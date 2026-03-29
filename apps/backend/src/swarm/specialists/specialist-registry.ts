import { access, copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type { ResolvedSpecialistDefinition } from "@forge/protocol";
import {
  MODEL_PRESET_DESCRIPTORS,
  inferProviderFromModelId,
  isKnownModelId,
  isSwarmReasoningLevel,
} from "../model-presets.js";
import { sanitizePathSegment } from "../data-paths.js";
import {
  getBuiltinSpecialistsDir,
  getProfileSpecialistsDir,
  getSharedSpecialistsDir,
} from "./specialist-paths.js";

const FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CACHE_KEY_SEPARATOR = "\u0000";
const SPECIALISTS_ENABLED_FILENAME = "specialists-enabled.json";

/**
 * Legacy model routing guidance injected into the manager prompt when specialists are disabled.
 * Extracted from the pre-specialists manager archetype.
 */
export const LEGACY_MODEL_ROUTING_GUIDANCE = `Model and reasoning selection for workers:
- spawn_agent accepts optional \`model\`, \`modelId\`, and \`reasoningLevel\` to tune cost, speed, and capability per worker.
- Available model presets: \`pi-codex\` (\`gpt-5.3-codex\`), \`pi-5.4\` (\`gpt-5.4\`), \`pi-opus\` (\`claude-opus-4-6\`), \`pi-grok\` (\`grok-4\`), and \`codex-app\` (\`default\` on openai-codex-app-server).
- Think in three tiers when assigning work:
  1. **Quick/cheap** — file reads, searches, command runs, simple edits. Use \`modelId: "gpt-5.3-codex-spark"\` or \`modelId: "claude-haiku-4-5-20251001"\` with \`reasoningLevel: "low"\`. Fast, minimal cost.
  2. **Standard** — normal implementation, moderate complexity. Use preset defaults with no overrides. This is the baseline and needs no tuning.
  3. **Complex** — architecture, thorough code review, debugging subtle issues. Choose the model explicitly (e.g., \`model: "pi-5.4"\` for heavy coding tasks, \`model: "pi-opus"\` for nuanced review).
- The primary optimization lever is **model selection**, not reasoning level. A haiku worker costs a fraction of opus; a spark worker is ultra-fast. Use cheaper models for sub-tasks and exploration.
- Reasoning level defaults are already high for all presets. Lower it for quick tasks; raising it further is rarely needed.
- Cross-provider strengths: Codex models tend to excel at backend/algorithmic work. Claude models shine at UI polish, nuanced code review, and writing. Mix them on the same project like specialists on a team.`;

const rosterCache = new Map<string, ResolvedSpecialistDefinition[]>();

export interface SpecialistFrontmatter {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  reasoningLevel?: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: string;
  builtin: boolean;
  pinned: boolean;
  webSearch: boolean;
}

export interface SaveSpecialistRequest {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  reasoningLevel?: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: string;
  pinned?: boolean;
  webSearch?: boolean;
  promptBody: string;
}

interface ParsedSpecialistFile {
  frontmatter: SpecialistFrontmatter;
  body: string;
}

export async function parseSpecialistFile(filePath: string): Promise<ParsedSpecialistFile | null> {
  let markdown: string;
  try {
    markdown = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }

  return parseSpecialistMarkdown(markdown);
}

export async function resolveRoster(profileId: string, dataDir: string): Promise<ResolvedSpecialistDefinition[]> {
  const normalizedProfileId = sanitizePathSegment(profileId);
  const cacheKey = getRosterCacheKey(dataDir, normalizedProfileId);
  const cached = rosterCache.get(cacheKey);
  if (cached) {
    return cloneRosterEntries(cached);
  }

  const sharedDir = getSharedSpecialistsDir(dataDir);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);

  const [sharedByHandle, profileByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared"),
    resolveDirectorySpecialists(profileDir, "profile"),
  ]);

  const allHandles = [...new Set([...sharedByHandle.keys(), ...profileByHandle.keys()])].sort();
  const resolved: ResolvedSpecialistDefinition[] = [];

  for (const handle of allHandles) {
    const profileEntry = profileByHandle.get(handle);
    if (profileEntry) {
      resolved.push({ ...profileEntry, shadowsGlobal: sharedByHandle.has(handle) });
      continue;
    }

    const sharedEntry = sharedByHandle.get(handle);
    if (sharedEntry) {
      resolved.push(sharedEntry);
    }
  }

  rosterCache.set(cacheKey, cloneRosterEntries(resolved));
  return cloneRosterEntries(resolved);
}

