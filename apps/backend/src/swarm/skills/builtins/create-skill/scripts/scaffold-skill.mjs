#!/usr/bin/env node
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE_ALIASES = new Map([
  ["global", "machine-local"],
  ["machine-local", "machine-local"],
  ["profile", "profile"],
  ["project", "project-local"],
  ["project-local", "project-local"],
]);
const TEMPLATE_ALIASES = new Map([
  ["minimal", "minimal"],
  ["scripted", "scripted"],
]);
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TODO_DESCRIPTION = "TODO: replace with a concise one-line description.";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(scriptDir, "..");
const templatesDir = resolve(skillRoot, "templates");

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.help) {
    printJson({
      ok: true,
      usage: {
        command: "node ./scripts/scaffold-skill.mjs --name <skill-name> [options]",
        options: {
          "--scope": "machine-local | profile | project-local",
          "--profile-id": "required for profile scope",
          "--data-dir": "defaults to SWARM_DATA_DIR, FORGE_DATA_DIR, or ~/.forge",
          "--cwd": "project root for project-local scope; defaults to process.cwd()",
          "--description": "skill description for frontmatter",
          "--template": "minimal | scripted",
          "--force": "overwrite scaffold-managed files inside an existing skill root",
        },
      },
    });
    return;
  }

  const name = requireSkillName(parsedArgs.name);
  const scope = normalizeScope(parsedArgs.scope ?? "machine-local");
  const description = normalizeDescription(parsedArgs.description);
  const template = normalizeTemplate(parsedArgs.template ?? "minimal");
  const dataDir = resolve(parsedArgs["data-dir"] ?? process.env.SWARM_DATA_DIR ?? process.env.FORGE_DATA_DIR ?? join(homedir(), ".forge"));
  const cwd = resolve(parsedArgs.cwd ?? process.cwd());
  const targetInfo = resolveSkillTargetInfo({ scope, name, dataDir, cwd, profileId: parsedArgs["profile-id"] });
  const templateFiles = await loadTemplateFiles(template);
  const filesToWrite = buildFiles({ name, description, template, templateFiles });

  const canonicalTargetRoot = await ensureWritableTargetRoot(targetInfo, parsedArgs.force === true);
  await writeScaffoldFiles(canonicalTargetRoot, filesToWrite);

  const warnings = [];
  if (description === TODO_DESCRIPTION) {
    warnings.push("Description was omitted. Replace the TODO description before shipping the skill.");
  }
  if (scope === "project-local") {
    warnings.push("Project-local skills live under <cwd>/.pi/skills and may be visible to git unless ignored.");
  }

  printJson({
    ok: true,
    scope,
    template,
    skillName: name,
    location: targetInfo.targetRoot,
    created: Array.from(filesToWrite.keys()),
    warnings,
    nextSteps: [
      `node ${resolve(skillRoot, "scripts", "validate-skill.mjs")} ${targetInfo.targetRoot}`,
    ],
  });
}

function parseArgs(argv) {
  const parsed = { force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "force") {
      parsed.force = true;
      continue;
    }
    if (key === "help") {
      parsed.help = true;
      continue;
    }

    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function requireSkillName(value) {
  if (typeof value !== "string") {
    fail("Missing required --name option.");
  }

  const normalized = value.trim();
  if (!SKILL_NAME_PATTERN.test(normalized)) {
    fail("Skill names must be lowercase kebab-case (letters, numbers, hyphens).", { received: value });
  }

  return normalized;
}

function normalizeScope(value) {
  const normalized = SCOPE_ALIASES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    fail("Unsupported scope.", { received: value, allowed: Array.from(new Set(SCOPE_ALIASES.values())) });
  }

  return normalized;
}

function normalizeTemplate(value) {
  const normalized = TEMPLATE_ALIASES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    fail("Unsupported template.", { received: value, allowed: Array.from(TEMPLATE_ALIASES.values()) });
  }

  return normalized;
}

function normalizeDescription(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return TODO_DESCRIPTION;
  }

  if (/\r|\n/.test(value) || value.includes("---")) {
    fail("Description must be a single line and must not contain YAML frontmatter delimiters.", {
      received: value,
    });
  }

  return value.trim();
}

function resolveSkillTargetInfo({ scope, name, dataDir, cwd, profileId }) {
  if (scope === "machine-local") {
    const scopeBase = join(dataDir, "skills");
    return {
      scopeAnchor: dataDir,
      scopeBase,
      targetRoot: join(scopeBase, name),
    };
  }

  if (scope === "profile") {
    if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId.trim())) {
      fail("Profile scope requires a valid --profile-id.");
    }

    const scopeBase = join(dataDir, "profiles", profileId.trim(), "pi", "skills");
    return {
      scopeAnchor: dataDir,
      scopeBase,
      targetRoot: join(scopeBase, name),
    };
  }

  const scopeBase = join(cwd, ".pi", "skills");
  return {
    scopeAnchor: cwd,
    scopeBase,
    targetRoot: join(scopeBase, name),
  };
}

