import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-files.js";
import { isEnoentError } from "../utils/fs-errors.js";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import {
  getKnowledgeArchiveDir,
  getKnowledgeEntriesDir,
  getKnowledgeIndexPath,
  getProfileKnowledgeArchiveDir,
  getProfileKnowledgeEntriesDir,
  getProfileKnowledgeIndexPath,
} from "./data-paths.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";

export type KnowledgeEntryType = "preference" | "convention" | "gotcha" | "pointer";
export type KnowledgeEntryScope = "global" | `profile:${string}`;
export type KnowledgeEntryStatus = "active" | "archived" | "superseded";
export type KnowledgeEntryImportance = "normal" | "high" | "pinned";
export type KnowledgeEvidenceTier =
  | "explicit_user"
  | "trusted_artifact"
  | "feedback_signal"
  | "repeated_pattern"
  | "agent_inference";

export interface KnowledgeEntrySource {
  kind: "user-stated" | "observed" | "legacy";
  session?: string;
  at: string;
}

export interface KnowledgeEntryFrontmatter {
  id: string;
  version: number;
  type: KnowledgeEntryType;
  scope: KnowledgeEntryScope;
  status: KnowledgeEntryStatus;
  first_seen: string;
  last_confirmed: string;
  support_count: number;
  sources: KnowledgeEntrySource[];
  evidence_tier: KnowledgeEvidenceTier;
  supersedes: string[];
  source_entry_ids: string[];
  importance: KnowledgeEntryImportance;
  decay_after_days: number | null;
  title: string;
  legacy?: boolean;
  indexed?: boolean;
}

export interface KnowledgeEntry {
  frontmatter: KnowledgeEntryFrontmatter;
  body: string;
  path: string;
}

export interface KnowledgeUpsertInput {
  id?: string;
  type: KnowledgeEntryType;
  scope: KnowledgeEntryScope;
  title: string;
  body: string;
  evidenceTier: KnowledgeEvidenceTier;
  sources: KnowledgeEntrySource[];
  importance?: KnowledgeEntryImportance;
  status?: KnowledgeEntryStatus;
  supersedes?: string[];
  sourceEntryIds?: string[];
  firstSeen?: string;
  lastConfirmed?: string;
  supportCount?: number;
  legacy?: boolean;
  expectedVersion?: number;
}

export interface KnowledgeSearchOptions {
  query?: string;
  id?: string;
  scope?: "global" | "profile" | "all";
  profileId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface KnowledgeSearchResult {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  scope: KnowledgeEntryScope;
  last_confirmed: string;
  support_count: number;
  importance: KnowledgeEntryImportance;
  status: KnowledgeEntryStatus;
}

export interface KnowledgeIndexResult {
  scope: KnowledgeEntryScope;
  path: string;
  tokenCap: number;
  tokenEstimate: number;
  indexedEntryIds: string[];
  demotedEntryIds: string[];
}

interface NormalizedKnowledgeUpsertInput {
  id: string;
  type: KnowledgeEntryType;
  scope: KnowledgeEntryScope;
  title: string;
  body: string;
  evidenceTier: KnowledgeEvidenceTier;
  sources: KnowledgeEntrySource[];
  importance: KnowledgeEntryImportance;
  status: KnowledgeEntryStatus;
  supersedes: string[];
  sourceEntryIds: string[];
  firstSeen?: string;
  lastConfirmed?: string;
  supportCount?: number;
  legacy: boolean;
}

export class KnowledgeServiceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "KnowledgeServiceError";
  }
}

export class KnowledgeService {
  private readonly dataDir: string;
  private readonly settingsService: Pick<KnowledgeV2SettingsService, "getSettings">;
  private readonly versioning?: VersioningMutationSink;
  private readonly now: () => Date;
  private writeMutex: Promise<void> = Promise.resolve();

  constructor(options: {
    dataDir: string;
    settingsService: Pick<KnowledgeV2SettingsService, "getSettings">;
    versioning?: VersioningMutationSink;
    now?: () => Date;
  }) {
    this.dataDir = options.dataDir;
    this.settingsService = options.settingsService;
    this.versioning = options.versioning;
    this.now = options.now ?? (() => new Date());
  }