async function resolveDirectorySpecialists(
  directoryPath: string,
  scope: "shared" | "profile",
): Promise<Map<string, ResolvedSpecialistDefinition>> {
  const files = await listMarkdownFiles(directoryPath);
  const handles = files
    .map((file) => ({
      file,
      handle: normalizeSpecialistHandle(file.name.slice(0, -3)),
    }))
    .filter((entry): entry is { file: Dirent; handle: string } => entry.handle.length > 0);

  const parsedEntries = await Promise.all(
    handles.map(async ({ file, handle }) => {
      const filePath = join(directoryPath, file.name);
      const parsed = await parseSpecialistFile(filePath);
      if (!parsed) {
        return null;
      }

      return {
        handle,
        definition: toResolvedSpecialistDefinition({
          specialistId: handle,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          sourceKind:
            scope === "profile"
              ? "profile"
              : parsed.frontmatter.builtin
                ? "builtin"
                : "global",
          sourcePath: filePath,
          shadowsGlobal: false,
        }),
      };
    }),
  );

  const byHandle = new Map<string, ResolvedSpecialistDefinition>();
  for (const entry of parsedEntries) {
    if (!entry) {
      continue;
    }

    byHandle.set(entry.handle, entry.definition);
  }

  return byHandle;
}

function cloneRosterEntries(roster: ResolvedSpecialistDefinition[]): ResolvedSpecialistDefinition[] {
  return roster.map((entry) => ({ ...entry }));
}

function getRosterCacheKey(dataDir: string, profileId: string): string {
  return `${dataDir}${CACHE_KEY_SEPARATOR}${profileId}`;
}

export function generateRosterBlock(roster: ResolvedSpecialistDefinition[]): string {
  const available = roster.filter((entry) => entry.enabled && entry.available);

  if (available.length === 0) {
    return "Named specialist workers: none configured. Use ad-hoc spawn_agent parameters for worker delegation.";
  }

  const lines = [
    "Named specialist workers — use `spawn_agent({ specialist: \"<handle>\" })` for standard delegation.",
    "Use ad-hoc model/reasoning/prompt params only when no specialist fits.",
    "",
  ];

  for (const s of available) {
    const primary = s.reasoningLevel
      ? `${s.provider}/${s.modelId} ${s.reasoningLevel}`
      : `${s.provider}/${s.modelId}`;
    const fallback = s.fallbackModelId
      ? ` -> fallback ${(s.fallbackProvider ?? "unknown")}/${s.fallbackModelId}${
          s.fallbackReasoningLevel ? ` ${s.fallbackReasoningLevel}` : ""
        }`
      : "";
    const webSearchTag = s.webSearch ? " [web search]" : "";
    lines.push(`- \`${s.specialistId}\`: ${s.whenToUse} [${primary}${fallback}]${webSearchTag}`);
  }

  lines.push(
    "",
    "Routing guidance:",
    "- For dual-model code reviews, use both code-reviewer and code-reviewer-2 for complementary correctness + design perspectives.",
    "- For quick investigations or simple tasks, prefer scout to avoid heavyweight model costs.",
    "- For research or analysis fan-outs, mix specialists across different models for diverse perspectives.",
    "- If no specialist fits the task, fall back to ad-hoc spawn_agent with explicit model/reasoning params.",
  );

  return lines.join("\n");
}

