import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1 } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationThroughputService } from "../stats/generation-throughput-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GenerationThroughputService", () => {
  it("streams manager and worker records, folds global duplicates, and uses token-weighted throughput", async () => {
    const dataDir = await createFixtureData();
    const service = new GenerationThroughputService(createSwarmManager(dataDir) as never);

    const snapshot = await service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });

    expect(snapshot.totals).toMatchObject({
      allCallCount: 3,
      terminalCallCount: 2,
      measuredCallCount: 2,
      incompleteCallCount: 1,
      outputTokens: 150,
      generationDurationMs: 3000,
      weightedTokensPerSecond: 50,
      p50TokensPerSecond: 50,
      p90TokensPerSecond: 50,
      p50TimeToFirstOutputMs: 100,
      coverage: 1,
      timeToFirstOutputCoverage: 1,
    });
    expect(snapshot.byRole.map((entry) => [entry.role, entry.measuredCallCount])).toEqual([
      ["manager", 1],
      ["worker", 1],
    ]);
    expect(snapshot.models.map((entry) => [entry.provider, entry.modelId, entry.outputTokens])).toEqual([
      ["openai-codex", "gpt-test", 100],
      ["anthropic", "claude-test", 50],
    ]);
    expect(snapshot.diagnostics).toMatchObject({
      duplicateRecordCount: 1,
      conflictRecordCount: 0,
      malformedRecordCount: 1,
      startOnlyCallCount: 1,
      incompleteCallCount: 1,
    });
    expect(snapshot.trends).toHaveLength(2);

    const calls = await service.getCallsPage({ rangePreset: "all", timezone: "UTC", quality: "all_measured", limit: 1 });
    expect(calls.totalCount).toBe(2);
    expect(calls.items.map((call) => [call.measurementId, call.role, call.tokensPerSecond])).toEqual([
      ["worker-call", "worker", 50],
    ]);
    expect(calls.nextCursor).toEqual(expect.any(String));
    const nextCalls = await service.getCallsPage({
      rangePreset: "all", timezone: "UTC", quality: "all_measured", limit: 1, cursor: calls.nextCursor ?? undefined,
    });
    expect(nextCalls.items.map((call) => call.measurementId)).toEqual(["manager-call"]);
    expect(nextCalls.nextCursor).toBeNull();
  });

  it("does not restore an invalidated cache from an older in-flight scan", async () => {
    const dataDir = await createFixtureData();
    let resolveStale: ((value: ReturnType<typeof scanFixture>) => void) | undefined;
    let resolveFresh: ((value: ReturnType<typeof scanFixture>) => void) | undefined;
    const stale = new Promise<ReturnType<typeof scanFixture>>((resolve) => { resolveStale = resolve; });
    const fresh = new Promise<ReturnType<typeof scanFixture>>((resolve) => { resolveFresh = resolve; });
    const scanProfiles = vi.fn()
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(fresh);
    const service = new GenerationThroughputService(createSwarmManager(dataDir) as never, { scanProfiles: scanProfiles as never });

    const staleRequest = service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });
    await vi.waitFor(() => expect(scanProfiles).toHaveBeenCalledTimes(1));
    service.invalidateFromRuntimeCompletion();
    resolveStale?.(scanFixture("stale"));
    await staleRequest;

    const freshRequest = service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });
    await vi.waitFor(() => expect(scanProfiles).toHaveBeenCalledTimes(2));
    resolveFresh?.(scanFixture("fresh"));
    await freshRequest;
    await service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });

    expect(scanProfiles).toHaveBeenCalledTimes(2);
  });

  it("invalidates after the persisted terminal-completion signal", async () => {
    const dataDir = await createFixtureData();
    const manager = createSwarmManager(dataDir);
    const scanProfiles = vi.fn(async () => scanFixture("scan"));
    const service = new GenerationThroughputService(manager as never, { scanProfiles: scanProfiles as never });

    await service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });
    manager.emitPersistedTerminal({ recordState: "terminal" });
    await service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "all" });

    expect(scanProfiles).toHaveBeenCalledTimes(2);
  });

  it("keeps strict quality separate from proxy measurements and validates custom query windows", async () => {
    const dataDir = await createFixtureData();
    const service = new GenerationThroughputService(createSwarmManager(dataDir) as never);

    const strict = await service.getSnapshot({ rangePreset: "all", timezone: "UTC", quality: "strict" });
    expect(strict.totals.measuredCallCount).toBe(1);
    expect(strict.totals.outputTokens).toBe(100);
    expect(strict.totals.weightedTokensPerSecond).toBe(50);

    await expect(service.getSnapshot({ rangePreset: "custom", timezone: "UTC" })).rejects.toMatchObject({
      statusCode: 400,
      message: "custom rangePreset requires startDate and endDate",
    });
  });
});

