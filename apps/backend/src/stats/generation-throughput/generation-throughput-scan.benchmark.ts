import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1, ManagerProfile } from "@forge/protocol";
import type { SwarmConfig } from "../../swarm/types.js";
import { buildGenerationMetrics, buildGenerationModelSummaries, buildGenerationRoleSummaries } from "./generation-throughput-aggregate.js";
import { scanGenerationThroughputProfiles } from "./generation-throughput-scan.js";

const TOTAL_SOURCE_RECORDS = 100_000;
const DUPLICATE_RECORDS = 10_000;
const UNIQUE_RECORDS = TOTAL_SOURCE_RECORDS - DUPLICATE_RECORDS;
const MEASURED_TERMINAL_RECORDS = 70_000;
const UNMEASURED_TERMINAL_RECORDS = 10_000;
const STARTED_RECORDS = UNIQUE_RECORDS - MEASURED_TERMINAL_RECORDS - UNMEASURED_TERMINAL_RECORDS;
const PROFILE_ID = "benchmark-profile";
const SESSION_ID = "benchmark-session";

interface BenchmarkManager {
  getConfig: () => SwarmConfig;
  listUserProfiles: () => ManagerProfile[];
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-generation-throughput-benchmark-"));
  try {
    const fixtureBytes = await writeFixture(dataDir);
    if (globalThis.gc) globalThis.gc();

    const before = process.memoryUsage().rss;
    const scanStartedAt = performance.now();
    const result = await scanGenerationThroughputProfiles(createManager(dataDir));
    const scanElapsedMs = performance.now() - scanStartedAt;
    const afterScan = process.memoryUsage().rss;

    const aggregateStartedAt = performance.now();
    const metrics = buildGenerationMetrics(result.records);
    const roles = buildGenerationRoleSummaries(result.records);
    const models = buildGenerationModelSummaries(result.records);
    const aggregateElapsedMs = performance.now() - aggregateStartedAt;
    const afterAggregate = process.memoryUsage().rss;

    const expectedOutputTokens = expectedMeasuredOutputTokens();
    const expectedGenerationDurationMs = expectedMeasuredGenerationDurationMs();
    const checks = {
      sourceRecordCount: TOTAL_SOURCE_RECORDS,
      foldedRecordCount: result.records.length,
      expectedFoldedRecordCount: UNIQUE_RECORDS,
      duplicateRecordCount: result.diagnostics.duplicateRecordCount,
      malformedRecordCount: result.diagnostics.malformedRecordCount,
      terminalCallCount: metrics.terminalCallCount,
      expectedTerminalCallCount: MEASURED_TERMINAL_RECORDS + UNMEASURED_TERMINAL_RECORDS,
      measuredCallCount: metrics.measuredCallCount,
      expectedMeasuredCallCount: MEASURED_TERMINAL_RECORDS,
      incompleteCallCount: metrics.incompleteCallCount,
      expectedIncompleteCallCount: STARTED_RECORDS,
      outputTokens: metrics.outputTokens,
      expectedOutputTokens,
      generationDurationMs: metrics.generationDurationMs,
      expectedGenerationDurationMs,
      roleCountTotal: roles.reduce((sum, role) => sum + role.allCallCount, 0),
      modelCountTotal: models.models.reduce((sum, model) => sum + model.allCallCount, 0),
    };
    assertChecks(checks);

    const report = {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      command: "cd apps/backend && pnpm exec node --expose-gc --import tsx src/stats/generation-throughput/generation-throughput-scan.benchmark.ts",
      fixture: {
        sourceRecordCount: TOTAL_SOURCE_RECORDS,
        uniqueRecordCount: UNIQUE_RECORDS,
        duplicateRecordCount: DUPLICATE_RECORDS,
        bytes: fixtureBytes,
        location: "os.tmpdir() (removed after run)",
      },
      elapsedMs: {
        scan: round(scanElapsedMs),
        aggregation: round(aggregateElapsedMs),
        total: round(scanElapsedMs + aggregateElapsedMs),
      },
      rssMiB: {
        before: roundMiB(before),
        afterScan: roundMiB(afterScan),
        afterAggregate: roundMiB(afterAggregate),
        growthAfterScan: roundMiB(afterScan - before),
        growthAfterAggregate: roundMiB(afterAggregate - before),
      },
      budgets: {
        scanElapsedUnder5s: scanElapsedMs < 5_000,
        rssGrowthUnder200MiB: afterAggregate - before < 200 * 1024 * 1024,
      },
      checks,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.budgets.scanElapsedUnder5s || !report.budgets.rssGrowthUnder200MiB) {
      throw new Error(`benchmark budget failed: ${JSON.stringify(report.budgets)}`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeFixture(dataDir: string): Promise<number> {
  const sessionDir = join(dataDir, "profiles", PROFILE_ID, "sessions", SESSION_ID);
  const workersDir = join(sessionDir, "workers");
  await mkdir(workersDir, { recursive: true });
  await writeFile(join(sessionDir, "meta.json"), JSON.stringify({ label: "100k scan benchmark" }), "utf8");

  const uniqueLines: string[] = [];
  const duplicateLines: string[] = [];
  for (let index = 0; index < UNIQUE_RECORDS; index += 1) {
    const record = createRecord(index);
    const line = JSON.stringify({ type: "custom", customType: "swarm_generation_measurement", data: record });
    uniqueLines.push(line);
    if (index < DUPLICATE_RECORDS) duplicateLines.push(line);
  }
  await writeFile(join(sessionDir, "session.jsonl"), `${uniqueLines.join("\n")}\n`, "utf8");
  await writeFile(join(workersDir, "worker-benchmark.jsonl"), `${duplicateLines.join("\n")}\n`, "utf8");
  return (await stat(join(sessionDir, "session.jsonl"))).size + (await stat(join(workersDir, "worker-benchmark.jsonl"))).size;
}

function createManager(dataDir: string): BenchmarkManager {
  return {
    getConfig: () => ({ paths: { dataDir } } as SwarmConfig),
    listUserProfiles: () => [{
      profileId: PROFILE_ID,
      displayName: "Benchmark Profile",
      defaultSessionAgentId: SESSION_ID,
      defaultModel: { provider: "openai-codex", modelId: "gpt-benchmark", thinkingLevel: "none" },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
  };
}

function createRecord(index: number): GenerationMeasurementRecordV1 {
  const isMeasured = index < MEASURED_TERMINAL_RECORDS;
  const isTerminal = index < MEASURED_TERMINAL_RECORDS + UNMEASURED_TERMINAL_RECORDS;
  const startedAt = "2026-07-01T00:00:00.000Z";
  const completedAt = isTerminal ? "2026-07-01T00:00:02.000Z" : null;
  const durationMs = isMeasured ? 1_000 + (index % 5) : null;
  const role = index % 2 === 0 ? "manager" : "worker";
  return {
    version: 1,
    measurementId: `benchmark-${String(index).padStart(6, "0")}`,
    recordState: isTerminal ? "terminal" : "started",
    recordSequence: isTerminal ? 2 : 1,
    startedAt,
    completedAt,
    identity: {
      profileId: PROFILE_ID,
      sessionId: SESSION_ID,
      agentId: role === "manager" ? SESSION_ID : "worker-benchmark",
      managerId: SESSION_ID,
      role,
      specialistId: null,
      specialistAttributionKnown: role === "manager" ? null : true,
    },
    model: {
      provider: index % 2 === 0 ? "openai-codex" : "anthropic",
      requestedModelId: index % 2 === 0 ? "gpt-benchmark" : "claude-benchmark",
      responseModelId: null,
      api: null,
      reasoningLevel: null,
    },
    correlation: { turnId: null },
    timing: {
      responseStreamStartedAt: isMeasured ? "2026-07-01T00:00:00.100Z" : null,
      firstOutputAt: isMeasured ? "2026-07-01T00:00:00.500Z" : null,
      lastOutputAt: isMeasured ? "2026-07-01T00:00:01.500Z" : null,
      requestWallMs: isMeasured ? 1_500 : null,
      timeToFirstOutputMs: isMeasured ? 500 : null,
      responseStreamOpenMs: isMeasured ? 1_400 : null,
      generationDurationMs: durationMs,
      interOutputSpanMs: isMeasured ? durationMs : null,
      boundarySource: isMeasured ? "content_delta_to_stream_end" : "unavailable",
    },
    usage: {
      outputTokens: isMeasured ? 100 + (index % 11) : null,
      reasoningTokens: null,
      tokenSource: isMeasured ? "provider_final" : "unavailable",
    },
    outcome: isTerminal ? "completed" : "aborted",
    reasoningBoundaryCoverage: "not_reported",
  };
}

function expectedMeasuredOutputTokens(): number {
  let total = 0;
  for (let index = 0; index < MEASURED_TERMINAL_RECORDS; index += 1) total += 100 + (index % 11);
  return total;
}

function expectedMeasuredGenerationDurationMs(): number {
  let total = 0;
  for (let index = 0; index < MEASURED_TERMINAL_RECORDS; index += 1) total += 1_000 + (index % 5);
  return total;
}

function assertChecks(checks: Record<string, number>): void {
  const expectedPairs: Array<[string, string]> = [
    ["foldedRecordCount", "expectedFoldedRecordCount"],
    ["terminalCallCount", "expectedTerminalCallCount"],
    ["measuredCallCount", "expectedMeasuredCallCount"],
    ["incompleteCallCount", "expectedIncompleteCallCount"],
    ["outputTokens", "expectedOutputTokens"],
    ["generationDurationMs", "expectedGenerationDurationMs"],
    ["roleCountTotal", "expectedFoldedRecordCount"],
    ["modelCountTotal", "expectedFoldedRecordCount"],
  ];
  for (const [actualKey, expectedKey] of expectedPairs) {
    if (checks[actualKey] !== checks[expectedKey]) {
      throw new Error(`benchmark correctness check failed: ${actualKey}=${checks[actualKey]} expected ${expectedKey}=${checks[expectedKey]}`);
    }
  }
  if (checks.duplicateRecordCount !== DUPLICATE_RECORDS || checks.malformedRecordCount !== 0) {
    throw new Error(`benchmark diagnostics check failed: ${JSON.stringify(checks)}`);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundMiB(value: number): number {
  return round(value / (1024 * 1024));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