  async upsertEntry(input: KnowledgeUpsertInput): Promise<KnowledgeEntry> {
    return this.withWriteLock(async () => {
      const normalized = this.normalizeUpsertInput(input);
      const existing = await this.readEntry(normalized.id, { includeArchived: true }).catch((error) => {
        if (error instanceof KnowledgeServiceError && error.code === "not_found") return undefined;
        throw error;
      });
      if (input.expectedVersion !== undefined && existing?.frontmatter.version !== input.expectedVersion) {
        throw new KnowledgeServiceError("Knowledge entry version conflict", "version_conflict");
      }
      const timestamp = this.now().toISOString().slice(0, 10);
      const frontmatter: KnowledgeEntryFrontmatter = {
        id: normalized.id,
        version: (existing?.frontmatter.version ?? 0) + 1,
        type: normalized.type,
        scope: normalized.scope,
        status: normalized.status ?? existing?.frontmatter.status ?? "active",
        first_seen: normalized.firstSeen ?? existing?.frontmatter.first_seen ?? timestamp,
        last_confirmed: normalized.lastConfirmed ?? timestamp,
        support_count: normalized.supportCount ?? existing?.frontmatter.support_count ?? 1,
        sources: normalized.sources,
        evidence_tier: normalized.evidenceTier,
        supersedes: normalized.supersedes,
        source_entry_ids: normalized.sourceEntryIds,
        importance: normalized.importance,
        decay_after_days: defaultDecayAfterDays(normalized.type),
        title: normalized.title,
        legacy: normalized.legacy || existing?.frontmatter.legacy ? true : undefined,
        indexed: existing?.frontmatter.indexed,
      };
      const targetPath = this.entryPath(frontmatter.scope, frontmatter.id, frontmatter.status === "archived");
      await writeKnowledgeEntryFile(targetPath, frontmatter, normalized.body);
      if (existing && existing.path !== targetPath) {
        await archiveOldPath(existing.path).catch(() => undefined);
      }
      await this.recordMutation(targetPath, "write", frontmatter.scope);
      await this.regenerateIndex(frontmatter.scope);
      return { frontmatter, body: normalized.body, path: targetPath };
    });
  }

  async saveLearning(input: {
    type: KnowledgeEntryType;
    scope: KnowledgeEntryScope;
    title: string;
    body: string;
    evidence: "user-stated" | "observed";
    sessionId?: string;
  }): Promise<KnowledgeEntry> {
    const source: KnowledgeEntrySource = {
      kind: input.evidence,
      ...(input.sessionId ? { session: input.sessionId } : {}),
      at: this.now().toISOString(),
    };
    const candidates = await this.searchEntries({ query: input.title, scope: "all", limit: 20 });
    const match = candidates
      .filter((candidate) => candidate.scope === input.scope)
      .find((candidate) => titleSimilarity(candidate.title, input.title) >= 0.75);
    if (!match) {
      return this.upsertEntry({
        type: input.type,
        scope: input.scope,
        title: input.title,
        body: input.body,
        evidenceTier: input.evidence === "user-stated" ? "explicit_user" : "agent_inference",
        sources: [source],
      });
    }

    const existing = await this.readEntry(match.id, { includeArchived: false });
    return this.upsertEntry({
      id: existing.frontmatter.id,
      type: existing.frontmatter.type,
      scope: existing.frontmatter.scope,
      title: existing.frontmatter.title,
      body: existing.body,
      evidenceTier: existing.frontmatter.evidence_tier,
      sources: dedupeSources([...existing.frontmatter.sources, source]),
      importance: existing.frontmatter.importance,
      supersedes: existing.frontmatter.supersedes,
      sourceEntryIds: existing.frontmatter.source_entry_ids,
      expectedVersion: existing.frontmatter.version,
    }).then((entry) => ({
      ...entry,
      frontmatter: {
        ...entry.frontmatter,
        support_count: existing.frontmatter.support_count + 1,
      },
    })).then(async (entry) => {
      await writeKnowledgeEntryFile(entry.path, entry.frontmatter, entry.body);
      await this.recordMutation(entry.path, "write", entry.frontmatter.scope);
      await this.regenerateIndex(entry.frontmatter.scope);
      return entry;
    });
  }

  async readEntry(id: string, options?: { includeArchived?: boolean }): Promise<KnowledgeEntry> {
    const safeId = normalizeId(id);
    for (const scope of await this.listKnownScopes()) {
      for (const archived of [false, true]) {
        if (archived && options?.includeArchived !== true) continue;
        const candidate = this.entryPath(scope, safeId, archived);
        const entry = await readKnowledgeEntryFile(candidate).catch((error) => {
          if (isEnoentError(error)) return undefined;
          throw error;
        });
        if (entry) return entry;
      }
    }
    throw new KnowledgeServiceError(`Knowledge entry not found: ${safeId}`, "not_found");
  }

