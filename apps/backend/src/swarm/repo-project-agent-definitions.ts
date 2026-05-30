import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import {
  PROJECT_AGENT_CAPABILITIES,
  type AgentModelDescriptor,
  type ProjectAgentCapability,
  type ProjectAgentSourceProblem,
  type RepoProjectAgentDefinitionConfig,
  type RepoProjectAgentInventoryItem,
  type RepoProjectAgentInventorySection
} from "@forge/protocol";
import { normalizeProjectAgentHandle, isReservedProjectAgentHandle } from "./agents/project-agent-registry.js";
import { sanitizePathSegment } from "./data-paths.js";
import { normalizePersistedSwarmModelDescriptor } from "./model-presets.js";

const MAX_DEFINITIONS = 50;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_REFERENCE_FILES = 25;
const MAX_REFERENCE_BYTES = 128 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 512 * 1024;
const MAX_WHEN_TO_USE_LENGTH = 280;

export interface ParsedRepoProjectAgentDefinition {
  definitionId: string;
  dirPath: string;
  config: RepoProjectAgentDefinitionConfig;
  prompt: string;
  referenceDocs: Array<{ path: string; content: string; sha256: string }>;
  signature: string;
}

export interface RepoProjectAgentDefinitionInventory extends RepoProjectAgentInventorySection {
  definitions: ParsedRepoProjectAgentDefinition[];
}

export async function scanRepoProjectAgentDefinitions(rootDir: string | undefined): Promise<RepoProjectAgentDefinitionInventory> {
  if (!rootDir) {
    return { exists: false, count: 0, items: [], definitions: [] };
  }

  const rootStats = await lstat(rootDir).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    return { path: rootDir, exists: false, count: 0, items: [], definitions: [] };
  }

  const rootEntriesResult = await readDirectoryEntries(rootDir, "project-agents");
  if (rootEntriesResult.problems.length > 0) {
    return { path: rootDir, exists: true, count: 0, items: [], definitions: [], problems: rootEntriesResult.problems };
  }

  const entries = rootEntriesResult.entries;
  const items: Array<RepoProjectAgentInventoryItem & { signature?: string }> = [];
  const definitions: ParsedRepoProjectAgentDefinition[] = [];
  let truncated = entries.length > MAX_DIRECTORY_ENTRIES;

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (items.length >= MAX_DEFINITIONS) {
      truncated = true;
      break;
    }
    const dirPath = join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      items.push(buildInvalidItem(rootDir, entry.name, dirPath, [{ code: "definition_symlink", message: "Project agent definition directories must not be symlinks.", path: entry.name }]));
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const parsed = await parseRepoProjectAgentDefinition(rootDir, entry.name, dirPath);
    items.push(parsed.item);
    if (parsed.definition) {
      definitions.push(parsed.definition);
    }
  }

  const conflictDefinitionIds = applyDuplicateHandleConflicts(items, definitions);
  const validDefinitions = definitions.filter((definition) => !conflictDefinitionIds.has(definition.definitionId));

  items.sort((left, right) => left.definitionId.localeCompare(right.definitionId));
  validDefinitions.sort((left, right) => left.definitionId.localeCompare(right.definitionId));
  return { path: rootDir, exists: true, count: items.length, items, definitions: validDefinitions, ...(truncated ? { truncated: true } : {}) };
}

