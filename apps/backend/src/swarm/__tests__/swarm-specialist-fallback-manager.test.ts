import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath } from "../data-paths.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import { RuntimeCallbackGate } from "../runtime/runtime-callback-gate.js";
import { SwarmSpecialistFallbackManager } from "../swarm-specialist-fallback-manager.js";
import { SwarmWorkerHealthService } from "../swarm-worker-health-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import { FakeRuntime, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";

async function makeTempConfig(port = 8898): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "swarm-specialist-fallback-test-"));
  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "sessions");
  const uploadsDir = join(dataDir, "uploads");
  const profilesDir = join(dataDir, "profiles");
  const sharedDir = join(dataDir, "shared");
  const sharedConfigDir = join(sharedDir, "config");
  const sharedCacheDir = join(sharedDir, "cache");
  const sharedStateDir = join(sharedDir, "state");
  const sharedAuthDir = join(sharedConfigDir, "auth");
  const sharedAuthFile = join(sharedAuthDir, "auth.json");
  const sharedSecretsFile = join(sharedConfigDir, "secrets.json");
  const sharedIntegrationsDir = join(sharedConfigDir, "integrations");
  const authDir = join(dataDir, "auth");
  const agentDir = join(dataDir, "agent");
  const managerAgentDir = join(agentDir, "manager");
  const repoArchetypesDir = join(root, ".swarm", "archetypes");
  const memoryDir = join(dataDir, "memory");
  const memoryFile = getProfileMemoryPath(dataDir, "manager");
  const repoMemorySkillFile = join(root, ".swarm", "skills", "memory", "SKILL.md");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(sharedAuthDir, { recursive: true });
  await mkdir(sharedIntegrationsDir, { recursive: true });
  await mkdir(sharedCacheDir, { recursive: true });
  await mkdir(sharedStateDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(managerAgentDir, { recursive: true });
  await mkdir(repoArchetypesDir, { recursive: true });

  return {
    host: "127.0.0.1",
    port,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, "worktrees")],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, "agents.json"),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager")
    }
  };
}