export async function seedBuiltins(dataDir: string): Promise<void> {
  const builtinDir = getBuiltinSpecialistsDir();
  const sharedDir = getSharedSpecialistsDir(dataDir);

  await mkdir(sharedDir, { recursive: true });

  const builtinFiles = await listMarkdownFiles(builtinDir);

  for (const file of builtinFiles) {
    const sourcePath = join(builtinDir, file.name);
    const destinationPath = join(sharedDir, file.name);
    const source = await parseSpecialistFile(sourcePath);

    if (!source) {
      throw new Error(`Invalid builtin specialist source file: ${sourcePath}`);
    }

    const destinationExists = await pathExists(destinationPath);
    if (!destinationExists) {
      await copyFile(sourcePath, destinationPath);
      continue;
    }

    const existing = await parseSpecialistFile(destinationPath);
    if (!existing) {
      await writeSpecialistFile(destinationPath, serializeSpecialistFile(source.frontmatter, source.body));
      continue;
    }

    if (existing.frontmatter.builtin !== true) {
      continue;
    }

    if (existing.frontmatter.pinned === true) {
      continue;
    }

    const mergedFrontmatter: SpecialistFrontmatter = {
      ...source.frontmatter,
      enabled: existing.frontmatter.enabled,
      pinned: existing.frontmatter.pinned,
    };

    await writeSpecialistFile(destinationPath, serializeSpecialistFile(mergedFrontmatter, source.body));
  }

  invalidateSpecialistCache();
}

export async function getSpecialistsEnabled(dataDir: string): Promise<boolean> {
  const filePath = join(getSharedSpecialistsDir(dataDir), SPECIALISTS_ENABLED_FILENAME);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled !== false;
  } catch (error) {
    if (isEnoentError(error)) {
      return true;
    }

    throw error;
  }
}

export async function setSpecialistsEnabled(dataDir: string, enabled: boolean): Promise<void> {
  const dir = getSharedSpecialistsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, SPECIALISTS_ENABLED_FILENAME);
  const tempPath = `${filePath}.tmp-${randomUUID()}`;

  try {
    await writeFile(tempPath, JSON.stringify({ enabled }, null, 2) + "\n", "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

export async function saveProfileSpecialist(
  dataDir: string,
  profileId: string,
  handle: string,
  data: SaveSpecialistRequest,
): Promise<void> {
  const normalizedProfileId = sanitizePathSegment(profileId);
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const frontmatter = validateSaveRequest(data);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);
  const filePath = join(profileDir, `${sanitizePathSegment(specialistId)}.md`);

  await mkdir(profileDir, { recursive: true });
  await writeSpecialistFile(filePath, serializeSpecialistFile(frontmatter, data.promptBody));

  invalidateSpecialistCache(normalizedProfileId);
}

export async function deleteProfileSpecialist(dataDir: string, profileId: string, handle: string): Promise<void> {
  const normalizedProfileId = sanitizePathSegment(profileId);
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const filePath = join(
    getProfileSpecialistsDir(dataDir, normalizedProfileId),
    `${sanitizePathSegment(specialistId)}.md`,
  );

  try {
    await unlink(filePath);
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(`Unknown specialist: ${specialistId}`);
    }

    throw error;
  }

  invalidateSpecialistCache(normalizedProfileId);
}

export async function resolveSharedRoster(dataDir: string): Promise<ResolvedSpecialistDefinition[]> {
  const sharedDir = getSharedSpecialistsDir(dataDir);
  const byHandle = await resolveDirectorySpecialists(sharedDir, "shared");
  const sorted = [...byHandle.values()].sort((a, b) => a.specialistId.localeCompare(b.specialistId));
  return sorted;
}