  async searchEntries(options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult[]> {
    const query = normalizeSearchText(options.query ?? options.id ?? "");
    const entries = await this.readEntriesForSearch(options);
    return entries
      .map((entry) => ({
        entry,
        score: rankSearchEntry(entry, query),
      }))
      .filter(({ score }) => query.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || compareIndexPriority(left.entry, right.entry))
      .slice(0, Math.max(1, Math.min(options.limit ?? 20, 100)))
      .map(({ entry }) => ({
        id: entry.frontmatter.id,
        type: entry.frontmatter.type,
        title: entry.frontmatter.title,
        scope: entry.frontmatter.scope,
        last_confirmed: entry.frontmatter.last_confirmed,
        support_count: entry.frontmatter.support_count,
        importance: entry.frontmatter.importance,
        status: entry.frontmatter.status,
      }));
  }

  async archiveEntry(id: string): Promise<KnowledgeEntry> {
    return this.withWriteLock(async () => {
      const existing = await this.readEntry(id, { includeArchived: false });
      const archived: KnowledgeEntry = {
        ...existing,
        frontmatter: {
          ...existing.frontmatter,
          version: existing.frontmatter.version + 1,
          status: "archived",
          indexed: false,
        },
        path: this.entryPath(existing.frontmatter.scope, existing.frontmatter.id, true),
      };
      await mkdir(dirname(archived.path), { recursive: true });
      // eslint-disable-next-line no-restricted-syntax -- archive move, not a temp+rename content write
      await rename(existing.path, archived.path).catch(async (error) => {
        if (!isEnoentError(error)) throw error;
        await writeKnowledgeEntryFile(archived.path, archived.frontmatter, archived.body);
      });
      await writeKnowledgeEntryFile(archived.path, archived.frontmatter, archived.body);
      await this.recordMutation(existing.path, "delete", archived.frontmatter.scope);
      await this.recordMutation(archived.path, "write", archived.frontmatter.scope);
      await this.regenerateIndex(archived.frontmatter.scope);
      return archived;
    });
  }

  async regenerateIndex(scope: KnowledgeEntryScope): Promise<KnowledgeIndexResult> {
    const activeEntries = (await this.readEntriesByScope(scope, false))
      .filter((entry) => entry.frontmatter.status === "active")
      .sort(compareIndexPriority);
    const tokenCap = scope === "global"
      ? this.settingsService.getSettings().indexCaps.global
      : this.settingsService.getSettings().indexCaps.profile;
    const selected: KnowledgeEntry[] = [];
    for (const entry of activeEntries) {
      const next = [...selected, entry];
      if (estimateTokens(renderIndex(scope, next)) <= tokenCap || entry.frontmatter.importance === "pinned") {
        selected.push(entry);
      }
    }
    const selectedIds = new Set(selected.map((entry) => entry.frontmatter.id));
    const demotedIds = activeEntries
      .filter((entry) => !selectedIds.has(entry.frontmatter.id))
      .map((entry) => entry.frontmatter.id);
    const indexPath = this.indexPath(scope);
    const content = renderIndex(scope, selected);
    await writeFileAtomic(indexPath, content);
    await this.recordMutation(indexPath, "write", scope);
    return {
      scope,
      path: indexPath,
      tokenCap,
      tokenEstimate: estimateTokens(content),
      indexedEntryIds: Array.from(selectedIds),
      demotedEntryIds: demotedIds,
    };
  }

  private normalizeUpsertInput(input: KnowledgeUpsertInput): NormalizedKnowledgeUpsertInput {
    const type = normalizeEntryType(input.type);
    const scope = normalizeScope(input.scope);
    const title = normalizeTitle(input.title);
    const body = normalizeBody(input.body);
    if (estimateTokens(body) > 120) {
      throw new KnowledgeServiceError("Knowledge entry body exceeds 120 token cap", "body_token_cap");
    }
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new KnowledgeServiceError("Knowledge entry sources must be non-empty", "missing_sources");
    }
    const sources = input.sources.map(normalizeSource);
    return {
      id: normalizeId(input.id ?? `${type}-${slugify(title)}`),
      type,
      scope,
      title,
      body,
      evidenceTier: normalizeEvidenceTier(input.evidenceTier),
      sources,
      importance: normalizeImportance(input.importance ?? "normal"),
      status: normalizeStatus(input.status ?? "active"),
      supersedes: (input.supersedes ?? []).map(normalizeId),
      sourceEntryIds: (input.sourceEntryIds ?? []).map(normalizeId),
      ...(input.firstSeen ? { firstSeen: normalizeDateString(input.firstSeen, "firstSeen") } : {}),
      ...(input.lastConfirmed ? { lastConfirmed: normalizeDateString(input.lastConfirmed, "lastConfirmed") } : {}),
      ...(input.supportCount === undefined
        ? {}
        : { supportCount: normalizePositiveInteger(input.supportCount, "supportCount") }),
      legacy: input.legacy === true,
    };
  }

