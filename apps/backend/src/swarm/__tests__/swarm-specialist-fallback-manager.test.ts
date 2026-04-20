import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath } from "../data-paths.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
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

    expect(manager.bufferStatusDuringHandoff(worker.agentId, 9, "streaming", 2, { tokens: 1, contextWindow: 10, percent: 5 })).toBe(
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

    const manager = new SwarmSpecialistFallbackManager({
      descriptors,
      runtimes,
      runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId,
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

    const recovery = manager.maybeRecoverWorkerWithSpecialistFallback({
      agentId: worker.agentId,
      errorMessage: "rate limit exceeded",
      sourcePhase: "prompt_start",
      runtimeToken: 31,
      handleRuntimeStatus: vi.fn(),
      handleRuntimeAgentEnd: vi.fn()
    });

    await Promise.resolve();
    expect(manager.isSuppressedRuntimeCallback(worker.agentId, 31)).toBe(true);

    const replacement = new FakeRuntime(
      {
        ...worker,
        model: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinkingLevel: "medium" }
      },
      "sys2"
    );
    releaseHandoff(replacement);

    await recovery;

    expect(manager.isSuppressedRuntimeCallback(worker.agentId, 31)).toBe(false);
  });

  it("is wired on SwarmManager after booting a default manager", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const specialist = buildWorkerDescriptor(config, { agentId: "wired-worker", managerId: manager.listAgents()[0]!.agentId });
    await expect(manager.resolveSpecialistFallbackModelForDescriptor(specialist)).resolves.toBeUndefined();
  });
});