async function parseRepoProjectAgentDefinition(
  rootDir: string,
  definitionId: string,
  dirPath: string
): Promise<{ item: RepoProjectAgentInventoryItem; definition?: ParsedRepoProjectAgentDefinition }> {
  const problems: ProjectAgentSourceProblem[] = [];
  validateDefinitionId(definitionId, problems);

  const configResult = await readLimitedText(join(dirPath, "config.json"), MAX_CONFIG_BYTES, "config.json");
  problems.push(...configResult.problems);
  const promptResult = await readLimitedText(join(dirPath, "prompt.md"), MAX_PROMPT_BYTES, "prompt.md");
  problems.push(...promptResult.problems);

  let config: RepoProjectAgentDefinitionConfig | undefined;
  if (configResult.content !== undefined) {
    config = parseConfig(configResult.content, problems);
  }

  const prompt = promptResult.content ?? "";
  if (promptResult.content !== undefined && prompt.trim().length === 0) {
    problems.push({ code: "prompt_empty", message: "prompt.md must be non-empty.", path: "prompt.md" });
  }

  if (config) {
    validateConfig(config, problems);
  }

  const referenceResult = await readReferenceDocs(dirPath);
  problems.push(...referenceResult.problems);

  const normalizedHandle = typeof config?.handle === "string" ? normalizeProjectAgentHandle(config.handle) : undefined;
  const signature = createDefinitionSignature({
    definitionId,
    config: configResult.content,
    prompt: promptResult.content,
    references: referenceResult.docs,
    problems
  });

  const recommendedModel = isAgentModelDescriptor(config?.model)
    ? normalizePersistedSwarmModelDescriptor(config.model) ?? config.model
    : undefined;

  const item: RepoProjectAgentInventoryItem & { signature?: string } = {
    definitionId,
    handle: typeof config?.handle === "string" && normalizedHandle ? normalizedHandle : definitionId,
    path: relative(rootDir, dirPath) || ".",
    status: problems.length === 0 && config ? "valid" : "invalid",
    problems,
    ...(typeof config?.displayName === "string" && config.displayName.trim() ? { displayName: config.displayName.trim() } : {}),
    ...(typeof config?.whenToUse === "string" && config.whenToUse.trim() ? { whenToUse: normalizeInlineText(config.whenToUse) } : {}),
    ...(Array.isArray(config?.capabilities) ? { requestedCapabilities: normalizeCapabilities(config.capabilities) } : {}),
    ...(recommendedModel ? { recommendedModel } : {}),
    signature
  };

  if (!config || problems.length > 0) {
    return { item };
  }

  return {
    item,
    definition: {
      definitionId,
      dirPath,
      config: {
        version: 1,
        handle: normalizedHandle!,
        ...(config.displayName?.trim() ? { displayName: config.displayName.trim() } : {}),
        whenToUse: normalizeInlineText(config.whenToUse),
        ...(config.capabilities && normalizeCapabilities(config.capabilities).length > 0 ? { capabilities: normalizeCapabilities(config.capabilities) } : {}),
        ...(recommendedModel ? { model: recommendedModel } : {})
      },
      prompt,
      referenceDocs: referenceResult.docs,
      signature
    }
  };
}

function applyDuplicateHandleConflicts(
  items: Array<RepoProjectAgentInventoryItem & { signature?: string }>,
  definitions: ParsedRepoProjectAgentDefinition[]
): Set<string> {
  const definitionsByHandle = new Map<string, ParsedRepoProjectAgentDefinition[]>();
  for (const definition of definitions) {
    const normalizedHandle = normalizeProjectAgentHandle(definition.config.handle);
    definitionsByHandle.set(normalizedHandle, [...(definitionsByHandle.get(normalizedHandle) ?? []), definition]);
  }

  const conflictDefinitionIds = new Set<string>();
  for (const [handle, duplicateDefinitions] of definitionsByHandle) {
    if (duplicateDefinitions.length < 2) {
      continue;
    }

    const duplicateIds = duplicateDefinitions.map((definition) => definition.definitionId).sort();
    for (const definition of duplicateDefinitions) {
      conflictDefinitionIds.add(definition.definitionId);
      const item = items.find((candidate) => candidate.definitionId === definition.definitionId);
      if (!item) {
        continue;
      }
      const problem: ProjectAgentSourceProblem = {
        code: "repo_project_agent_handle_conflict",
        message: `Repository project-agent handle "${handle}" is used by multiple definitions: ${duplicateIds.join(", ")}.`,
        path: "config.json"
      };
      item.status = "conflict";
      item.problems = [...item.problems, problem];
      item.signature = createConflictSignature(item.signature, problem, duplicateIds);
    }
  }

  return conflictDefinitionIds;
}

function parseConfig(content: string, problems: ProjectAgentSourceProblem[]): RepoProjectAgentDefinitionConfig | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      problems.push({ code: "config_not_object", message: "config.json must contain a JSON object.", path: "config.json" });
      return undefined;
    }
    return parsed as unknown as RepoProjectAgentDefinitionConfig;
  } catch (error) {
    problems.push({ code: "config_invalid_json", message: error instanceof Error ? error.message : "config.json is not valid JSON.", path: "config.json" });
    return undefined;
  }
}

