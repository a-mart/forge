import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelDescriptorFromPreset } from "../model-presets.js";
import type { PromptRegistry } from "../prompt-registry.js";
import { SecretsEnvService } from "../secrets-env-service.js";
import { SkillFileService } from "../skill-file-service.js";
import { SkillMetadataService } from "../skill-metadata-service.js";
import {
  SwarmConfigurationCoordinator,
  type SwarmConfigurationAccessPolicy,
} from "../swarm-configuration-coordinator.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeConfig(): Promise<SwarmConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), "forge-configuration-coordinator-"));
  cleanupPaths.push(rootDir);
  const dataDir = join(rootDir, "data");
  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    runtimeTarget: "builder",
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: resolveModelDescriptorFromPreset("pi-codex"),
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir],
    paths: {
      rootDir,
      dataDir,
      swarmDir: join(dataDir, "swarm"),
      uploadsDir: join(dataDir, "uploads"),
      agentsStoreFile: join(dataDir, "swarm", "agents.json"),
      profilesDir: join(dataDir, "profiles"),
      sharedDir: join(dataDir, "shared"),
      sharedConfigDir: join(dataDir, "shared", "config"),
      sharedCacheDir: join(dataDir, "shared", "cache"),
      sharedStateDir: join(dataDir, "shared", "state"),
      sharedAuthDir: join(dataDir, "shared", "config", "auth"),
      sharedAuthFile: join(dataDir, "shared", "config", "auth", "auth.json"),
      sharedSecretsFile: join(dataDir, "shared", "config", "secrets.json"),
      sessionsDir: join(dataDir, "sessions"),
      memoryDir: join(dataDir, "memory"),
      authDir: join(dataDir, "auth"),
      authFile: join(dataDir, "auth", "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir: join(rootDir, "agent"),
      managerAgentDir: join(rootDir, "manager-agent"),
      repoArchetypesDir: join(rootDir, "archetypes"),
      repoMemorySkillFile: join(rootDir, "memory-skill.md"),
    },
  };
}

function createManagerDescriptor(
  agentId: string,
  profileId = agentId,
  archetypeId?: string,
): AgentDescriptor & { role: "manager"; profileId: string } {
  return {
    agentId,
    profileId,
    role: "manager",
    status: "idle",
    label: agentId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    model: resolveModelDescriptorFromPreset("pi-codex"),
    modelOrigin: "profile_default",
    cwd: "/tmp",
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...(archetypeId ? { archetypeId } : {}),
  } as AgentDescriptor & { role: "manager"; profileId: string };
}

function createProfile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: resolveModelDescriptorFromPreset("pi-codex"),
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  } as ManagerProfile;
}

