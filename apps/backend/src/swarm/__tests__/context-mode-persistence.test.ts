import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import { SwarmSettingsService } from "../swarm-settings-service.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

function descriptor(config: { defaultCwd: string; defaultModel: AgentDescriptor["model"]; paths: { sessionsDir: string } }, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor & { role: "manager"; profileId: string } {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    profileId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, "manager.jsonl"),
    ...overrides,
  };
}

function profile(config: { defaultModel: AgentDescriptor["model"] }, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager Profile",
    defaultSessionAgentId: "manager",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultModel: config.defaultModel,
    ...overrides,
  };
}

describe("context mode persistence", () => {
  it("survives project fresh, session summary override, and inherit restore across store reopen", async () => {
    const config = await makeTempConfig();
    await mkdir(join(config.paths.dataDir, "swarm"), { recursive: true });
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: config.paths.agentsStoreFile,
      configuredManagerId: config.managerId,
      logDebug: vi.fn(),
    });
    const session = descriptor(config);
    const managerProfile = profile(config);
    const profiles = new Map([["manager", { ...managerProfile }]]);
    const sessions = [{ ...session }];
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const persistLiveMaps = async () => {
      store.replace({
        agents: sessions,
        profiles: Array.from(profiles.values()),
      });
      await store.save();
    };
    await persistLiveMaps();

    const service = new SwarmSettingsService({
      config,
      profiles,
      skillMetadataService: {} as never,
      skillFileService: {} as never,
      secretsEnvService: {} as never,
      getSessionsForProfile: (profileId) => sessions.filter((item) => item.profileId === profileId),
      getAllManagerSessions: () => sessions,
      getSessionById: (agentId) => sessions.find((item) => item.agentId === agentId),
      resolveAndValidateCwd: async (cwd) => cwd,
      assertCanChangeManagerCwd: () => {},
      applyManagerRuntimeRecyclePolicy,
      hasActiveSecureSession: () => false,
      stopSecureSessionForLifecycle: async () => undefined,
      beginSecureSessionLifecycleFence: async () => "fence",
      cancelSecureSessionLifecycleFence: async () => undefined,
      completeSecureSessionLifecycleFence: async () => undefined,
      saveStore: persistLiveMaps,
      emitAgentsSnapshot: vi.fn(),
      emitProfilesSnapshot: vi.fn(),
      logDebug: vi.fn(),
    });

    await service.updateProjectContextMode("manager", "fresh");
    const afterProject = await new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: config.paths.agentsStoreFile,
    }).load();
    expect(afterProject.profiles?.[0]?.defaultContextMode).toBe("fresh");
    expect(afterProject.agents[0]?.contextModeOverride).toBeUndefined();

    await service.updateSessionContextMode("manager", "summary");
    const afterOverride = await new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: config.paths.agentsStoreFile,
    }).load();
    expect(afterOverride.profiles?.[0]?.defaultContextMode).toBe("fresh");
    expect(afterOverride.agents[0]?.contextModeOverride).toBe("summary");

    await service.updateSessionContextMode("manager", null);
    const afterInherit = await new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: config.paths.agentsStoreFile,
    }).load();
    expect(afterInherit.profiles?.[0]?.defaultContextMode).toBe("fresh");
    expect(afterInherit.agents[0]?.contextModeOverride).toBeUndefined();
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });
});
