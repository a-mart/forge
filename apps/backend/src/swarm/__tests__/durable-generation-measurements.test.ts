import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1 } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { loadDurableGenerationMeasurements } from "../generation-throughput/durable-generation-measurements.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable generation measurements", () => {
  it("folds manager and worker terminal records before restart/bootstrap hydration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-generation-history-"));
    tempDirs.push(dataDir);
    const sessionDir = join(dataDir, "profiles", "profile-1", "sessions", "manager-1");
    const workersDir = join(sessionDir, "workers");
    await mkdir(workersDir, { recursive: true });
    const manager = terminalRecord("manager-call", "manager", "2026-07-01T00:00:02.000Z");
    const worker = terminalRecord("worker-call", "worker", "2026-07-01T00:00:04.000Z");
    await writeFile(join(sessionDir, "session.jsonl"), `${wrap(manager)}\n${wrap(worker)}\n`);
    await writeFile(join(workersDir, "worker-1.jsonl"), `${wrap(worker)}\n`);

    await expect(loadDurableGenerationMeasurements(dataDir, "profile-1", "manager-1"))
      .resolves.toEqual([manager, worker]);
  });
});

function terminalRecord(
  measurementId: string,
  role: "manager" | "worker",
  completedAt: string,
): GenerationMeasurementRecordV1 {
  return {
    version: 1,
    measurementId,
    recordState: "terminal",
    recordSequence: 2,
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt,
    identity: {
      profileId: "profile-1",
      sessionId: "manager-1",
      agentId: role === "manager" ? "manager-1" : "worker-1",
      managerId: "manager-1",
      role,
      specialistId: null,
      specialistAttributionKnown: role === "manager" ? null : true,
    },
    model: { provider: "openai", requestedModelId: "gpt-test", responseModelId: null, api: null, reasoningLevel: null },
    correlation: { turnId: null },
    timing: {
      responseStreamStartedAt: "2026-07-01T00:00:00.100Z",
      firstOutputAt: "2026-07-01T00:00:00.500Z",
      lastOutputAt: "2026-07-01T00:00:01.500Z",
      requestWallMs: 2000,
      timeToFirstOutputMs: 500,
      responseStreamOpenMs: 1900,
      generationDurationMs: 1500,
      interOutputSpanMs: 1000,
      boundarySource: "content_delta_to_stream_end",
    },
    usage: { outputTokens: 100, reasoningTokens: null, tokenSource: "provider_final" },
    outcome: "completed",
    reasoningBoundaryCoverage: "not_reported",
  };
}

function wrap(record: GenerationMeasurementRecordV1): string {
  return JSON.stringify({ type: "custom", customType: "swarm_generation_measurement", data: record });
}