function validateConfig(config: RepoProjectAgentDefinitionConfig, problems: ProjectAgentSourceProblem[]): void {
  if (config.version !== 1) {
    problems.push({ code: "config_version", message: "config.json version must be 1.", path: "config.json" });
  }
  if (typeof config.handle !== "string" || normalizeProjectAgentHandle(config.handle).length === 0) {
    problems.push({ code: "handle_required", message: "config.json handle must be non-empty after sanitization.", path: "config.json" });
  } else if (config.handle !== normalizeProjectAgentHandle(config.handle)) {
    problems.push({ code: "handle_unsanitized", message: "config.json handle must already be sanitized.", path: "config.json" });
  } else if (isReservedProjectAgentHandle(config.handle)) {
    problems.push({
      code: "handle_reserved",
      message: 'config.json handle "codex" is reserved for Codex @mention routing.',
      path: "config.json",
    });
  }
  if (typeof config.whenToUse !== "string" || normalizeInlineText(config.whenToUse).length === 0) {
    problems.push({ code: "when_to_use_required", message: "config.json whenToUse must be non-empty.", path: "config.json" });
  } else if (normalizeInlineText(config.whenToUse).length > MAX_WHEN_TO_USE_LENGTH) {
    problems.push({ code: "when_to_use_too_large", message: `config.json whenToUse must be ${MAX_WHEN_TO_USE_LENGTH} characters or fewer.`, path: "config.json" });
  }
  if (config.displayName !== undefined && (typeof config.displayName !== "string" || config.displayName.trim().length === 0)) {
    problems.push({ code: "display_name_invalid", message: "config.json displayName must be a non-empty string when provided.", path: "config.json" });
  }
  if (config.capabilities !== undefined) {
    if (!Array.isArray(config.capabilities)) {
      problems.push({ code: "capabilities_invalid", message: "config.json capabilities must be an array when provided.", path: "config.json" });
    } else {
      for (const capability of config.capabilities) {
        if (typeof capability !== "string" || !PROJECT_AGENT_CAPABILITIES.includes(capability as ProjectAgentCapability)) {
          problems.push({ code: "capability_unknown", message: `Unknown project agent capability: ${String(capability)}`, path: "config.json" });
        }
      }
    }
  }
  if (config.model !== undefined && !isAgentModelDescriptor(config.model)) {
    problems.push({ code: "model_invalid", message: "config.json model must include provider, modelId, and thinkingLevel strings when provided.", path: "config.json" });
  }
}

async function readReferenceDocs(dirPath: string): Promise<{ docs: Array<{ path: string; content: string; sha256: string }>; problems: ProjectAgentSourceProblem[] }> {
  const referenceDir = join(dirPath, "reference");
  const problems: ProjectAgentSourceProblem[] = [];
  const docs: Array<{ path: string; content: string; sha256: string }> = [];
  const referenceStats = await lstat(referenceDir).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!referenceStats) {
    return { docs, problems };
  }
  if (referenceStats.isSymbolicLink() || !referenceStats.isDirectory()) {
    problems.push({ code: "reference_root_invalid", message: "reference must be a real directory when provided.", path: "reference" });
    return { docs, problems };
  }

  const entriesResult = await readDirectoryEntries(referenceDir, "reference");
  problems.push(...entriesResult.problems);
  if (entriesResult.problems.length > 0) {
    return { docs, problems };
  }

  const entries = entriesResult.entries;
  let totalBytes = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(referenceDir, entry.name);
    const relativePath = join("reference", entry.name);
    if (entry.isSymbolicLink()) {
      problems.push({ code: "reference_symlink", message: "Reference markdown files must not be symlinks.", path: relativePath });
      continue;
    }
    if (entry.isDirectory()) {
      problems.push({ code: "reference_nested", message: "Project agent references must be flat markdown files directly under reference/.", path: relativePath });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (extname(entry.name).toLowerCase() !== ".md") {
      continue;
    }
    if (docs.length >= MAX_REFERENCE_FILES) {
      problems.push({ code: "reference_count_limit", message: `At most ${MAX_REFERENCE_FILES} reference markdown files are allowed.`, path: "reference" });
      break;
    }
    validatePathSegment("reference", entry.name, problems, relativePath);
    const contentResult = await readLimitedText(entryPath, MAX_REFERENCE_BYTES, relativePath);
    problems.push(...contentResult.problems);
    if (contentResult.content === undefined) {
      continue;
    }
    totalBytes += Buffer.byteLength(contentResult.content, "utf8");
    if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
      problems.push({ code: "reference_total_size_limit", message: `Reference markdown files must total ${MAX_TOTAL_REFERENCE_BYTES} bytes or fewer.`, path: "reference" });
      break;
    }
    docs.push({ path: entry.name, content: contentResult.content, sha256: sha256(contentResult.content) });
  }
  return { docs, problems };
}

