import type { SpecialistTargetSpace, TierConfig } from "@forge/protocol";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { parseCollaborationSpecialistHandlesJson } from "../collaboration/specialist-selection.js";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import { normalizeArchetypeId, type PromptRegistry } from "./prompt-registry.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import { classifyRuntimeCapacityError } from "./runtime-utils.js";
import type { SkillMetadata, SkillMetadataService } from "./skill-metadata-service.js";
import { resolveCollaborationSkillRoster } from "./skills/collaboration-skill-resolver.js";
import {
  generateRosterBlock,
  normalizeSpecialistHandle,
  resolveCollaborationChannelRoster,
  resolveRoster,
  resolveTierConfigs,
  resolveWorkspaceRoster,
} from "./specialists/specialist-registry.js";
import {
  formatDelegationRosterModelContext,
  resolveDelegationRosterForManager,
} from "./specialists/delegation-roster-store.js";
import type {
  AgentDescriptor,
  SpawnAgentInput,
  SwarmConfig,
  SwarmReasoningLevel,
} from "./types.js";
import type { RuntimeErrorEvent } from "./runtime-contracts.js";
import {
  buildModelCapacityBlockKey,
  clampModelCapacityBlockDurationMs,
  getCollabSessionInfo,
  isCollabSession,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
  previewForLog,
  readStringDetail,
} from "./swarm-manager-utils.js";

const MERGER_ARCHETYPE_ID = "merger";
const MODEL_CAPACITY_BLOCK_DEFAULT_MS = 10 * 60_000;

export interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
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

export interface SpecialistRegistryModule {
  resolveRoster(
    profileId: string,
    targetSpace?: SpecialistTargetSpace,
  ): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[], tierConfigs?: readonly TierConfig[]): string;
  resolveTierConfigs(): Promise<TierConfig[]>;
  normalizeSpecialistHandle(value: string): string;
}

export interface ModelCapacityBlock {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
  blockSetAt: string;
  sourcePhase: RuntimeErrorEvent["phase"];
  reason: string;
}

export interface PromptResourceCoordinatorOptions {
  config: SwarmConfig;
  promptRegistry: PromptRegistry;
  skillMetadataService: SkillMetadataService;
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  applySpecialistAvailability(
    roster: ResolvedSpecialistDefinitionLike[],
    targetSpace: SpecialistTargetSpace,
    managerAgentId: string,
  ): ResolvedSpecialistDefinitionLike[] | Promise<ResolvedSpecialistDefinitionLike[]>;
  now: () => string;
  logDebug(message: string, details?: unknown): void;
}

/** Resolves project-scoped prompt resources and owns transient model-capacity policy state. */
export class PromptResourceCoordinator {
  readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  private specialistRegistryModulePromise: Promise<SpecialistRegistryModule> | null = null;

  constructor(private readonly options: PromptResourceCoordinatorOptions) {}

  maybeRecordModelCapacityBlock(
    agentId: string,
    descriptor: AgentDescriptor,
    error: RuntimeErrorEvent,
  ): void {
    if (descriptor.role !== "worker" || (error.phase !== "prompt_dispatch" && error.phase !== "prompt_start")) {
      return;
    }

    const classification = classifyRuntimeCapacityError(formatRuntimeErrorForCapacityClassification(error));
    if (!classification.isQuotaOrRateLimit) {
      return;
    }

    const blockDurationMs = clampModelCapacityBlockDurationMs(
      classification.retryAfterMs ?? MODEL_CAPACITY_BLOCK_DEFAULT_MS,
    );
    const provider = normalizeOptionalAgentId(descriptor.model.provider)?.toLowerCase();
    const modelId = normalizeOptionalModelId(descriptor.model.modelId)?.toLowerCase();
    if (!blockDurationMs || !provider || !modelId) {
      return;
    }

    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return;
    }

    const blockedUntilMs = Date.now() + blockDurationMs;
    const existing = this.modelCapacityBlocks.get(key);
    if (existing && existing.blockedUntilMs >= blockedUntilMs) {
      return;
    }

