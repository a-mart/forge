import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { isEnoentError } from "./claude-utils.js";

const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";
const CLAUDE_CONTEXT_FILE_NAME = "CLAUDE.md";
const MANAGER_MEMORY_HEADER = "# Manager Memory (shared across all sessions — read-only reference)";
const SESSION_MEMORY_HEADER = "# Session Memory (this session's working memory — your writes go here)";
const COMMON_KNOWLEDGE_MEMORY_HEADER = "# Common Knowledge (maintained by Cortex — read-only reference)";

export interface ClaudePromptAssemblerOptions {
  // Base prompt (archetype or specialist)
  basePrompt: string;

  // Memory
  profileMemoryPath?: string;
  sessionMemoryPath?: string;
  commonKnowledgePath?: string;
  memoryContextFile?: { path: string; content: string };

  // Context
  agentsMdPaths?: string[];
  swarmMdPath?: string;
  projectAgentDirectory?: string;
  referenceDocs?: string;

  // Skills
  availableSkills?: Array<{ name: string; description: string; location: string }>;

  // Onboarding state
  onboardingSnapshot?: string;

  // Agent identity
  role: "manager" | "worker";
  agentId: string;

  // Optional explicit cwd for the final Pi-style footer.
  cwd?: string;
}

interface LoadedContextFile {
  path: string;
  content: string;
}

export async function assembleClaudePrompt(options: ClaudePromptAssemblerOptions): Promise<string> {
  const sections: string[] = [];
  const trimmedBasePrompt = options.basePrompt.trim();
  if (trimmedBasePrompt.length > 0) {
    sections.push(trimmedBasePrompt);
  }

  const trimmedReferenceDocs = options.referenceDocs?.trim();
  if (trimmedReferenceDocs) {
    sections.push(trimmedReferenceDocs);
  }

  const trimmedProjectAgentDirectory = options.projectAgentDirectory?.trim();
  if (options.role === "manager" && trimmedProjectAgentDirectory) {
    sections.push(trimmedProjectAgentDirectory);
  }

  const [agentsFiles, swarmFile, memoryComposite] = await Promise.all([
    loadContextFiles(options.agentsMdPaths ?? []),
    loadOptionalContextFile(options.swarmMdPath),
    options.memoryContextFile
      ? Promise.resolve(trimTrailingNewlines(options.memoryContextFile.content))
      : buildMemoryComposite({
          profileMemoryPath: options.profileMemoryPath,
          sessionMemoryPath: options.sessionMemoryPath,
          commonKnowledgePath: options.commonKnowledgePath
        })
  ]);

  const projectContextEntries: string[] = [];
  for (const contextFile of agentsFiles) {
    projectContextEntries.push(renderProjectContextFile(contextFile));
  }

  if (swarmFile) {
    projectContextEntries.push(renderProjectContextFile(swarmFile));
  }

  const trimmedMemoryComposite = memoryComposite.trim();
  if (trimmedMemoryComposite.length > 0) {
    const memoryPathLabel =
      normalizeOptionalPath(options.memoryContextFile?.path) ??
      normalizeOptionalPath(options.sessionMemoryPath) ??
      "memory.md";
    projectContextEntries.push(renderProjectContextFile({ path: memoryPathLabel, content: trimmedMemoryComposite }));
  }

  const trimmedOnboardingSnapshot = options.onboardingSnapshot?.trim();
  if (trimmedOnboardingSnapshot) {
    projectContextEntries.push(trimmedOnboardingSnapshot);
  }

  const projectContextBlock = ["# Project Context", ...projectContextEntries].join("\n\n");
  sections.push(projectContextBlock);

  const skillsBlock = buildSkillsBlock(options.availableSkills ?? []);
  if (skillsBlock) {
    sections.push(skillsBlock);
  }

  sections.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  sections.push(`Current working directory: ${resolveAssemblerCwd(options)}`);

  return sections.filter((section) => section.trim().length > 0).join("\n\n").trimEnd();
}

/**
 * Historical name retained for the Phase 3 work package. For Pi parity this helper mirrors
 * per-directory context discovery by preferring AGENTS.md and falling back to CLAUDE.md.
 */