export async function saveSharedSpecialist(
  dataDir: string,
  handle: string,
  data: SaveSpecialistRequest,
): Promise<void> {
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const frontmatter = validateSaveRequest(data);
  const sharedDir = getSharedSpecialistsDir(dataDir);
  const filePath = join(sharedDir, `${sanitizePathSegment(specialistId)}.md`);

  // Preserve builtin flag if the file already exists as a builtin
  const existing = await parseSpecialistFile(filePath);
  if (existing && existing.frontmatter.builtin) {
    frontmatter.builtin = true;
  }

  await mkdir(sharedDir, { recursive: true });
  await writeSpecialistFile(filePath, serializeSpecialistFile(frontmatter, data.promptBody));

  invalidateSpecialistCache();
}

export async function deleteSharedSpecialist(dataDir: string, handle: string): Promise<void> {
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const sharedDir = getSharedSpecialistsDir(dataDir);
  const filePath = join(sharedDir, `${sanitizePathSegment(specialistId)}.md`);

  const existing = await parseSpecialistFile(filePath);
  if (!existing) {
    throw new Error(`Unknown specialist: ${specialistId}`);
  }

  if (existing.frontmatter.builtin) {
    throw new Error(`Cannot delete builtin specialist: ${specialistId}`);
  }

  await unlink(filePath);
  invalidateSpecialistCache();
}

export async function getWorkerTemplate(): Promise<string> {
  const builtinDir = getBuiltinSpecialistsDir();
  // Go up from builtins to archetypes/builtins/worker.md
  const workerMdPath = join(builtinDir, "..", "..", "archetypes", "builtins", "worker.md");
  try {
    return await readFile(workerMdPath, "utf8");
  } catch {
    // Fallback minimal template
    return [
      "You are a worker agent in a swarm.",
      "- You can list agents and send messages to other agents.",
      "- Use coding tools (read/bash/edit/write) to execute implementation tasks.",
      "- Report progress and outcomes back to the manager using send_message_to_agent.",
      "- You are not user-facing.",
    ].join("\n");
  }
}

export function invalidateSpecialistCache(profileId?: string): void {
  if (!profileId) {
    rosterCache.clear();
    return;
  }

  const normalizedProfileId = sanitizePathSegment(profileId);
  for (const key of rosterCache.keys()) {
    if (key.endsWith(`${CACHE_KEY_SEPARATOR}${normalizedProfileId}`)) {
      rosterCache.delete(key);
    }
  }
}

function parseSpecialistMarkdown(markdown: string): ParsedSpecialistFile | null {
  const normalizedMarkdown = markdown.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_BLOCK_PATTERN.exec(normalizedMarkdown);
  if (!match) {
    return null;
  }

  const frontmatterValues = parseFrontmatterValues(match[1]);

  // Backward compatibility: migrate legacy preset-based frontmatter (`model`) to `modelId`.
  const legacyModelPreset = parseOptionalString(frontmatterValues.model);
  if (legacyModelPreset && !frontmatterValues.modelId) {
    const preset = MODEL_PRESET_DESCRIPTORS[legacyModelPreset as keyof typeof MODEL_PRESET_DESCRIPTORS];
    if (preset) {
      frontmatterValues.modelId = preset.modelId;
    }
  }

  const displayName = parseRequiredString(frontmatterValues, "displayName");
  const color = parseRequiredString(frontmatterValues, "color");
  const whenToUse = parseRequiredString(frontmatterValues, "whenToUse");
  const modelId = parseRequiredString(frontmatterValues, "modelId");

  if (!displayName || !color || !whenToUse || !modelId) {
    return null;
  }

  if (!HEX_COLOR_PATTERN.test(color)) {
    return null;
  }

  const enabled = parseOptionalBoolean(frontmatterValues.enabled);
  const builtin = parseOptionalBoolean(frontmatterValues.builtin);
  const pinned = parseOptionalBoolean(frontmatterValues.pinned);
  const webSearch = parseOptionalBoolean(frontmatterValues.webSearch);

  if (frontmatterValues.enabled !== undefined && enabled === undefined) {
    return null;
  }

  if (frontmatterValues.builtin !== undefined && builtin === undefined) {
    return null;
  }

  if (frontmatterValues.pinned !== undefined && pinned === undefined) {
    return null;
  }

  if (frontmatterValues.webSearch !== undefined && webSearch === undefined) {
    return null;
  }

  const reasoningLevel = parseOptionalString(frontmatterValues.reasoningLevel);
  if (reasoningLevel && !isSwarmReasoningLevel(reasoningLevel)) {
    return null;
  }

  const fallbackModelId = parseOptionalString(frontmatterValues.fallbackModelId);
  const fallbackReasoningLevel = parseOptionalString(frontmatterValues.fallbackReasoningLevel);
  if (fallbackReasoningLevel && !isSwarmReasoningLevel(fallbackReasoningLevel)) {
    return null;
  }

  const body = normalizedMarkdown.slice(match[0].length).trim();
  if (!body) {
    return null;
  }

  return {
    frontmatter: {
      displayName,
      color,
      enabled: enabled ?? true,
      whenToUse,
      modelId,
      reasoningLevel,
      fallbackModelId,
      fallbackReasoningLevel,
      builtin: builtin ?? false,
      pinned: pinned ?? false,
      webSearch: webSearch ?? false,
    },
    body,
  };
}

