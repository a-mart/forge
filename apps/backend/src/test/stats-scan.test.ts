import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProfilesData } from "../stats/stats-scan.js";
import { CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";

const tempDirs: string[] = [];

describe("scanProfilesData", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("counts active agents and manager repo paths identically for raw-minimal and normalized agent stores", async () => {
    const repoA = await createTempDir("forge-stats-repo-a-");
    const repoB = await createTempDir("forge-stats-repo-b-");

    const rawDataDir = await createStatsFixture({
      agents: rawMinimalAgents(repoA, repoB),
      sessionIds: ["session-one", "session-two"],
    });
    const normalizedDataDir = await createStatsFixture({
      agents: normalizedAgents(repoA, repoB),
      sessionIds: ["session-one", "session-two"],
    });

    const raw = await scanProfilesData(rawDataDir, [PROFILE_ID], "UTC");
    const normalized = await scanProfilesData(normalizedDataDir, [PROFILE_ID], "UTC");

    expect(raw.activeWorkerCount).toBe(3);
    expect(raw.activeSessionCount).toBe(5);
    expect(raw.managerRepoPaths).toEqual([resolve(repoA), resolve(repoB), resolve(repoB, "terminated")]);

    expect(normalized.activeWorkerCount).toBe(raw.activeWorkerCount);
    expect(normalized.activeSessionCount).toBe(raw.activeSessionCount);
    expect(normalized.managerRepoPaths).toEqual(raw.managerRepoPaths);
  });

  it("excludes archived sessions and projects from active counters while preserving historical session counts", async () => {
    const dataDir = await createStatsFixture({
      profiles: [{ profileId: "archived-profile", archivedAt: "2026-05-20T00:00:00.000Z" }],
      agents: [
        { agentId: "active-manager", role: "manager", status: "idle", profileId: PROFILE_ID },
        {
          agentId: "archived-session",
          role: "manager",
          status: "idle",
          profileId: PROFILE_ID,
          archivedAt: "2026-05-20T00:00:00.000Z",
        },
        { agentId: "archived-project-manager", role: "manager", status: "idle", profileId: "archived-profile" },
        { agentId: "active-worker", managerId: "active-manager", role: "worker", status: "streaming" },
        { agentId: "archived-session-worker", managerId: "archived-session", role: "worker", status: "streaming" },
        {
          agentId: "archived-project-worker",
          managerId: "archived-project-manager",
          role: "worker",
          status: "streaming",
        },
      ],
      sessionIds: ["session-one", "session-two", "session-three"],
    });

    const result = await scanProfilesData(dataDir, [PROFILE_ID], "UTC");

    expect(result.totalSessionCount).toBe(3);
    expect(result.activeSessionCount).toBe(1);
    expect(result.activeWorkerCount).toBe(1);
  });

  it("collects Cursor SDK custom usage records from manager and worker files", async () => {
    const dataDir = await createStatsFixture({
      agents: [
        { agentId: "session-one", role: "manager", status: "idle", profileId: PROFILE_ID },
        { agentId: "worker-cursor", managerId: "session-one", role: "worker", status: "idle" },
      ],
      sessionIds: ["session-one"],
    });
    const sessionDir = join(dataDir, "profiles", PROFILE_ID, "sessions", "session-one");
    await writeJsonl(join(sessionDir, "session.jsonl"), [
      cursorUsageEntry("manager-usage", "2026-05-20T10:00:00.000Z", {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        total: 999,
      }),
      cursorUsageEntry("invalid-timestamp", "not-a-date", { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 }, { capturedAt: "also-bad" }),
    ]);
    await mkdir(join(sessionDir, "workers"), { recursive: true });
    await writeJsonl(join(sessionDir, "workers", "worker-cursor.jsonl"), [
      cursorUsageEntry("worker-usage", "2026-05-20T11:00:00.000Z", {
        input: 20,
        output: 6,
        cacheRead: 3,
        cacheWrite: 2,
        total: 555,
      }, { reasoningLevel: null }),
    ]);
    await writeFile(join(sessionDir, "meta.json"), JSON.stringify({
      workers: [{ id: "worker-cursor", createdAt: "2026-05-20T11:00:00.000Z", terminatedAt: "2026-05-20T11:01:00.000Z" }]
    }), "utf8");

    const result = await scanProfilesData(dataDir, [PROFILE_ID], "UTC");

    expect(result.usageRecords).toEqual([
      expect.objectContaining({
        timestampMs: Date.parse("2026-05-20T10:00:00.000Z"),
        modelId: "cursor-sdk/composer-2.5",
        reasoningLevel: "medium",
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        total: 17,
      }),
      expect.objectContaining({
        timestampMs: Date.parse("2026-05-20T11:00:00.000Z"),
        modelId: "cursor-sdk/composer-2.5",
        reasoningLevel: "default",
        input: 20,
        output: 6,
        cacheRead: 3,
        cacheWrite: 2,
        total: 31,
      }),
    ]);
    expect(result.dailyUsage.get("2026-05-20")).toEqual({ input: 30, output: 10, cacheRead: 5, cacheWrite: 3, total: 48 });
    expect(result.workerRuns).toEqual([
      expect.objectContaining({ workerId: "worker-cursor", billableTokens: 26 })
    ]);
    expect(result.diagnostics.skippedMissingTimestampUsageRecords).toBe(1);
  });

  it("uses session directories, not agents.json managers, as the authoritative session count", async () => {
    const dataDir = await createStatsFixture({
      agents: [
        { id: "only-manager-in-store", role: "manager", status: "idle", cwd: join(tmpdir(), "forge-stats-authoritative") },
        { id: "streaming-worker", role: "worker", status: "streaming" },
      ],
      sessionIds: ["session-one", "session-two", "session-three"],
    });

    const result = await scanProfilesData(dataDir, [PROFILE_ID], "UTC");

    expect(result.totalSessionCount).toBe(3);
    expect(result.activeSessionCount).toBe(1);
    expect(result.activeWorkerCount).toBe(1);
  });

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});