async function loadTemplateFiles(template) {
  const skillTemplateName = template === "scripted" ? "scripted-SKILL.md.tmpl" : "minimal-SKILL.md.tmpl";
  const skillTemplatePath = resolve(templatesDir, skillTemplateName);
  const helperTemplatePath = resolve(templatesDir, "helper-script.mjs.tmpl");

  const skillTemplate = await readUtf8File(skillTemplatePath);
  const helperTemplate = template === "scripted" ? await readUtf8File(helperTemplatePath) : null;

  return {
    skillTemplate,
    helperTemplate,
  };
}

function buildFiles({ name, description, template, templateFiles }) {
  const files = new Map();
  const replacements = new Map([
    ["__SKILL_NAME__", name],
    ["__SKILL_DESCRIPTION__", description],
    ["__DISPLAY_NAME__", toDisplayName(name)],
  ]);

  files.set("SKILL.md", applyTemplate(templateFiles.skillTemplate, replacements));
  if (template === "scripted" && templateFiles.helperTemplate) {
    files.set(join("scripts", "main.mjs"), templateFiles.helperTemplate);
  }

  return files;
}

async function ensureWritableTargetRoot(targetInfo, force) {
  const normalizedScopeAnchor = await normalizeTrustedAmbientAliasPrefix(targetInfo.scopeAnchor);
  const normalizedScopeBase = await normalizeTrustedAmbientAliasPrefix(targetInfo.scopeBase);
  const normalizedTargetRoot = await normalizeTrustedAmbientAliasPrefix(targetInfo.targetRoot);

  const anchorInfo = await resolveExistingDirectoryAnchor(normalizedScopeAnchor);
  const scopeBaseSegments = toRelativeSegments(anchorInfo.lexical, normalizedScopeBase);
  const targetSegments = toRelativeSegments(normalizedScopeBase, normalizedTargetRoot);

  const ensuredScopeBase = await ensureSafeDirectoryChain(anchorInfo, scopeBaseSegments, "Scope path component");
  const ensuredTargetRoot = await ensureSafeDirectoryChain(ensuredScopeBase, targetSegments, "Target skill root");

  if (!isPathWithinRoot(ensuredScopeBase.canonical, ensuredTargetRoot.canonical)) {
    fail("Target skill root resolved outside the expected scope base.", {
      scopeBase: targetInfo.scopeBase,
      canonicalScopeBase: ensuredScopeBase.canonical,
      targetRoot: targetInfo.targetRoot,
      canonicalTargetRoot: ensuredTargetRoot.canonical,
    });
  }

  const entries = await readdir(ensuredTargetRoot.canonical);
  if (entries.length > 0 && !force) {
    fail("Target skill root already exists and is not empty. Re-run with --force to overwrite scaffold-managed files.", {
      location: targetInfo.targetRoot,
      entries,
    });
  }

  return ensuredTargetRoot.canonical;
}

async function writeScaffoldFiles(canonicalRoot, filesToWrite) {
  for (const [relativePath, content] of filesToWrite.entries()) {
    const absolutePath = resolve(canonicalRoot, relativePath);
    ensureWithinRoot(canonicalRoot, absolutePath, relativePath);
    await ensureManagedParentPathSafe(canonicalRoot, dirname(relativePath));
    await ensureWritableFilePathSafe(canonicalRoot, relativePath);
    await writeFile(absolutePath, content, "utf8");
  }
}

function ensureWithinRoot(rootPath, absolutePath, relativePath = absolutePath) {
  const relativePathFromRoot = relative(rootPath, absolutePath);
  if (
    relativePathFromRoot === "" ||
    (!relativePathFromRoot.startsWith("..") && !relativePathFromRoot.includes(`${sep}..${sep}`) && relativePathFromRoot !== "..")
  ) {
    return;
  }

  fail("Refusing to access a path outside the target skill root.", {
    rootPath,
    attemptedPath: absolutePath,
    relativePath,
  });
}

async function resolveExistingDirectoryAnchor(anchorPath) {
  let currentPath = await normalizeTrustedAmbientAliasPrefix(resolve(anchorPath));

  while (true) {
    if (await pathExists(currentPath)) {
      await assertNoSymlinkPathComponents(currentPath, "Scope anchor path component");

      const currentStats = await stat(currentPath);
      if (!currentStats.isDirectory()) {
        fail("Scope anchor must resolve to a directory.", { location: currentPath });
      }

      return {
        lexical: currentPath,
        canonical: await realpath(currentPath),
      };
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      fail("Unable to find an existing directory ancestor for the requested scope.", { anchorPath });
    }
    currentPath = parentPath;
  }
}

