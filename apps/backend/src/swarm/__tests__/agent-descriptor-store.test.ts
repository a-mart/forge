import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

function descriptor(config: SwarmConfig, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, "manager.jsonl"),
    ...overrides
  };
}

function profile(config: SwarmConfig, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager Profile",
    defaultSessionAgentId: "manager",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultModel: config.defaultModel,
    ...overrides
  };
}

async function writeStore(config: SwarmConfig, agents: unknown[], profiles: ManagerProfile[] = []): Promise<void> {
  await mkdir(join(config.paths.dataDir, "swarm"), { recursive: true });
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify({ agents, profiles }, null, 2)}\n`, "utf8");
}

function createStore(config: SwarmConfig): AgentDescriptorStore {
  return new AgentDescriptorStore({
    dataDir: config.paths.dataDir,
    storeFilePath: config.paths.agentsStoreFile,
    configuredManagerId: config.managerId,
    logDebug: vi.fn()
  });
}

describe("AgentDescriptorStore", () => {
  it("loads valid descriptors, skips malformed neighbors, and returns empty store for malformed files", async () => {
    const config = await makeTempConfig();
    const valid = descriptor(config, { agentId: "valid-manager" });
    await writeStore(config, [{ agentId: "broken", role: "manager" }, { displayName: "missing id" }, valid]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = createStore(config);
    await expect(store.load()).resolves.toEqual({ agents: [valid], profiles: [] });
    expect(store.snapshotForPersistence().agents).toEqual([valid]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("agentId=broken");
    expect(warn.mock.calls[1]?.[0]).toContain("index=1");
    warn.mockRestore();

    await writeFile(config.paths.agentsStoreFile, "not json", "utf8");
    await expect(createStore(config).load()).resolves.toEqual({ agents: [], profiles: [] });
  });

  it.each([
    [".forge", ".middleman"],
    ["forge", "middleman"]
  ])("normalizes legacy %s sessionFile paths from matching %s data directories", async (currentName, legacyName) => {
    const baseConfig = await makeTempConfig();
    const root = await mkdtemp(join(tmpdir(), "forge-store-path-normalization-"));
    const dataDir = resolve(root, currentName);
    const legacyDataDir = resolve(root, legacyName);
    const config: SwarmConfig = {
      ...baseConfig,
      paths: {
        ...baseConfig.paths,
        dataDir,
        swarmDir: join(dataDir, "swarm"),
        agentsStoreFile: join(dataDir, "swarm", "agents.json"),
        sessionsDir: join(dataDir, "sessions")
      }
    };
    const legacySessionFile = join(legacyDataDir, "profiles", "manager", "sessions", "manager", "session.jsonl");
    const currentSessionFile = join(dataDir, "profiles", "manager", "sessions", "manager", "session.jsonl");
    await writeStore(config, [descriptor(config, { sessionFile: legacySessionFile })]);

    const loaded = await createStore(config).load();

    expect(loaded.agents[0]?.sessionFile).toBe(currentSessionFile);
  });

  it("strips stale service-tier fields from persisted profile default models on load and save", async () => {
    const config = await makeTempConfig();
    const staleProfile = profile(config, {
      defaultModel: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        thinkingLevel: "xhigh",
        serviceTier: "priority"
      } as ManagerProfile["defaultModel"] & { serviceTier: string }
    });
    await writeStore(config, [descriptor(config)], [staleProfile]);

    const store = createStore(config);
    const loaded = await store.load();

    expect((loaded.profiles?.[0]?.defaultModel as ManagerProfile["defaultModel"] & { serviceTier?: unknown }).serviceTier).toBeUndefined();
    expect(loaded.profiles?.[0]?.defaultModel).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh"
    });

    await store.save();
    const persisted = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { profiles: ManagerProfile[] };
    expect((persisted.profiles[0]?.defaultModel as ManagerProfile["defaultModel"] & { serviceTier?: unknown }).serviceTier).toBeUndefined();
  });

  it("normalizes stopped_on_restart to stopped on load", async () => {
    const config = await makeTempConfig();
    await writeStore(config, [descriptor(config, { status: "stopped_on_restart" })]);

    const loaded = await createStore(config).load();

    expect(loaded.agents[0]?.status).toBe("stopped");
  });

  it("saves descriptors and profiles in stable manager-first sorted order", async () => {
    const config = await makeTempConfig();
    const store = createStore({ ...config, managerId: "configured" });
    store.replace({
      agents: [
        descriptor(config, { agentId: "worker-a", role: "worker", managerId: "configured", createdAt: "2026-01-01T00:00:00.000Z" }),
        descriptor(config, { agentId: "manager-b", createdAt: "2026-01-03T00:00:00.000Z" }),
        descriptor(config, { agentId: "configured", createdAt: "2026-01-04T00:00:00.000Z" }),
        descriptor(config, { agentId: "manager-a", createdAt: "2026-01-02T00:00:00.000Z" })
      ],
      profiles: [
        profile(config, { profileId: "z", sortOrder: 2 }),
        profile(config, { profileId: "configured", sortOrder: 9 }),
        profile(config, { profileId: "a", sortOrder: 1 })
      ]
    });

    await store.save();

    const persisted = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { agents: AgentDescriptor[]; profiles: ManagerProfile[] };
    expect(persisted.agents.map((agent) => agent.agentId)).toEqual(["configured", "manager-a", "manager-b", "worker-a"]);
    expect(persisted.profiles.map((item) => item.profileId)).toEqual(["configured", "a", "z"]);
  });

  it("keeps public and persisted project-agent prompt/source projections distinct", async () => {
    const config = await makeTempConfig();
    const projectAgentDescriptor = descriptor(config, {
      projectAgent: {
        handle: "docs",
        whenToUse: "Maintain docs.",
        systemPrompt: "Private project-agent prompt mirror.",
        creatorSessionId: "creator",
        capabilities: ["create_session"],
        source: {
          type: "repo",
          workspaceKey: "workspace-a",
          forgeDirRealpath: "/repo/.forge",
          definitionId: "docs",
          activatedAt: "2026-04-03T00:00:00.000Z"
        }
      }
    });
    const store = createStore(config);
    store.replace({ agents: [projectAgentDescriptor], profiles: [] });

    expect(store.get("manager")?.projectAgent).toEqual({
      handle: "docs",
      whenToUse: "Maintain docs.",
      creatorSessionId: "creator",
      capabilities: ["create_session"],
      sourceKind: "repo"
    });
    expect(store.snapshot().agents[0]?.projectAgent).not.toHaveProperty("systemPrompt");
    expect(store.snapshot().agents[0]?.projectAgent).not.toHaveProperty("source");
    expect(store.snapshot().agents[0]?.projectAgent?.sourceKind).toBe("repo");
    const publicProjectAgentJson = JSON.stringify(store.snapshot().agents[0]?.projectAgent);
    expect(publicProjectAgentJson).not.toContain("workspace-a");
    expect(publicProjectAgentJson).not.toContain("/repo/.forge");
    expect(publicProjectAgentJson).not.toContain("activatedAt");
    expect(store.getForPersistence("manager")?.projectAgent?.systemPrompt).toBe("Private project-agent prompt mirror.");
    expect(store.getForPersistence("manager")?.projectAgent?.source).toEqual({
      type: "repo",
      workspaceKey: "workspace-a",
      forgeDirRealpath: "/repo/.forge",
      definitionId: "docs",
      activatedAt: "2026-04-03T00:00:00.000Z"
    });

    await store.save();
    const persisted = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };
    expect(persisted.agents[0]?.projectAgent?.systemPrompt).toBe("Private project-agent prompt mirror.");
    expect(persisted.agents[0]?.projectAgent?.source).toEqual({
      type: "repo",
      workspaceKey: "workspace-a",
      forgeDirRealpath: "/repo/.forge",
      definitionId: "docs",
      activatedAt: "2026-04-03T00:00:00.000Z"
    });
  });

  it("rolls back in-memory changes when a transaction callback throws", async () => {
    const config = await makeTempConfig();
    const store = createStore(config);
    store.replace({ agents: [descriptor(config)], profiles: [profile(config)] });

    await expect(store.transaction(() => {
      store.patchDescriptor("manager", { displayName: "Changed" });
      store.deleteProfile("manager");
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(store.require("manager").displayName).toBe("Manager");
    expect(store.getProfile("manager")?.displayName).toBe("Manager Profile");
  });

  it("rolls back in-memory changes when transaction save fails", async () => {
    const config = await makeTempConfig();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId
    });
    store.replace({ agents: [descriptor(config)], profiles: [] });
    await writeFile(join(config.paths.dataDir, "missing-parent"), "file blocks mkdir", "utf8");

    await expect(store.transaction(() => {
      store.patchDescriptor("manager", { displayName: "Changed" });
    })).rejects.toThrow();

    expect(store.require("manager").displayName).toBe("Manager");
  });

  it("syncs rollback transactions back into external live maps when callbacks throw", async () => {
    const config = await makeTempConfig();
    const store = createStore(config);
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };

    await expect(store.transactionWithLiveMaps(liveMaps, (transactionStore) => {
      transactionStore.patchDescriptor("manager", { displayName: "Changed" });
      transactionStore.deleteProfile("manager");
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Manager");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Manager Profile");
    expect(store.require("manager").displayName).toBe("Manager");
  });

  it("syncs rollback transactions back into external live maps when save fails", async () => {
    const config = await makeTempConfig();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId
    });
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };
    await writeFile(join(config.paths.dataDir, "missing-parent"), "file blocks mkdir", "utf8");

    await expect(store.transactionWithLiveMaps(liveMaps, (transactionStore) => {
      transactionStore.patchDescriptor("manager", { displayName: "Changed" });
      transactionStore.patchProfile("manager", { displayName: "Changed Profile" });
    })).rejects.toThrow();

    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Manager");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Manager Profile");
    expect(store.require("manager").displayName).toBe("Manager");
  });

  it("preserves rollback transaction save failure semantics when onSaveError throws", async () => {
    const config = await makeTempConfig();
    const logDebug = vi.fn();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId,
      logDebug
    });
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };
    const callbackError = new Error("callback boom");
    let saveError: unknown;
    let thrownError: unknown;
    await writeFile(join(config.paths.dataDir, "missing-parent"), "file blocks mkdir", "utf8");

    try {
      await store.transactionWithLiveMaps(
        liveMaps,
        (transactionStore) => {
          transactionStore.patchDescriptor("manager", { displayName: "Changed" });
          transactionStore.patchProfile("manager", { displayName: "Changed Profile" });
        },
        {
          onSaveError: (error) => {
            saveError = error;
            throw callbackError;
          }
        }
      );
    } catch (error) {
      thrownError = error;
    }

    expect(saveError).toBeDefined();
    expect(thrownError).toBe(saveError);
    expect(thrownError).not.toBe(callbackError);
    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Manager");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Manager Profile");
    expect(store.require("manager").displayName).toBe("Manager");
    expect(logDebug).toHaveBeenCalledWith("agent-descriptor-store:on-save-error-callback-failed", { error: callbackError });
  });

  it("keeps external live-map mutations for best-effort transactions when save fails", async () => {
    const config = await makeTempConfig();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId
    });
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };
    const onSaveError = vi.fn();
    await writeFile(join(config.paths.dataDir, "missing-parent"), "file blocks mkdir", "utf8");

    await expect(store.transactionWithLiveMaps(
      liveMaps,
      (transactionStore) => {
        transactionStore.patchDescriptor("manager", { displayName: "Changed" });
        transactionStore.patchProfile("manager", { displayName: "Changed Profile" });
      },
      { saveMode: "best-effort", onSaveError }
    )).resolves.toBeUndefined();

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Changed");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Changed Profile");
    expect(store.require("manager").displayName).toBe("Changed");
  });

  it("patches one descriptor in live maps without saving or replacing unrelated objects", async () => {
    const config = await makeTempConfig();
    const store = createStore(config);
    const manager = descriptor(config, {
      projectAgent: {
        handle: "manager",
        whenToUse: "Use for management.",
        systemPrompt: "Private prompt."
      }
    });
    const worker = descriptor(config, { agentId: "worker", role: "worker", managerId: "manager" });
    const managerProfile = profile(config);
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", manager], ["worker", worker]]),
      profiles: new Map<string, ManagerProfile>([["manager", managerProfile]])
    };
    const persistedBefore = await readFile(config.paths.agentsStoreFile, "utf8");

    const updated = store.patchDescriptorInLiveMaps(liveMaps, "manager", { status: "streaming" });

    expect(updated?.status).toBe("streaming");
    expect(updated?.projectAgent).not.toHaveProperty("systemPrompt");
    expect(liveMaps.descriptors.get("manager")?.status).toBe("streaming");
    expect(liveMaps.descriptors.get("manager")?.projectAgent?.systemPrompt).toBe("Private prompt.");
    expect(liveMaps.descriptors.get("worker")).toBe(worker);
    expect(liveMaps.profiles.get("manager")).toBe(managerProfile);
    await expect(readFile(config.paths.agentsStoreFile, "utf8")).resolves.toBe(persistedBefore);
  });

  it("preserves best-effort transaction mutations when onSaveError throws", async () => {
    const config = await makeTempConfig();
    const logDebug = vi.fn();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId,
      logDebug
    });
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };
    const callbackError = new Error("callback boom");
    let saveError: unknown;
    await writeFile(join(config.paths.dataDir, "missing-parent"), "file blocks mkdir", "utf8");

    await expect(store.transactionWithLiveMaps(
      liveMaps,
      (transactionStore) => {
        transactionStore.patchDescriptor("manager", { displayName: "Changed" });
        transactionStore.patchProfile("manager", { displayName: "Changed Profile" });
      },
      {
        saveMode: "best-effort",
        onSaveError: (error) => {
          saveError = error;
          throw callbackError;
        }
      }
    )).resolves.toBeUndefined();

    expect(saveError).toBeDefined();
    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Changed");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Changed Profile");
    expect(store.require("manager").displayName).toBe("Changed");
    expect(logDebug).toHaveBeenCalledWith("agent-descriptor-store:on-save-error-callback-failed", { error: callbackError });
  });
});