  private async readEntriesForSearch(options: KnowledgeSearchOptions): Promise<KnowledgeEntry[]> {
    const scopes = await this.resolveSearchScopes(options);
    const batches = await Promise.all(scopes.map((scope) => this.readEntriesByScope(scope, false)));
    const entries = batches.flat();
    if (options.includeArchived === true) {
      const archived = await Promise.all(scopes.map((scope) => this.readEntriesByScope(scope, true)));
      entries.push(...archived.flat());
    }
    return entries;
  }

  private async resolveSearchScopes(options: KnowledgeSearchOptions): Promise<KnowledgeEntryScope[]> {
    if (options.scope === "global") return ["global"];
    if (options.scope === "profile") {
      if (!options.profileId) return [];
      return [`profile:${options.profileId}`];
    }
    return this.listKnownScopes(options.profileId);
  }

  private async listKnownScopes(preferredProfileId?: string): Promise<KnowledgeEntryScope[]> {
    const scopes = new Set<KnowledgeEntryScope>(["global"]);
    if (preferredProfileId) scopes.add(`profile:${preferredProfileId}`);
    let profiles: string[] = [];
    try {
      profiles = await readdir(join(this.dataDir, "profiles"));
    } catch (error) {
      if (!isEnoentError(error)) throw error;
    }
    for (const profileId of profiles) scopes.add(`profile:${profileId}`);
    return Array.from(scopes);
  }

