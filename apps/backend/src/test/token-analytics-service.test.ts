import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { TokenAnalyticsService } from "../stats/token-analytics-service.js";
import { getProfileSpecialistsDir, getSharedSpecialistsDir } from "../swarm/specialists/specialist-paths.js";

interface TestContext {
  rootDir: string;
  dataDir: string;
  service: TokenAnalyticsService;
}

describe("TokenAnalyticsService", () => {
  let context: TestContext;

  beforeEach(async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "token-analytics-"));
    const dataDir = join(rootDir, "data");
    await seedAnalyticsFixture(dataDir);

    const swarmManager = {
      getConfig: () => ({
        paths: {
          dataDir,
        },
      }),
      listProfiles: () => createProfiles(),
    } as Pick<SwarmManager, "getConfig" | "listProfiles"> as SwarmManager;

    context = {
      rootDir,
      dataDir,
      service: new TokenAnalyticsService(swarmManager),
    };
  });

  afterEach(async () => {
    context.service.clearCache();
    vi.restoreAllMocks();
  });

  it("builds token analytics snapshots with attribution, filters, specialist metadata, and cost coverage", async () => {
    const snapshot = await context.service.getSnapshot({
      rangePreset: "all",
      timezone: "UTC",
      provider: "openai-codex",
    });

    expect(snapshot.totals.runCount).toBe(3);
    expect(snapshot.totals.eventCount).toBe(3);
    expect(snapshot.totals.usage.total).toBe(28);
    expect(snapshot.totals.cost.costCoverage).toBe("partial");
    expect(snapshot.totals.cost.costCoveredEventCount).toBe(2);
    expect(snapshot.query.provider).toBe("openai-codex");

    expect(snapshot.availableFilters.providers.map((entry) => entry.provider)).toEqual([
      "anthropic",
      "openai-codex",
      "xai",
    ]);
    expect(snapshot.availableFilters.specialists).toEqual([
      expect.objectContaining({
        specialistId: "backend",
        displayName: "Backend Specialist",
        hasProfileVariants: true,
        runCount: 2,
        usage: expect.objectContaining({ total: 39 }),
      }),
    ]);

    expect(snapshot.attribution.specialist.runCount).toBe(2);
    expect(snapshot.attribution.specialist.usage.total).toBe(21);
    expect(snapshot.attribution.adHoc.runCount).toBe(1);
    expect(snapshot.attribution.adHoc.usage.total).toBe(7);
    expect(snapshot.attribution.unknown.runCount).toBe(0);

    expect(snapshot.specialistBreakdown[0]).toEqual(
      expect.objectContaining({
        specialistId: "backend",
        displayName: "Backend Specialist",
        hasProfileVariants: true,
        runCount: 2,
        usage: expect.objectContaining({ total: 21 }),
        topModelId: "gpt-5.4",
        topModelProvider: "openai-codex",
        topProfileId: "beta",
        topProfileDisplayName: "Beta",
      })
    );
  });

  it("filters snapshots by specialistId even without an attribution filter", async () => {
    const snapshot = await context.service.getSnapshot({
      rangePreset: "all",
      timezone: "UTC",
      specialistId: "backend",
    });

    expect(snapshot.query.specialistId).toBe("backend");
    expect(snapshot.query.attribution).toBe("all");
    expect(snapshot.totals.runCount).toBe(2);
    expect(snapshot.totals.eventCount).toBe(3);
    expect(snapshot.totals.usage.total).toBe(39);
    expect(snapshot.attribution.specialist.runCount).toBe(2);
    expect(snapshot.attribution.adHoc.runCount).toBe(0);
    expect(snapshot.attribution.unknown.runCount).toBe(0);
    expect(snapshot.specialistBreakdown).toEqual([
      expect.objectContaining({
        specialistId: "backend",
        attributionKind: "specialist",
        runCount: 2,
        usage: expect.objectContaining({ total: 39 }),
      }),
    ]);
  });

  it("composes specialistId with attribution filters instead of discarding it", async () => {
    const snapshot = await context.service.getSnapshot({
      rangePreset: "all",
      timezone: "UTC",
      specialistId: "backend",
      attribution: "ad_hoc",
    });

    expect(snapshot.query.specialistId).toBe("backend");
    expect(snapshot.query.attribution).toBe("ad_hoc");
    expect(snapshot.totals.runCount).toBe(0);
    expect(snapshot.totals.eventCount).toBe(0);
    expect(snapshot.totals.usage.total).toBe(0);
    expect(snapshot.specialistBreakdown).toEqual([]);
  });

  it("skips malformed usage rows with missing or invalid timestamps", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await appendWorkerEvent(
      join(context.dataDir, "profiles", "alpha", "sessions", "alpha", "workers", "worker-adhoc.jsonl"),
      {
        type: "message",
        message: {
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 8,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 13,
          },
        },
      }
    );
    await appendWorkerEvent(
      join(context.dataDir, "profiles", "alpha", "sessions", "alpha", "workers", "worker-adhoc.jsonl"),
      {
        type: "message",
        timestamp: "not-a-timestamp",
        message: {
          timestamp: "still-not-a-timestamp",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 4,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
          },
        },
      }
    );

    const snapshot = await context.service.getSnapshot(
      { rangePreset: "all", timezone: "UTC" },
      { forceRefresh: true }
    );

    expect(snapshot.totals.eventCount).toBe(5);
    expect(snapshot.totals.usage.total).toBe(55);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0]).toContain(
      "Skipped 2 usage events with missing or invalid timestamps during scan"
    );
  });

  it("paginates worker summaries and returns per-worker event drill-down", async () => {
    const firstPage = await context.service.getWorkerPage({
      rangePreset: "all",
      timezone: "UTC",
      sort: "totalTokens",
      direction: "desc",
      limit: 2,
    });

    expect(firstPage.totalCount).toBe(4);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items[0]).toEqual(
      expect.objectContaining({
        workerId: "worker-specialist",
        sessionLabel: "Alpha Session",
        specialistDisplayName: "Backend Specialist",
        attributionKind: "specialist",
        usage: expect.objectContaining({ total: 28 }),
        cost: expect.objectContaining({
          costCoverage: "partial",
          costCoveredEventCount: 1,
        }),
      })
    );
    expect(firstPage.items[0]?.modelsUsed).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929", totalTokens: 18 },
      { provider: "openai-codex", modelId: "gpt-5.4", totalTokens: 10 },
    ]);

    const secondPage = await context.service.getWorkerPage({
      rangePreset: "all",
      timezone: "UTC",
      sort: "totalTokens",
      direction: "desc",
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.items[0]).toEqual(
      expect.objectContaining({
        workerId: "worker-unknown",
        attributionKind: "unknown",
      })
    );
    expect(secondPage.items[1]).toEqual(
      expect.objectContaining({
        workerId: "worker-adhoc",
        attributionKind: "ad_hoc",
      })
    );

    const workerEvents = await context.service.getWorkerEvents({
      profileId: "alpha",
      sessionId: "alpha",
      workerId: "worker-specialist",
    });

    expect(workerEvents.worker).toEqual(
      expect.objectContaining({
        workerId: "worker-specialist",
        reasoningLevels: ["high", "low"],
        usage: expect.objectContaining({ total: 28 }),
      })
    );
    expect(workerEvents.events).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
        usage: expect.objectContaining({ total: 18 }),
      }),
      expect.objectContaining({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        usage: expect.objectContaining({ total: 10 }),
      }),
    ]);
  });

  it("reuses cached raw scan results until a force refresh is requested", async () => {
    const initial = await context.service.getSnapshot({ rangePreset: "all", timezone: "UTC" });
    expect(initial.totals.usage.total).toBe(55);

    await appendWorkerEvent(
      join(context.dataDir, "profiles", "alpha", "sessions", "alpha", "workers", "worker-adhoc.jsonl"),
      {
        type: "message",
        timestamp: "2026-04-06T11:05:00.000Z",
        message: {
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 3,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5,
          },
        },
      }
    );

    const cached = await context.service.getSnapshot({ rangePreset: "all", timezone: "UTC" });
    expect(cached.totals.usage.total).toBe(55);

    const refreshed = await context.service.getSnapshot(
      { rangePreset: "all", timezone: "UTC" },
      { forceRefresh: true }
    );
    expect(refreshed.totals.usage.total).toBe(60);
  });
});