function validateSaveRequest(data: SaveSpecialistRequest): SpecialistFrontmatter {
  const displayName = data.displayName.trim();
  const color = data.color.trim();
  const whenToUse = data.whenToUse.trim();
  const modelId = data.modelId.trim();
  const fallbackModelId = data.fallbackModelId?.trim();
  const promptBody = data.promptBody.trim();

  if (!displayName) {
    throw new Error("displayName is required");
  }

  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new Error("color must be a hex color in #RRGGBB format");
  }

  if (!whenToUse) {
    throw new Error("whenToUse is required");
  }

  if (!modelId) {
    throw new Error("modelId is required");
  }

  if (!promptBody) {
    throw new Error("promptBody is required");
  }

  const reasoningLevel = data.reasoningLevel?.trim();
  if (reasoningLevel !== undefined && reasoningLevel.length > 0 && !isSwarmReasoningLevel(reasoningLevel)) {
    throw new Error("reasoningLevel must be one of none|low|medium|high|xhigh");
  }

  const normalizedFallbackModelId = fallbackModelId && fallbackModelId.length > 0 ? fallbackModelId : undefined;

  const fallbackReasoningLevel = data.fallbackReasoningLevel?.trim();
  if (
    fallbackReasoningLevel !== undefined &&
    fallbackReasoningLevel.length > 0 &&
    !isSwarmReasoningLevel(fallbackReasoningLevel)
  ) {
    throw new Error("fallbackReasoningLevel must be one of none|low|medium|high|xhigh");
  }

  // Strip fallback reasoning level when there's no fallback model — it has no effect without one.
  const normalizedFallbackReasoningLevel =
    normalizedFallbackModelId && fallbackReasoningLevel && fallbackReasoningLevel.length > 0
      ? fallbackReasoningLevel
      : undefined;

  return {
    displayName,
    color,
    enabled: data.enabled,
    whenToUse,
    modelId,
    reasoningLevel: reasoningLevel && reasoningLevel.length > 0 ? reasoningLevel : undefined,
    fallbackModelId: normalizedFallbackModelId,
    fallbackReasoningLevel: normalizedFallbackReasoningLevel,
    builtin: false,
    pinned: data.pinned ?? false,
    webSearch: normalizeWebSearchForModelId(modelId, data.webSearch === true),
  };
}

function parseFrontmatterValues(rawFrontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = rawFrontmatter.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    values[key] = parseYamlStringValue(value);
  }

  return values;
}

