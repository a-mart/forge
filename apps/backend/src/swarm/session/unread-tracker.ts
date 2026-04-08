import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProfileUnreadStatePath, getProfilesDir } from "../data-paths.js";
import { renameWithRetry } from "../retry-rename.js";

const DEFAULT_DEBOUNCE_MS = 3000;
const MAX_UNREAD_COUNT = 999;

interface UnreadTrackerOptions {
  dataDir: string;
  getProfileIds: () => string[];
  getSessionAgentIds: (profileId: string) => string[];
  debounceMs?: number;
}

interface PersistedUnreadState {
  counts: Record<string, number>;
}

export class UnreadTracker {
  private readonly dataDir: string;
  private readonly getProfileIdsFn: () => string[];
  private readonly getSessionAgentIdsFn: (profileId: string) => string[];
  private readonly debounceMs: number;

  private readonly counts = new Map<string, Map<string, number>>();
  private readonly dirtyProfiles = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(options: UnreadTrackerOptions) {
    this.dataDir = options.dataDir;
    this.getProfileIdsFn = options.getProfileIds;
    this.getSessionAgentIdsFn = options.getSessionAgentIds;
    this.debounceMs =
      typeof options.debounceMs === "number" && Number.isFinite(options.debounceMs) && options.debounceMs >= 0
        ? Math.floor(options.debounceMs)
        : DEFAULT_DEBOUNCE_MS;
  }

  async load(): Promise<void> {
    this.counts.clear();
    this.dirtyProfiles.clear();
    this.clearFlushTimer();

    const profileIds = this.getProfileIdsFn();
    for (const profileId of profileIds) {
      const loaded = await this.loadProfileCounts(profileId);
      const validSessionIds = new Set(this.getSessionAgentIdsFn(profileId));
      const pruned = new Map<string, number>();
      let changed = false;

      for (const [sessionAgentId, count] of loaded.entries()) {
        if (!validSessionIds.has(sessionAgentId)) {
          changed = true;
          continue;
        }

        pruned.set(sessionAgentId, count);
      }

      if (pruned.size > 0) {
        this.counts.set(profileId, pruned);
      }

      if (changed) {
        this.dirtyProfiles.add(profileId);
      }
    }

    await this.pruneOrphanProfileFiles(new Set(profileIds));

    if (this.dirtyProfiles.size > 0) {
      await this.flushDirtyProfiles();
    }
  }

  async flush(): Promise<void> {
    this.clearFlushTimer();
    await this.flushDirtyProfiles();
  }

  increment(profileId: string, sessionAgentId: string): number {
    const map = this.getOrCreateProfileMap(profileId);
    const current = map.get(sessionAgentId) ?? 0;
    const next = Math.min(MAX_UNREAD_COUNT, current + 1);

    if (next === current) {
      return next;
    }

    map.set(sessionAgentId, next);
    this.markDirty(profileId);
    return next;
  }

  markRead(profileId: string, sessionAgentId: string): number {
    const map = this.counts.get(profileId);
    if (!map) {
      return 0;
    }

    const previous = map.get(sessionAgentId) ?? 0;
    if (previous <= 0) {
      return 0;
    }

    map.delete(sessionAgentId);
    if (map.size === 0) {
      this.counts.delete(profileId);
    }

    this.markDirty(profileId);
    return previous;
  }

  markUnread(profileId: string, sessionAgentId: string): number {
    const map = this.getOrCreateProfileMap(profileId);
    const previous = map.get(sessionAgentId) ?? 0;

    if (previous === 1) {
      return previous;
    }

    map.set(sessionAgentId, 1);
    this.markDirty(profileId);
    return previous;
  }

  clearSession(profileId: string, sessionAgentId: string): void {
    const map = this.counts.get(profileId);
    if (!map || !map.has(sessionAgentId)) {
      return;
    }

    map.delete(sessionAgentId);
    if (map.size === 0) {
      this.counts.delete(profileId);
    }

    this.markDirty(profileId);
  }

  clearProfile(profileId: string): void {
    this.counts.delete(profileId);
    this.markDirty(profileId);
  }

  getSnapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};

    for (const profileMap of this.counts.values()) {
      for (const [sessionAgentId, count] of profileMap.entries()) {
        if (count > 0) {
          snapshot[sessionAgentId] = count;
        }
      }
    }

    return snapshot;
  }

  getCount(profileId: string, sessionAgentId: string): number {
    return this.counts.get(profileId)?.get(sessionAgentId) ?? 0;
  }

  private getOrCreateProfileMap(profileId: string): Map<string, number> {
    const existing = this.counts.get(profileId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, number>();
    this.counts.set(profileId, created);
    return created;
  }

  private markDirty(profileId: string): void {
    this.dirtyProfiles.add(profileId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushDirtyProfiles();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushDirtyProfiles(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    this.flushInFlight = this.flushDirtyProfilesInternal().finally(() => {
      this.flushInFlight = null;
    });

    await this.flushInFlight;
  }

  private async flushDirtyProfilesInternal(): Promise<void> {
    if (this.dirtyProfiles.size === 0) {
      return;
    }

    const pendingProfileIds = Array.from(this.dirtyProfiles);
    for (const profileId of pendingProfileIds) {
      this.dirtyProfiles.delete(profileId);

      try {
        await this.persistProfile(profileId);
      } catch (error) {
        this.dirtyProfiles.add(profileId);
        console.warn(`[swarm] unread:failed_to_persist profile=${profileId}`, {
          message: error instanceof Error ? error.message : String(error)
        });
        this.scheduleFlush();
      }
    }
  }

  private async loadProfileCounts(profileId: string): Promise<Map<string, number>> {
    const path = getProfileUnreadStatePath(this.dataDir, profileId);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return new Map<string, number>();
      }

      throw error;
    }

    try {
      return parsePersistedUnreadState(raw);
    } catch (error) {
      console.warn(`[swarm] unread:failed_to_load profile=${profileId} path=${path}`, {
        message: error instanceof Error ? error.message : String(error)
      });
      await this.recoverCorruptedFile(path);
      return new Map<string, number>();
    }
  }

  private async recoverCorruptedFile(path: string): Promise<void> {
    const corruptPath = `${path}.corrupt`;
    try {
      await rm(corruptPath, { force: true });
    } catch {
      // best effort
    }

    try {
      await renameWithRetry(path, corruptPath, { retries: 8, baseDelayMs: 15 });
    } catch (error) {
      if (!isEnoent(error)) {
        console.warn(`[swarm] unread:failed_to_mark_corrupt path=${path}`, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async pruneOrphanProfileFiles(knownProfileIds: Set<string>): Promise<void> {
    const profilesDir = getProfilesDir(this.dataDir);

    let entries: Dirent[];
    try {
      entries = await readdir(profilesDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || knownProfileIds.has(entry.name)) {
        continue;
      }

      const orphanPath = join(profilesDir, entry.name, "unread-state.json");
      try {
        await rm(orphanPath, { force: true });
      } catch (error) {
        if (!isEnoent(error)) {
          console.warn(`[swarm] unread:failed_to_prune_orphan profile=${entry.name} path=${orphanPath}`, {
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  private async persistProfile(profileId: string): Promise<void> {
    const path = getProfileUnreadStatePath(this.dataDir, profileId);
    if (!this.getProfileIdsFn().includes(profileId)) {
      await rm(path, { force: true });
      return;
    }

    const map = this.counts.get(profileId);
    const payload = toPersistedUnreadState(map);
    const tmpPath = `${path}.tmp`;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
  }

}

function parsePersistedUnreadState(raw: string): Map<string, number> {
  const parsed = JSON.parse(raw) as Partial<PersistedUnreadState>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Unread state must be a JSON object");
  }

  const counts = parsed.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("Unread state counts must be an object");
  }

  const result = new Map<string, number>();
  for (const [sessionAgentId, value] of Object.entries(counts)) {
    const normalizedSessionAgentId = sessionAgentId.trim();
    if (!normalizedSessionAgentId) {
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }

    const normalizedCount = Math.min(MAX_UNREAD_COUNT, Math.floor(value));
    if (normalizedCount <= 0) {
      continue;
    }

    result.set(normalizedSessionAgentId, normalizedCount);
  }

  return result;
}

function toPersistedUnreadState(map: Map<string, number> | undefined): PersistedUnreadState {
  const counts: Record<string, number> = {};
  if (!map) {
    return { counts };
  }

  for (const [sessionAgentId, count] of map.entries()) {
    if (count > 0) {
      counts[sessionAgentId] = count;
    }
  }

  return { counts };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