const PROFILE_ID = "profile-a";

function rawMinimalAgents(repoA: string, repoB: string): unknown[] {
  return [
    { role: "worker", status: "streaming" },
    { role: "worker", status: "streaming" },
    { role: "worker", status: "idle" },
    { role: "worker", status: "stopped" },
    { role: "manager", status: "idle", cwd: repoA },
    { role: "manager", status: "streaming", cwd: repoB },
    { role: "manager", status: "paused", cwd: repoA },
    { role: "manager", status: "stopped", cwd: repoB },
    { role: "manager", status: "terminated", cwd: join(repoB, "terminated") },
    { role: "manager", status: "idle", cwd: "   " },
    { role: "worker", status: "streaming", cwd: join(repoA, "worker-cwd-is-ignored") },
    { role: "manager", status: "idle", cwd: 42 },
    { role: "not-a-real-role", status: "streaming", cwd: join(repoA, "invalid-role") },
    null,
    "malformed-agent",
    ["malformed-agent"],
  ];
}

function normalizedAgents(repoA: string, repoB: string): unknown[] {
  return rawMinimalAgents(repoA, repoB).map((agent, index) => {
    if (!isRecord(agent)) {
      return agent;
    }

    return {
      id: `agent-${index}`,
      name: `Agent ${index}`,
      provider: "openai",
      model: "gpt-5.1-codex-max",
      reasoningLevel: "medium",
      managerId: agent.role === "worker" ? "manager-one" : undefined,
      profileId: agent.role === "manager" ? PROFILE_ID : undefined,
      createdAt: "2026-05-05T00:00:00.000Z",
      lastActiveAt: "2026-05-05T00:01:00.000Z",
      sessionFile:
        agent.role === "manager" ? join("profiles", PROFILE_ID, "sessions", `agent-${index}`, "session.jsonl") : undefined,
      ...agent,
    };
  });
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function cursorUsageEntry(
  id: string,
  timestamp: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
  overrides: { capturedAt?: string; reasoningLevel?: string | null } = {}
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
      reasoningLevel: overrides.reasoningLevel === undefined ? "medium" : overrides.reasoningLevel,
      usage,
      sdkRunId: "run-1",
      sdkAgentId: "sdk-agent-1",
      providerStatus: "FINISHED",
      runStatus: "finished",
      waitStatus: "finished",
      terminalStatus: "FINISHED",
      outcome: "completed",
      capturedAt: overrides.capturedAt ?? timestamp,
    },
  };
}

async function createStatsFixture(options: { agents: unknown[]; sessionIds: string[]; profiles?: unknown[] }): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-stats-scan-"));
  tempDirs.push(dataDir);
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "profiles", PROFILE_ID, "sessions");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(swarmDir, "agents.json"), `${JSON.stringify({ agents: options.agents, profiles: options.profiles }, null, 2)}\n`, "utf8");

  for (const sessionId of options.sessionIds) {
    await mkdir(join(sessionsDir, sessionId), { recursive: true });
  }

  return dataDir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
