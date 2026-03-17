import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@forge/protocol";
import {
  getRootSessionMemoryPath,
  getSessionFilePath,
  getSessionMetaPath,
  getSessionMemoryPath
} from "../data-paths.js";
import {
  readSessionMeta,
  rebuildSessionMeta,
  updateSessionMetaStats,
  updateSessionMetaWorker,
  writeSessionMeta
} from "../session-manifest.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.3-codex",
  thinkingLevel: "xhigh"
};

describe("session-manifest", () => {
  it("writes and reads meta files atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");

    const meta: SessionMeta = {
      sessionId: "manager",
      profileId: "manager",
      label: "Main",
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.3-codex"
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      cwd: "/tmp/project",
      promptFingerprint: null,
      promptComponents: null,
      cortexReviewExcludedAt: "2026-03-01T00:10:00.000Z",
      lastMemoryMergeAttemptId: "manager--s2:2026-03-01T00:00:00.000Z",
      lastMemoryMergeProfileHashBefore: "before-hash",
      lastMemoryMergeProfileHashAfter: "after-hash",
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    };

    await writeSessionMeta(dataDir, meta);

    const path = getSessionMetaPath(dataDir, "manager", "manager");
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const roundTrip = await readSessionMeta(dataDir, "manager", "manager");
    expect(roundTrip).toEqual(meta);
  });

  it("readSessionMeta returns undefined for missing or malformed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");

    await expect(readSessionMeta(dataDir, "manager", "manager")).resolves.toBeUndefined();

    const metaPath = getSessionMetaPath(dataDir, "manager", "manager");
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await writeFile(metaPath, "{ not-json", "utf8");

    await expect(readSessionMeta(dataDir, "manager", "manager")).resolves.toBeUndefined();
  });

  it("rebuilds meta files from agents.json and filesystem stats", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const rootSessionId = "manager";
    const profileId = "manager";
    const nonRootSessionId = "manager--s2";

    const rootSessionFile = getSessionFilePath(dataDir, profileId, rootSessionId);
    const nonRootSessionFile = getSessionFilePath(dataDir, profileId, nonRootSessionId);
    const rootMemoryFile = getRootSessionMemoryPath(dataDir, profileId);
    const nonRootMemoryFile = getSessionMemoryPath(dataDir, profileId, nonRootSessionId);

    await mkdir(join(dataDir, "swarm"), { recursive: true });
    await mkdir(join(dataDir, "profiles", profileId, "sessions", rootSessionId), { recursive: true });
    await mkdir(join(dataDir, "profiles", profileId, "sessions", nonRootSessionId), { recursive: true });

    await writeFile(rootSessionFile, "root-session", "utf8");
    await writeFile(nonRootSessionFile, "child-session", "utf8");
    await writeFile(rootMemoryFile, "root-memory", "utf8");
    await writeFile(nonRootMemoryFile, "child-memory", "utf8");

    const createdAt = "2026-03-01T00:00:00.000Z";
    const updatedAt = "2026-03-01T00:00:01.000Z";

    const agentsStore = {
      agents: [
        {
          agentId: rootSessionId,
          displayName: rootSessionId,
          role: "manager",
          managerId: rootSessionId,
          profileId,
          status: "idle",
          createdAt,
          updatedAt,
          cwd: "/tmp/root",
          model: DEFAULT_MODEL,
          sessionFile: rootSessionFile
        },
        {
          agentId: nonRootSessionId,
          displayName: nonRootSessionId,
          role: "manager",
          managerId: nonRootSessionId,
          profileId,
          status: "idle",
          createdAt,
          updatedAt,
          cwd: "/tmp/child",
          model: DEFAULT_MODEL,
          sessionFile: nonRootSessionFile,
          sessionLabel: "Child"
        },
        {
          agentId: "worker-a",
          displayName: "worker-a",
          role: "worker",
          managerId: rootSessionId,
          profileId,
          status: "terminated",
          createdAt,
          updatedAt,
          cwd: "/tmp/root",
          model: DEFAULT_MODEL,
          sessionFile: join(dataDir, "profiles", profileId, "sessions", rootSessionId, "workers", "worker-a.jsonl")
        },
        {
          agentId: "worker-b",
          displayName: "worker-b",
          role: "worker",
          managerId: nonRootSessionId,
          profileId,
          status: "streaming",
          createdAt,
          updatedAt,
          cwd: "/tmp/child",
          model: DEFAULT_MODEL,
          sessionFile: join(
            dataDir,
            "profiles",
            profileId,
            "sessions",
            nonRootSessionId,
            "workers",
            "worker-b.jsonl"
          )
        }
      ]
    };

    await writeFile(agentsStoreFile, `${JSON.stringify(agentsStore, null, 2)}\n`, "utf8");

    const rebuilt = await rebuildSessionMeta({
      dataDir,
      agentsStoreFile
    });

    expect(rebuilt).toHaveLength(2);

    const rootMeta = await readSessionMeta(dataDir, profileId, rootSessionId);
    expect(rootMeta?.workers.map((worker) => worker.id)).toEqual(["worker-a"]);
    expect(rootMeta?.workers[0]?.status).toBe("terminated");
    expect(rootMeta?.stats.sessionFileSize).toBe(String("root-session".length));
    expect(rootMeta?.stats.memoryFileSize).toBe(String("root-memory".length));
    expect(rootMeta?.cortexReviewedMemoryBytes).toBe("root-memory".length);
    expect(rootMeta?.cortexReviewedMemoryAt).toBeNull();

    const childMeta = await readSessionMeta(dataDir, profileId, nonRootSessionId);
    expect(childMeta?.label).toBe("Child");
    expect(childMeta?.workers.map((worker) => worker.id)).toEqual(["worker-b"]);
    expect(childMeta?.workers[0]?.status).toBe("streaming");
    expect(childMeta?.stats.activeWorkers).toBe(1);
    expect(childMeta?.stats.sessionFileSize).toBe(String("child-session".length));
    expect(childMeta?.stats.memoryFileSize).toBe(String("child-memory".length));
    expect(childMeta?.cortexReviewedMemoryBytes).toBe("child-memory".length);
    expect(childMeta?.cortexReviewedMemoryAt).toBeNull();
  });

  it("updates worker metadata incrementally", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");
    const profileId = "manager";
    const sessionId = "manager--s2";

    const meta: SessionMeta = {
      sessionId,
      profileId,
      label: "Session",
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.3-codex"
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      cwd: "/tmp/project",
      promptFingerprint: null,
      promptComponents: null,
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    };

    await writeSessionMeta(dataDir, meta);

    await updateSessionMetaWorker(
      dataDir,
      profileId,
      sessionId,
      {
        id: "worker-a",
        model: "openai-codex/gpt-5.3-codex",
        status: "streaming",
        createdAt: "2026-03-01T00:00:10.000Z",
        tokens: {
          input: 120,
          output: 15
        }
      },
      () => "2026-03-01T00:00:11.000Z"
    );

    await updateSessionMetaWorker(
      dataDir,
      profileId,
      sessionId,
      {
        id: "worker-a",
        status: "terminated",
        terminatedAt: "2026-03-01T00:00:20.000Z",
        tokens: {
          input: 180,
          output: 25
        }
      },
      () => "2026-03-01T00:00:21.000Z"
    );

    const updated = await readSessionMeta(dataDir, profileId, sessionId);
    expect(updated?.workers).toHaveLength(1);
    expect(updated?.workers[0]?.status).toBe("terminated");
    expect(updated?.workers[0]?.terminatedAt).toBe("2026-03-01T00:00:20.000Z");
    expect(updated?.stats.totalWorkers).toBe(1);
    expect(updated?.stats.activeWorkers).toBe(0);
    expect(updated?.stats.totalTokens).toEqual({ input: 180, output: 25 });
  });

  it("refreshes file size stats", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");
    const profileId = "manager";
    const sessionId = "manager";

    const sessionFile = getSessionFilePath(dataDir, profileId, sessionId);
    const memoryFile = getRootSessionMemoryPath(dataDir, profileId);

    await mkdir(join(dataDir, "profiles", profileId, "sessions", sessionId), { recursive: true });
    await writeFile(sessionFile, "session-payload", "utf8");
    await writeFile(memoryFile, "memory-payload", "utf8");

    await writeSessionMeta(dataDir, {
      sessionId,
      profileId,
      label: null,
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.3-codex"
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      cwd: "/tmp/project",
      promptFingerprint: null,
      promptComponents: null,
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    });

    const refreshed = await updateSessionMetaStats(dataDir, profileId, sessionId);
    expect(refreshed?.stats.sessionFileSize).toBe(String("session-payload".length));
    expect(refreshed?.stats.memoryFileSize).toBe(String("memory-payload".length));
    expect(refreshed?.cortexReviewedMemoryBytes).toBe("memory-payload".length);
    expect(refreshed?.cortexReviewedMemoryAt).toBeNull();
  });

  it("does not overwrite existing memory watermarks on stats refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");
    const profileId = "manager";
    const sessionId = "manager";

    const sessionFile = getSessionFilePath(dataDir, profileId, sessionId);
    const memoryFile = getRootSessionMemoryPath(dataDir, profileId);
    const reviewedAt = "2026-03-02T00:00:00.000Z";

    await mkdir(join(dataDir, "profiles", profileId, "sessions", sessionId), { recursive: true });
    await writeFile(sessionFile, "session-payload", "utf8");
    await writeFile(memoryFile, "memory-payload-updated", "utf8");

    await writeSessionMeta(dataDir, {
      sessionId,
      profileId,
      label: null,
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.3-codex"
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      cwd: "/tmp/project",
      promptFingerprint: null,
      promptComponents: null,
      cortexReviewedMemoryBytes: 10,
      cortexReviewedMemoryAt: reviewedAt,
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    });

    const refreshed = await updateSessionMetaStats(dataDir, profileId, sessionId);
    expect(refreshed?.stats.memoryFileSize).toBe(String("memory-payload-updated".length));
    expect(refreshed?.cortexReviewedMemoryBytes).toBe(10);
    expect(refreshed?.cortexReviewedMemoryAt).toBe(reviewedAt);
  });
});
