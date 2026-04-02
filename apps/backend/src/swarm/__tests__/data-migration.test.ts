import * as fs from "node:fs/promises";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import {
  getLegacyAgentMemoryPath,
  getLegacyAuthFilePath,
  getLegacySecretsFilePath,
  getLegacySessionFilePath,
  getProfileIntegrationsDir,
  getProfileMemoryPath,
  getProfileScheduleFilePath,
  getSessionFilePath,
  getSessionMemoryPath,
  getSessionMetaPath,
  getSharedDir,
  getWorkerSessionFilePath
} from "../data-paths.js";
import { migrateDataDirectory } from "../data-migration.js";
import type { AgentDescriptor } from "../types.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.3-codex",
  thinkingLevel: "xhigh"
};

const FIXED_TIMESTAMP = "2026-03-02T00:00:00.000Z";

describe("data-migration", () => {
  it("migrates flat legacy data into profile-scoped hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";
    const nonRootSessionId = "manager--s2";
    const workerId = "worker-a";

    const agents: AgentDescriptor[] = [
      createManagerDescriptor(rootSessionId, profileId),
      createManagerDescriptor(nonRootSessionId),
      createWorkerDescriptor(workerId, nonRootSessionId)
    ];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });

    await writeText(getLegacyAgentMemoryPath(dataDir, rootSessionId), "root-memory\n");
    await writeText(getLegacyAgentMemoryPath(dataDir, nonRootSessionId), "session-memory\n");

    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    await writeText(getLegacySessionFilePath(dataDir, nonRootSessionId), "session\n");
    await writeText(getLegacySessionFilePath(dataDir, workerId), "worker\n");

    await writeJson(join(dataDir, "schedules", `${profileId}.json`), {
      schedules: [{ id: "profile-schedule", name: "profile" }]
    });
    await writeJson(join(dataDir, "schedules", `${nonRootSessionId}.json`), {
      schedules: [{ id: "session-schedule", name: "session" }]
    });

    await writeJson(getLegacyAuthFilePath(dataDir), { provider: "openai-codex" });
    await writeJson(getLegacySecretsFilePath(dataDir), { OPENAI_API_KEY: "secret" });

    await writeJson(join(dataDir, "integrations", "shared", "shared.json"), { enabled: true });
    await writeJson(join(dataDir, "integrations", "managers", profileId, "profile.json"), {
      profileId,
      enabled: true
    });

    const result = await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles
    );

    expect(result.migrated).toBe(true);

    await expect(readFile(getProfileMemoryPath(dataDir, profileId), "utf8")).resolves.toBe("root-memory\n");
    await expect(readFile(getSessionMemoryPath(dataDir, profileId, nonRootSessionId), "utf8")).resolves.toBe(
      "session-memory\n"
    );

    await expect(readFile(getSessionFilePath(dataDir, profileId, rootSessionId), "utf8")).resolves.toBe("root-session\n");
    await expect(readFile(getSessionFilePath(dataDir, profileId, nonRootSessionId), "utf8")).resolves.toBe("session\n");
    await expect(
      readFile(getWorkerSessionFilePath(dataDir, profileId, nonRootSessionId, workerId), "utf8")
    ).resolves.toBe("worker\n");

    const migratedSchedules = JSON.parse(
      await readFile(getProfileScheduleFilePath(dataDir, profileId), "utf8")
    ) as { schedules: Array<{ id: string; sessionId?: string }> };
    expect(migratedSchedules.schedules.map((schedule) => schedule.id)).toEqual([
      "profile-schedule",
      "session-schedule"
    ]);
    expect(migratedSchedules.schedules).toEqual([
      { id: "profile-schedule", name: "profile" },
      { id: "session-schedule", name: "session", sessionId: nonRootSessionId }
    ]);

    await expect(readFile(join(getSharedDir(dataDir), "auth", "auth.json"), "utf8")).resolves.toContain(
      "openai-codex"
    );
    await expect(readFile(join(getSharedDir(dataDir), "secrets.json"), "utf8")).resolves.toContain(
      "OPENAI_API_KEY"
    );
    await expect(readFile(join(getSharedDir(dataDir), "integrations", "shared.json"), "utf8")).resolves.toContain(
      "enabled"
    );
    await expect(
      readFile(join(getProfileIntegrationsDir(dataDir, profileId), "profile.json"), "utf8")
    ).resolves.toContain(profileId);

    const migratedStore = JSON.parse(await readFile(agentsStoreFile, "utf8")) as {
      agents: AgentDescriptor[];
      profiles: ManagerProfile[];
    };

    const rootSessionDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === rootSessionId);
    const nonRootSessionDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === nonRootSessionId);
    const workerDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === workerId);

    expect(rootSessionDescriptor?.sessionFile).toBe(getSessionFilePath(dataDir, profileId, rootSessionId));
    expect(nonRootSessionDescriptor?.sessionFile).toBe(getSessionFilePath(dataDir, profileId, nonRootSessionId));
    expect(nonRootSessionDescriptor?.profileId).toBe(profileId);
    expect(workerDescriptor?.sessionFile).toBe(
      getWorkerSessionFilePath(dataDir, profileId, nonRootSessionId, workerId)
    );
    expect(workerDescriptor?.profileId).toBe(profileId);

    const rootMeta = JSON.parse(
      await readFile(getSessionMetaPath(dataDir, profileId, rootSessionId), "utf8")
    ) as { sessionId: string };
    const nonRootMeta = JSON.parse(
      await readFile(getSessionMetaPath(dataDir, profileId, nonRootSessionId), "utf8")
    ) as { sessionId: string };

    expect(rootMeta.sessionId).toBe(rootSessionId);
    expect(nonRootMeta.sessionId).toBe(nonRootSessionId);

    await expect(stat(join(dataDir, "profiles", nonRootSessionId))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(stat(join(dataDir, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "schedules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "auth"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "integrations"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "secrets.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const sentinel = await readFile(join(dataDir, ".migration-v1-done"), "utf8");
    expect(sentinel.trim().length).toBeGreaterThan(0);
  });

  it.each(["EXDEV", "EPERM"])("falls back to copy when hardlinking session files fails with %s", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-link-fallback-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";

    const agents: AgentDescriptor[] = [createManagerDescriptor(rootSessionId, profileId)];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });
    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    const sourceStatsBeforeMigration = await stat(getLegacySessionFilePath(dataDir, rootSessionId));

    const failingLinkError = Object.assign(new Error("link failed"), { code });
    const linkMock = vi.fn(async () => {
      throw failingLinkError;
    });

    await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles,
      {},
      {
        fileOps: {
          link: linkMock,
          copyFile: (sourcePath, destinationPath, mode) => fs.copyFile(sourcePath, destinationPath, mode)
        }
      }
    );

    expect(linkMock).toHaveBeenCalledTimes(1);

    const migratedPath = getSessionFilePath(dataDir, profileId, rootSessionId);
    await expect(readFile(migratedPath, "utf8")).resolves.toBe("root-session\n");

    const targetStats = await stat(migratedPath);
    expect(targetStats.ino).not.toBe(sourceStatsBeforeMigration.ino);
    await expect(stat(getLegacySessionFilePath(dataDir, rootSessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats ENOENT from the hardlink path as a benign no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-link-enoent-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";

    const agents: AgentDescriptor[] = [createManagerDescriptor(rootSessionId, profileId)];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });
    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");

    const linkMock = vi.fn(async () => {
      throw Object.assign(new Error("source disappeared"), { code: "ENOENT" });
    });
    const copyMock = vi.fn(async () => undefined);

    await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles,
      {},
      {
        fileOps: {
          link: linkMock,
          copyFile: copyMock
        }
      }
    );

    expect(linkMock).toHaveBeenCalledTimes(1);
    expect(copyMock).not.toHaveBeenCalled();
    await expect(stat(getSessionFilePath(dataDir, profileId, rootSessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips migration when sentinel exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-sentinel-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";

    const agents: AgentDescriptor[] = [createManagerDescriptor(rootSessionId, profileId)];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });
    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    await writeText(join(dataDir, ".migration-v1-done"), "already-ran\n");

    const result = await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles
    );

    expect(result.migrated).toBe(false);

    const migratedPath = getSessionFilePath(dataDir, profileId, rootSessionId);
    await expect(stat(migratedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const stored = JSON.parse(await readFile(agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };
    expect(stored.agents[0]?.sessionFile).toContain(`sessions/${rootSessionId}.jsonl`);
  });
});

function createManagerDescriptor(agentId: string, profileId?: string): AgentDescriptor {
  const descriptor: AgentDescriptor = {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    status: "idle",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    cwd: "/tmp/project",
    model: { ...DEFAULT_MODEL },
    sessionFile: join(tmpdir(), `.forge/sessions/${agentId}.jsonl`)
  };

  if (profileId) {
    descriptor.profileId = profileId;
  }

  return descriptor;
}

function createWorkerDescriptor(workerId: string, managerId: string): AgentDescriptor {
  return {
    agentId: workerId,
    displayName: workerId,
    role: "worker",
    managerId,
    status: "idle",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    cwd: "/tmp/project",
    model: { ...DEFAULT_MODEL },
    sessionFile: join(tmpdir(), `.forge/sessions/${workerId}.jsonl`)
  };
}

function createProfile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
