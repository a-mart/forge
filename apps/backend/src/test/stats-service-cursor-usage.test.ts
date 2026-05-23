import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StatsService } from "../stats/stats-service.js";
import { CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";

const activeRoots: string[] = [];
const PROFILE_ID = "profile-a";

afterEach(async () => {
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StatsService Cursor SDK usage aggregation", () => {
  it("includes Cursor SDK custom usage records in aggregate stats snapshots", async () => {
    const dataDir = await createCursorUsageDataDir();
    const service = new StatsService(createSwarmManagerStub(dataDir));

    const snapshot = await service.getSnapshot("all", { forceRefresh: true, timezone: "UTC" });

    expect(snapshot.tokens.allTime).toBe(48);
    expect(snapshot.cache).toEqual(expect.objectContaining({ hitRate: 14.29, cachedTokensSaved: 5 }));
    expect(snapshot.models).toEqual([
      expect.objectContaining({
        modelId: "cursor-sdk/composer-2.5",
        tokenCount: 48,
        reasoningBreakdown: expect.arrayContaining([
          expect.objectContaining({ level: "medium", tokenCount: 17 }),
          expect.objectContaining({ level: "default", tokenCount: 31 }),
        ]),
      }),
    ]);
    expect(snapshot.allProviders).toEqual(["cursor-sdk"]);
    expect(snapshot.workers.averageTokensPerRun).toBe(26);

    const cursorDay = snapshot.dailyUsage.find((entry) => entry.date === "2026-05-20");
    expect(cursorDay).toEqual(expect.objectContaining({
      tokens: 48,
      inputTokens: 30,
      outputTokens: 10,
      cachedTokens: 5,
    }));
  });
});

async function createCursorUsageDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-stats-service-cursor-"));
  activeRoots.push(root);
  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionDir = join(dataDir, "profiles", PROFILE_ID, "sessions", "session-one");
  const workersDir = join(sessionDir, "workers");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(workersDir, { recursive: true });
  await writeFile(join(swarmDir, "agents.json"), JSON.stringify({
    profiles: [{ profileId: PROFILE_ID }],
    agents: [
      { agentId: "session-one", role: "manager", status: "idle", profileId: PROFILE_ID },
      { agentId: "worker-cursor", managerId: "session-one", role: "worker", status: "idle" },
    ],
  }), "utf8");
  await writeJsonl(join(sessionDir, "session.jsonl"), [
    cursorUsageEntry("manager-usage", "2026-05-20T10:00:00.000Z", {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      total: 999,
    }, { reasoningLevel: "medium" }),
  ]);
  await writeJsonl(join(workersDir, "worker-cursor.jsonl"), [
    cursorUsageEntry("worker-usage", "2026-05-20T11:00:00.000Z", {
      input: 20,
      output: 6,
      cacheRead: 3,
      cacheWrite: 2,
      total: 555,
    }, { reasoningLevel: null }),
  ]);
  await writeFile(join(sessionDir, "meta.json"), JSON.stringify({
    workers: [{ id: "worker-cursor", createdAt: "2026-05-20T11:00:00.000Z", terminatedAt: "2026-05-20T11:01:00.000Z" }],
  }), "utf8");

  return dataDir;
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function cursorUsageEntry(
  id: string,
  timestamp: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
  options: { reasoningLevel: string | null }
): unknown {
  return {
    type: "custom",
    customType: CURSOR_SDK_USAGE_ENTRY_TYPE,
    id,
    timestamp,
    data: {
      version: 1,
      source: "cursor_sdk_on_delta_turn_ended",
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      reasoningLevel: options.reasoningLevel,
      usage,
      sdkRunId: "run-1",
      sdkAgentId: "sdk-agent-1",
      providerStatus: "FINISHED",
      runStatus: "finished",
      waitStatus: "finished",
      terminalStatus: "FINISHED",
      outcome: "completed",
      capturedAt: timestamp,
    },
  };
}

function createSwarmManagerStub(dataDir: string): any {
  return {
    getConfig: () => ({
      isDesktop: false,
      paths: {
        dataDir,
        rootDir: join(dataDir, "repo"),
        sharedAuthFile: join(dataDir, "shared", "config", "auth", "auth.json"),
        sharedCacheDir: join(dataDir, "shared", "cache"),
      },
    }),
    getCredentialPoolService: () => undefined,
  };
}