async function readDirectoryEntries(path: string, relativePath: string): Promise<{ entries: Dirent[]; problems: ProjectAgentSourceProblem[] }> {
  try {
    return { entries: await readdir(path, { withFileTypes: true }), problems: [] };
  } catch (error) {
    if (isEnoentError(error)) {
      return { entries: [], problems: [] };
    }
    return {
      entries: [],
      problems: [
        {
          code: "directory_readdir_failed",
          message: error instanceof Error ? error.message : `Unable to read directory: ${relativePath}`,
          path: relativePath
        }
      ]
    };
  }
}

async function readLimitedText(path: string, maxBytes: number, relativePath: string): Promise<{ content?: string; problems: ProjectAgentSourceProblem[] }> {
  const problems: ProjectAgentSourceProblem[] = [];
  const stats = await lstat(path).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!stats) {
    problems.push({ code: "file_missing", message: `${relativePath} is required.`, path: relativePath });
    return { problems };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    problems.push({ code: "file_invalid", message: `${relativePath} must be a real file, not a symlink or directory.`, path: relativePath });
    return { problems };
  }
  if (stats.size > maxBytes) {
    problems.push({ code: "file_too_large", message: `${relativePath} must be ${maxBytes} bytes or fewer.`, path: relativePath });
    return { problems };
  }
  try {
    return { content: await readFile(path, "utf-8"), problems };
  } catch (error) {
    problems.push({
      code: "file_read_failed",
      message: error instanceof Error ? error.message : `Unable to read ${relativePath}.`,
      path: relativePath
    });
    return { problems };
  }
}

function validateDefinitionId(definitionId: string, problems: ProjectAgentSourceProblem[]): void {
  validatePathSegment("definitionId", definitionId, problems, definitionId);
  if (normalizeProjectAgentHandle(definitionId) !== definitionId) {
    problems.push({ code: "definitionId_unsanitized", message: "definitionId must be lowercase letters, numbers, and dashes.", path: definitionId });
  }
}

function validatePathSegment(label: string, segment: string, problems: ProjectAgentSourceProblem[], problemPath: string): void {
  try {
    if (sanitizePathSegment(segment) !== segment) {
      problems.push({ code: `${label}_unsanitized`, message: `${label} must already be sanitized.`, path: problemPath });
    }
  } catch (error) {
    problems.push({ code: `${label}_invalid`, message: error instanceof Error ? error.message : `${label} is invalid.`, path: problemPath });
  }
}

function normalizeCapabilities(value: ProjectAgentCapability[] | undefined): ProjectAgentCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((capability) => PROJECT_AGENT_CAPABILITIES.includes(capability)))).sort(
    (left, right) => PROJECT_AGENT_CAPABILITIES.indexOf(left) - PROJECT_AGENT_CAPABILITIES.indexOf(right)
  );
}

function createDefinitionSignature(options: {
  definitionId: string;
  config?: string;
  prompt?: string;
  references: Array<{ path: string; content: string; sha256: string }>;
  problems: ProjectAgentSourceProblem[];
}): string {
  return sha256(
    JSON.stringify({
      version: 1,
      definitionId: options.definitionId,
      config: options.config ?? null,
      prompt: options.prompt ?? null,
      references: options.references.map((doc) => ({ path: doc.path, sha256: doc.sha256 })).sort((left, right) => left.path.localeCompare(right.path)),
      problems: options.problems.map((problem) => ({ code: problem.code, message: problem.message, path: problem.path ?? null })).sort((left, right) => `${left.path}:${left.code}:${left.message}`.localeCompare(`${right.path}:${right.code}:${right.message}`))
    })
  );
}

function createConflictSignature(
  previousSignature: string | undefined,
  problem: ProjectAgentSourceProblem,
  duplicateIds: string[]
): string {
  return sha256(JSON.stringify({ version: 1, previousSignature: previousSignature ?? null, problem, duplicateIds }));
}

function buildInvalidItem(
  rootDir: string,
  definitionId: string,
  dirPath: string,
  problems: ProjectAgentSourceProblem[]
): RepoProjectAgentInventoryItem & { signature: string } {
  return {
    definitionId,
    handle: definitionId,
    path: relative(rootDir, dirPath) || ".",
    status: "invalid",
    problems,
    signature: createDefinitionSignature({ definitionId, references: [], problems })
  };
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isAgentModelDescriptor(value: unknown): value is AgentModelDescriptor {
  return isRecord(value) && typeof value.provider === "string" && typeof value.modelId === "string" && typeof value.thinkingLevel === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
