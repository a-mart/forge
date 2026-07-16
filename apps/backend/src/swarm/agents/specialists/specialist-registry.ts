import { access, copyFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { isEnoentError, isNotDirLikeMissingError } from "../../../utils/fs-errors.js";
import { writeFileAtomic, writeJsonFileAtomic } from "../../../utils/atomic-files.js";
import type { RuntimeTarget } from "../../../runtime-target.js";
import {
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModelsByFamily,
  type EffortTier,
  type ResolvedSpecialistDefinition,
  type SpecialistTargetSpace,
  type TierConfig,
} from "@forge/protocol";
import {
  inferProviderFromModelId,
  isSwarmReasoningLevel,
  normalizeCursorSdkThinkingLevel,
  resolveModelDescriptorFromPreset,
  resolveRemovedSwarmModelPresetAlias,
} from "../../model-presets.js";
import { modelCatalogService } from "../../model-catalog-service.js";
import { sanitizePathSegment } from "../../data-paths.js";
import {
  getBuiltinSpecialistsDir,
  getProfileSpecialistsDir,
  getSessionSpecialistsDir,
  getSharedSpecialistsDir,
} from "../../specialists/specialist-paths.js";

const FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CACHE_KEY_SEPARATOR = "\u0000";
const SPECIALISTS_ENABLED_FILENAME = "specialists-enabled.json";
const TIER_CONFIGS_FILENAME = "tier-configs.json";
const REMOVED_BUILTIN_SPECIALIST_FILES = new Set([
  "app-runtime.md",
  "backend.md",
  "frontend.md",
  "doc-writer.md",
  "web-researcher.md",
  "scout.md",
  "cursor-builder.md",
  "collab-planner.md",
  "collab-reviewer.md",
  "collab-doc-writer.md",
  "collab-scout.md",
  "collab-researcher.md",
]);
export const SPECIALIST_TARGET_SPACE_FRONTMATTER_KEY = "TargetSpace";
const LEGACY_SPECIALIST_TARGET_SPACE_FRONTMATTER_KEY = "targetSpace";
const DEFAULT_SPECIALIST_TARGET_SPACE: SpecialistTargetSpace[] = ["builder"];

export const EFFORT_TIER_ORDER = ["light", "fast", "standard", "deep", "max"] as const satisfies readonly EffortTier[];

export const DEFAULT_TIER_CONFIGS: Record<EffortTier, TierConfig> = {
  light: {
    tier: "light",
    displayName: "Light",
    description: "Cheap lookups, quick reads, simple edits, and lightweight checks.",
    color: "#6b7280",
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    reasoningLevel: "low",
    fallbackProvider: "openai-codex",
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "low",
  },
  fast: {
    tier: "fast",
    displayName: "Fast",
    description: "Capable low-latency executor for well-specified implementation tasks.",
    color: "#2563eb",
    provider: "cursor-sdk",
    modelId: "composer-2.5",
    reasoningLevel: "none",
    fallbackProvider: "openai-codex",
    fallbackModelId: "gpt-5.4",
    fallbackReasoningLevel: "high",
  },
  standard: {
    tier: "standard",
    displayName: "Standard",
    description: "Default balanced tier for ordinary implementation, research, and review.",
    color: "#7c3aed",
    provider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "medium",
    fallbackProvider: "openai-codex",
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "medium",
  },
  deep: {
    tier: "deep",
    displayName: "Deep",
    description: "Thorough planning, non-trivial design, and careful review/debugging.",
    color: "#10b981",
    provider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "high",
    fallbackProvider: "openai-codex",
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "medium",
  },
  max: {
    tier: "max",
    displayName: "Max",
    description: "Architecture, high-risk refactors, and the hardest debugging tasks.",
    color: "#f59e0b",
    provider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "xhigh",
    fallbackProvider: "openai-codex",
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "medium",
  },
};
const TIER_ROSTER_DESCRIPTIONS: Record<EffortTier, string> = {
  light: "quick checks/simple edits",
  fast: "low-latency implementation",
  standard: "balanced default work",
  deep: "planning/review/debugging",
  max: "architecture/high-risk debugging",
};

export interface LegacySpecialistRewrite {
  tier: EffortTier;
  lens?: string;
}

export const LEGACY_SPECIALIST_REWRITE_TABLE: Record<string, LegacySpecialistRewrite> = {
  architect: { tier: "max", lens: "architect" },
  planner: { tier: "deep", lens: "planner" },
  "code-reviewer": { tier: "deep", lens: "code-reviewer" },
  "code-reviewer-2": { tier: "deep", lens: "code-reviewer-2" },
  researcher: { tier: "standard", lens: "researcher" },
  "web-researcher": { tier: "standard", lens: "researcher" },
  "codex-plugin": { tier: "standard", lens: "codex-plugin" },
  backend: { tier: "fast" },
  frontend: { tier: "fast" },
  "doc-writer": { tier: "standard" },
  scout: { tier: "light" },
  "cursor-builder": { tier: "fast" },
  "collab-planner": { tier: "deep" },
  "collab-reviewer": { tier: "deep" },
  "collab-doc-writer": { tier: "standard" },
  "collab-scout": { tier: "light" },
  "collab-researcher": { tier: "standard" },
};

function formatPresetList(entries: string[]): string {
  if (entries.length === 0) {
    return "none";
  }

  if (entries.length === 1) {
    return entries[0];
  }

  if (entries.length === 2) {
    return `${entries[0]} and ${entries[1]}`;
  }

  return `${entries.slice(0, -1).join(", ")}, and ${entries[entries.length - 1]}`;
}

function selectVariantModelId(
  familyId: string,
  matcher: (model: { modelId: string; displayName: string; isFamilyDefault: boolean }) => boolean,
): string | undefined {
  const variants = getCatalogModelsByFamily(familyId).filter((model) => !model.isFamilyDefault);
  return variants.find(matcher)?.modelId ?? variants[0]?.modelId;
}

function buildLegacyModelRoutingGuidance(): string {
  const presetList = formatPresetList(
    Object.values(FORGE_MODEL_CATALOG.families)
      .filter((family) => family.visibleInSpawnPreset)
      .map((family) => `\`${family.familyId}\` (\`${family.defaultModelId}\`)`),
  );

  const codexQuickModelId = getCatalogFamily("pi-codex-spark")?.defaultModelId ?? "gpt-5.3-codex-spark";
  const anthropicQuickModelId =
    selectVariantModelId("pi-opus", (model) => model.displayName.toLowerCase().includes("haiku")) ??
    "claude-haiku-4-5-20251001";
  const complexCodingPreset = getCatalogFamily("pi-5.5")?.familyId ?? "pi-5.5";
  const complexReviewPreset = getCatalogFamily("pi-opus")?.familyId ?? "pi-opus";

  return `Model and reasoning selection for workers:
- spawn_agent accepts optional \`model\`, \`modelId\`, and \`reasoningLevel\` to tune cost, speed, and capability per worker.
- Available model presets: ${presetList}.
- Think in three tiers when assigning work:
  1. **Quick/cheap** — file reads, searches, command runs, simple edits. Use \`modelId: "${codexQuickModelId}"\` or \`modelId: "${anthropicQuickModelId}"\` with \`reasoningLevel: "low"\`. Fast, minimal cost.
  2. **Standard** — normal implementation, moderate complexity. Use preset defaults with no overrides. This is the baseline and needs no tuning.
  3. **Complex** — architecture, thorough code review, debugging subtle issues. Choose the model explicitly (e.g., \`model: "${complexCodingPreset}"\` for heavy coding tasks, \`model: "${complexReviewPreset}"\` for nuanced review).
- The primary optimization lever is **model selection**, not reasoning level. A haiku worker costs a fraction of opus; a spark worker is ultra-fast. Use cheaper models for sub-tasks and exploration.
- Reasoning level defaults are already high for all presets. Lower it for quick tasks; raising it further is rarely needed.
- Cross-provider strengths: Codex models tend to excel at backend/algorithmic work. Claude models shine at UI polish, nuanced code review, and writing. Mix them on the same project like specialists on a team.`;
}

/**
 * Legacy model routing guidance injected into the manager prompt when specialists are disabled.
 * Extracted from the pre-specialists manager archetype.
 */
export const LEGACY_MODEL_ROUTING_GUIDANCE = buildLegacyModelRoutingGuidance();

type InternalResolvedSpecialistDefinition = ResolvedSpecialistDefinition & { forgePrecedence?: "override" };

const rosterCache = new Map<string, ResolvedSpecialistDefinition[]>();
const sharedRosterHandleCache = new Map<string, string[]>();

export interface SpecialistFrontmatter {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: string;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: string;
  builtin: boolean;
  pinned: boolean;
  webSearch: boolean;
  targetSpace: SpecialistTargetSpace[];
  defaultTier?: EffortTier;
  forgePrecedence?: "override";
}

export interface SaveSpecialistRequest {
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: string;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: string;
  pinned?: boolean;
  webSearch?: boolean;
  targetSpace?: SpecialistTargetSpace[];
  defaultTier?: EffortTier;
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

export async function resolveRoster(
  profileId: string,
  dataDir: string,
  targetSpace: SpecialistTargetSpace = "builder",
): Promise<ResolvedSpecialistDefinition[]> {
  const normalizedProfileId = sanitizePathSegment(profileId);
  const cacheKey = getRosterCacheKey({ dataDir, profileId: normalizedProfileId, targetSpace });
  const cached = rosterCache.get(cacheKey);
  if (cached) {
    return cloneRosterEntries(cached);
  }

  const sharedDir = getSharedSpecialistsDir(dataDir);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);

  const [sharedByHandle, profileByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared", targetSpace),
    resolveDirectorySpecialists(profileDir, "profile", targetSpace),
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

export async function resolveWorkspaceRoster(
  profileId: string,
  dataDir: string,
  workspaceSpecialistsDir: string | undefined,
  targetSpace: SpecialistTargetSpace = "builder",
): Promise<ResolvedSpecialistDefinition[]> {
  if (!workspaceSpecialistsDir || targetSpace === "collaboration") {
    return resolveRoster(profileId, dataDir, targetSpace);
  }

  const normalizedProfileId = sanitizePathSegment(profileId);
  const sharedDir = getSharedSpecialistsDir(dataDir);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);
  const [sharedByHandle, workspaceByHandle, profileByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared", targetSpace),
    resolveDirectorySpecialists(workspaceSpecialistsDir, "workspace", targetSpace),
    resolveDirectorySpecialists(profileDir, "profile", targetSpace),
  ]);

  const allHandles = [...new Set([...sharedByHandle.keys(), ...workspaceByHandle.keys(), ...profileByHandle.keys()])].sort();
  const resolved: ResolvedSpecialistDefinition[] = [];
  for (const handle of allHandles) {
    const profileEntry = profileByHandle.get(handle);
    if (profileEntry) {
      resolved.push({ ...profileEntry, shadowsGlobal: sharedByHandle.has(handle) });
      continue;
    }

    const workspaceEntry = workspaceByHandle.get(handle);
    const sharedEntry = sharedByHandle.get(handle);
    if (workspaceEntry && !sharedEntry) {
      resolved.push(workspaceEntry);
      continue;
    }
    if (workspaceEntry && sharedEntry && workspaceEntry.forgePrecedence === "override" && !sharedEntry.builtin) {
      resolved.push({
        ...workspaceEntry,
        shadowsGlobal: true,
        conflictWarning: "Repository specialist overrides inherited global specialist."
      });
      continue;
    }
    if (sharedEntry) {
      resolved.push(sharedEntry);
    }
  }

  return cloneRosterEntries(resolved);
}

export interface CollaborationChannelRosterOptions {
  sessionAgentId: string;
  selectedGlobalHandles: readonly string[];
}

export async function resolveCollaborationChannelRoster(
  dataDir: string,
  options: CollaborationChannelRosterOptions,
): Promise<ResolvedSpecialistDefinition[]> {
  const normalizedSessionAgentId = sanitizePathSegment(options.sessionAgentId);
  const selectedGlobalHandles = normalizeSelectedHandles(options.selectedGlobalHandles);
  const cacheKey = getRosterCacheKey({
    dataDir,
    profileId: "_collaboration",
    targetSpace: "collaboration",
    sessionAgentId: normalizedSessionAgentId,
    selectedGlobalHandles,
  });
  const cached = rosterCache.get(cacheKey);
  if (cached) {
    return cloneRosterEntries(cached);
  }

  const sharedDir = getSharedSpecialistsDir(dataDir);
  const channelDir = getSessionSpecialistsDir(dataDir, "_collaboration", normalizedSessionAgentId);
  const [sharedByHandle, channelByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared", "collaboration"),
    resolveDirectorySpecialists(channelDir, "channel"),
  ]);

  const selectedShared = new Map<string, ResolvedSpecialistDefinition>();
  for (const handle of selectedGlobalHandles) {
    const entry = sharedByHandle.get(handle);
    if (entry) {
      selectedShared.set(handle, entry);
    }
  }

  const allHandles = [...new Set([...selectedShared.keys(), ...channelByHandle.keys()])].sort();
  const resolved: ResolvedSpecialistDefinition[] = [];
  for (const handle of allHandles) {
    const channelEntry = channelByHandle.get(handle);
    if (channelEntry) {
      resolved.push({ ...channelEntry, shadowsGlobal: sharedByHandle.has(handle) });
      continue;
    }
    const sharedEntry = selectedShared.get(handle);
    if (sharedEntry) {
      resolved.push(sharedEntry);
    }
  }

  rosterCache.set(cacheKey, cloneRosterEntries(resolved));
  return cloneRosterEntries(resolved);
}

