import { access, copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type { ResolvedSpecialistDefinition } from "@forge/protocol";
import {
  MODEL_PRESET_DESCRIPTORS,
  isSwarmModelPreset,
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

const rosterCache = new Map<string, ResolvedSpecialistDefinition[]>();

export interface SpecialistFrontmatter {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  model: string;
  reasoningLevel?: string;
  builtin: boolean;
}

export interface SaveSpecialistRequest {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  model: string;
  reasoningLevel?: string;
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
    const model = s.reasoningLevel ? `${s.model} ${s.reasoningLevel}` : s.model;
    lines.push(`- \`${s.specialistId}\`: ${s.whenToUse} [${model}]`);
  }

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

    const mergedFrontmatter: SpecialistFrontmatter = {
      ...source.frontmatter,
      enabled: existing.frontmatter.enabled,
    };

    await writeSpecialistFile(destinationPath, serializeSpecialistFile(mergedFrontmatter, source.body));
  }

  invalidateSpecialistCache();
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
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  invalidateSpecialistCache(normalizedProfileId);
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
  const displayName = parseRequiredString(frontmatterValues, "displayName");
  const color = parseRequiredString(frontmatterValues, "color");
  const whenToUse = parseRequiredString(frontmatterValues, "whenToUse");
  const model = parseRequiredString(frontmatterValues, "model");

  if (!displayName || !color || !whenToUse || !model) {
    return null;
  }

  if (!HEX_COLOR_PATTERN.test(color)) {
    return null;
  }

  const enabled = parseOptionalBoolean(frontmatterValues.enabled);
  const builtin = parseOptionalBoolean(frontmatterValues.builtin);

  if (frontmatterValues.enabled !== undefined && enabled === undefined) {
    return null;
  }

  if (frontmatterValues.builtin !== undefined && builtin === undefined) {
    return null;
  }

  const reasoningLevel = parseOptionalString(frontmatterValues.reasoningLevel);
  if (reasoningLevel && !isSwarmReasoningLevel(reasoningLevel)) {
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
      model,
      reasoningLevel,
      builtin: builtin ?? false,
    },
    body,
  };
}

function validateSaveRequest(data: SaveSpecialistRequest): SpecialistFrontmatter {
  const displayName = data.displayName.trim();
  const color = data.color.trim();
  const whenToUse = data.whenToUse.trim();
  const model = data.model.trim();
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

  if (!promptBody) {
    throw new Error("promptBody is required");
  }

  if (!isSwarmModelPreset(model)) {
    throw new Error(`model must be one of ${Object.keys(MODEL_PRESET_DESCRIPTORS).join("|")}`);
  }

  const reasoningLevel = data.reasoningLevel?.trim();
  if (reasoningLevel !== undefined && reasoningLevel.length > 0 && !isSwarmReasoningLevel(reasoningLevel)) {
    throw new Error("reasoningLevel must be one of none|low|medium|high|xhigh");
  }

  return {
    displayName,
    color,
    enabled: data.enabled,
    whenToUse,
    model,
    reasoningLevel: reasoningLevel && reasoningLevel.length > 0 ? reasoningLevel : undefined,
    builtin: false,
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

function toResolvedSpecialistDefinition(options: {
  specialistId: string;
  frontmatter: SpecialistFrontmatter;
  body: string;
  sourceKind: "builtin" | "global" | "profile";
  sourcePath: string;
  shadowsGlobal: boolean;
}): ResolvedSpecialistDefinition {
  const knownModel = options.frontmatter.model in MODEL_PRESET_DESCRIPTORS;

  return {
    specialistId: options.specialistId,
    displayName: options.frontmatter.displayName,
    color: options.frontmatter.color,
    enabled: options.frontmatter.enabled,
    whenToUse: options.frontmatter.whenToUse,
    model: options.frontmatter.model,
    reasoningLevel: options.frontmatter.reasoningLevel,
    builtin: options.frontmatter.builtin,
    promptBody: options.body,
    sourceKind: options.sourceKind,
    sourcePath: options.sourcePath,
    available: knownModel,
    availabilityCode: knownModel ? "ok" : "invalid_model",
    availabilityMessage: knownModel ? undefined : `Unknown model preset: ${options.frontmatter.model}`,
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
    `model: ${quoteYamlString(frontmatter.model)}`,
  ];

  if (frontmatter.reasoningLevel) {
    lines.push(`reasoningLevel: ${quoteYamlString(frontmatter.reasoningLevel)}`);
  }

  if (frontmatter.builtin) {
    lines.push("builtin: true");
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