async function setup(input?: {
  descriptors?: AgentDescriptor[];
  profiles?: ManagerProfile[];
  access?: Partial<SwarmConfigurationAccessPolicy>;
}) {
  const config = await makeConfig();
  const descriptors = new Map((input?.descriptors ?? []).map((entry) => [entry.agentId, entry]));
  const profiles = new Map((input?.profiles ?? []).map((entry) => [entry.profileId, entry]));
  const skillMetadataService = new SkillMetadataService({ config });
  const secretsEnvService = new SecretsEnvService({
    config,
    ensureSkillMetadataLoaded: () => skillMetadataService.ensureSkillMetadataLoaded(),
    getSkillMetadata: () => skillMetadataService.getSkillMetadata(),
  });
  const access: SwarmConfigurationAccessPolicy = {
    assertManagerSettingsTargetNotArchived: vi.fn(),
    assertProfileNotArchived: vi.fn(),
    getRequiredBuilderSessionDescriptor: (agentId) => descriptors.get(agentId)!,
    getRequiredCollaborationSessionDescriptor: (agentId) => descriptors.get(agentId)!,
    assertDescriptorNotEffectivelyArchived: vi.fn(),
    ...input?.access,
  };
  const late = vi.fn(() => {
    throw new Error("late prompt dependency was read during configuration composition");
  });
  const sessionsForProfile = (profileId: string) =>
    Array.from(descriptors.values()).filter(
      (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
        descriptor.role === "manager" && descriptor.profileId === profileId,
    );

  const coordinator = new SwarmConfigurationCoordinator({
    config,
    defaultModelPreset: "pi-codex",
    descriptors,
    profiles,
    promptRegistry: {} as PromptRegistry,
    skillMetadataService,
    skillFileService: new SkillFileService(),
    secretsEnvService,
    sessions: {
      getSessionsForProfile: sessionsForProfile,
      getAllManagerSessions: () => Array.from(profiles.keys()).flatMap(sessionsForProfile),
      getSessionById: (agentId) => {
        const descriptor = descriptors.get(agentId);
        return descriptor?.role === "manager" && descriptor.profileId
          ? descriptor as AgentDescriptor & { role: "manager"; profileId: string }
          : undefined;
      },
    },
    access,
    persistence: {
      transactionDescriptors: late,
      saveStore: late,
      emitAgentsSnapshot: late,
      emitProfilesSnapshot: late,
    },
    prompt: {
      getAgentMemoryPath: late,
      ensureAgentMemoryFile: late,
      resolveMemoryOwnerAgentId: late,
      resolveSessionProfileId: late,
      refreshSessionMetaStats: late,
      refreshSessionMetaStatsBySessionId: late,
      getExternalProjectAgentDirectoryEntries: late,
      getKnowledgeV2Enabled: late,
    },
    applySpecialistAvailability: late,
    applyManagerRuntimeRecyclePolicy: late,
    now: () => "2026-07-13T00:00:00.000Z",
    logDebug: vi.fn(),
  });

  return { coordinator, access, late };
}

describe("SwarmConfigurationCoordinator", () => {
  it("composes explicit settings and prompt owners without reading late capabilities", async () => {
    const { coordinator, late } = await setup();

    expect(coordinator.settings).toBeDefined();
    expect(coordinator.promptResources).toBeDefined();
    expect(coordinator.prompts).toBeDefined();
    expect(coordinator.skills).toBeDefined();
    expect(coordinator.secrets).toBeDefined();
    expect(late).not.toHaveBeenCalled();
  });

  it("owns model-cache visualization state and default model resolution", async () => {
    const { coordinator } = await setup();

    expect(coordinator.isModelCacheVisualizationEnabled()).toBe(false);
    await coordinator.applyModelCacheVisualizationSettingsChange(true);

    expect(coordinator.isModelCacheVisualizationEnabled()).toBe(true);
    expect(coordinator.resolveDefaultModelDescriptor()).toEqual(
      resolveModelDescriptorFromPreset("pi-codex"),
    );
  });

  it("applies archive policy before model settings reach the state owner", async () => {
    const archivedGate = vi.fn(() => {
      throw new Error("archived manager");
    });
    const { coordinator, late } = await setup({
      access: { assertManagerSettingsTargetNotArchived: archivedGate },
    });

    await expect(coordinator.updateManagerModel("manager", "pi-codex"))
      .rejects.toThrow("archived manager");
    expect(archivedGate).toHaveBeenCalledWith("manager", "update manager model");
    expect(late).not.toHaveBeenCalled();
  });

  it("keeps the Cortex working-directory prohibition inside configuration policy", async () => {
    const descriptor = createManagerDescriptor("cortex", "cortex", "cortex");
    const { coordinator } = await setup({
      descriptors: [descriptor],
      profiles: [createProfile("cortex")],
    });

    await expect(coordinator.updateManagerCwd("cortex", "/tmp"))
      .rejects.toThrow("Cannot change working directory for Cortex profile");
  });

  it("fails clearly when the generated Pi model projection is requested before boot", async () => {
    const { coordinator } = await setup();

    expect(() => coordinator.getPiModelsJsonPathOrThrow())
      .toThrow("Pi model projection path is unavailable before SwarmManager boot completes.");
  });
});
