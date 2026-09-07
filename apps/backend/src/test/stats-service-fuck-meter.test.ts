import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsService } from "../stats/stats-service.js";

const activeRoots: string[] = [];
const PROFILE_ID = "profile-a";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StatsService fuck meter", () => {
  it("zero-fills the selected range independently of token days, including all-time user activity", async () => {
    const dataDir = await createFuckMeterDataDir();
    const service = new StatsService(createSwarmManagerStub(dataDir));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-21T12:00:00.000Z"));

    try {
      const week = await service.getSnapshot("7d", { forceRefresh: true, timezone: "UTC" });
      expect(week.dailyUsage.map((entry) => entry.date)).toEqual([
        "2026-05-15",
        "2026-05-16",
        "2026-05-17",
        "2026-05-18",
        "2026-05-19",
        "2026-05-20",
        "2026-05-21",
      ]);
      expect(week.fuckMeter?.daily).toEqual([
        { date: "2026-05-15", count: 0 },
        { date: "2026-05-16", count: 0 },
        { date: "2026-05-17", count: 0 },
        { date: "2026-05-18", count: 0 },
        { date: "2026-05-19", count: 0 },
        { date: "2026-05-20", count: 2 },
        { date: "2026-05-21", count: 1 },
      ]);
      expect(week.dailyUsage.find((entry) => entry.date === "2026-05-01")).toBeUndefined();

      const all = await service.getSnapshot("all", { forceRefresh: true, timezone: "UTC" });
      expect(all.dailyUsage[0]?.date).toBe("2026-05-20");
      expect(all.fuckMeter?.daily[0]?.date).toBe("2026-05-01");
      expect(all.fuckMeter?.daily).toEqual(
        expect.arrayContaining([
          { date: "2026-05-01", count: 1 },
          { date: "2026-05-02", count: 0 },
          { date: "2026-05-20", count: 2 },
          { date: "2026-05-21", count: 1 },
        ]),
      );
      expect(all.fuckMeter?.daily).toHaveLength(21);

      const chicago = await service.getSnapshot("7d", { forceRefresh: true, timezone: "America/Chicago" });
      expect(chicago.fuckMeter?.daily.find((entry) => entry.date === "2026-05-20")?.count).toBe(3);
      expect(chicago.fuckMeter?.daily.find((entry) => entry.date === "2026-05-21")?.count).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("recomputes and recaches fuckMeter on repeat refresh", async () => {
    const dataDir = await createFuckMeterDataDir();
    const service = new StatsService(createSwarmManagerStub(dataDir));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-21T12:00:00.000Z"));

    try {
      const first = await service.getSnapshot("7d", { forceRefresh: true, timezone: "UTC" });
      const cached = await service.getSnapshot("7d", { timezone: "UTC" });
      expect(cached.fuckMeter).toEqual(first.fuckMeter);

      const sessionDir = join(dataDir, "profiles", PROFILE_ID, "sessions", "session-one");
      await appendJsonl(join(sessionDir, "session.jsonl"), [
        conversationEntry({
          role: "user",
          source: "user_input",
          text: "another fuck",
          timestamp: "2026-05-21T08:00:00.000Z",
        }),
      ]);

      const refreshed = await service.getSnapshot("7d", { forceRefresh: true, timezone: "UTC" });
      expect(refreshed.fuckMeter?.daily.find((entry) => entry.date === "2026-05-21")?.count).toBe(2);
      expect(first.fuckMeter?.daily.find((entry) => entry.date === "2026-05-21")?.count).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

async function createFuckMeterDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-stats-service-fuck-"));
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
      { agentId: "worker-one", managerId: "session-one", role: "worker", status: "idle" },
    ],
  }), "utf8");
  await writeJsonl(join(sessionDir, "session.jsonl"), [
    conversationEntry({
      role: "user",
      source: "user_input",
      text: "early fuck",
      timestamp: "2026-05-01T12:00:00.000Z",
    }),
    conversationEntry({
      role: "user",
      source: "user_input",
      text: "Fuck this fucking messed up thing",
      timestamp: "2026-05-20T10:00:00.000Z",
      attachments: [{ name: "motherfucker.txt" }],
    }),
    conversationEntry({
      role: "assistant",
      source: "assistant_output",
      text: "assistant fucking reply",
      timestamp: "2026-05-20T10:01:00.000Z",
    }),
    conversationEntry({
      role: "user",
      source: "project_agent_input",
      text: "generated fucking delegation",
      timestamp: "2026-05-20T10:02:00.000Z",
    }),
    {
      type: "message",
      timestamp: "2026-05-20T10:04:00.000Z",
      message: {
        role: "user",
        content: "duplicate model user message: fuck",
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
      },
    },
  ]);
  await writeJsonl(join(workersDir, "worker-one.jsonl"), [
    conversationEntry({
      role: "user",
      source: "user_input",
      text: "worker chat: fuck this",
      timestamp: "2026-05-21T04:00:00.000Z",
    }),
  ]);
  await writeJsonl(join(workersDir, "worker-one.conversation.jsonl"), [
    conversationEntry({
      role: "user",
      source: "user_input",
      text: "sidecar duplicate fuck",
      timestamp: "2026-05-21T04:00:00.000Z",
    }),
  ]);

  return dataDir;
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function appendJsonl(path: string, entries: unknown[]): Promise<void> {
  await appendFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function conversationEntry(options: {
  role: string;
  source: string;
  text: string;
  timestamp: string;
  attachments?: unknown[];
}): unknown {
  return {
    type: "custom",
    customType: "swarm_conversation_entry",
    timestamp: options.timestamp,
    data: {
      type: "conversation_message",
      agentId: "session-one",
      role: options.role,
      text: options.text,
      timestamp: options.timestamp,
      source: options.source,
      attachments: options.attachments,
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
    getOpenAIAuthBrokerRuntimeService: () => ({ fetchUsageSnapshot: async () => null }),
  };
}
