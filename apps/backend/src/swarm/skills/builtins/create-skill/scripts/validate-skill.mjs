#!/usr/bin/env node
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const VALID_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "env", "envVars"]);
const PATH_REFERENCE_PATTERN = /(?:^|[\s`("'\[])((?:\.{1,2}\/|\/(?!\/)|[A-Za-z]:[\\/]|(?:scripts|references|templates)\/)[^\s`)'"\]]+)/gm;
const TODO_PLACEHOLDER_PATTERN = /\bTODO\b\s*:/gi;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    printJson({
      ok: true,
      usage: "node ./scripts/validate-skill.mjs [skill-root-or-skill-file]",
    });
    return;
  }

  const rawTarget = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
  const resolvedTarget = resolve(rawTarget);
  const skillRoot = basename(resolvedTarget) === "SKILL.md" ? dirname(resolvedTarget) : resolvedTarget;
  const skillFile = join(skillRoot, "SKILL.md");

  const checks = [];
  const errors = [];
  const warnings = [];

  if (!(await pathExists(skillRoot))) {
    fail("Skill root does not exist.", { skillRoot });
  }

  const rootStats = await stat(skillRoot);
  if (!rootStats.isDirectory()) {
    fail("Skill root must be a directory or a SKILL.md path.", { skillRoot });
  }

  if (!(await pathExists(skillFile))) {
    fail("SKILL.md was not found under the skill root.", { skillRoot, skillFile });
  }

  const markdown = await readFile(skillFile, "utf8");
  const parsed = parseFrontmatter(markdown);
  const body = stripFrontmatter(markdown);
  const canonicalSkillRoot = await realpath(skillRoot);

  addPresenceCheck({ checks, errors }, "skill-file", true, `Found ${skillFile}`);
  addPresenceCheck({ checks, errors }, "frontmatter", parsed.present, parsed.present ? "Frontmatter block found." : "Frontmatter block missing.");

  if (!parsed.present) {
    finish({ skillRoot, skillFile, checks, errors, warnings, references: [] });
    return;
  }

  addValueCheck({ checks, errors }, "frontmatter.name", Boolean(parsed.name), parsed.name ? `name: ${parsed.name}` : "Missing frontmatter name.");
  addValueCheck({ checks, errors }, "frontmatter.description", Boolean(parsed.description), parsed.description ? `description: ${parsed.description}` : "Missing frontmatter description.");

  if (parsed.description && /^TODO:/i.test(parsed.description)) {
    warnings.push("Frontmatter description still contains a TODO placeholder.");
    checks.push({ name: "frontmatter.description.todo", status: "warn", detail: "Replace the TODO description before shipping." });
  }

  const unknownKeys = parsed.topLevelKeys.filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.push(`Unknown frontmatter keys: ${unknownKeys.join(", ")}`);
    checks.push({ name: "frontmatter.unknown-keys", status: "warn", detail: `Unknown keys: ${unknownKeys.join(", ")}` });
  } else {
    checks.push({ name: "frontmatter.unknown-keys", status: "pass", detail: "No unknown top-level frontmatter keys." });
  }

  if (parsed.name) {
    const expectedDirectoryName = basename(skillRoot);
    if (parsed.name !== expectedDirectoryName) {
      warnings.push(`Frontmatter name (${parsed.name}) does not match directory name (${expectedDirectoryName}).`);
      checks.push({
        name: "frontmatter.name-directory-match",
        status: "warn",
        detail: `Frontmatter name (${parsed.name}) differs from directory name (${expectedDirectoryName}).`,
      });
    } else {
      checks.push({ name: "frontmatter.name-directory-match", status: "pass", detail: "Frontmatter name matches directory name." });
    }
  }

  const invalidEnvNames = parsed.env.filter((entry) => !VALID_ENV_NAME_PATTERN.test(entry.name));
  if (invalidEnvNames.length > 0) {
    errors.push(`Invalid env var names: ${invalidEnvNames.map((entry) => entry.name).join(", ")}`);
    checks.push({
      name: "frontmatter.env",
      status: "error",
      detail: `Invalid env names: ${invalidEnvNames.map((entry) => entry.name).join(", ")}`,
    });
  } else {
    checks.push({
      name: "frontmatter.env",
      status: "pass",
      detail: parsed.env.length > 0 ? `Validated ${parsed.env.length} env declaration(s).` : "No env declarations present.",
    });
  }

  const recommendedSections = [
    { key: "use", pattern: /^##\s+(trigger check|use this skill when|when to use)/im, label: "usage / trigger section" },
    { key: "avoid-use", pattern: /^(?:##\s+)?(do not use this skill when|when not to use|avoid use|non-trigger)\b/im, label: "when-not-to-use / non-trigger section" },
    { key: "workflow", pattern: /^##\s+(workflow|eval-first workflow)/im, label: "workflow section" },
    { key: "guardrails", pattern: /^##\s+guardrails/im, label: "guardrails section" },
    { key: "output", pattern: /^##\s+(output|output \/ report format)/im, label: "output section" },
  ];

  for (const section of recommendedSections) {
    if (section.pattern.test(markdown)) {
      checks.push({ name: `recommended.${section.key}`, status: "pass", detail: `Found ${section.label}.` });
    } else {
      warnings.push(`Missing recommended ${section.label}.`);
      checks.push({ name: `recommended.${section.key}`, status: "warn", detail: `Missing ${section.label}.` });
    }
  }

  const bodyTodoMatches = Array.from(body.matchAll(TODO_PLACEHOLDER_PATTERN));
  if (bodyTodoMatches.length > 0) {
    const todoSections = collectTodoSections(body);
    const detail = todoSections.length > 0
      ? `Found ${bodyTodoMatches.length} TODO placeholder(s) in: ${todoSections.join(", ")}.`
      : `Found ${bodyTodoMatches.length} TODO placeholder(s) in the skill body.`;
    warnings.push(`${detail} Replace them before shipping the skill.`);
    checks.push({
      name: "body.todo-placeholders",
      status: "warn",
      detail,
    });
  } else {
    checks.push({ name: "body.todo-placeholders", status: "pass", detail: "No TODO placeholders found in the skill body." });
  }

  const referencedPaths = collectReferencedPaths(markdown);
  const resolvedReferences = [];
  for (const referencePath of referencedPaths) {
    const resolvedReference = resolveReferencePath(canonicalSkillRoot, referencePath);
    const isAbsoluteReference = isAbsolutePathReference(referencePath);
    const lexicalWithinRoot = isPathWithinRoot(canonicalSkillRoot, resolvedReference);

    if (!(await pathExists(resolvedReference))) {
      const missingReferenceWithinRoot = lexicalWithinRoot || await hasCanonicalAncestorWithinRoot(canonicalSkillRoot, resolvedReference);
      if (!missingReferenceWithinRoot) {
        errors.push(`Reference escapes skill root: ${referencePath}`);
        checks.push({ name: `references.${referencePath}`, status: "error", detail: "Reference escapes skill root." });
        continue;
      }

      resolvedReferences.push({ path: referencePath, absolutePath: resolvedReference });
      errors.push(`Missing referenced file: ${referencePath}`);
      checks.push({ name: `references.${referencePath}`, status: "error", detail: "Referenced file is missing." });
      continue;
    }

    const canonicalReferencePath = await realpath(resolvedReference);
    resolvedReferences.push({ path: referencePath, absolutePath: resolvedReference });

    if (!isPathWithinRoot(canonicalSkillRoot, canonicalReferencePath)) {
      errors.push(`Reference escapes skill root: ${referencePath}`);
      checks.push({ name: `references.${referencePath}`, status: "error", detail: "Reference escapes skill root." });
      continue;
    }

    if (isAbsoluteReference) {
      warnings.push(`Absolute path reference detected: ${referencePath}`);
      checks.push({ name: `references.${referencePath}`, status: "warn", detail: "Absolute path reference stays within the skill root but is less portable." });
      continue;
    }

    checks.push({ name: `references.${referencePath}`, status: "pass", detail: "Reference exists." });
  }

  const topLevelEntries = await readdir(skillRoot);
  checks.push({ name: "skill-root.entries", status: "pass", detail: `Found ${topLevelEntries.length} top-level entr${topLevelEntries.length === 1 ? "y" : "ies"}.` });

  finish({ skillRoot, skillFile, checks, errors, warnings, references: resolvedReferences });
}

function stripFrontmatter(markdown) {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) {
    return markdown;
  }

  return markdown.slice(match[0].length);
}

function parseFrontmatter(markdown) {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) {
    return { present: false, topLevelKeys: [], env: [] };
  }

  const lines = match[1].split(/\r?\n/);
  const topLevelKeys = [];
  let name;
  let description;
  let envStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = countLeadingSpaces(line);
    if (indent > 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    topLevelKeys.push(key);

    if (key === "name") {
      name = parseYamlStringValue(rawValue);
      continue;
    }

    if (key === "description") {
      description = parseYamlStringValue(rawValue);
      continue;
    }

    if (key === "env" || key === "envVars") {
      envStart = index;
    }
  }

  return {
    present: true,
    topLevelKeys,
    name,
    description,
    env: envStart >= 0 ? parseEnvDeclarations(lines, envStart) : [],
  };
}

function parseEnvDeclarations(lines, envStart) {
  const envIndent = countLeadingSpaces(lines[envStart]);
  const declarations = [];
  let current = null;

  const flush = () => {
    if (!current) {
      return;
    }

    declarations.push({ name: typeof current.name === "string" ? current.name.trim() : "" });
    current = null;
  };

  for (let index = envStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = countLeadingSpaces(line);
    if (indent <= envIndent) {
      break;
    }

    if (trimmed.startsWith("-")) {
      flush();
      current = {};
      const inline = trimmed.slice(1).trim();
      if (inline) {
        assignInlineField(current, inline);
      }
      continue;
    }

    if (current) {
      assignInlineField(current, trimmed);
    }
  }

  flush();
  return declarations;
}

function assignInlineField(target, line) {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return;
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = parseYamlStringValue(line.slice(separatorIndex + 1).trim());
  if (key === "name") {
    target.name = value;
  }
}

function parseYamlStringValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function collectReferencedPaths(markdown) {
  const matches = [];
  let match;

  while ((match = PATH_REFERENCE_PATTERN.exec(markdown)) !== null) {
    matches.push(match[1]);
  }
  PATH_REFERENCE_PATTERN.lastIndex = 0;

  return Array.from(new Set(matches)).sort((left, right) => left.localeCompare(right));
}

function collectTodoSections(markdown) {
  const sections = [];
  const sectionPattern = /^##\s+(.+)$/gm;
  let currentSection = "body";
  let lastIndex = 0;
  let match;

  while ((match = sectionPattern.exec(markdown)) !== null) {
    const chunk = markdown.slice(lastIndex, match.index);
    if (TODO_PLACEHOLDER_PATTERN.test(chunk)) {
      sections.push(currentSection);
    }
    TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
    currentSection = match[1].trim();
    lastIndex = sectionPattern.lastIndex;
  }

  const tail = markdown.slice(lastIndex);
  if (TODO_PLACEHOLDER_PATTERN.test(tail)) {
    sections.push(currentSection);
  }
  TODO_PLACEHOLDER_PATTERN.lastIndex = 0;

  return Array.from(new Set(sections));
}

function countLeadingSpaces(value) {
  const match = /^\s*/.exec(value);
  return match ? match[0].length : 0;
}

function resolveReferencePath(rootPath, referencePath) {
  if (isAbsolutePathReference(referencePath)) {
    return resolve(referencePath);
  }

  return resolve(rootPath, referencePath);
}

function isAbsolutePathReference(referencePath) {
  return isAbsolute(referencePath) || win32.isAbsolute(referencePath);
}

function isPathWithinRoot(rootPath, targetPath) {
  if (!(isAbsolute(targetPath) || win32.isAbsolute(targetPath))) {
    return false;
  }

  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`${sep}..${sep}`) && relativePath !== "..");
}

async function hasCanonicalAncestorWithinRoot(rootPath, targetPath) {
  let currentPath = resolve(targetPath);

  while (true) {
    if (await pathExists(currentPath)) {
      const canonicalCurrentPath = await realpath(currentPath);
      return isPathWithinRoot(rootPath, canonicalCurrentPath);
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function addPresenceCheck(state, name, passes, detail) {
  state.checks.push({ name, status: passes ? "pass" : "error", detail });
  if (!passes) {
    state.errors.push(detail);
  }
}

function addValueCheck(state, name, passes, detail) {
  state.checks.push({ name, status: passes ? "pass" : "error", detail });
  if (!passes) {
    state.errors.push(detail);
  }
}

function finish({ skillRoot, skillFile, checks, errors, warnings, references }) {
  printJson({
    ok: errors.length === 0,
    skillRoot,
    skillFile,
    checks,
    errors,
    warnings,
    references,
  });
  process.exit(errors.length === 0 ? 0 : 1);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message, details = undefined) {
  printJson({ ok: false, error: message, ...(details ? { details } : {}) });
  process.exit(1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