async function resolveDirectorySpecialists(
  directoryPath: string,
  scope: "shared" | "profile" | "channel" | "workspace",
  targetSpace?: SpecialistTargetSpace,
): Promise<Map<string, InternalResolvedSpecialistDefinition>> {
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
      if (!parsed || (targetSpace && !parsed.frontmatter.targetSpace.includes(targetSpace))) {
        return null;
      }
      if (REMOVED_BUILTIN_SPECIALIST_FILES.has(file.name) && parsed.frontmatter.builtin) {
        return null;
      }

      return {
        handle,
        definition: toResolvedSpecialistDefinition({
          specialistId: handle,
          frontmatter: scope === "channel"
            ? { ...parsed.frontmatter, targetSpace: ["collaboration"] }
            : parsed.frontmatter,
          body: parsed.body,
          sourceKind:
            scope === "profile"
              ? "profile"
              : scope === "channel"
                ? "channel"
                : scope === "workspace"
                  ? "workspace"
                  : parsed.frontmatter.builtin
                    ? "builtin"
                    : "global",
          sourcePath: filePath,
          shadowsGlobal: false,
        }),
      };
    }),
  );

  const byHandle = new Map<string, InternalResolvedSpecialistDefinition>();
  for (const entry of parsedEntries) {
    if (!entry) {
      continue;
    }

    byHandle.set(entry.handle, entry.definition);
  }

  return byHandle;
}