function createProfiles(): ManagerProfile[] {
  return [
    {
      profileId: "alpha",
      displayName: "Alpha",
      defaultSessionAgentId: "alpha",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
    {
      profileId: "beta",
      displayName: "Beta",
      defaultSessionAgentId: "beta",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
}

async function seedAnalyticsFixture(dataDir: string): Promise<void> {
  await writeSpecialistFile(
    join(getSharedSpecialistsDir(dataDir), "backend.md"),
    [
      "---",
      'displayName: "Backend Specialist"',
      'color: "#7c3aed"',
      "enabled: true",
      'whenToUse: "Backend implementation"',
      'modelId: "gpt-5.4"',
      'provider: "openai-codex"',
      "---",
      "You are a backend specialist.",
      "",
    ].join("\n")
  );

  await writeSpecialistFile(
    join(getProfileSpecialistsDir(dataDir, "beta"), "backend.md"),
    [
      "---",
      'displayName: "Beta Backend"',
      'color: "#2563eb"',
      "enabled: true",
      'whenToUse: "Backend implementation for beta"',
      'modelId: "gpt-5.4"',
      'provider: "openai-codex"',
      "---",
      "You are a beta backend specialist.",
      "",
    ].join("\n")
  );

  await writeSession(
    dataDir,
    "alpha",
    "alpha",
    "Alpha Session",
    [
      {
        id: "worker-specialist",
        specialistId: "backend",
        specialistAttributionKnown: true,
        createdAt: "2026-04-02T10:00:00.000Z",
        terminatedAt: "2026-04-02T10:30:00.000Z",
      },
      {
        id: "worker-adhoc",
        specialistId: null,
        specialistAttributionKnown: true,
        createdAt: "2026-04-03T11:00:00.000Z",
        terminatedAt: "2026-04-03T11:05:00.000Z",
      },
      {
        id: "worker-unknown",
        specialistId: null,
        createdAt: "2026-04-04T12:00:00.000Z",
        terminatedAt: "2026-04-04T12:07:00.000Z",
      },
    ],
    {
      "worker-specialist": [
        {
          type: "message",
          timestamp: "2026-04-02T10:01:00.000Z",
          message: {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
            reasoningLevel: "high",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 2,
              cacheWrite: 1,
              totalTokens: 18,
              cost: {
                input: 0.1,
                output: 0.05,
                cacheRead: 0.02,
                cacheWrite: 0.01,
                total: 0.18,
              },
            },
          },
        },
        {
          type: "message",
          timestamp: "2026-04-02T10:02:00.000Z",
          message: {
            provider: "openai-codex",
            model: "gpt-5.4",
            reasoningLevel: "low",
            usage: {
              input: 6,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 10,
            },
          },
        },
      ],
      "worker-adhoc": [
        {
          type: "message",
          timestamp: "2026-04-03T11:01:00.000Z",
          message: {
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {
              input: 3,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 7,
              cost: {
                input: 0.03,
                output: 0.04,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.07,
              },
            },
          },
        },
      ],
      "worker-unknown": [
        {
          type: "message",
          timestamp: "2026-04-04T12:02:00.000Z",
          message: {
            provider: "xai",
            model: "grok-4",
            usage: {
              input: 5,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 9,
            },
          },
        },
      ],
    }
  );

  await writeSession(
    dataDir,
    "beta",
    "beta",
    null,
    [
      {
        id: "worker-beta-specialist",
        specialistId: "backend",
        specialistAttributionKnown: true,
        createdAt: "2026-04-05T09:00:00.000Z",
        terminatedAt: "2026-04-05T09:04:00.000Z",
      },
    ],
    {
      "worker-beta-specialist": [
        {
          type: "message",
          timestamp: "2026-04-05T09:01:00.000Z",
          message: {
            provider: "openai-codex",
            model: "gpt-5.4",
            reasoningLevel: "medium",
            usage: {
              input: 6,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 11,
              cost: {
                input: 0.06,
                output: 0.05,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.11,
              },
            },
          },
        },
      ],
    }
  );
}

async function writeSpecialistFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeSession(
  dataDir: string,
  profileId: string,
  sessionId: string,
  label: string | null,
  workers: Array<{
    id: string;
    specialistId: string | null;
    specialistAttributionKnown?: boolean;
    createdAt: string;
    terminatedAt: string | null;
  }>,
  workerEvents: Record<string, unknown[]>
): Promise<void> {
  const sessionDir = join(dataDir, "profiles", profileId, "sessions", sessionId);
  const workersDir = join(sessionDir, "workers");
  await mkdir(workersDir, { recursive: true });

  await writeFile(
    join(sessionDir, "meta.json"),
    JSON.stringify(
      {
        sessionId,
        profileId,
        label,
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.4",
        },
        createdAt: workers[0]?.createdAt ?? "2026-04-01T00:00:00.000Z",
        updatedAt: workers[workers.length - 1]?.terminatedAt ?? workers[0]?.createdAt ?? "2026-04-01T00:00:00.000Z",
        cwd: "/tmp/project",
        promptFingerprint: null,
        promptComponents: null,
        workers: workers.map((worker) => ({
          id: worker.id,
          model: "openai-codex/gpt-5.4",
          specialistId: worker.specialistId,
          ...(worker.specialistAttributionKnown === undefined
            ? {}
            : { specialistAttributionKnown: worker.specialistAttributionKnown }),
          status: "terminated",
          createdAt: worker.createdAt,
          terminatedAt: worker.terminatedAt,
          tokens: {
            input: 0,
            output: 0,
          },
        })),
        stats: {
          totalWorkers: workers.length,
          activeWorkers: 0,
          totalTokens: {
            input: 0,
            output: 0,
          },
          sessionFileSize: null,
          memoryFileSize: null,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const [workerId, events] of Object.entries(workerEvents)) {
    await writeFile(
      join(workersDir, `${workerId}.jsonl`),
      events.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8"
    );
  }
}

async function appendWorkerEvent(path: string, event: unknown): Promise<void> {
  const original = await readFile(path, "utf8");
  await writeFile(path, `${original}${JSON.stringify(event)}\n`, "utf8");
}