function parseRequiredString(values: Record<string, string>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeWebSearchForModelId(modelId: string, webSearch: boolean): boolean {
  return webSearch && inferProviderFromModelId(modelId) === "xai";
}

function toResolvedSpecialistDefinition(options: {
  specialistId: string;
  frontmatter: SpecialistFrontmatter;
  body: string;
  sourceKind: "builtin" | "global" | "profile";
  sourcePath: string;
  shadowsGlobal: boolean;
}): ResolvedSpecialistDefinition {
  const knownPrimaryModel = isKnownModelId(options.frontmatter.modelId);
  const knownFallbackModel =
    !options.frontmatter.fallbackModelId || isKnownModelId(options.frontmatter.fallbackModelId);

  const provider = inferProviderFromModelId(options.frontmatter.modelId) ?? "unknown";
  const fallbackProvider = options.frontmatter.fallbackModelId
    ? (inferProviderFromModelId(options.frontmatter.fallbackModelId) ?? undefined)
    : undefined;

  let availabilityCode: "ok" | "invalid_model" = "ok";
  let availabilityMessage: string | undefined;

  if (!knownPrimaryModel) {
    availabilityCode = "invalid_model";
    availabilityMessage = `Unknown modelId: ${options.frontmatter.modelId}`;
  } else if (!knownFallbackModel && options.frontmatter.fallbackModelId) {
    availabilityCode = "invalid_model";
    availabilityMessage = `Unknown fallbackModelId: ${options.frontmatter.fallbackModelId}`;
  }

  const webSearch = normalizeWebSearchForModelId(options.frontmatter.modelId, options.frontmatter.webSearch);

  return {
    specialistId: options.specialistId,
    displayName: options.frontmatter.displayName,
    color: options.frontmatter.color,
    enabled: options.frontmatter.enabled,
    whenToUse: options.frontmatter.whenToUse,
    modelId: options.frontmatter.modelId,
    provider,
    reasoningLevel: options.frontmatter.reasoningLevel,
    fallbackModelId: options.frontmatter.fallbackModelId,
    fallbackProvider,
    fallbackReasoningLevel: options.frontmatter.fallbackReasoningLevel,
    builtin: options.frontmatter.builtin,
    pinned: options.frontmatter.pinned,
    webSearch,
    promptBody: options.body,
    sourceKind: options.sourceKind,
    sourcePath: options.sourcePath,
    available: availabilityCode === "ok",
    availabilityCode,
    availabilityMessage,
    shadowsGlobal: options.shadowsGlobal,
  };
}

function serializeSpecialistFile(frontmatter: SpecialistFrontmatter, body: string): string {
  const lines = [
    "---",
    `displayName: ${quoteYamlString(frontmatter.displayName)}`,
    `color: ${quoteYamlString(frontmatter.color)}`,
    `enabled: ${frontmatter.enabled ? "true" : "false"}`,
    `whenToUse: ${quoteYamlString(frontmatter.whenToUse)}`,
    `modelId: ${quoteYamlString(frontmatter.modelId)}`,
  ];

  if (frontmatter.reasoningLevel) {
    lines.push(`reasoningLevel: ${quoteYamlString(frontmatter.reasoningLevel)}`);
  }

  if (frontmatter.fallbackModelId) {
    lines.push(`fallbackModelId: ${quoteYamlString(frontmatter.fallbackModelId)}`);

    if (frontmatter.fallbackReasoningLevel) {
      lines.push(`fallbackReasoningLevel: ${quoteYamlString(frontmatter.fallbackReasoningLevel)}`);
    }
  }

  if (frontmatter.builtin) {
    lines.push("builtin: true");
  }

  if (frontmatter.pinned) {
    lines.push("pinned: true");
  }

  if (frontmatter.webSearch) {
    lines.push("webSearch: true");
  }

  lines.push("---", "", body.trim(), "");

  return lines.join("\n");
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

async function writeSpecialistFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomUUID()}`;

  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup for failed temp writes.
    }
    throw error;
  }
}

async function listMarkdownFiles(directoryPath: string): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingOrNonDirectoryError(error)) {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeSpecialistHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingOrNonDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code ?? "")
  );
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