function buildWorkerDescriptor(config: SwarmConfig, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  const now = new Date().toISOString();
  const agentId = overrides.agentId ?? "worker-spec";
  const sessionFile = join(config.paths.sessionsDir, `${agentId}.jsonl`);
  return {
    agentId,
    displayName: agentId,
    role: "worker",
    managerId: "mgr-1",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: config.defaultCwd,
    sessionFile,
    specialistId: "backend",
    profileId: "profile-1",
    model: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function runtimeBindingOptionHelpers(
  runtimes: Map<string, SwarmAgentRuntime>,
  runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>,
  runtimeTokensByAgentId: Map<string, number>
) {
  return {
    getRuntime: (agentId: string) => runtimes.get(agentId),
    isRuntime: (agentId: string, runtime: SwarmAgentRuntime) => runtimes.get(agentId) === runtime,
    getRuntimeToken: (agentId: string) => runtimeTokensByAgentId.get(agentId),
    clearRuntimeToken: (agentId: string, runtimeToken?: number) => {
      if (runtimeToken !== undefined && runtimeTokensByAgentId.get(agentId) !== runtimeToken) {
        return;
      }
      runtimeTokensByAgentId.delete(agentId);
    },
    restoreRuntimeTokenForFallbackRollback: (agentId: string, runtimeToken: number) => {
      runtimeTokensByAgentId.set(agentId, runtimeToken);
    },
    getRuntimeCreationPromise: (agentId: string) => runtimeCreationPromisesByAgentId.get(agentId),
    setRuntimeCreationPromise: (agentId: string, promise: Promise<SwarmAgentRuntime>) => {
      runtimeCreationPromisesByAgentId.set(agentId, promise);
    },
    clearRuntimeCreationPromiseIfCurrent: (agentId: string, promise: Promise<SwarmAgentRuntime>) => {
      if (runtimeCreationPromisesByAgentId.get(agentId) !== promise) {
        return false;
      }
      runtimeCreationPromisesByAgentId.delete(agentId);
      return true;
    },
    detachRuntimeIfMatches: (agentId: string, expectedRuntime: SwarmAgentRuntime, runtimeToken?: number) => {
      if (runtimes.get(agentId) !== expectedRuntime) {
        return false;
      }
      if (runtimeToken !== undefined && runtimeTokensByAgentId.get(agentId) !== runtimeToken) {
        return false;
      }
      runtimes.delete(agentId);
      if (runtimeToken !== undefined) {
        runtimeTokensByAgentId.delete(agentId);
      }
      return true;
    }
  };
}

function attachRealFallbackHandoff(
  manager: SwarmSpecialistFallbackManager,
  runtimeTokensByAgentId: Map<string, number>
): RuntimeCallbackGate {
  const gate = new RuntimeCallbackGate({
    getCurrentRuntimeToken: (agentId) => runtimeTokensByAgentId.get(agentId)
  });
  manager.setFallbackHandoffController({
    beginFallbackHandoff: (agentId, suppressedRuntimeToken) =>
      gate.beginFallbackHandoff(agentId, suppressedRuntimeToken),
    endFallbackHandoff: (agentId, suppressedRuntimeToken) =>
      gate.endFallbackHandoff(agentId, suppressedRuntimeToken),
    getFallbackHandoffSnapshot: (agentId, suppressedRuntimeToken) =>
      gate.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken),
    reconcileBufferedCallbacksOnAbort: (agentId, suppressedRuntimeToken, handlers) =>
      gate.reconcileBufferedCallbacksOnAbort(agentId, suppressedRuntimeToken, handlers)
  });
  return gate;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwarmSpecialistFallbackManager", () => {
  it("resolves a cross-vendor fallback model from the specialist roster", async () => {
    const config = await makeTempConfig();
    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config);
    descriptors.set(worker.agentId, worker);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark", fallbackReasoningLevel: "medium" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);
    expect(resolved?.provider).toBe("openai-codex");
    expect(resolved?.modelId).toBe("gpt-5.3-codex-spark");
  });

  it("applies session Fast mode to compatible specialist fallback recovery models", async () => {
    const config = await makeTempConfig();
    const parentManager = buildWorkerDescriptor(config, {
      agentId: "mgr-1",
      role: "manager",
      managerId: "mgr-1",
      specialistId: undefined,
      fastModePolicy: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const worker = buildWorkerDescriptor(config, { managerId: parentManager.agentId });
    const descriptors = new Map<string, AgentDescriptor>([
      [parentManager.agentId, parentManager],
      [worker.agentId, worker],
    ]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn(),
    });
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.4", fallbackReasoningLevel: "high" },
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      getManagedModelProviderCredentialSummaries: vi.fn(async () => new Map([
        ["openai-codex", { configured: true, authTypes: ["oauth"], sources: ["pool"], chatgptAuthAvailable: true }],
      ])),
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn(),
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);

    expect(resolved).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      serviceTier: "priority",
    });
  });

  it("preserves explicit worker Fast opt-out during compatible specialist fallback recovery", async () => {
    const config = await makeTempConfig();
    const parentManager = buildWorkerDescriptor(config, {
      agentId: "mgr-1",
      role: "manager",
      managerId: "mgr-1",
      specialistId: undefined,
      fastModePolicy: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const worker = buildWorkerDescriptor(config, { managerId: parentManager.agentId, fastModeOverride: false });
    const descriptors = new Map<string, AgentDescriptor>([
      [parentManager.agentId, parentManager],
      [worker.agentId, worker],
    ]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn(),
    });
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.4", fallbackReasoningLevel: "high" },
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      getManagedModelProviderCredentialSummaries: vi.fn(async () => new Map([
        ["openai-codex", { configured: true, authTypes: ["oauth"], sources: ["pool"], chatgptAuthAvailable: true }],
      ])),
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn(),
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);

    expect(resolved).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" });
    expect(resolved?.serviceTier).toBeUndefined();
  });

  it("strips priority from unsupported specialist fallback recovery models even when Fast mode is enabled", async () => {
    const config = await makeTempConfig();
    const parentManager = buildWorkerDescriptor(config, {
      agentId: "mgr-1",
      role: "manager",
      managerId: "mgr-1",
      specialistId: undefined,
      fastModePolicy: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const worker = buildWorkerDescriptor(config, { managerId: parentManager.agentId });
    const descriptors = new Map<string, AgentDescriptor>([
      [parentManager.agentId, parentManager],
      [worker.agentId, worker],
    ]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn(),
    });
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "claude-sonnet-4-20250514", fallbackReasoningLevel: "high" },
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => ({ ...m, serviceTier: "priority" }),
      getManagedModelProviderCredentialSummaries: vi.fn(async () => new Map([
        ["openai-codex", { configured: true, authTypes: ["oauth"], sources: ["pool"], chatgptAuthAvailable: true }],
      ])),
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn(),
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);

    expect(resolved).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });
    expect(resolved?.serviceTier).toBeUndefined();
  });

  it("currently infers fallback provider from fallbackModelId even when roster carries fallbackProvider", async () => {
    const config = await makeTempConfig();
    const worker = buildWorkerDescriptor(config);
    const descriptors = new Map<string, AgentDescriptor>([[worker.agentId, worker]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        {
          specialistId: "backend",
          fallbackModelId: "gpt-5.4",
          fallbackProvider: "anthropic",
          fallbackReasoningLevel: "high"
        }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);

    expect(resolved).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("resolves worker fallback from the parent collab manager's collaboration roster", async () => {
    const config = await makeTempConfig();
    const collabManager = buildWorkerDescriptor(config, {
      agentId: "collab-manager",
      role: "manager",
      managerId: "collab-manager",
      specialistId: undefined,
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" }
    });
    const worker = buildWorkerDescriptor(config, { managerId: collabManager.agentId });
    const descriptors = new Map<string, AgentDescriptor>([
      [collabManager.agentId, collabManager],
      [worker.agentId, worker]
    ]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const resolveSpecialistRosterForProfile = vi.fn(async (_profileId: string, targetSpace?: string) =>
      targetSpace === "collaboration"
        ? [{ specialistId: "backend", fallbackModelId: "gpt-5.4", fallbackReasoningLevel: "high" }]
        : []
    );

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile,
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const resolved = await manager.resolveSpecialistFallbackModelForDescriptor(worker);

    expect(resolveSpecialistRosterForProfile).toHaveBeenCalledWith("profile-1", "collaboration");
    expect(resolved?.modelId).toBe("gpt-5.4");
    expect(resolved?.thinkingLevel).toBe("high");
  });

  it("returns undefined when the roster has no fallback model for the specialist", async () => {
    const config = await makeTempConfig();
    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const worker = buildWorkerDescriptor(config);
    descriptors.set(worker.agentId, worker);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [{ specialistId: "backend" }]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    await expect(manager.resolveSpecialistFallbackModelForDescriptor(worker)).resolves.toBeUndefined();
  });

  it("does not recover when the error is not eligible for specialist retry", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w1.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w1" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 1);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "something completely unrelated",
      sourcePhase: "prompt_start",
      runtimeToken: 1,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    expect(recovered).toBe(false);
  });

  it("does not recover when the resolved fallback exactly matches the current worker model", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-same-model.jsonl"), "", "utf8");

    const worker = buildWorkerDescriptor(config, {
      agentId: "w-same-model",
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    });
    const descriptors = new Map<string, AgentDescriptor>([[worker.agentId, worker]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const current = new FakeRuntime(worker, "sys");
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 7);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const createRuntimeForDescriptor = vi.fn();
    const handleRuntimeStatus = vi.fn();
    const handleRuntimeAgentEnd = vi.fn();
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.4", fallbackReasoningLevel: "high" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor,
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 7,
      handleRuntimeStatus,
      handleRuntimeAgentEnd,
    });

    expect(recovered).toBe(false);
    expect(createRuntimeForDescriptor).not.toHaveBeenCalled();
    expect(runtimeCreationPromisesByAgentId.has(worker.agentId)).toBe(false);
    expect(runtimes.get(worker.agentId)).toBe(current);
    expect(descriptors.get(worker.agentId)?.model).toEqual(worker.model);
  });

  it("buffers status during an active handoff and reapplies it on abort reconciliation", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-buf.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-buf" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "retry-me" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 9);

    let continueRoster: (entries: Array<{ specialistId: string; fallbackModelId?: string }>) => void = () => {};
    const rosterGate = new Promise<Array<{ specialistId: string; fallbackModelId?: string }>>((resolve) => {
      continueRoster = resolve;
    });

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: () => rosterGate,
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });
    const gate = attachRealFallbackHandoff(manager, runtimeTokensByAgentId);

    const handleRuntimeStatus = vi.fn();
    const handleRuntimeAgentEnd = vi.fn();

    const recovery = manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 9,
      handleRuntimeStatus,
      handleRuntimeAgentEnd
    });

    expect(gate.bufferStatusDuringHandoff(worker.agentId, 9, "streaming", 2, { tokens: 1, contextWindow: 10, percent: 5 })).toBe(
      true
    );

    continueRoster([]);

    await recovery;

    expect(handleRuntimeStatus).toHaveBeenCalledWith(
      9,
      worker.agentId,
      "streaming",
      2,
      expect.objectContaining({ tokens: 1 })
    );
  });

  it("replays queued user messages onto the replacement runtime and shuts down the previous runtime", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-replay.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-replay" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "do-the-thing" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 11);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    let nextToken = 100;
    const attachRuntime = vi.fn((agentId: string, runtime: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtime);
    });
    const createRuntimeForDescriptor = vi.fn(async (descriptor: AgentDescriptor, systemPrompt: string) => {
      const token = nextToken;
      nextToken += 1;
      runtimeTokensByAgentId.set(descriptor.agentId, token);
      return new FakeRuntime(structuredClone(descriptor), systemPrompt);
    });
    const patchDescriptor = vi.fn(async (agentId: string, patch: (descriptor: AgentDescriptor) => AgentDescriptor) => {
      const currentDescriptor = descriptors.get(agentId);
      if (!currentDescriptor) {
        return undefined;
      }
      const updatedDescriptor = patch(structuredClone(currentDescriptor));
      descriptors.set(agentId, updatedDescriptor);
      return updatedDescriptor;
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor,
      attachRuntime,
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      patchDescriptor,
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 11,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    expect(recovered).toBe(true);
    expect(createRuntimeForDescriptor).toHaveBeenCalled();
    expect(attachRuntime).toHaveBeenCalledWith(worker.agentId, expect.any(FakeRuntime));

    const replacement = runtimes.get(worker.agentId) as FakeRuntime;
    expect(replacement).toBeDefined();
    expect(replacement.sendCalls.map((c) => c.delivery)).toEqual(["auto"]);

    expect(current.terminateCalls.length).toBeGreaterThan(0);
    expect(patchDescriptor).toHaveBeenCalledTimes(1);
    expect(descriptors.get(worker.agentId)?.model.provider).toBe("openai-codex");
  });

  it("rolls back to the previous runtime when replacement creation fails", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-roll.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-roll" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "rollback" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 21);

    const restoreSpy = vi.spyOn(current, "restorePreparedSpecialistFallbackReplay");

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(async () => {
        throw new Error("cannot create replacement");
      }),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 21,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    expect(recovered).toBe(false);
    expect(restoreSpy).toHaveBeenCalled();
    expect(descriptors.get(worker.agentId)?.model.provider).toBe("anthropic");
    expect(runtimes.get(worker.agentId)).toBe(current);
  });

  it("rolls back and clears the discarded replacement token when reroute persistence fails before attach", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-pre-attach-reroute-fails.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-pre-attach-reroute-fails" });
    descriptors.set(worker.agentId, worker);

    const originalRuntimeToken = 23;
    const replacementRuntimeToken = 24;
    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "retry after persist failure" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken);

    const restoreSpy = vi.spyOn(current, "restorePreparedSpecialistFallbackReplay");
    const clearedTokens: Array<number | undefined> = [];
    const restoredTokens: number[] = [];

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const replacement = new FakeRuntime(
      {
        ...worker,
        model: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinkingLevel: "medium" }
      },
      "sys2"
    );
    const attachRuntime = vi.fn((agentId: string, runtime: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtime);
    });
    const bindingHelpers = runtimeBindingOptionHelpers(
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId
    );

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...bindingHelpers,
      clearRuntimeToken: (agentId, runtimeToken) => {
        clearedTokens.push(runtimeToken);
        bindingHelpers.clearRuntimeToken(agentId, runtimeToken);
      },
      restoreRuntimeTokenForFallbackRollback: (agentId, runtimeToken) => {
        restoredTokens.push(runtimeToken);
        bindingHelpers.restoreRuntimeTokenForFallbackRollback(agentId, runtimeToken);
      },
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(async (descriptor: AgentDescriptor) => {
        runtimeTokensByAgentId.set(descriptor.agentId, replacementRuntimeToken);
        return replacement;
      }),
      attachRuntime,
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      patchDescriptor: vi.fn(async () => {
        throw new Error("persist reroute failed");
      }),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: originalRuntimeToken,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    expect(recovered).toBe(false);
    expect(restoreSpy).toHaveBeenCalled();
    expect(current.terminateCalls).toHaveLength(0);
    expect(replacement.terminateCalls).toHaveLength(1);
    expect(attachRuntime).toHaveBeenCalledWith(worker.agentId, current);
    expect(runtimes.get(worker.agentId)).toBe(current);
    expect(clearedTokens).toContain(replacementRuntimeToken);
    expect(restoredTokens).toContain(originalRuntimeToken);
    expect(runtimeTokensByAgentId.get(worker.agentId)).toBe(originalRuntimeToken);
    expect(runtimeCreationPromisesByAgentId.has(worker.agentId)).toBe(false);
    expect(descriptors.get(worker.agentId)?.model).toEqual(worker.model);
  });

  it("preserves unrelated descriptor updates and newer updatedAt when rollback restores original fallback state", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-rollback-preserve.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();
    const previousUpdatedAt = "2026-01-01T00:00:00.000Z";
    const rerouteUpdatedAt = "2026-01-01T00:00:01.000Z";
    const unrelatedUpdatedAt = "2026-01-01T00:00:02.000Z";

    const worker = buildWorkerDescriptor(config, {
      agentId: "w-rollback-preserve",
      displayName: "Original",
      updatedAt: previousUpdatedAt
    });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "rollback-preserve" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 22);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const attachRuntime = vi.fn((agentId: string, runtime: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtime);
    });
    const replacement = new FakeRuntime(
      {
        ...worker,
        model: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinkingLevel: "medium" }
      },
      "sys2"
    );
    replacement.sendMessageError = new Error("fallback replay boom");
    const patchDescriptor = vi.fn(async (agentId: string, patch: (descriptor: AgentDescriptor) => AgentDescriptor) => {
      const currentDescriptor = descriptors.get(agentId);
      if (!currentDescriptor) {
        return undefined;
      }
      const updatedDescriptor = patch(structuredClone(currentDescriptor));
      expect(updatedDescriptor.updatedAt).toBe(rerouteUpdatedAt);
      updatedDescriptor.displayName = "Renamed while rerouted";
      updatedDescriptor.updatedAt = unrelatedUpdatedAt;
      descriptors.set(agentId, updatedDescriptor);
      return updatedDescriptor;
    });
    const patchDescriptorInLiveMaps = vi.fn((agentId: string, patch: (descriptor: AgentDescriptor) => AgentDescriptor) => {
      const currentDescriptor = descriptors.get(agentId);
      if (!currentDescriptor) {
        return undefined;
      }
      const updatedDescriptor = patch(structuredClone(currentDescriptor));
      descriptors.set(agentId, updatedDescriptor);
      return updatedDescriptor;
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => rerouteUpdatedAt,
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(async () => replacement),
      attachRuntime,
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      patchDescriptor,
      patchDescriptorInLiveMaps,
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });

    const recovered = await manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 22,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    expect(recovered).toBe(false);
    expect(patchDescriptor).toHaveBeenCalledTimes(1);
    expect(patchDescriptorInLiveMaps).toHaveBeenCalledTimes(1);
    expect(descriptors.get(worker.agentId)).toMatchObject({
      displayName: "Renamed while rerouted",
      status: "idle",
      updatedAt: unrelatedUpdatedAt,
      model: expect.objectContaining({ provider: "anthropic" })
    });
    expect(runtimes.get(worker.agentId)).toBe(current);
  });

  it("replays buffered old-runtime status then agent_end when fallback aborts", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-replay-abort.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-replay-abort" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "retry-me" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 41);

    let continueRoster: (entries: Array<{ specialistId: string; fallbackModelId?: string }>) => void = () => {};
    const rosterGate = new Promise<Array<{ specialistId: string; fallbackModelId?: string }>>((resolve) => {
      continueRoster = resolve;
    });

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    const replayOrder: string[] = [];
    const gateRef: { current?: RuntimeCallbackGate } = {};
    const handleRuntimeStatus = vi.fn(async () => {
      expect(gateRef.current?.isSuppressedRuntimeCallback(worker.agentId, 41)).toBe(false);
      replayOrder.push("status");
    });
    const handleRuntimeAgentEnd = vi.fn(async () => {
      expect(gateRef.current?.isSuppressedRuntimeCallback(worker.agentId, 41)).toBe(false);
      replayOrder.push("agent_end");
    });
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: () => rosterGate,
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });
    const gate = attachRealFallbackHandoff(manager, runtimeTokensByAgentId);
    gateRef.current = gate;

    const recovery = manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 41,
      handleRuntimeStatus,
      handleRuntimeAgentEnd
    });

    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 41)).toBe(true);
    expect(gate.bufferStatusDuringHandoff(worker.agentId, 41, "streaming", 2, {
      tokens: 5,
      contextWindow: 50,
      percent: 10
    })).toBe(true);
    expect(gate.bufferAgentEndDuringHandoff(worker.agentId, 41)).toBe(true);

    continueRoster([]);

    await expect(recovery).resolves.toBe(false);

    expect(replayOrder).toEqual(["status", "agent_end"]);
    expect(handleRuntimeStatus).toHaveBeenCalledWith(
      41,
      worker.agentId,
      "streaming",
      2,
      expect.objectContaining({ tokens: 5 })
    );
    expect(handleRuntimeAgentEnd).toHaveBeenCalledWith(41, worker.agentId);
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 41)).toBe(false);
  });

  it("ends successful fallback handoff without replaying buffered old-runtime callbacks", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-success-no-replay.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-success-no-replay" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "retry-me" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 42);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    let signalCreateStarted: () => void = () => {};
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let releaseReplacement: (runtime: SwarmAgentRuntime) => void = () => {};
    const replacementGate = new Promise<SwarmAgentRuntime>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementRuntimeToken = 43;
    const attachRuntime = vi.fn((agentId: string, runtime: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtime);
    });
    const createRuntimeForDescriptor = vi.fn(() => {
      runtimeTokensByAgentId.set(worker.agentId, replacementRuntimeToken);
      signalCreateStarted();
      return replacementGate;
    });

    const handleRuntimeStatus = vi.fn();
    const handleRuntimeAgentEnd = vi.fn();
    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor,
      attachRuntime,
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });
    const gate = attachRealFallbackHandoff(manager, runtimeTokensByAgentId);

    const recovery = manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 42,
      handleRuntimeStatus,
      handleRuntimeAgentEnd
    });

    await createStarted;
    expect(runtimeTokensByAgentId.get(worker.agentId)).toBe(replacementRuntimeToken);
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 42)).toBe(true);
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, replacementRuntimeToken)).toBe(false);
    expect(gate.bufferStatusDuringHandoff(worker.agentId, 42, "idle", 0)).toBe(true);
    expect(gate.bufferStatusDuringHandoff(worker.agentId, replacementRuntimeToken, "streaming", 1)).toBe(false);
    expect(gate.bufferAgentEndDuringHandoff(worker.agentId, 42)).toBe(true);
    expect(gate.bufferAgentEndDuringHandoff(worker.agentId, replacementRuntimeToken)).toBe(false);

    const replacement = new FakeRuntime(
      {
        ...worker,
        model: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinkingLevel: "medium" }
      },
      "sys2"
    );
    releaseReplacement(replacement);

    await expect(recovery).resolves.toBe(true);

    expect(handleRuntimeStatus).not.toHaveBeenCalled();
    expect(handleRuntimeAgentEnd).not.toHaveBeenCalled();
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 42)).toBe(false);
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, replacementRuntimeToken)).toBe(false);
    expect(runtimeTokensByAgentId.get(worker.agentId)).toBe(replacementRuntimeToken);
    expect(attachRuntime).toHaveBeenCalledWith(worker.agentId, replacement);
  });

  it("exposes suppression for callbacks tied to the active handoff token", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sessionsDir, "w-sup.jsonl"), "", "utf8");

    const descriptors = new Map<string, AgentDescriptor>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtimeTokensByAgentId = new Map<string, number>();

    const worker = buildWorkerDescriptor(config, { agentId: "w-sup" });
    descriptors.set(worker.agentId, worker);

    const current = new FakeRuntime(worker, "sys");
    current.specialistFallbackReplayMessage = { text: "x" };
    runtimes.set(worker.agentId, current);
    runtimeTokensByAgentId.set(worker.agentId, 31);

    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes,
      getConversationHistory: () => [],
      sendMessage: vi.fn(),
      publishToUser: vi.fn(),
      terminateDescriptor: vi.fn(),
      saveStore: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      resolvePromptWithFallback: vi.fn(async (_c, _p, _f, fb) => fb),
      isRuntimeInContextRecovery: () => false,
      logDebug: vi.fn()
    });

    let releaseHandoff: (value: SwarmAgentRuntime) => void = () => {};
    const handoffBarrier = new Promise<SwarmAgentRuntime>((resolve) => {
      releaseHandoff = resolve;
    });

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
      ...runtimeBindingOptionHelpers(runtimes, runtimeCreationPromisesByAgentId, runtimeTokensByAgentId),
      workerHealthService: health,
      now: () => new Date().toISOString(),
      resolveSpecialistRosterForProfile: vi.fn(async () => [
        { specialistId: "backend", fallbackModelId: "gpt-5.3-codex-spark" }
      ]),
      resolveSpawnModelWithCapacityFallback: (m) => m,
      resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
      injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
      createRuntimeForDescriptor: vi.fn(async () => handoffBarrier),
      attachRuntime: vi.fn(),
      detachRuntime: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(),
      refreshSessionMetaStatsBySessionId: vi.fn(),
      saveStore: vi.fn(),
      emitStatus: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      clearTrackedToolPaths: vi.fn(),
      logDebug: vi.fn()
    });
    const gate = attachRealFallbackHandoff(manager, runtimeTokensByAgentId);

    const recovery = manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 31,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    await Promise.resolve();
    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 31)).toBe(true);

    const replacement = new FakeRuntime(
      {
        ...worker,
        model: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinkingLevel: "medium" }
      },
      "sys2"
    );
    releaseHandoff(replacement);

    await recovery;

    expect(gate.isSuppressedRuntimeCallback(worker.agentId, 31)).toBe(false);
  });

  it("is wired on SwarmManager after booting a default manager", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const specialist = buildWorkerDescriptor(config, { agentId: "wired-worker", managerId: manager.listAgents()[0]!.agentId });
    await expect(manager.resolveSpecialistFallbackModelForDescriptor(specialist)).resolves.toBeUndefined();
  });
});
