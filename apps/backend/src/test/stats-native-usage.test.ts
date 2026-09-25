import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { scanProfilesData } from "../stats/stats-scan.js";
import { scanTokenAnalyticsProfiles } from "../stats/token-analytics/token-analytics-scan.js";
import { StatsSourceCache } from "../stats/stats-source-cache.js";

it("merges native and Pi model usage, deduplicates fork copies, and survives cache restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-native-stats-"));
  const session = join(root, "profiles/p/sessions/s");
  const worker = join(session, "workers/w.jsonl");
  const write = async (path: string, entries: unknown[]) => writeFile(path, entries.map(x => JSON.stringify(x)).join("\n") + "\n");
  const native = (input: number, hour: number) => ({ type: "custom", customType: "swarm_native_usage", data: {
    version: 1, provider: "claude-native", nativeSessionId: "native", ownerAgentId: "w", counterId: "claude-fable-5-1", modelId: "claude-fable-5-1",
    reasoningLevel: "high", capturedAt: `2026-09-25T${hour}:00:00Z`, usage: { input, output: 5, cacheRead: 20, cacheWrite: 2 },
  } });
  try {
    await mkdir(join(session, "workers"), { recursive: true });
    await mkdir(join(root, "profiles/p/sessions/fork"), { recursive: true });
    await write(join(session, "session.jsonl"), []);
    await writeFile(join(session, "meta.json"), JSON.stringify({ workers: [{ id: "w", createdAt: "2026-09-25T09:00:00Z", terminatedAt: "2026-09-25T13:00:00Z" }] }));
    await write(join(root, "profiles/p/sessions/fork/session.jsonl"), [native(10, 10), native(15, 11)]);
    await write(worker, [native(10, 10), native(15, 11), native(15, 11), {
      type: "message", timestamp: "2026-09-25T12:00:00Z", message: { provider: "anthropic", model: "claude-fable-5-1",
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }]);
    const scan = await scanProfilesData(root, ["p"], "UTC");
    expect(scan.usageRecords.reduce((n, r) => n + r.total, 0)).toBe(53);
    expect(scan.workerRuns[0]?.billableTokens).toBe(31);
    expect(new Set(scan.usageRecords.map(r => r.modelId))).toEqual(new Set(["claude-fable-5-1"]));
    const cached = await new StatsSourceCache(root).read(worker);
    expect(cached.some(row => row.entry.customType === "swarm_native_usage")).toBe(true);
    expect(await scanProfilesData(root, ["p"], "UTC")).toEqual(scan);
    const analytics = await scanTokenAnalyticsProfiles({ getConfig: () => ({ paths: { dataDir: root } }), listUserProfiles: () => [{ profileId: "p" }] } as never);
    expect(new Set(analytics.events.map(e => `${e.provider}/${e.modelId}`))).toEqual(new Set(["anthropic/claude-fable-5-1"]));
    expect(analytics.events.reduce((n, e) => n + e.usage.total, 0)).toBe(53);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("recovers only linked native histories and reconciles them with newly persisted counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-native-history-"));
  const { recoverNativeUsage } = await import("../stats/native-usage-history.js");
  const { getNativeCodexHome } = await import("../swarm/data-paths.js");
  const source = new StatsSourceCache(root);
  const claudeProjectsDir = join(root, "claude-projects");
  const dir = join(claudeProjectsDir, "project");
  const timestamp = "2026-09-20T10:00:00Z";
  const link = { type: "custom", customType: "swarm_native_claude_state", data: { version: 1, ownerAgentId: "owner", sessionId: "11111111-1111-1111-1111-111111111111", cwd: root } };
  const cumulative = { type: "custom", customType: "swarm_native_usage", data: { version: 1, provider: "claude-native", nativeSessionId: link.data.sessionId,
    counterId: "claude-fable-5-1", modelId: "claude-fable-5-1", reasoningLevel: "high", capturedAt: "2026-09-21T10:00:00Z", runtimeStartedAt: "2026-09-21T09:00:00Z",
    usage: { input: 20, output: 8, cacheRead: 40, cacheWrite: 4 } } };
  try {
    await mkdir(dir, { recursive: true });
    const row = { type: "assistant", timestamp, sessionId: link.data.sessionId, message: { id: "msg-1", model: "claude-fable-5-1",
      content: [{ text: "PRIVATE_CANARY" }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 } } };
    await writeFile(join(dir, `${link.data.sessionId}.jsonl`), [row, row, { ...row, timestamp: "2026-09-20T10:00:01Z", message: { ...row.message, usage: { ...row.message.usage, output_tokens: 5 } } },
      { ...row, timestamp: "2026-09-21T09:30:00Z", message: { ...row.message, id: "new-instrumented-turn" } },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const records = await recoverNativeUsage(root, [link, cumulative], "owner", { claudeProjectsDir });
    expect(records.at(-1)?.data.usage.total).toBe(37);
    expect(JSON.stringify(await source.read(join(dir, `${link.data.sessionId}.jsonl`)))).not.toContain("PRIVATE_CANARY");
    expect(await recoverNativeUsage(root, [link], "fork", { claudeProjectsDir })).toEqual([]);
    const nativeDir = join(getNativeCodexHome(root), "sessions/2026/09/20");
    await mkdir(nativeDir, { recursive: true });
    const codexId = "22222222-2222-2222-2222-222222222222";
    await writeFile(join(nativeDir, `rollout-2026-09-20T10-00-00-${codexId}.jsonl`), [
      { type: "session_meta", payload: { id: codexId } },
      { type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const codex = await recoverNativeUsage(root, [{ type: "custom", customType: "swarm_native_codex_state", data: { version: 1, ownerAgentId: "owner", threadId: codexId } }], "owner", { claudeProjectsDir });
    expect(codex[0]?.data).toMatchObject({ modelId: "gpt-6-sol", usage: { input: 20, output: 10, cacheRead: 80, total: 110 } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