function cloneRosterEntries(roster: ResolvedSpecialistDefinition[]): ResolvedSpecialistDefinition[] {
  return roster.map(({ forgePrecedence: _forgePrecedence, ...entry }: InternalResolvedSpecialistDefinition) => ({ ...entry }));
}

function getSharedRosterHandleCacheKey(dataDir: string, targetSpace: SpecialistTargetSpace): string {
  return `${dataDir}${CACHE_KEY_SEPARATOR}${targetSpace}`;
}

async function refreshSharedRosterHandleCache(dataDir: string): Promise<void> {
  await Promise.all([
    resolveSharedRoster(dataDir, "builder"),
    resolveSharedRoster(dataDir, "collaboration"),
  ]);
}

function getRosterCacheKey(options: {
  dataDir: string;
  profileId: string;
  targetSpace: SpecialistTargetSpace;
  sessionAgentId?: string;
  selectedGlobalHandles?: readonly string[];
  workspaceSpecialistsDir?: string;
}): string {
  return [
    options.dataDir,
    options.profileId,
    options.targetSpace,
    options.sessionAgentId ?? "",
    options.workspaceSpecialistsDir ?? "",
    ...(options.selectedGlobalHandles ?? []),
  ].join(CACHE_KEY_SEPARATOR);
}

export function generateRosterBlock(roster: ResolvedSpecialistDefinition[]): string {
  return generateTierLensRosterBlock(roster, Object.values(DEFAULT_TIER_CONFIGS));
}