export async function discoverAgentsMd(cwd: string): Promise<string[]> {
  const discoveredPaths: string[] = [];
  let currentDir = resolve(cwd);

  while (true) {
    const agentsPath = join(currentDir, AGENTS_CONTEXT_FILE_NAME);
    const claudePath = join(currentDir, CLAUDE_CONTEXT_FILE_NAME);

    if (await pathExists(agentsPath)) {
      discoveredPaths.unshift(agentsPath);
    } else if (await pathExists(claudePath)) {
      discoveredPaths.unshift(claudePath);
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return discoveredPaths;
}

export async function buildMemoryComposite(options: {
  profileMemoryPath?: string;
  sessionMemoryPath?: string;
  commonKnowledgePath?: string;
}): Promise<string> {
  const [profileMemoryContent, sessionMemoryContent, commonKnowledgeContent] = await Promise.all([
    readOptionalTextFile(options.profileMemoryPath),
    readOptionalTextFile(options.sessionMemoryPath),
    readOptionalTextFile(options.commonKnowledgePath)
  ]);

  const sections: string[] = [];
  const hasProfileMemory = options.profileMemoryPath !== undefined;
  const hasSessionMemory = options.sessionMemoryPath !== undefined;

  if (hasProfileMemory) {
    sections.push(MANAGER_MEMORY_HEADER, "", trimTrailingNewlines(profileMemoryContent ?? ""));
  }

  if (hasSessionMemory) {
    if (sections.length > 0) {
      sections.push("", "---", "");
    }
    sections.push(SESSION_MEMORY_HEADER, "", trimTrailingNewlines(sessionMemoryContent ?? ""));
  }

  const normalizedCommonKnowledge = trimTrailingNewlines(commonKnowledgeContent ?? "").trim();
  if (normalizedCommonKnowledge.length > 0) {
    if (sections.length > 0) {
      sections.push("", "---", "");
    }
    sections.push(COMMON_KNOWLEDGE_MEMORY_HEADER, "", trimTrailingNewlines(commonKnowledgeContent ?? ""));
  }

  return sections.join("\n").trimEnd();
}

async function loadContextFiles(paths: string[]): Promise<LoadedContextFile[]> {
  const files = await Promise.all(paths.map(async (path) => loadOptionalContextFile(path)));
  return files.filter((file): file is LoadedContextFile => file !== undefined);
}

async function loadOptionalContextFile(path: string | undefined): Promise<LoadedContextFile | undefined> {
  const normalizedPath = normalizeOptionalPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const content = await readOptionalTextFile(normalizedPath);
  if (content === undefined) {
    return undefined;
  }

  return {
    path: normalizedPath,
    content
  };
}

function renderProjectContextFile(file: LoadedContextFile): string {
  return [`## ${file.path}`, "", trimTrailingNewlines(file.content)].join("\n").trimEnd();
}

function buildSkillsBlock(skills: Array<{ name: string; description: string; location: string }>): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ];

  for (const skill of skills) {
    const normalizedName = skill.name.trim();
    const normalizedDescription = skill.description.trim();
    const normalizedLocation = skill.location.trim();

    if (!normalizedName || !normalizedLocation) {
      continue;
    }

    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(normalizedName)}</name>`);
    if (normalizedDescription.length > 0) {
      lines.push(`    <description>${escapeXml(normalizedDescription)}</description>`);
    }
    lines.push(`    <location>${escapeXml(normalizedLocation)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function resolveAssemblerCwd(options: ClaudePromptAssemblerOptions): string {
  const explicitCwd = normalizeOptionalPath(options.cwd);
  if (explicitCwd) {
    return explicitCwd;
  }

  const deepestAgentContextPath = options.agentsMdPaths
    ?.map((path) => normalizeOptionalPath(path))
    .filter((path): path is string => path !== undefined)
    .at(-1);
  if (deepestAgentContextPath) {
    return dirname(deepestAgentContextPath);
  }

  const swarmMdPath = normalizeOptionalPath(options.swarmMdPath);
  if (swarmMdPath) {
    return dirname(swarmMdPath);
  }

  return resolve(process.cwd());
}

async function readOptionalTextFile(path: string | undefined): Promise<string | undefined> {
  const normalizedPath = normalizeOptionalPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  try {
    return await readFile(normalizedPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await readOptionalTextFile(path)) !== undefined;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? resolve(trimmed) : undefined;
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