  private async readEntriesByScope(scope: KnowledgeEntryScope, archived: boolean): Promise<KnowledgeEntry[]> {
    const dir = this.entriesDir(scope, archived);
    let fileNames: string[] = [];
    try {
      fileNames = await readdir(dir);
    } catch (error) {
      if (isEnoentError(error)) return [];
      throw error;
    }
    const entries = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".md"))
        .map((fileName) => readKnowledgeEntryFile(join(dir, fileName))),
    );
    return entries;
  }

  private entriesDir(scope: KnowledgeEntryScope, archived: boolean): string {
    if (scope === "global") return archived ? getKnowledgeArchiveDir(this.dataDir) : getKnowledgeEntriesDir(this.dataDir);
    const profileId = scope.slice("profile:".length);
    return archived
      ? getProfileKnowledgeArchiveDir(this.dataDir, profileId)
      : getProfileKnowledgeEntriesDir(this.dataDir, profileId);
  }

  private entryPath(scope: KnowledgeEntryScope, id: string, archived: boolean): string {
    return join(this.entriesDir(scope, archived), `${normalizeId(id)}.md`);
  }

  private indexPath(scope: KnowledgeEntryScope): string {
    if (scope === "global") return getKnowledgeIndexPath(this.dataDir);
    return getProfileKnowledgeIndexPath(this.dataDir, scope.slice("profile:".length));
  }

  private async recordMutation(path: string, action: "write" | "delete", scope: KnowledgeEntryScope): Promise<void> {
    await this.versioning?.recordMutation({
      path,
      action,
      source: "knowledge-v2",
      profileId: scope === "global" ? "cortex" : scope.slice("profile:".length),
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeMutex;
    let release: (() => void) | undefined;
    this.writeMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

async function readKnowledgeEntryFile(path: string): Promise<KnowledgeEntry> {
  const raw = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const normalized = validateFrontmatter(frontmatter, body);
  return { frontmatter: normalized, body, path };
}

async function writeKnowledgeEntryFile(path: string, frontmatter: KnowledgeEntryFrontmatter, body: string): Promise<void> {
  validateFrontmatter(frontmatter as unknown as Record<string, unknown>, body);
  await writeFileAtomic(path, `${serializeFrontmatter(frontmatter)}\n${body.trim()}\n`);
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(raw);
  if (!match) throw new KnowledgeServiceError("Knowledge entry is missing frontmatter", "bad_frontmatter");
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    frontmatter[key] = parseFrontmatterValue(value);
  }
  return { frontmatter, body: match[2].trim() };
}

function parseFrontmatterValue(value: string): unknown {
  if (value === "null") return null;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value.replace(/^"(.*)"$/u, "$1");
}

function serializeFrontmatter(frontmatter: KnowledgeEntryFrontmatter): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function validateFrontmatter(value: Record<string, unknown>, body: string): KnowledgeEntryFrontmatter {
  const id = normalizeId(String(value.id ?? ""));
  const type = normalizeEntryType(value.type);
  const scope = normalizeScope(value.scope);
  const status = normalizeStatus(value.status);
  const sources = Array.isArray(value.sources) ? value.sources.map(normalizeSource) : [];
  if (sources.length === 0) throw new KnowledgeServiceError("Knowledge entry sources must be non-empty", "missing_sources");
  if (estimateTokens(body) > 120) throw new KnowledgeServiceError("Knowledge entry body exceeds 120 token cap", "body_token_cap");
  return {
    id,
    version: normalizePositiveInteger(value.version, "version"),
    type,
    scope,
    status,
    first_seen: normalizeDateString(value.first_seen, "first_seen"),
    last_confirmed: normalizeDateString(value.last_confirmed, "last_confirmed"),
    support_count: normalizePositiveInteger(value.support_count, "support_count"),
    sources,
    evidence_tier: normalizeEvidenceTier(value.evidence_tier),
    supersedes: Array.isArray(value.supersedes) ? value.supersedes.map((item) => normalizeId(String(item))) : [],
    source_entry_ids: Array.isArray(value.source_entry_ids) ? value.source_entry_ids.map((item) => normalizeId(String(item))) : [],
    importance: normalizeImportance(value.importance ?? "normal"),
    decay_after_days:
      value.decay_after_days === null ? null : normalizePositiveInteger(value.decay_after_days, "decay_after_days"),
    title: normalizeTitle(value.title),
    legacy: value.legacy === true ? true : undefined,
    indexed: typeof value.indexed === "boolean" ? value.indexed : undefined,
  };
}

function renderIndex(scope: KnowledgeEntryScope, entries: KnowledgeEntry[]): string {
  const typeNames: Record<KnowledgeEntryType, string> = {
    preference: "Preferences",
    convention: "Conventions",
    gotcha: "Gotchas",
    pointer: "Pointers",
  };
  const lines = [
    `# Knowledge Index (${scope === "global" ? "global" : scope}) · generated ${new Date().toISOString().slice(0, 10)} · ${entries.length} entries · ~${estimateTokens(entries.map(formatIndexLine).join("\n"))} tok`,
    "> Recalled notes maintained by Cortex. Pull full entries with the `knowledge` tool before acting.",
    "",
  ];
  for (const type of ["preference", "convention", "gotcha", "pointer"] as KnowledgeEntryType[]) {
    const group = entries.filter((entry) => entry.frontmatter.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${typeNames[type]}`);
    lines.push(...group.map(formatIndexLine), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatIndexLine(entry: KnowledgeEntry): string {
  return `- [${entry.frontmatter.id}] ${entry.frontmatter.title} · conf ${entry.frontmatter.last_confirmed} ×${entry.frontmatter.support_count}`;
}

function compareIndexPriority(left: KnowledgeEntry, right: KnowledgeEntry): number {
  return (
    importanceRank(right.frontmatter.importance) - importanceRank(left.frontmatter.importance) ||
    right.frontmatter.support_count - left.frontmatter.support_count ||
    Date.parse(right.frontmatter.last_confirmed) - Date.parse(left.frontmatter.last_confirmed) ||
    typeRank(right.frontmatter.type) - typeRank(left.frontmatter.type) ||
    left.frontmatter.id.localeCompare(right.frontmatter.id)
  );
}

function rankSearchEntry(entry: KnowledgeEntry, query: string): number {
  if (!query) return 1;
  const haystack = normalizeSearchText(`${entry.frontmatter.id} ${entry.frontmatter.title} ${entry.body} ${entry.frontmatter.type}`);
  return query.split(" ").reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function titleSimilarity(left: string, right: string): number {
  const leftTerms = new Set(normalizeSearchText(left).split(" ").filter(Boolean));
  const rightTerms = new Set(normalizeSearchText(right).split(" ").filter(Boolean));
  const union = new Set([...leftTerms, ...rightTerms]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared / union.size;
}

function dedupeSources(sources: KnowledgeEntrySource[]): KnowledgeEntrySource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function archiveOldPath(path: string): Promise<void> {
  await mkdir(join(dirname(path), ".replaced"), { recursive: true });
  // eslint-disable-next-line no-restricted-syntax -- move to .replaced, not a temp+rename content write
  await rename(path, join(dirname(path), ".replaced", basename(path)));
}

function normalizeEntryType(value: unknown): KnowledgeEntryType {
  if (value === "preference" || value === "convention" || value === "gotcha" || value === "pointer") return value;
  throw new KnowledgeServiceError("Knowledge entry type must be preference|convention|gotcha|pointer", "bad_type");
}

function normalizeScope(value: unknown): KnowledgeEntryScope {
  if (value === "global") return "global";
  if (typeof value === "string" && /^profile:[A-Za-z0-9._-]+$/u.test(value)) return value as KnowledgeEntryScope;
  throw new KnowledgeServiceError("Knowledge entry scope must be global or profile:<id>", "bad_scope");
}

function normalizeStatus(value: unknown): KnowledgeEntryStatus {
  if (value === "active" || value === "archived" || value === "superseded") return value;
  throw new KnowledgeServiceError("Knowledge entry status must be active|archived|superseded", "bad_status");
}

function normalizeImportance(value: unknown): KnowledgeEntryImportance {
  if (value === "normal" || value === "high" || value === "pinned") return value;
  throw new KnowledgeServiceError("Knowledge entry importance must be normal|high|pinned", "bad_importance");
}

function normalizeEvidenceTier(value: unknown): KnowledgeEvidenceTier {
  if (
    value === "explicit_user" ||
    value === "trusted_artifact" ||
    value === "feedback_signal" ||
    value === "repeated_pattern" ||
    value === "agent_inference"
  ) {
    return value;
  }
  throw new KnowledgeServiceError("Knowledge entry evidence_tier is invalid", "bad_evidence_tier");
}

function normalizeSource(value: unknown): KnowledgeEntrySource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeServiceError("Knowledge entry source must be an object", "bad_source");
  }
  const maybe = value as Record<string, unknown>;
  const kind = maybe.kind;
  if (kind !== "user-stated" && kind !== "observed" && kind !== "legacy") {
    throw new KnowledgeServiceError("Knowledge entry source kind is invalid", "bad_source");
  }
  const session = typeof maybe.session === "string" && maybe.session.trim() ? maybe.session.trim() : undefined;
  if (kind !== "user-stated" && !session) {
    throw new KnowledgeServiceError("Observed knowledge sources must include a session id", "bad_source");
  }
  return {
    kind,
    ...(session ? { session } : {}),
    at: normalizeDateString(maybe.at, "source.at"),
  };
}

function normalizeId(value: string): string {
  const id = slugify(value);
  if (!id) throw new KnowledgeServiceError("Knowledge entry id is required", "bad_id");
  return id;
}

function normalizeTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!title) throw new KnowledgeServiceError("Knowledge entry title is required", "bad_title");
  return title;
}

function normalizeBody(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new KnowledgeServiceError("Knowledge entry body is required", "bad_body");
  return body;
}

function normalizeDateString(value: unknown, fieldName: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Number.isNaN(Date.parse(text))) {
    throw new KnowledgeServiceError(`${fieldName} must be a date string`, "bad_date");
  }
  return text.length > 10 ? text : text.slice(0, 10);
}

function normalizePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new KnowledgeServiceError(`${fieldName} must be a non-negative integer`, "bad_number");
  }
  return value;
}

function defaultDecayAfterDays(type: KnowledgeEntryType): number | null {
  switch (type) {
    case "preference": return 365;
    case "convention": return 180;
    case "gotcha": return 120;
    case "pointer": return null;
  }
}

function typeRank(type: KnowledgeEntryType): number {
  return type === "gotcha" ? 4 : type === "convention" ? 3 : type === "preference" ? 2 : 1;
}

function importanceRank(importance: KnowledgeEntryImportance): number {
  return importance === "pinned" ? 3 : importance === "high" ? 2 : 1;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function estimateTokens(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}