async function createFixtureData(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-generation-throughput-"));
  tempDirs.push(dataDir);
  const sessionDir = join(dataDir, "profiles", "project-a", "sessions", "session-a");
  const workersDir = join(sessionDir, "workers");
  await mkdir(workersDir, { recursive: true });
  await writeFile(join(sessionDir, "meta.json"), JSON.stringify({ label: "Build throughput" }), "utf8");

  const managerTerminal = record({
    measurementId: "manager-call",
    role: "manager",
    outputTokens: 100,
    durationMs: 2000,
    completedAt: "2026-04-02T00:00:03.000Z",
    provider: "openai-codex",
    modelId: "gpt-test",
    boundarySource: "content_delta_to_stream_end",
  });
  const workerTerminal = record({
    measurementId: "worker-call",
    role: "worker",
    outputTokens: 50,
    durationMs: 1000,
    completedAt: "2026-04-02T00:00:20.000Z",
    provider: "anthropic",
    modelId: "claude-test",
    boundarySource: "response_stream_proxy",
  });
  const started = record({
    measurementId: "abandoned-call",
    role: "manager",
    state: "started",
    outputTokens: null,
    durationMs: null,
    completedAt: null,
    provider: "openai-codex",
    modelId: "gpt-test",
    boundarySource: "unavailable",
  });

  await writeFile(
    join(sessionDir, "session.jsonl"),
    [wrap(managerTerminal), wrap(started), wrap(workerTerminal), '{"type":"custom","customType":"swarm_generation_measurement","data":{"version":1}}'].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(workersDir, "worker-a.jsonl"), `${wrap(workerTerminal)}\n`, "utf8");
  return dataDir;
}

function record(input: {
  measurementId: string;
  role: "manager" | "worker";
  state?: "started" | "terminal";
  outputTokens: number | null;
  durationMs: number | null;
  completedAt: string | null;
  provider: string;
  modelId: string;
  boundarySource: GenerationMeasurementRecordV1["timing"]["boundarySource"];
}): GenerationMeasurementRecordV1 {
  const state = input.state ?? "terminal";
  const startedAt = "2026-04-02T00:00:00.000Z";
  const isTerminal = state === "terminal";
  return {
    version: 1,
    measurementId: input.measurementId,
    recordState: state,
    recordSequence: isTerminal ? 2 : 1,
    startedAt,
    completedAt: input.completedAt,
    identity: input.role === "manager"
      ? {
          profileId: "project-a", sessionId: "session-a", agentId: "session-a", managerId: "session-a", role: "manager",
          specialistId: null, specialistAttributionKnown: null,
        }
      : {
          profileId: "project-a", sessionId: "session-a", agentId: "worker-a", managerId: "session-a", role: "worker",
          specialistId: null, specialistAttributionKnown: true,
        },
    model: { provider: input.provider, requestedModelId: input.modelId, responseModelId: null, api: null, reasoningLevel: null },
    correlation: { turnId: "turn-a" },
    timing: {
      responseStreamStartedAt: isTerminal ? "2026-04-02T00:00:00.050Z" : null,
      firstOutputAt: isTerminal ? "2026-04-02T00:00:01.000Z" : null,
      lastOutputAt: isTerminal ? "2026-04-02T00:00:02.000Z" : null,
      requestWallMs: isTerminal ? 3000 : null,
      timeToFirstOutputMs: isTerminal ? 100 : null,
      responseStreamOpenMs: isTerminal ? 2950 : null,
      generationDurationMs: input.durationMs,
      interOutputSpanMs: isTerminal ? 1000 : null,
      boundarySource: input.boundarySource,
    },
    usage: { outputTokens: input.outputTokens, reasoningTokens: null, tokenSource: isTerminal ? "provider_final" : "unavailable" },
    outcome: isTerminal ? "completed" : "aborted",
    reasoningBoundaryCoverage: "not_reported",
  };
}

function wrap(record: GenerationMeasurementRecordV1): string {
  return JSON.stringify({ type: "custom", customType: "swarm_generation_measurement", data: record });
}

function scanFixture(scannedAt: string) {
  return {
    scannedAt,
    records: [],
    diagnostics: { malformedRecordCount: 0, duplicateRecordCount: 0, conflictRecordCount: 0, startOnlyCallCount: 0 },
  };
}

function createSwarmManager(dataDir: string) {
  let persistedListener: ((record: { recordState: "terminal" }) => void) | undefined;
  return {
    getConfig: () => ({ paths: { dataDir } }),
    listUserProfiles: () => [{ profileId: "project-a", displayName: "Project A" }],
    on: (event: string, listener: (record: { recordState: "terminal" }) => void) => {
      if (event === "generation_measurement_terminal_persisted") persistedListener = listener;
    },
    emitPersistedTerminal: (record: { recordState: "terminal" }) => persistedListener?.(record),
  };
}
