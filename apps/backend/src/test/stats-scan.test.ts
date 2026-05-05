import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProfilesData } from "../stats/stats-scan.js";

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

async function createStatsFixture(options: { agents: unknown[]; sessionIds: string[] }): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-stats-scan-"));
  tempDirs.push(dataDir);
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "profiles", PROFILE_ID, "sessions");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(swarmDir, "agents.json"), `${JSON.stringify({ agents: options.agents }, null, 2)}\n`, "utf8");

  for (const sessionId of options.sessionIds) {
    await mkdir(join(sessionsDir, sessionId), { recursive: true });
  }

  return dataDir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