async function normalizeTrustedAmbientAliasPrefix(pathValue) {
  if (process.platform !== "darwin") {
    return pathValue;
  }

  for (const aliasPrefix of ["/var", "/tmp"]) {
    if (pathValue !== aliasPrefix && !pathValue.startsWith(`${aliasPrefix}${sep}`)) {
      continue;
    }

    try {
      const canonicalPrefix = await realpath(aliasPrefix);
      if (canonicalPrefix === aliasPrefix) {
        continue;
      }

      const remainder = pathValue.slice(aliasPrefix.length).replace(new RegExp(`^\\${sep}+`), "");
      return remainder.length > 0 ? join(canonicalPrefix, remainder) : canonicalPrefix;
    } catch {
      continue;
    }
  }

  return pathValue;
}

async function assertNoSymlinkPathComponents(targetPath, label) {
  const existingPaths = [];
  let currentPath = resolve(targetPath);

  while (true) {
    existingPaths.push(currentPath);
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  for (const pathEntry of existingPaths.reverse()) {
    if (!(await pathExists(pathEntry))) {
      continue;
    }

    const entryStats = await lstat(pathEntry);
    if (entryStats.isSymbolicLink()) {
      fail(`${label} must not be a symlink.`, {
        location: pathEntry,
      });
    }
  }
}

async function ensureSafeDirectoryChain(anchorInfo, relativeSegments, label) {
  let lexicalCurrent = anchorInfo.lexical;
  let canonicalCurrent = anchorInfo.canonical;

  for (const segment of relativeSegments) {
    const nextLexical = join(lexicalCurrent, segment);
    if (await pathExists(nextLexical)) {
      const nextStats = await lstat(nextLexical);
      if (nextStats.isSymbolicLink()) {
        fail(`${label} must not be a symlink.`, {
          location: nextLexical,
          relativePath: relative(anchorInfo.lexical, nextLexical),
        });
      }

      const directoryStats = await stat(nextLexical);
      if (!directoryStats.isDirectory()) {
        fail(`${label} exists but is not a directory.`, {
          location: nextLexical,
          relativePath: relative(anchorInfo.lexical, nextLexical),
        });
      }

      canonicalCurrent = await realpath(nextLexical);
      lexicalCurrent = nextLexical;
      continue;
    }

    const nextCanonical = join(canonicalCurrent, segment);
    await mkdir(nextCanonical, { recursive: false });
    canonicalCurrent = await realpath(nextCanonical);
    lexicalCurrent = nextLexical;
  }

  return {
    lexical: lexicalCurrent,
    canonical: canonicalCurrent,
  };
}

function toRelativeSegments(fromPath, toPath) {
  const relativePath = relative(fromPath, toPath);
  if (!relativePath || relativePath === ".") {
    return [];
  }

  if (relativePath.startsWith("..") || relativePath.includes(`${sep}..${sep}`)) {
    fail("Resolved path escapes the expected scope anchor.", {
      fromPath,
      toPath,
    });
  }

  return relativePath.split(sep).filter(Boolean);
}

async function ensureManagedParentPathSafe(rootPath, relativeParentPath) {
  if (relativeParentPath === ".") {
    return;
  }

  const segments = relativeParentPath.split(sep).filter(Boolean);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    if (!(await pathExists(currentPath))) {
      await mkdir(currentPath, { recursive: false });
      continue;
    }

    const currentStats = await lstat(currentPath);
    if (currentStats.isSymbolicLink()) {
      fail("Managed parent path must not be a symlink.", {
        location: currentPath,
        relativePath: relative(rootPath, currentPath),
      });
    }
    if (!currentStats.isDirectory()) {
      fail("Managed parent path exists but is not a directory.", {
        location: currentPath,
        relativePath: relative(rootPath, currentPath),
      });
    }
  }
}

async function ensureWritableFilePathSafe(rootPath, relativeFilePath) {
  const absolutePath = resolve(rootPath, relativeFilePath);
  ensureWithinRoot(rootPath, absolutePath, relativeFilePath);

  if (!(await pathExists(absolutePath))) {
    return;
  }

  const existingStats = await lstat(absolutePath);
  if (existingStats.isSymbolicLink()) {
    fail("Managed file path must not be a symlink.", {
      location: absolutePath,
      relativePath: relativeFilePath,
    });
  }
  if (!existingStats.isFile()) {
    fail("Managed file path exists but is not a regular file.", {
      location: absolutePath,
      relativePath: relativeFilePath,
    });
  }
}

function applyTemplate(template, replacements) {
  let result = template;
  for (const [placeholder, value] of replacements.entries()) {
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

function toDisplayName(name) {
  return name
    .split("-")
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(" ");
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`${sep}..${sep}`) && relativePath !== "..");
}

async function readUtf8File(path) {
  return readFile(path, "utf8");
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message, details = undefined) {
  const payload = { ok: false, error: message, ...(details ? { details } : {}) };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