export function generateTierLensRosterBlock(
  roster: ResolvedSpecialistDefinition[],
  tierConfigs: readonly TierConfig[] = Object.values(DEFAULT_TIER_CONFIGS),
): string {
  const available = roster.filter((entry) => entry.enabled && entry.available);
  const lines = [
    "Spawn workers with `tier`; add `lens` for role/output guidance.",
    "",
    "Effort tiers:",
  ];

  const configsByTier = new Map(tierConfigs.map((config) => [config.tier, config]));
  for (const tier of EFFORT_TIER_ORDER) {
    const config = configsByTier.get(tier) ?? DEFAULT_TIER_CONFIGS[tier];
    const primary = `${compactProvider(config.provider)}/${config.modelId}${config.reasoningLevel ? ` ${config.reasoningLevel}` : ""}`;
    const fallback = config.fallbackModelId
      ? ` -> fb ${compactProvider(config.fallbackProvider ?? "unknown")}/${config.fallbackModelId}${
          config.fallbackReasoningLevel ? ` ${config.fallbackReasoningLevel}` : ""
        }`
      : "";
    lines.push(`- \`${tier}\`: ${TIER_ROSTER_DESCRIPTIONS[tier]} [${primary}${fallback}]`);
  }

  const builtinLenses = available.filter((entry) => entry.builtin);
  if (builtinLenses.length > 0) {
    lines.push("", "Lenses (attach to any tier):");
    for (const lens of builtinLenses) {
      const defaultTier = lens.defaultTier ? ` (${lens.defaultTier})` : "";
      const webSearchTag = lens.webSearch ? " Web/source rules included." : "";
      lines.push(`- \`${lens.specialistId}\`${defaultTier}: ${compactRosterText(lens.whenToUse)}${webSearchTag}`);
    }
  }

  const customSpecialists = available.filter((entry) => !entry.builtin);
  if (customSpecialists.length > 0) {
    lines.push("", "Custom specialists (legacy `specialist` handle):");
    for (const s of customSpecialists) {
      const fallback = s.fallbackModelId
        ? ` -> fb ${compactProvider(s.fallbackProvider ?? "unknown")}/${s.fallbackModelId}${
            s.fallbackReasoningLevel ? ` ${s.fallbackReasoningLevel}` : ""
          }`
        : "";
      const model = s.modelId && s.provider
        ? ` [${compactProvider(s.provider)}/${s.modelId}${s.reasoningLevel ? ` ${s.reasoningLevel}` : ""}${fallback}]`
        : "";
      const webSearchTag = s.webSearch ? " [web search]" : "";
      lines.push(`- \`${s.specialistId}\`: ${compactRosterText(s.whenToUse, 120)}${model}${webSearchTag}`);
    }
  }

  lines.push(
    "",
    "Routing guidance:",
    "- Prefer `light`/`fast` for clear work; reserve `deep`/`max` for planning, review, architecture, and hard debugging.",
    "- Dual-angle review: spawn `code-reviewer` plus `code-reviewer-2`.",
    "- If no combo fits, use ad-hoc `spawn_agent` with explicit model/reasoning.",
  );

  return lines.join("\n");
}

function compactProvider(provider: string): string {
  if (provider === "openai-codex") return "codex";
  if (provider === "cursor-sdk") return "cursor";
  if (provider === "claude-sdk") return "claude-sdk";
  return provider;
}

function compactRosterText(text: string, maxLength = 96): string {
  const firstSentence = text.split(/(?<=\.)\s+/u)[0]?.trim() || text.trim();
  if (firstSentence.length <= maxLength) return firstSentence;
  const clipped = firstSentence.slice(0, maxLength - 3).trimEnd();
  return `${clipped}...`;
}

export interface SeedBuiltinsOptions {
  /**
   * Deprecated compatibility option. Builtin specialist seeding is intentionally
   * target-space agnostic: shared storage is the union used by Builder and the
   * collaboration server, and each file's TargetSpace frontmatter controls
   * runtime visibility.
   */
  runtimeTarget?: RuntimeTarget;
}

