import { getSessionFilePath, getWorkerSessionFilePath } from "./data-paths.js";
import { resolveModelDescriptorFromPreset, inferProviderFromModelId, parseSwarmModelPreset, parseSwarmReasoningLevel } from "./model-presets.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type { RuntimeShutdownOptions, SetPinnedContentOptions, SwarmAgentRuntime } from "./runtime-contracts.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import { isNonRunningAgentStatus, transitionAgentStatus } from "./agent-state-machine.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  ConversationAttachment,
  ManagerProfile,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";
import {
  buildModelCapacityBlockKey,
  cloneDescriptor,
  normalizeAgentId,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
  normalizeThinkingLevelForProvider,
  resolveNextCapacityFallbackModelId,
  shouldRetrySpecialistSpawnWithFallback
} from "./swarm-manager-utils.js";

const MANAGER_ARCHETYPE_ID = "manager";
const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  provider: string;
  reasoningLevel?: SwarmReasoningLevel;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

interface ModelCapacityBlockLike {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
}

export type AgentLifecycleStopSessionOptions = {
  saveStore: boolean;
  emitSnapshots: boolean;
  emitStatus?: boolean;
  deleteWorkers?: boolean;
};

export type ManagerRuntimeRecycleReason =
  | "model_change"
  | "cwd_change"
  | "idle_transition"
  | "prompt_mode_change"
  | "project_agent_directory_change"
  | "specialist_roster_change";

export interface SwarmAgentLifecycleServiceOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  pendingManagerRuntimeRecycleAgentIds: Set<string>;
  modelCapacityBlocks: Map<string, ModelCapacityBlockLike>;
  sessionProvisioner: SessionProvisioner;
  now: () => string;
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  assertManager: (agentId: string, action: string) => AgentDescriptor;
  hasRunningManagers: (options?: { excludeCortex?: boolean }) => boolean;
  generateUniqueAgentId: (source: string) => string;
  generateUniqueManagerId: (source: string) => string;
  resolveAndValidateCwd: (cwd: string) => Promise<string>;
  resolveDefaultModelDescriptor: () => AgentModelDescriptor;
  resolveSpawnWorkerArchetypeId: (
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string
  ) => Promise<string | undefined>;
  resolveSpecialistRosterForProfile: (profileId: string) => Promise<ResolvedSpecialistDefinitionLike[]>;
  normalizeSpecialistHandle: (value: string) => Promise<string | undefined>;
  resolveSystemPromptForDescriptor: (descriptor: AgentDescriptor) => Promise<string>;
  injectWorkerIdentityContext: (descriptor: AgentDescriptor, systemPrompt: string) => string;
  createRuntimeForDescriptor: (
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number
  ) => Promise<SwarmAgentRuntime>;
  allocateRuntimeToken: (agentId: string) => number;
  clearRuntimeToken: (agentId: string, runtimeToken?: number) => void;
  getRuntimeToken: (agentId: string) => number | undefined;
  ensureSessionFileParentDirectory: (sessionFile: string) => Promise<void>;
  updateSessionMetaForWorkerDescriptor: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string
  ) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  refreshSessionMetaStats: (descriptor: AgentDescriptor) => Promise<void>;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  attachRuntime: (agentId: string, runtime: SwarmAgentRuntime) => void;
  saveStore: () => Promise<void>;
  emitStatus: (
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  seedWorkerCompletionReportTimestamp: (agentId: string) => void;
  clearWatchdogState: (agentId: string) => void;
  deleteWorkerStallState: (agentId: string) => void;
  deleteWorkerActivityState: (agentId: string) => void;
  deleteWorkerCompletionReportState: (agentId: string) => void;
  markPendingManualManagerStopNotice: (agentId: string) => void;
  cancelAllPendingChoicesForAgent: (agentId: string) => void;
  runRuntimeShutdown: (
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ) => Promise<{ timedOut: boolean; runtimeToken?: number }>;
  detachRuntime: (agentId: string, runtimeToken?: number) => boolean;
  syncPinnedContentForManagerRuntime: (
    descriptor: ProvisionedSessionDescriptor,
    options?: {
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    }
  ) => Promise<void>;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ) => Promise<SendMessageReceipt>;
  sendManagerBootstrapMessage: (managerId: string) => Promise<void>;
  materializeSortOrder: () => void;
  getSessionsForProfile: (profileId: string) => Array<AgentDescriptor & { role: "manager"; profileId: string }>;
  getWorkersForManager: (managerId: string) => AgentDescriptor[];
  deleteConversationHistory: (agentId: string, sessionFile: string) => void;
  deleteManagerSchedulesFile: (profileId: string) => Promise<void>;
  migrateLegacyProfileKnowledgeToReferenceDoc: (profileId: string) => Promise<void>;
}