    this.modelCapacityBlocks.set(key, {
      provider,
      modelId,
      blockedUntilMs,
      blockSetAt: this.options.now(),
      sourcePhase: error.phase,
      reason: error.message,
    });
    this.options.logDebug("model_capacity:block_set", {
      agentId,
      provider,
      modelId,
      phase: error.phase,
      retryAfterMs: classification.retryAfterMs,
      blockDurationMs,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      messagePreview: previewForLog(error.message, 240),
    });
  }

  async resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string,
  ): Promise<string | undefined> {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!await this.options.promptRegistry.resolveEntry("archetype", explicit, profileId)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    return normalizedAgentId === MERGER_ARCHETYPE_ID || normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
      ? MERGER_ARCHETYPE_ID
      : undefined;
  }

  async loadSpecialistRegistryModule(): Promise<SpecialistRegistryModule> {
    if (!this.specialistRegistryModulePromise) {
      const dataDir = this.options.config.paths.dataDir;
      this.specialistRegistryModulePromise = Promise.resolve({
        resolveRoster: (profileId, targetSpace) =>
          resolveRoster(profileId, dataDir, targetSpace) as Promise<ResolvedSpecialistDefinitionLike[]>,
        generateRosterBlock: generateRosterBlock as SpecialistRegistryModule["generateRosterBlock"],
        resolveTierConfigs: () => resolveTierConfigs(dataDir),
        normalizeSpecialistHandle,
      });
    }
    return this.specialistRegistryModulePromise;
  }

  async resolveSpecialistRosterForProfile(
    profileId: string,
    targetSpace: SpecialistTargetSpace = "builder",
    workspaceSpecialistsDir?: string,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (workspaceSpecialistsDir && targetSpace !== "collaboration") {
      return resolveWorkspaceRoster(
        profileId,
        this.options.config.paths.dataDir,
        workspaceSpecialistsDir,
        targetSpace,
      ) as Promise<ResolvedSpecialistDefinitionLike[]>;
    }
    return (await this.loadSpecialistRegistryModule()).resolveRoster(profileId, targetSpace);
  }

  async resolveSpecialistRosterForManager(
    manager: AgentDescriptor,
    targetSpace: SpecialistTargetSpace = "builder",
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (targetSpace !== "collaboration" || !isCollabSession(manager)) {
      const workspace = await this.resolveProjectWorkspaceForManager(manager);
      const roster = await this.resolveSpecialistRosterForProfile(
        manager.profileId ?? manager.agentId,
        targetSpace,
        workspace?.repoRootResources.specialistsDir,
      );
      return this.options.applySpecialistAvailability(roster, targetSpace, manager.agentId);
    }

    const channelId = manager.collab?.channelId;
    if (!channelId || !isCollaborationServerRuntimeTarget(this.options.config.runtimeTarget)) {
      return this.resolveCollaborationSpecialists(manager.agentId, []);
    }

    try {
      const channel = (await createCollaborationDbHelpers(this.options.config)).getChannel(channelId);
      return channel
        ? this.resolveCollaborationSpecialists(
            channel.backingSessionAgentId,
            parseCollaborationSpecialistHandlesJson(channel.activeSpecialistHandlesJson),
          )
        : this.resolveCollaborationSpecialists(manager.agentId, []);
    } catch (error) {
      this.options.logDebug("collaboration:specialists:resolve_error", {
        agentId: manager.agentId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.resolveCollaborationSpecialists(manager.agentId, []);
    }
  }

  async buildDelegationRosterModelContext(manager: AgentDescriptor): Promise<string> {
    return formatDelegationRosterModelContext(
      await resolveDelegationRosterForManager(this.options.config.paths.dataDir, manager),
    );
  }

  async resolveProjectWorkspaceForManager(manager: AgentDescriptor) {
    const profileId = manager.profileId ?? manager.agentId;
    try {
      return await new ProjectWorkspaceResolver({
        dataDir: this.options.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
      }).resolvePassive({ profileId, sessionAgentId: manager.agentId, cwd: manager.cwd });
    } catch (error) {
      this.options.logDebug("project_resources:resolve:error", {
        agentId: manager.agentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async resolveSkillRosterForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[] | null> {
    const manager = descriptor.role === "manager"
      ? descriptor
      : this.options.getDescriptor(descriptor.managerId);
    const collabInfo = getCollabSessionInfo(manager);
    if (manager?.role === "manager" && collabInfo) {
      return this.resolveCollaborationSkills(
        descriptor,
        manager as AgentDescriptor & { role: "manager" },
        collabInfo.channelId,
      );
    }

    const profileId = manager?.role === "manager"
      ? normalizeOptionalAgentId(manager.profileId) ?? manager.agentId
      : normalizeOptionalAgentId(descriptor.profileId);
    if (!profileId) {
      return null;
    }

    const workspace = manager?.role === "manager"
      ? await this.resolveProjectWorkspaceForManager(manager)
      : undefined;
    return this.options.skillMetadataService.getProfileSkillMetadataForWorkspace(
      profileId,
      workspace?.effectiveForgeDirRealpath,
    );
  }

  private resolveCollaborationSpecialists(
    sessionAgentId: string,
    selectedGlobalHandles: string[],
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    return resolveCollaborationChannelRoster(this.options.config.paths.dataDir, {
      sessionAgentId,
      selectedGlobalHandles,
    }) as Promise<ResolvedSpecialistDefinitionLike[]>;
  }

  private async resolveCollaborationSkills(
    descriptor: AgentDescriptor,
    manager: AgentDescriptor & { role: "manager" },
    channelId: string,
  ): Promise<SkillMetadata[]> {
    try {
      const channel = (await createCollaborationDbHelpers(this.options.config)).getChannel(channelId);
      if (!channel) {
        this.options.logDebug("collaboration:skills:channel_missing", {
          agentId: descriptor.agentId,
          managerId: manager.agentId,
          channelId,
        });
      }
      const roster = await resolveCollaborationSkillRoster({
        selectionJson: channel?.activeSkillHandlesJson ?? "[]",
        skillMetadataService: this.options.skillMetadataService,
      });
      return roster.skills;
    } catch (error) {
      this.options.logDebug("collaboration:skills:resolve_error", {
        agentId: descriptor.agentId,
        managerId: manager.agentId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
      return (await resolveCollaborationSkillRoster({
        selectionJson: "[]",
        skillMetadataService: this.options.skillMetadataService,
      })).skills;
    }
  }
}

function formatRuntimeErrorForCapacityClassification(error: RuntimeErrorEvent): string {
  const detailParts = [
    readStringDetail(error.details, "errorName"),
    readStringDetail(error.details, "errorCode"),
  ].filter((value): value is string => Boolean(value));
  return detailParts.length > 0 ? `${error.message} ${detailParts.join(" ")}` : error.message;
}
