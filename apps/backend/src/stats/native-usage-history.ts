import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getNativeCodexHome } from "../swarm/data-paths.js";
import { NATIVE_USAGE_ENTRY_TYPE, NativeUsageAccumulator, parseNativeUsageEntry, type NativeUsageRecord, type NativeUsageTotals } from "../utils/native-usage-records.js";
import { getStatsSourceCache } from "./stats-source-cache.js";

type Entry = Record<string, unknown>;
type UsageEntry = { type: "custom"; customType: typeof NATIVE_USAGE_ENTRY_TYPE; data: NativeUsageRecord };
const object = (value: unknown): Entry | null => value && typeof value === "object" && !Array.isArray(value) ? value as Entry : null;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Read-only recovery, restricted to native identities owned by this Forge transcript.
 * Original transcripts stay authoritative; the shared source cache stores only counts.
 */
export class NativeUsageHistory {
  private codexFiles?: Promise<string[]>;
  private claudeFiles?: Promise<string[]>;
  constructor(private readonly dataDir: string, private readonly options: { claudeProjectsDir?: string } = {}) {}

  async recover(entries: Entry[], ownerAgentId: string): Promise<UsageEntry[]> {
    const { dataDir, options } = this;
    const result: UsageEntry[] = [];
    const links = new Map<string, { provider: NativeUsageRecord["provider"]; id: string }>();
    const firstRecorded = new Map<string, number>();
    for (const entry of entries) {
      const usage = parseNativeUsageEntry(entry);
      if (usage) {
        const key = `${usage.nativeSessionId}/${usage.counterId}`;
        firstRecorded.set(key, Math.min(firstRecorded.get(key) ?? Infinity, Date.parse(usage.runtimeStartedAt ?? usage.capturedAt)));
      }
      const state = object(entry.data);
      if (entry.type !== "custom" || state?.version !== 1 || state.ownerAgentId !== ownerAgentId) continue;
      const provider = entry.customType === "swarm_native_claude_state" ? "claude-native" : entry.customType === "swarm_native_codex_state" ? "codex-native" : null;
      const id = provider === "claude-native" ? state.sessionId : state.threadId;
      if (provider && typeof id === "string" && uuid.test(id)) links.set(`${provider}/${id}`, { provider, id });
    }
    if (!links.size) return result;
    const cache = getStatsSourceCache(dataDir);
    const claudeRoot = options.claudeProjectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    for (const { provider, id } of links.values()) {
      let paths: string[];
      if (provider === "codex-native") {
        this.codexFiles ??= filesUnder(join(getNativeCodexHome(dataDir), "sessions"), 4);
        paths = (await this.codexFiles).filter(path => path.endsWith(`-${id}.jsonl`));
      } else {
        this.claudeFiles ??= filesUnder(claudeRoot, 1);
        paths = (await this.claudeFiles).filter(path => path.endsWith(`${id}.jsonl`));
      }
      const mainCounters = new NativeUsageAccumulator();
      const modelTotals = new Map<string, NativeUsageTotals>();
      for (const path of paths) {
        let rows;
        try { rows = await cache.read(path); } catch { continue; } // Missing/unreadable native history cannot break Stats.
        if (provider === "codex-native" && !rows.some(row => row.entry.type === "native_codex_identity" && row.entry.sessionId === id)) continue;
        let modelId: string | undefined;
        let reasoningLevel: string | null = null;
        for (const { entry } of rows) {
          if (entry.type === "native_codex_context") {
            modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
            reasoningLevel = typeof entry.reasoningLevel === "string" ? entry.reasoningLevel : null;
            continue;
          }
          const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
          if (!Number.isFinite(Date.parse(timestamp)) || !object(entry.usage)) continue;
          let usage = entry.usage as unknown as NativeUsageTotals;
          if (provider === "claude-native") {
            if (entry.type !== "native_claude_usage" || entry.sessionId !== id || typeof entry.modelId !== "string" || typeof entry.messageId !== "string") continue;
            modelId = entry.modelId;
            if (Date.parse(timestamp) >= (firstRecorded.get(`${id}/${modelId}`) ?? Infinity)) continue;
            const delta = mainCounters.consume({ version: 1, provider, nativeSessionId: id, counterId: entry.messageId, modelId, reasoningLevel, capturedAt: timestamp, usage });
            if (!delta) continue;
            const prev = modelTotals.get(modelId);
            usage = { input: (prev?.input ?? 0) + delta.input, output: (prev?.output ?? 0) + delta.output,
              cacheRead: (prev?.cacheRead ?? 0) + delta.cacheRead, cacheWrite: (prev?.cacheWrite ?? 0) + delta.cacheWrite, total: (prev?.total ?? 0) + delta.total };
            modelTotals.set(modelId, usage);
          } else if (entry.type !== "native_codex_usage" || Date.parse(timestamp) >= (firstRecorded.get(`${id}/thread`) ?? Infinity)) continue;
          if (!modelId) continue;
          result.push({ type: "custom", customType: NATIVE_USAGE_ENTRY_TYPE, data: { version: 1, provider,
            nativeSessionId: id, ownerAgentId, counterId: provider === "codex-native" ? "thread" : modelId, modelId, reasoningLevel, capturedAt: timestamp, usage } });
        }
      }
    }
    return result;
  }
}
export async function recoverNativeUsage(dataDir: string, entries: Entry[], ownerAgentId: string,
  options: { claudeProjectsDir?: string } = {}): Promise<UsageEntry[]> {
  return new NativeUsageHistory(dataDir, options).recover(entries, ownerAgentId);
}
async function filesUnder(path: string, depth: number): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(join(path, entry.name));
      else if (entry.isDirectory() && depth > 0) result.push(...await filesUnder(join(path, entry.name), depth - 1));
    }
    return result;
  } catch { return []; }
}