export async function seedBuiltins(dataDir: string, options: SeedBuiltinsOptions = {}): Promise<void> {
  const builtinDir = getBuiltinSpecialistsDir();
  const sharedDir = getSharedSpecialistsDir(dataDir);

  await mkdir(sharedDir, { recursive: true });

  void options.runtimeTarget;
  const builtinFiles = await listMarkdownFiles(builtinDir);

  for (const removedFile of REMOVED_BUILTIN_SPECIALIST_FILES) {
    await unlink(join(sharedDir, removedFile)).catch((error) => {
      if (!isEnoentError(error)) {
        throw error;
      }
    });
  }

  for (const file of builtinFiles) {
    if (REMOVED_BUILTIN_SPECIALIST_FILES.has(file.name)) {
      continue;
    }
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
  await refreshSharedRosterHandleCache(dataDir);
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

export function normalizeEffortTier(value: string | undefined): EffortTier | undefined {
  return parseEffortTier(value);
}

export function getTierAttributionId(tier: EffortTier, lens?: string): string {
  return lens ? `${tier}:${normalizeSpecialistHandle(lens)}` : tier;
}

export function resolveLegacySpecialistRewrite(handle: string): LegacySpecialistRewrite | undefined {
  const specialistId = normalizeSpecialistHandle(handle);
  const rewrite = specialistId ? LEGACY_SPECIALIST_REWRITE_TABLE[specialistId] : undefined;
  return rewrite ? { ...rewrite } : undefined;
}

export async function resolveTierConfigs(dataDir: string): Promise<TierConfig[]> {
  const filePath = join(getSharedSpecialistsDir(dataDir), TIER_CONFIGS_FILENAME);
  let overrides: unknown;
  try {
    overrides = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isEnoentError(error)) {
      return cloneTierConfigs(Object.values(DEFAULT_TIER_CONFIGS));
    }
    throw error;
  }

  const byTier = new Map<EffortTier, TierConfig>();
  for (const tier of EFFORT_TIER_ORDER) {
    byTier.set(tier, { ...DEFAULT_TIER_CONFIGS[tier] });
  }

  const rawConfigs = Array.isArray(overrides)
    ? overrides
    : overrides && typeof overrides === "object" && Array.isArray((overrides as { tiers?: unknown }).tiers)
      ? (overrides as { tiers: unknown[] }).tiers
      : overrides && typeof overrides === "object"
        ? Object.values(overrides as Record<string, unknown>)
        : [];

  for (const raw of rawConfigs) {
    const config = parseTierConfig(raw);
    if (config) {
      byTier.set(config.tier, config);
    }
  }

  return EFFORT_TIER_ORDER.map((tier) => ({ ...byTier.get(tier)! }));
}

export async function resolveTierConfig(dataDir: string, tier: EffortTier): Promise<TierConfig> {
  const configs = await resolveTierConfigs(dataDir);
  const config = configs.find((entry) => entry.tier === tier);
  if (!config) {
    throw new Error(`Unknown tier: ${tier}`);
  }
  return { ...config };
}

export async function saveTierConfigs(dataDir: string, configs: readonly TierConfig[]): Promise<TierConfig[]> {
  const byTier = new Map<EffortTier, TierConfig>();
  for (const tier of EFFORT_TIER_ORDER) {
    byTier.set(tier, { ...DEFAULT_TIER_CONFIGS[tier] });
  }
  for (const raw of configs) {
    const config = parseTierConfig(raw);
    if (!config) {
      throw new Error("Invalid tier config");
    }
    byTier.set(config.tier, config);
  }

  const normalized = EFFORT_TIER_ORDER.map((tier) => byTier.get(tier)!);
  const dir = getSharedSpecialistsDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeJsonFileAtomic(join(dir, TIER_CONFIGS_FILENAME), { tiers: normalized });
  return cloneTierConfigs(normalized);
}

export async function setSpecialistsEnabled(dataDir: string, enabled: boolean): Promise<void> {
  const dir = getSharedSpecialistsDir(dataDir);
  const filePath = join(dir, SPECIALISTS_ENABLED_FILENAME);

  await writeJsonFileAtomic(filePath, { enabled });
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

export async function saveChannelSpecialist(
  dataDir: string,
  sessionAgentId: string,
  handle: string,
  data: SaveSpecialistRequest,
): Promise<void> {
  const normalizedSessionAgentId = sanitizePathSegment(sessionAgentId);
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const frontmatter = validateSaveRequest({ ...data, targetSpace: ["collaboration"] });
  const channelDir = getSessionSpecialistsDir(dataDir, "_collaboration", normalizedSessionAgentId);
  const filePath = join(channelDir, `${sanitizePathSegment(specialistId)}.md`);

  await mkdir(channelDir, { recursive: true });
  await writeSpecialistFile(filePath, serializeSpecialistFile(frontmatter, data.promptBody));

  invalidateSpecialistCache(undefined, normalizedSessionAgentId);
}

export async function deleteChannelSpecialist(dataDir: string, sessionAgentId: string, handle: string): Promise<void> {
  const normalizedSessionAgentId = sanitizePathSegment(sessionAgentId);
  const specialistId = normalizeSpecialistHandle(handle);

  if (!specialistId) {
    throw new Error(`Invalid specialist handle: ${handle}`);
  }

  const filePath = join(
    getSessionSpecialistsDir(dataDir, "_collaboration", normalizedSessionAgentId),
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

  invalidateSpecialistCache(undefined, normalizedSessionAgentId);
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

export async function resolveSharedRoster(
  dataDir: string,
  targetSpace?: SpecialistTargetSpace,
): Promise<ResolvedSpecialistDefinition[]> {
  const sharedDir = getSharedSpecialistsDir(dataDir);
  const byHandle = await resolveDirectorySpecialists(sharedDir, "shared", targetSpace);
  const sorted = [...byHandle.values()].sort((a, b) => a.specialistId.localeCompare(b.specialistId));
  if (targetSpace) {
    sharedRosterHandleCache.set(getSharedRosterHandleCacheKey(dataDir, targetSpace), sorted.map((entry) => entry.specialistId));
  }
  return sorted;
}

export function getCachedSharedSpecialistHandles(
  dataDir: string,
  targetSpace: SpecialistTargetSpace,
): string[] | undefined {
  const handles = sharedRosterHandleCache.get(getSharedRosterHandleCacheKey(dataDir, targetSpace));
  return handles ? [...handles] : undefined;
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
  await refreshSharedRosterHandleCache(dataDir);
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
  await refreshSharedRosterHandleCache(dataDir);
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
      "- Use coding tools (read/bash/edit/write) to execute implementation tasks.",
      "- Your final assistant response is returned to the manager automatically.",
      "- You are not user-facing.",
    ].join("\n");
  }
}

export function invalidateSpecialistCache(profileId?: string, sessionAgentId?: string): void {
  if (!profileId && !sessionAgentId) {
    rosterCache.clear();
    return;
  }

  const normalizedProfileId = profileId ? sanitizePathSegment(profileId) : undefined;
  const normalizedSessionAgentId = sessionAgentId ? sanitizePathSegment(sessionAgentId) : undefined;
  for (const key of rosterCache.keys()) {
    const parts = key.split(CACHE_KEY_SEPARATOR);
    if (normalizedProfileId && parts[1] !== normalizedProfileId) {
      continue;
    }
    if (normalizedSessionAgentId && parts[3] !== normalizedSessionAgentId) {
      continue;
    }
    rosterCache.delete(key);
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
    const legacyProvider = parseOptionalString(frontmatterValues.provider);
    const effectiveDescriptor =
      modelCatalogService.resolveModelDescriptorFromFamily(legacyModelPreset) ??
      (() => {
        const replacementPreset = resolveRemovedSwarmModelPresetAlias(legacyModelPreset);
        return replacementPreset ? resolveModelDescriptorFromPreset(replacementPreset) : undefined;
      })();
    if (effectiveDescriptor) {
      frontmatterValues.modelId = effectiveDescriptor.modelId;
      if (!frontmatterValues.provider) {
        frontmatterValues.provider = effectiveDescriptor.provider;
      }
    } else if (isLegacyModelFieldModelId(legacyModelPreset, legacyProvider)) {
      frontmatterValues.modelId = legacyModelPreset;
      if (!frontmatterValues.provider) {
        const inferredProvider = inferProviderFromModelId(legacyModelPreset);
        if (inferredProvider) {
          frontmatterValues.provider = inferredProvider;
        }
      }
    } else {
      return null;
    }
  }

  const displayName = parseRequiredString(frontmatterValues, "displayName");
  const color = parseRequiredString(frontmatterValues, "color");
  const whenToUse = parseRequiredString(frontmatterValues, "whenToUse");
  const modelId = parseOptionalString(frontmatterValues.modelId);

  if (!displayName || !color || !whenToUse) {
    return null;
  }

  if (!HEX_COLOR_PATTERN.test(color)) {
    return null;
  }

  const enabled = parseOptionalBoolean(frontmatterValues.enabled);
  const builtin = parseOptionalBoolean(frontmatterValues.builtin);
  const pinned = parseOptionalBoolean(frontmatterValues.pinned);
  const webSearch = parseOptionalBoolean(frontmatterValues.webSearch);
  const forgePrecedence = parseOptionalString(frontmatterValues.forgePrecedence) === "override" ? "override" : undefined;
  const defaultTier = parseEffortTier(frontmatterValues.defaultTier);
  const targetSpace = parseTargetSpace(
    frontmatterValues[SPECIALIST_TARGET_SPACE_FRONTMATTER_KEY] ??
      frontmatterValues[LEGACY_SPECIALIST_TARGET_SPACE_FRONTMATTER_KEY],
  );

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

  if (targetSpace === undefined) {
    return null;
  }

  if (frontmatterValues.defaultTier !== undefined && !defaultTier) {
    return null;
  }

  const normalizedModel = modelId
    ? normalizeLegacyCursorAcpSpecialistModel({
        provider: parseOptionalString(frontmatterValues.provider),
        modelId,
        reasoningLevel: parseOptionalString(frontmatterValues.reasoningLevel),
      })
    : {
        provider: parseOptionalString(frontmatterValues.provider),
        modelId: undefined,
        reasoningLevel: normalizeLegacyReasoningLevel(parseOptionalString(frontmatterValues.reasoningLevel)),
      };
  if (normalizedModel.reasoningLevel && !isSwarmReasoningLevel(normalizedModel.reasoningLevel)) {
    return null;
  }

  const normalizedFallbackModel = normalizeLegacyCursorAcpSpecialistModel({
    provider: parseOptionalString(frontmatterValues.fallbackProvider),
    modelId: parseOptionalString(frontmatterValues.fallbackModelId),
    reasoningLevel: parseOptionalString(frontmatterValues.fallbackReasoningLevel),
  });
  if (normalizedFallbackModel.reasoningLevel && !isSwarmReasoningLevel(normalizedFallbackModel.reasoningLevel)) {
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
      modelId: normalizedModel.modelId ?? modelId,
      provider: normalizedModel.provider,
      reasoningLevel: normalizedModel.reasoningLevel,
      fallbackModelId: normalizedFallbackModel.modelId,
      fallbackProvider: normalizedFallbackModel.provider,
      fallbackReasoningLevel: normalizedFallbackModel.reasoningLevel,
      builtin: builtin ?? false,
      pinned: pinned ?? false,
      webSearch: webSearch ?? false,
      targetSpace,
      defaultTier,
      forgePrecedence,
    },
    body,
  };
}

function validateSaveRequest(data: SaveSpecialistRequest): SpecialistFrontmatter {
  const displayName = data.displayName.trim();
  const color = data.color.trim();
  const whenToUse = data.whenToUse.trim();
  const modelId = data.modelId?.trim();
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

  if (!modelId && !data.defaultTier) {
    throw new Error("modelId is required unless defaultTier is provided");
  }

  if (!promptBody) {
    throw new Error("promptBody is required");
  }

  const provider = data.provider?.trim();
  const reasoningLevel = data.reasoningLevel?.trim();
  if (reasoningLevel !== undefined && reasoningLevel.length > 0 && !isSwarmReasoningLevel(reasoningLevel)) {
    throw new Error("reasoningLevel must be one of none|low|medium|high|xhigh|max|ultra");
  }

  const normalizedFallbackModelId = fallbackModelId && fallbackModelId.length > 0 ? fallbackModelId : undefined;
  const fallbackProvider = data.fallbackProvider?.trim();

  const fallbackReasoningLevel = data.fallbackReasoningLevel?.trim();
  if (
    fallbackReasoningLevel !== undefined &&
    fallbackReasoningLevel.length > 0 &&
    !isSwarmReasoningLevel(fallbackReasoningLevel)
  ) {
    throw new Error("fallbackReasoningLevel must be one of none|low|medium|high|xhigh|max|ultra");
  }

  // Strip fallback reasoning level when there's no fallback model — it has no effect without one.
  const normalizedFallbackReasoningLevel =
    normalizedFallbackModelId && fallbackReasoningLevel && fallbackReasoningLevel.length > 0
      ? fallbackReasoningLevel
      : undefined;

  const targetSpace = normalizeTargetSpace(data.targetSpace);
  if (!targetSpace) {
    throw new Error("targetSpace must contain builder and/or collaboration");
  }

  return {
    displayName,
    color,
    enabled: data.enabled,
    whenToUse,
    modelId: modelId && modelId.length > 0 ? modelId : undefined,
    provider: provider && provider.length > 0 ? provider : undefined,
    reasoningLevel: reasoningLevel && reasoningLevel.length > 0 ? reasoningLevel : undefined,
    fallbackModelId: normalizedFallbackModelId,
    fallbackProvider:
      normalizedFallbackModelId && fallbackProvider && fallbackProvider.length > 0 ? fallbackProvider : undefined,
    fallbackReasoningLevel: normalizedFallbackReasoningLevel,
    builtin: false,
    pinned: data.pinned ?? false,
    webSearch: modelId ? normalizeWebSearchForModelId(provider, modelId, data.webSearch === true) : false,
    targetSpace,
    defaultTier: data.defaultTier,
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

function parseTargetSpace(value: string | undefined): SpecialistTargetSpace[] | undefined {
  if (value === undefined) {
    return [...DEFAULT_SPECIALIST_TARGET_SPACE];
  }

  const rawEntries = value.trim().startsWith("[") && value.trim().endsWith("]")
    ? value.trim().slice(1, -1).split(",")
    : [value];

  const entries = rawEntries
    .map((entry) => parseYamlStringValue(entry).trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return normalizeTargetSpace(entries);
}

function isLegacyModelFieldModelId(modelId: string, provider: string | undefined): boolean {
  const inferredProvider = provider ?? inferProviderFromModelId(modelId) ?? undefined;
  return modelCatalogService.isKnownModelId(modelId, inferredProvider);
}

function normalizeSelectedHandles(handles: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawHandle of handles) {
    const handle = normalizeSpecialistHandle(rawHandle);
    if (!handle || seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    normalized.push(handle);
  }
  return normalized;
}

function parseEffortTier(value: string | undefined): EffortTier | undefined {
  const normalized = value?.trim().toLowerCase();
  return EFFORT_TIER_ORDER.includes(normalized as EffortTier) ? normalized as EffortTier : undefined;
}

function cloneTierConfigs(configs: readonly TierConfig[]): TierConfig[] {
  return configs.map((config) => ({ ...config }));
}

function parseTierConfig(value: unknown): TierConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const tier = typeof raw.tier === "string" ? parseEffortTier(raw.tier) : undefined;
  const fallback = tier ? DEFAULT_TIER_CONFIGS[tier] : undefined;
  const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!tier || !fallback || !modelId || !provider) {
    return undefined;
  }

  const reasoningLevel = typeof raw.reasoningLevel === "string"
    ? normalizeLegacyReasoningLevel(raw.reasoningLevel)
    : undefined;
  if (reasoningLevel && !isSwarmReasoningLevel(reasoningLevel)) {
    return undefined;
  }

  const fallbackModelId = typeof raw.fallbackModelId === "string" && raw.fallbackModelId.trim().length > 0
    ? raw.fallbackModelId.trim()
    : undefined;
  const fallbackProvider = typeof raw.fallbackProvider === "string" && raw.fallbackProvider.trim().length > 0
    ? raw.fallbackProvider.trim()
    : fallbackModelId
      ? inferProviderFromModelId(fallbackModelId) ?? undefined
      : undefined;
  const fallbackReasoningLevel = typeof raw.fallbackReasoningLevel === "string"
    ? normalizeLegacyReasoningLevel(raw.fallbackReasoningLevel)
    : undefined;
  if (fallbackReasoningLevel && !isSwarmReasoningLevel(fallbackReasoningLevel)) {
    return undefined;
  }

  return {
    tier,
    displayName: typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : fallback.displayName,
    description: typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : fallback.description,
    color: typeof raw.color === "string" && HEX_COLOR_PATTERN.test(raw.color.trim())
      ? raw.color.trim()
      : fallback.color,
    provider,
    modelId,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(fallbackModelId ? { fallbackModelId } : {}),
    ...(fallbackProvider ? { fallbackProvider } : {}),
    ...(fallbackModelId && fallbackReasoningLevel ? { fallbackReasoningLevel } : {}),
  };
}

function normalizeTargetSpace(values: readonly string[] | undefined): SpecialistTargetSpace[] | undefined {
  if (!values) {
    return [...DEFAULT_SPECIALIST_TARGET_SPACE];
  }

  const normalized: SpecialistTargetSpace[] = [];
  for (const value of values) {
    if (value !== "builder" && value !== "collaboration") {
      return undefined;
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }

  return normalized.length > 0 ? normalized : undefined;
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

function normalizeWebSearchForModelId(provider: string | undefined, modelId: string, webSearch: boolean): boolean {
  const resolvedProvider = provider?.trim() || inferProviderFromModelId(modelId) || "";
  return webSearch && resolvedProvider === "xai";
}

function normalizeLegacyCursorAcpSpecialistModel(model: {
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
}): { provider?: string; modelId?: string; reasoningLevel?: string } {
  const provider = model.provider?.trim();
  const modelId = model.modelId?.trim();
  const normalizedProvider = provider?.toLowerCase();
  const normalizedModelId = modelId?.toLowerCase();

  if (normalizedProvider === "cursor-acp" && (!normalizedModelId || normalizedModelId === "default")) {
    return normalizeCursorSdkSpecialistModel(model.reasoningLevel);
  }

  if (normalizedProvider === "cursor-sdk" && normalizedModelId && modelCatalogService.isKnownModelId(normalizedModelId, "cursor-sdk")) {
    return {
      provider: "cursor-sdk",
      modelId: normalizedModelId,
      reasoningLevel: normalizeCursorSdkThinkingLevel(model.reasoningLevel, normalizedModelId),
    };
  }

  return {
    provider,
    modelId,
    reasoningLevel: normalizeLegacyReasoningLevel(model.reasoningLevel),
  };
}

function normalizeCursorSdkSpecialistModel(reasoningLevel: string | undefined): { provider: string; modelId: string; reasoningLevel: string } {
  return {
    provider: "cursor-sdk",
    modelId: "composer-2.5",
    reasoningLevel: normalizeCursorSdkThinkingLevel(reasoningLevel, "composer-2.5"),
  };
}

function normalizeLegacyReasoningLevel(level: string | undefined): string | undefined {
  const normalized = level?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized === "x-high" ? "xhigh" : normalized;
}

function toResolvedSpecialistDefinition(options: {
  specialistId: string;
  frontmatter: SpecialistFrontmatter;
  body: string;
  sourceKind: "builtin" | "global" | "profile" | "channel" | "workspace";
  sourcePath: string;
  shadowsGlobal: boolean;
}): InternalResolvedSpecialistDefinition {
  const provider = options.frontmatter.modelId
    ? options.frontmatter.provider ?? inferProviderFromModelId(options.frontmatter.modelId) ?? "unknown"
    : options.frontmatter.provider;
  const fallbackProvider = options.frontmatter.fallbackProvider
    ?? (options.frontmatter.fallbackModelId
      ? (inferProviderFromModelId(options.frontmatter.fallbackModelId) ?? undefined)
      : undefined);

  const knownPrimaryModel =
    !options.frontmatter.modelId || modelCatalogService.isKnownModelId(options.frontmatter.modelId, provider);
  const knownFallbackModel =
    !options.frontmatter.fallbackModelId ||
    modelCatalogService.isKnownModelId(options.frontmatter.fallbackModelId, fallbackProvider);

  let availabilityCode: "ok" | "invalid_model" = "ok";
  let availabilityMessage: string | undefined;

  if (!knownPrimaryModel) {
    availabilityCode = "invalid_model";
    availabilityMessage = `Unknown modelId: ${options.frontmatter.modelId}`;
  } else if (!knownFallbackModel && options.frontmatter.fallbackModelId) {
    availabilityCode = "invalid_model";
    availabilityMessage = `Unknown fallbackModelId: ${options.frontmatter.fallbackModelId}`;
  }

  const webSearch = options.frontmatter.modelId
    ? normalizeWebSearchForModelId(provider, options.frontmatter.modelId, options.frontmatter.webSearch)
    : false;

  return {
    specialistId: options.specialistId,
    displayName: options.frontmatter.displayName,
    color: options.frontmatter.color,
    enabled: options.frontmatter.enabled,
    whenToUse: options.frontmatter.whenToUse,
    ...(options.frontmatter.modelId ? { modelId: options.frontmatter.modelId } : {}),
    ...(provider ? { provider } : {}),
    reasoningLevel: options.frontmatter.reasoningLevel,
    fallbackModelId: options.frontmatter.fallbackModelId,
    fallbackProvider,
    fallbackReasoningLevel: options.frontmatter.fallbackReasoningLevel,
    builtin: options.frontmatter.builtin,
    pinned: options.frontmatter.pinned,
    webSearch,
    targetSpace: [...options.frontmatter.targetSpace],
    promptBody: options.body,
    sourceKind: options.sourceKind,
    sourcePath: options.sourcePath,
    available: availabilityCode === "ok",
    availabilityCode,
    availabilityMessage,
    shadowsGlobal: options.shadowsGlobal,
    ...(options.frontmatter.defaultTier ? { defaultTier: options.frontmatter.defaultTier } : {}),
    ...(options.frontmatter.forgePrecedence ? { forgePrecedence: options.frontmatter.forgePrecedence } : {}),
  };
}

function serializeSpecialistFile(frontmatter: SpecialistFrontmatter, body: string): string {
  const lines = [
    "---",
    `displayName: ${quoteYamlString(frontmatter.displayName)}`,
    `color: ${quoteYamlString(frontmatter.color)}`,
    `enabled: ${frontmatter.enabled ? "true" : "false"}`,
    `whenToUse: ${quoteYamlString(frontmatter.whenToUse)}`,
    `${SPECIALIST_TARGET_SPACE_FRONTMATTER_KEY}: [${frontmatter.targetSpace.join(", ")}]`,
  ];

  if (frontmatter.defaultTier) {
    lines.push(`defaultTier: ${quoteYamlString(frontmatter.defaultTier)}`);
  }

  if (frontmatter.modelId) {
    lines.push(`modelId: ${quoteYamlString(frontmatter.modelId)}`);
  }

  if (frontmatter.provider) {
    lines.push(`provider: ${quoteYamlString(frontmatter.provider)}`);
  }

  if (frontmatter.reasoningLevel) {
    lines.push(`reasoningLevel: ${quoteYamlString(frontmatter.reasoningLevel)}`);
  }

  if (frontmatter.fallbackModelId) {
    lines.push(`fallbackModelId: ${quoteYamlString(frontmatter.fallbackModelId)}`);

    if (frontmatter.fallbackProvider) {
      lines.push(`fallbackProvider: ${quoteYamlString(frontmatter.fallbackProvider)}`);
    }

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
  await writeFileAtomic(filePath, content);
}

async function listMarkdownFiles(directoryPath: string): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNotDirLikeMissingError(error)) {
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