export class SwarmAgentLifecycleService {
  constructor(private readonly options: SwarmAgentLifecycleServiceOptions) {}

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const { terminatedWorkerIds } = await this.stopSessionInternal(agentId, {
      saveStore: true,
      emitSnapshots: true
    });

    return { terminatedWorkerIds };
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Session is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Session is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Session is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.options.now();
    this.options.descriptors.set(agentId, descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.options.descriptors.set(agentId, descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.options.now();
      this.options.descriptors.set(agentId, descriptor);
      throw error;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.options.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.options.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.options.now();
    const managerProfileId = manager.profileId ?? manager.agentId;
    const rawSpecialist = input.specialist?.trim();
    let requestedSpecialistId: string | undefined;

    if (rawSpecialist) {
      requestedSpecialistId = await this.options.normalizeSpecialistHandle(rawSpecialist);
    }

    if (
      requestedSpecialistId &&
      (
        input.model !== undefined ||
        input.modelId !== undefined ||
        input.systemPrompt !== undefined ||
        input.archetypeId !== undefined
      )
    ) {
      throw new Error(
        "Cannot combine 'specialist' with model/prompt/archetype overrides. Use specialist mode or ad-hoc mode, not both. reasoningLevel is the only allowed override in specialist mode."
      );
    }

    let model: AgentModelDescriptor;
    let archetypeId: string | undefined;
    let specialist: ResolvedSpecialistDefinitionLike | undefined;
    let specialistFallbackModel: AgentModelDescriptor | undefined;
    let explicitSystemPrompt: string | undefined;
    let webSearch = false;

    if (requestedSpecialistId) {
      const roster = await this.options.resolveSpecialistRosterForProfile(managerProfileId);
      specialist = roster.find((entry) => entry.specialistId === requestedSpecialistId);
      if (!specialist) {
        throw new Error(
          `Unknown specialist: ${requestedSpecialistId}. See manager system prompt for available specialists.`
        );
      }

      if (!specialist.enabled) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" is disabled for this profile. Enable it before spawning.`
        );
      }

      if (!specialist.available) {
        const reason =
          specialist.availabilityMessage?.trim() ||
          (specialist.availabilityCode
            ? `availability code: ${specialist.availabilityCode}`
            : "unavailable with current auth/configuration");
        throw new Error(`Specialist "${requestedSpecialistId}" is currently unavailable: ${reason}`);
      }

      const inferredProvider = specialist.provider || inferProviderFromModelId(specialist.modelId);
      if (!inferredProvider) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" has an unknown modelId provider mapping: ${specialist.modelId}`
        );
      }

      const reasoningLevelOverride = parseSwarmReasoningLevel(
        input.reasoningLevel,
        "spawn_agent.reasoningLevel"
      );

      model = {
        provider: inferredProvider,
        modelId: specialist.modelId,
        thinkingLevel: reasoningLevelOverride ?? specialist.reasoningLevel ?? "xhigh"
      };
      model.thinkingLevel = normalizeThinkingLevelForProvider(model.provider, model.thinkingLevel);
      model = this.resolveSpawnModelWithCapacityFallback(model);

      if (specialist.fallbackModelId) {
        const inferredFallbackProvider = specialist.fallbackProvider || inferProviderFromModelId(specialist.fallbackModelId);
        if (inferredFallbackProvider) {
          specialistFallbackModel = {
            provider: inferredFallbackProvider,
            modelId: specialist.fallbackModelId,
            thinkingLevel: specialist.fallbackReasoningLevel ?? model.thinkingLevel
          };
          specialistFallbackModel.thinkingLevel = normalizeThinkingLevelForProvider(
            specialistFallbackModel.provider,
            specialistFallbackModel.thinkingLevel
          );
          specialistFallbackModel = this.resolveSpawnModelWithCapacityFallback(specialistFallbackModel);
        }
      }

      archetypeId = undefined;
      explicitSystemPrompt = specialist.promptBody;
    } else {
      const requestedModel = this.resolveSpawnModel(input, manager.model);
      model = this.resolveSpawnModelWithCapacityFallback(requestedModel);
      archetypeId = await this.options.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);
      explicitSystemPrompt = input.systemPrompt?.trim();
      webSearch = input.webSearch === true;
    }

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      profileId: manager.profileId ?? manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.options.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: getWorkerSessionFilePath(
        this.options.dataDir,
        manager.profileId ?? manager.agentId,
        manager.agentId,
        agentId
      ),
      ...(webSearch ? { webSearch: true } : {})
    };

    if (specialist) {
      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      if (specialist.webSearch) {
        descriptor.webSearch = true;
      }
    }

    this.options.descriptors.set(agentId, descriptor);
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      specialistId: descriptor.specialistId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    try {
      const baseSystemPrompt =
        explicitSystemPrompt && explicitSystemPrompt.length > 0
          ? explicitSystemPrompt
          : await this.options.resolveSystemPromptForDescriptor(descriptor);

      const runtimeSystemPrompt = this.options.injectWorkerIdentityContext(descriptor, baseSystemPrompt);

      let runtime: SwarmAgentRuntime;
      try {
        runtime = await this.options.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
      } catch (error) {
        if (specialistFallbackModel && shouldRetrySpecialistSpawnWithFallback(error, descriptor.model)) {
          const previousModel = { ...descriptor.model };
          descriptor.model = { ...specialistFallbackModel };
          this.options.descriptors.set(agentId, descriptor);
          await this.options.saveStore();

          this.options.logDebug("agent:spawn:specialist_fallback_retry", {
            agentId,
            specialistId: specialist?.specialistId,
            previousModel,
            fallbackModel: descriptor.model,
            error: error instanceof Error ? error.message : String(error)
          });

          runtime = await this.options.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
        } else {
          throw error;
        }
      }

      this.options.attachRuntime(agentId, runtime);
      this.options.seedWorkerCompletionReportTimestamp(agentId);

      const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      const contextUsage = runtime.getContextUsage();
      descriptor.contextUsage = contextUsage;
      this.options.descriptors.set(agentId, descriptor);
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      this.options.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
      this.options.emitAgentsSnapshot();
    } catch (error) {
      try {
        if (this.options.runtimes.has(agentId)) {
          const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
          this.options.detachRuntime(agentId, shutdown.runtimeToken);
        }
      } catch (shutdownError) {
        this.options.logDebug("agent:spawn:rollback_runtime_error", {
          agentId,
          error: String(shutdownError)
        });
      }

      this.options.clearWatchdogState(agentId);
      this.options.deleteWorkerStallState(agentId);
      this.options.deleteWorkerActivityState(agentId);
      this.options.deleteWorkerCompletionReportState(agentId);

      this.options.descriptors.delete(agentId);
      this.options.emitAgentsSnapshot();
      await this.options.saveStore();

      try {
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      } catch (metaError) {
        this.options.logDebug("agent:spawn:rollback_meta_error", {
          agentId,
          managerId: descriptor.managerId,
          error: String(metaError)
        });
      }

      throw error;
    }

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.options.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.options.assertManager(callerAgentId, "kill agents");

    const target = this.options.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.options.saveStore();

    this.options.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.options.emitStatus(targetAgentId, target.status, 0);
    this.options.emitAgentsSnapshot();
  }

  async stopWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    const runtime = this.options.runtimes.get(agentId);
    if (runtime) {
      const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
      this.options.detachRuntime(agentId, shutdown.runtimeToken);
    }

    if (descriptor.role === "worker") {
      this.options.clearWatchdogState(agentId);
      this.options.deleteWorkerStallState(agentId);
      this.options.deleteWorkerActivityState(agentId);
      this.options.deleteWorkerCompletionReportState(agentId);
    }

    descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.options.descriptors.set(agentId, descriptor);

    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    await this.options.saveStore();

    this.options.emitStatus(agentId, descriptor.status, 0);
    this.options.emitAgentsSnapshot();
  }

  async resumeWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Worker is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Worker is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Worker is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.options.now();
    this.options.descriptors.set(agentId, descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.options.descriptors.set(agentId, descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.options.now();
      this.options.descriptors.set(agentId, descriptor);
      throw error;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const manager = this.options.assertManager(callerAgentId, "stop all agents");

    const target = this.options.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    const stoppedWorkerIds: string[] = [];
    const managerRuntime = this.options.runtimes.get(target.agentId);
    if (managerRuntime && (target.status === "streaming" || managerRuntime.getStatus() === "streaming")) {
      this.options.markPendingManualManagerStopNotice(target.agentId);
    }

    this.options.cancelAllPendingChoicesForAgent(targetManagerId);

    for (const descriptor of Array.from(this.options.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      this.options.clearWatchdogState(descriptor.agentId);
      this.options.deleteWorkerStallState(descriptor.agentId);
      this.options.deleteWorkerActivityState(descriptor.agentId);

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const runtime = this.options.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "stopInFlight", { abort: true });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.contextUsage = undefined;
      descriptor.updatedAt = this.options.now();
      this.options.descriptors.set(descriptor.agentId, descriptor);
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (!isNonRunningAgentStatus(target.status)) {
      if (managerRuntime) {
        const shutdown = await this.options.runRuntimeShutdown(target, "stopInFlight", { abort: true });
        this.options.detachRuntime(target.agentId, shutdown.runtimeToken);
      }

      target.status = transitionAgentStatus(target.status, "idle");
      target.contextUsage = undefined;
      target.updatedAt = this.options.now();
      this.options.descriptors.set(target.agentId, target);
      this.options.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      managerStopped = true;
    }

    await this.options.refreshSessionMetaStatsBySessionId(targetManagerId);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.options.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.options.hasRunningManagers({ excludeCortex: true });
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const normalizedRequestedName = normalizeAgentId(requestedName);
    if (normalizedRequestedName === CORTEX_PROFILE_ID) {
      throw new Error('The manager name "cortex" is reserved');
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const managerId = this.options.generateUniqueManagerId(requestedName);
    const createdAt = this.options.now();
    const cwd = await this.options.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      profileId: managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: requestedModelPreset
        ? resolveModelDescriptorFromPreset(requestedModelPreset)
        : this.options.resolveDefaultModelDescriptor(),
      sessionFile: getSessionFilePath(this.options.dataDir, managerId, managerId)
    };

    this.options.materializeSortOrder();

    const maxSortOrder = Array.from(this.options.profiles.values()).reduce(
      (max, profile) => Math.max(max, profile.sortOrder ?? -1),
      -1
    );

    const profile: ManagerProfile = {
      profileId: descriptor.agentId,
      displayName: descriptor.displayName,
      defaultSessionAgentId: descriptor.agentId,
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt,
      sortOrder: maxSortOrder + 1
    };

    let runtime: SwarmAgentRuntime | undefined;
    let persistedSystemPrompt: string | undefined;
    await this.options.sessionProvisioner.provisionSession({
      descriptor: descriptor as AgentDescriptor & { role: "manager"; profileId: string },
      profile,
      ensureProfilePiDirectories: true,
      initializeRuntime: async () => {
        const systemPrompt = await this.options.resolveSystemPromptForDescriptor(descriptor);
        runtime = await this.options.createRuntimeForDescriptor(descriptor, systemPrompt);
        this.options.attachRuntime(managerId, runtime);
        persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;
      }
    });

    const contextUsage = runtime?.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.options.descriptors.set(managerId, descriptor);

    await this.options.captureSessionRuntimePromptMeta(descriptor, persistedSystemPrompt);
    await this.options.refreshSessionMetaStats(descriptor);
    await this.options.migrateLegacyProfileKnowledgeToReferenceDoc(profile.profileId);
    await this.options.saveStore();

    this.options.emitStatus(managerId, descriptor.status, runtime?.getPendingCount() ?? 0, contextUsage);
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.options.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.options.assertManager(callerAgentId, "delete managers");

    const profile = this.options.profiles.get(targetManagerId);
    const sessionDescriptors = profile ? this.options.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.options.descriptors.get(targetManagerId);
      if (!target || target.role !== "manager") {
        throw new Error(`Unknown manager: ${targetManagerId}`);
      }
      sessionDescriptors.push(target as ProvisionedSessionDescriptor);
    }

    if (sessionDescriptors.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)) {
      throw new Error("Cortex manager cannot be deleted");
    }

    const terminatedWorkerIds: string[] = [];

    for (const sessionDescriptor of sessionDescriptors) {
      for (const workerDescriptor of this.options.getWorkersForManager(sessionDescriptor.agentId)) {
        terminatedWorkerIds.push(workerDescriptor.agentId);
        await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true });
        this.options.descriptors.delete(workerDescriptor.agentId);
        this.options.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
      }

      await this.terminateDescriptor(sessionDescriptor, { abort: true, emitStatus: true });
      this.options.descriptors.delete(sessionDescriptor.agentId);
      this.options.deleteConversationHistory(sessionDescriptor.agentId, sessionDescriptor.sessionFile);
    }

    if (profile) {
      this.options.profiles.delete(profile.profileId);
    } else {
      this.options.profiles.delete(targetManagerId);
    }

    const schedulesProfileId = profile?.profileId ?? sessionDescriptors[0]?.profileId ?? targetManagerId;
    await this.options.deleteManagerSchedulesFile(schedulesProfileId);

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async notifySpecialistRosterChanged(profileId: string): Promise<void> {
    try {
      const roster = await this.options.resolveSpecialistRosterForProfile(profileId);
      await this.syncWorkerSpecialistMetadata(profileId, roster);
    } catch (error) {
      this.options.logDebug("specialist:roster_change:sync:error", {
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const sessions = this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "specialist_roster_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("specialist:roster_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "project_agent_directory_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "streaming";
  }

  async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const inFlightCreation = this.options.runtimeCreationPromisesByAgentId.get(descriptor.agentId);
    if (inFlightCreation) {
      return inFlightCreation;
    }

    const existingRuntime = this.options.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const creationPromise = this.createAndAttachRuntimeForDescriptor(descriptor);
    this.options.runtimeCreationPromisesByAgentId.set(descriptor.agentId, creationPromise);

    try {
      return await creationPromise;
    } finally {
      if (this.options.runtimeCreationPromisesByAgentId.get(descriptor.agentId) === creationPromise) {
        this.options.runtimeCreationPromisesByAgentId.delete(descriptor.agentId);
      }
    }
  }

  resolveSpawnModel(input: SpawnAgentInput, fallback: AgentModelDescriptor): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(
      input.reasoningLevel,
      "spawn_agent.reasoningLevel"
    );

    const descriptor = requestedPreset
      ? resolveModelDescriptorFromPreset(requestedPreset)
      : {
          ...fallback,
          modelId: normalizeOptionalModelId(fallback.modelId) ?? fallback.modelId,
          provider: normalizeOptionalAgentId(fallback.provider) ?? fallback.provider,
          thinkingLevel: fallback.thinkingLevel
        };

    const requestedModelId = normalizeOptionalModelId(input.modelId);
    if (requestedModelId) {
      descriptor.modelId = requestedModelId;
    }

    if (requestedReasoningLevel) {
      descriptor.thinkingLevel = requestedReasoningLevel;
    }

    descriptor.thinkingLevel = normalizeThinkingLevelForProvider(
      descriptor.provider,
      descriptor.thinkingLevel
    );

    return descriptor;
  }

  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    const provider = normalizeOptionalAgentId(model.provider)?.toLowerCase();
    const requestedModelId = normalizeOptionalModelId(model.modelId)?.toLowerCase();
    if (!provider || !requestedModelId) {
      return model;
    }

    const requestedBlock = this.getActiveModelCapacityBlock(provider, requestedModelId);
    if (!requestedBlock) {
      return model;
    }

    const attemptedModelIds: string[] = [requestedModelId];
    let candidateModelId = requestedModelId;

    while (true) {
      const nextModelId = resolveNextCapacityFallbackModelId(provider, candidateModelId);
      if (!nextModelId) {
        this.options.logDebug("agent:spawn:model_blocked_no_fallback", {
          provider,
          requestedModelId,
          blockedUntil: new Date(requestedBlock.blockedUntilMs).toISOString(),
          attemptedModelIds
        });
        return model;
      }

      attemptedModelIds.push(nextModelId);

      const nextBlock = this.getActiveModelCapacityBlock(provider, nextModelId);
      if (!nextBlock) {
        this.options.logDebug("agent:spawn:model_reroute", {
          provider,
          requestedModelId,
          selectedModelId: nextModelId,
          attemptedModelIds
        });
        return {
          ...model,
          modelId: nextModelId
        };
      }

      candidateModelId = nextModelId;
    }
  }

  async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[] }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    const terminatedWorkerIds: string[] = [];
    const runtime = this.options.runtimes.get(agentId);
    if (
      runtime &&
      !options.deleteWorkers &&
      (descriptor.status === "streaming" || runtime.getStatus() === "streaming")
    ) {
      this.options.markPendingManualManagerStopNotice(agentId);
    }

    for (const workerDescriptor of this.options.getWorkersForManager(agentId)) {
      terminatedWorkerIds.push(workerDescriptor.agentId);
      await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true });
      if (options.deleteWorkers) {
        this.options.descriptors.delete(workerDescriptor.agentId);
      }
      this.options.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
    }

    if (runtime) {
      const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
      this.options.detachRuntime(agentId, shutdown.runtimeToken);
    }
    this.options.pendingManagerRuntimeRecycleAgentIds.delete(agentId);

    descriptor.status = descriptor.status === "error"
      ? "idle"
      : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.options.descriptors.set(agentId, descriptor);

    if (options.emitStatus ?? true) {
      this.options.emitStatus(agentId, descriptor.status, 0);
    }

    await this.options.refreshSessionMetaStatsBySessionId(agentId);

    if (options.saveStore) {
      await this.options.saveStore();
    }

    if (options.emitSnapshots) {
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
    }

    return { terminatedWorkerIds };
  }

  async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      this.options.pendingManagerRuntimeRecycleAgentIds.delete(agentId);
      return "none";
    }

    if (reason === "idle_transition" && !this.options.pendingManagerRuntimeRecycleAgentIds.has(agentId)) {
      return "none";
    }

    const runtime = this.options.runtimes.get(agentId);
    if (!runtime) {
      this.options.pendingManagerRuntimeRecycleAgentIds.delete(agentId);
      return "none";
    }

    if (!this.canRecycleManagerRuntimeImmediately(descriptor, runtime)) {
      this.options.pendingManagerRuntimeRecycleAgentIds.add(agentId);
      return "deferred";
    }

    await this.recycleManagerRuntime(descriptor, runtime, reason);
    return "recycled";
  }

  async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.options.cancelAllPendingChoicesForAgent(descriptor.agentId);

    if (descriptor.role === "worker") {
      this.options.clearWatchdogState(descriptor.agentId);
      this.options.deleteWorkerStallState(descriptor.agentId);
      this.options.deleteWorkerActivityState(descriptor.agentId);
      this.options.deleteWorkerCompletionReportState(descriptor.agentId);
    }

    const runtime = this.options.runtimes.get(descriptor.agentId);
    if (runtime) {
      const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: options.abort });
      this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
    }
    this.options.pendingManagerRuntimeRecycleAgentIds.delete(descriptor.agentId);

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.options.descriptors.set(descriptor.agentId, descriptor);

    if (descriptor.role === "worker") {
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else {
      await this.options.refreshSessionMetaStats(descriptor);
    }

    if (options.emitStatus) {
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  async syncWorkerSpecialistMetadata(
    profileId: string,
    roster: ResolvedSpecialistDefinitionLike[]
  ): Promise<void> {
    const rosterById = new Map(roster.map((entry) => [entry.specialistId, entry]));
    let changed = false;

    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "worker" || descriptor.profileId !== profileId) {
        continue;
      }

      const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
      if (!specialistId) {
        continue;
      }

      const specialist = rosterById.get(specialistId);
      if (!specialist) {
        continue;
      }

      if (
        descriptor.specialistId === specialist.specialistId &&
        descriptor.specialistDisplayName === specialist.displayName &&
        descriptor.specialistColor === specialist.color
      ) {
        continue;
      }

      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      this.options.descriptors.set(descriptor.agentId, descriptor);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
  }

  private canRecycleManagerRuntimeImmediately(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime
  ): boolean {
    return (
      descriptor.role === "manager" &&
      descriptor.status === "idle" &&
      runtime.getStatus() === "idle" &&
      runtime.getPendingCount() === 0 &&
      !runtime.isContextRecoveryInProgress?.()
    );
  }

  private async recycleManagerRuntime(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime,
    reason: ManagerRuntimeRecycleReason
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const runtimeToken = this.options.getRuntimeToken(descriptor.agentId);
    this.options.pendingManagerRuntimeRecycleAgentIds.delete(descriptor.agentId);

    try {
      await runtime.recycle();
    } catch (error) {
      this.options.pendingManagerRuntimeRecycleAgentIds.add(descriptor.agentId);
      throw error;
    }

    this.options.detachRuntime(descriptor.agentId, runtimeToken);

    if (descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      this.options.descriptors.set(descriptor.agentId, descriptor);
    }

    await this.options.refreshSessionMetaStats(descriptor);

    this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.options.logDebug("manager:runtime_recycled", {
      agentId: descriptor.agentId,
      profileId: descriptor.profileId,
      reason,
      model: descriptor.model
    });
  }

  private async createAndAttachRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);

    const existingRuntime = this.options.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const systemPrompt = await this.options.resolveSystemPromptForDescriptor(descriptor);
    const runtimeBeforeCreate = this.options.runtimes.get(descriptor.agentId);
    if (runtimeBeforeCreate) {
      return runtimeBeforeCreate;
    }

    const runtimeToken = this.options.allocateRuntimeToken(descriptor.agentId);
    const runtime = await this.options.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
    if (descriptor.role === "manager") {
      await this.options.syncPinnedContentForManagerRuntime(descriptor as ProvisionedSessionDescriptor, { runtime });
    }
    const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;

    const latestDescriptor = this.options.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return concurrentRuntime;
    }

    this.options.attachRuntime(descriptor.agentId, runtime);
    if (latestDescriptor.role === "worker") {
      this.options.seedWorkerCompletionReportTimestamp(latestDescriptor.agentId);
    }

    const contextUsage = runtime.getContextUsage();
    latestDescriptor.contextUsage = contextUsage;
    this.options.descriptors.set(descriptor.agentId, latestDescriptor);

    if (latestDescriptor.role === "manager") {
      await this.options.captureSessionRuntimePromptMeta(latestDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStats(latestDescriptor);
    } else {
      await this.options.updateSessionMetaForWorkerDescriptor(latestDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(latestDescriptor.managerId);
    }

    this.options.emitStatus(descriptor.agentId, latestDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
  }

  private getActiveModelCapacityBlock(provider: string, modelId: string): ModelCapacityBlockLike | undefined {
    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return undefined;
    }

    const block = this.options.modelCapacityBlocks.get(key);
    if (!block) {
      return undefined;
    }

    if (Date.now() >= block.blockedUntilMs) {
      this.options.modelCapacityBlocks.delete(key);
      this.options.logDebug("model_capacity:block_expired", {
        provider: block.provider,
        modelId: block.modelId,
        blockedUntil: new Date(block.blockedUntilMs).toISOString()
      });
      return undefined;
    }

    return block;
  }
}
