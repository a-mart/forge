import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  isRepoProjectAgentSource,
  isSystemProfile,
  normalizeProjectAgentPlacement,
  type ActivateRepoProjectAgentRequest,
  type ProjectAgentCapability,
  type ProjectAgentExternalDirectoryEntry,
  type ProjectAgentPlacement,
} from "@forge/protocol";
import {
  analyzeSessionForPromotion,
  type AnalyzeSessionForPromotionOptions,
  type ProjectAgentRecommendations,
} from "./agents/project-agent-analysis.js";
import {
  assertRepoProjectAgentSourceAvailable,
  resolveRepoProjectAgentSource,
  type RepoProjectAgentSourceResolution,
} from "./agents/repo-project-agent-source.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { getModel, type Api, type Model } from "./pi/pi-ai-compat.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import {
  getRepoProjectAgentPlacementForgeDir,
  ProjectWorkspaceResolver,
  type ProjectWorkspaceResolution,
} from "./project-workspace-resolver.js";
import {
  rollbackWrittenRepoProjectAgentDefinition,
  writeRepoProjectAgentDefinition,
  type WrittenRepoProjectAgentDefinition,
} from "./repo-project-agent-definition-writer.js";
import { scanRepoProjectAgentDefinitions } from "./repo-project-agent-definitions.js";
import type { ProjectAgentSharingService } from "./project-agent-sharing-service.js";
import type { ManagerRuntimeRecycleReason } from "./runtime/runtime-recovery-state.js";
import { cloneProjectAgentInfoValue } from "./swarm-manager-utils.js";
import type { SwarmProjectAgentService } from "./swarm-project-agent-service.js";
import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ManagerProfile,
  SwarmConfig,
} from "./types.js";

export type ProjectAgentManagerDescriptor = AgentDescriptor & {
  role: "manager";
};

export type ProjectAgentSessionDescriptor = ProjectAgentManagerDescriptor & {
  profileId: string;
};

export type ActiveProjectAgentDescriptor = ProjectAgentManagerDescriptor & {
  projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
};

export interface ProjectAgentAnalysisModel {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  modelLabel: string;
}

export interface ProjectAgentWorkspaceResolverPort {
  resolve(options: {
    profileId: string;
    sessionAgentId: string;
    cwd: string;
  }): Promise<ProjectWorkspaceResolution>;
}

type ProjectAgentServicePort = Pick<
  SwarmProjectAgentService,
  | "createAndPromoteProjectAgent"
  | "activateRepoProjectAgent"
  | "setSessionProjectAgent"
  | "getProjectAgentConfig"
  | "listProjectAgentReferences"
  | "getProjectAgentReference"
  | "setProjectAgentReference"
  | "deleteProjectAgentReference"
>;

type ProjectAgentSharingPort = Pick<
  ProjectAgentSharingService,
  | "reconcile"
  | "getSharingSnapshot"
  | "replaceSharingTargets"
  | "getExternalDirectoryEntries"
  | "listGrantsForSourceAgent"
>;

export interface ProjectAgentCoordinatorOptions {
  config: SwarmConfig;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: ReadonlyMap<string, ManagerProfile>;
  projectAgents: ProjectAgentServicePort;
  sharing: ProjectAgentSharingPort;
  access: {
    getRequiredBuilderSession(
      agentId: string,
      operation: string,
    ): ProjectAgentSessionDescriptor;
    assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void;
    assertSessionSupportsProjectAgent(descriptor: ProjectAgentSessionDescriptor): void;
  };
  prompt: {
    getConversationHistory(agentId: string): ConversationEntryEvent[];
    buildResolvedManagerPrompt(
      descriptor: ProjectAgentManagerDescriptor,
      options: { ignoreProjectAgentSystemPrompt: true },
    ): Promise<string>;
    resolveLiveSystemPrompt(descriptor: ProjectAgentManagerDescriptor): Promise<string>;
    readPersistedSystemPrompt(descriptor: ProjectAgentManagerDescriptor): Promise<string | null>;
  };
  runtime: {
    hasRuntime(agentId: string): boolean;
    recycleManager(
      agentId: string,
      reason: ManagerRuntimeRecycleReason,
    ): Promise<"recycled" | "deferred" | "none">;
  };
  persistence: {
    upsertDescriptorInLiveMaps(descriptor: AgentDescriptor): void;
    saveStore(): Promise<void>;
  };
  events: {
    emitAgentsSnapshot(): void;
    emitSessionProjectAgentUpdated(
      agentId: string,
      profileId: string,
      projectAgent: AgentDescriptor["projectAgent"] | null,
    ): void;
  };
  notifyProjectAgentsChanged?: (profileId: string) => Promise<void>;
  listSessionsForProfile(profileId: string): ProjectAgentSessionDescriptor[];
  getPiModelsJsonPath(): string;
  now(): string;
  logDebug(message: string, details?: Record<string, unknown>): void;
  createWorkspaceResolver?: () => ProjectAgentWorkspaceResolverPort;
  resolveRepoSource?: typeof resolveRepoProjectAgentSource;
  resolveAnalysisModel?: () => Promise<ProjectAgentAnalysisModel>;
  analyzeSession?: (
    model: Model<Api>,
    options: AnalyzeSessionForPromotionOptions,
  ) => Promise<ProjectAgentRecommendations>;
}

/**
 * Owns the cross-service Project Agent application workflows.
 *
 * Storage mutation remains in SwarmProjectAgentService and grant persistence
 * remains in ProjectAgentSharingService. This coordinator owns the surrounding
 * access checks, repository-source freshness, runtime boundaries, analysis,
 * directory projection, and fan-out notifications.
 */
export class ProjectAgentCoordinator {
  private readonly createWorkspaceResolver: () => ProjectAgentWorkspaceResolverPort;
  private readonly resolveRepoSource: typeof resolveRepoProjectAgentSource;
  private readonly resolveAnalysisModel: () => Promise<ProjectAgentAnalysisModel>;
  private readonly analyzeSession: NonNullable<ProjectAgentCoordinatorOptions["analyzeSession"]>;

  constructor(private readonly options: ProjectAgentCoordinatorOptions) {
    this.createWorkspaceResolver = options.createWorkspaceResolver ?? (() => {
      const settingsStore = new ProjectResourceSettingsStore(options.config.paths.dataDir);
      return new ProjectWorkspaceResolver({
        dataDir: options.config.paths.dataDir,
        settingsStore,
      });
    });
    this.resolveRepoSource = options.resolveRepoSource ?? resolveRepoProjectAgentSource;
    this.resolveAnalysisModel = options.resolveAnalysisModel ?? (() => this.resolveDefaultAnalysisModel());
    this.analyzeSession = options.analyzeSession ?? analyzeSessionForPromotion;
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
      capabilities?: ProjectAgentCapability[];
      placement?: ProjectAgentPlacement;
    },
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    const placement = normalizeProjectAgentPlacement(params.placement);
    if (placement !== "repo") {
      return this.options.projectAgents.createAndPromoteProjectAgent(creatorAgentId, params);
    }

    const creatorDescriptor = this.options.access.getRequiredBuilderSession(
      creatorAgentId,
      "create project agents",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(creatorDescriptor);
    if (creatorDescriptor.sessionPurpose !== "agent_creator") {
      throw new Error("Only agent_creator sessions can create project agents");
    }

    const written = await this.writeRepoDefinitionForPlacement({
      descriptor: creatorDescriptor,
      handle: params.handle ?? params.sessionName,
      displayName: params.sessionName,
      whenToUse: params.whenToUse,
      capabilities: params.capabilities,
      prompt: params.systemPrompt,
    });

    try {
      const result = await this.activateWrittenRepoDefinition({
        sourceDescriptor: creatorDescriptor,
        definition: written.definition,
        forgeDirRealpath: written.forgeDir,
        workspaceKey: written.workspaceKey,
        mode: "create",
        applyRecommendedModel: false,
        approvedCapabilities: params.capabilities ?? [],
        creatorSessionId: creatorAgentId,
      });
      return {
        agentId: result.agentId,
        handle: result.projectAgent.handle,
        profileId: result.profileId,
      };
    } catch (error) {
      await this.removeWrittenDefinitionIfUnreferenced(written, {
        operation: "create",
        agentId: creatorAgentId,
      });
      throw error;
    }
  }

  async activateRepoProjectAgent(
    request: ActivateRepoProjectAgentRequest,
  ): Promise<{
    profileId: string;
    agentId: string;
    projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
  }> {
    const sourceDescriptor = this.options.access.getRequiredBuilderSession(
      request.sessionAgentId,
      "activate repository project agents",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(sourceDescriptor);
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    if (request.profileId !== profileId) {
      throw new Error("Session does not belong to the requested profile.");
    }

    const resolver = this.createWorkspaceResolver();
    const resolution = await resolver.resolve({
      profileId,
      sessionAgentId: sourceDescriptor.agentId,
      cwd: sourceDescriptor.cwd,
    });
    if (resolution.warning) {
      throw new Error(resolution.warning);
    }
    if (!resolution.effectiveForgeDirRealpath || !resolution.repoRootResources.projectAgentsDir) {
      throw new Error("No repository project-agent definitions directory is available for this workspace.");
    }

    const inventory = await scanRepoProjectAgentDefinitions(
      resolution.repoRootResources.projectAgentsDir,
    );
    if (inventory.problems?.length) {
      throw new Error(
        `Repository project-agent definitions are unavailable: ${inventory.problems.map((problem) => problem.message).join("; ")}`,
      );
    }
    const item = inventory.items.find(
      (candidate) => candidate.definitionId === request.definitionId,
    );
    if (!item) {
      throw new Error(`Repository project-agent definition not found: ${request.definitionId}`);
    }
    if (item.status !== "valid") {
      throw new Error(
        `Repository project-agent definition ${request.definitionId} is ${item.status}: ${item.problems.map((problem) => problem.message).join("; ")}`,
      );
    }
    const definition = inventory.definitions.find(
      (candidate) => candidate.definitionId === request.definitionId,
    );
    if (!definition) {
      throw new Error(
        `Repository project-agent definition ${request.definitionId} is not activatable.`,
      );
    }

    const result = await this.options.projectAgents.activateRepoProjectAgent({
      profileId,
      sourceSessionAgentId: sourceDescriptor.agentId,
      mode: request.mode,
      definition,
      source: {
        type: "repo",
        workspaceKey: resolution.workspaceKey,
        forgeDirRealpath: resolution.effectiveForgeDirRealpath,
        definitionId: definition.definitionId,
        activatedAt: this.options.now(),
        signature: definition.signature,
      },
      ...(request.targetAgentId ? { targetAgentId: request.targetAgentId } : {}),
      applyRecommendedModel: request.applyRecommendedModel,
      approvedCapabilities: request.approvedCapabilities,
      explicitBindToSourceWorkspace: request.explicitBindToSourceWorkspace,
      resolveSessionWorkspaceSource: async (descriptor) => {
        const targetResolution = await resolver.resolve({
          profileId: descriptor.profileId ?? descriptor.agentId,
          sessionAgentId: descriptor.agentId,
          cwd: descriptor.cwd,
        });
        return {
          workspaceKey: targetResolution.workspaceKey,
          ...(targetResolution.effectiveForgeDirRealpath
            ? { forgeDirRealpath: targetResolution.effectiveForgeDirRealpath }
            : {}),
        };
      },
    });

    await this.notifySharedTargetsChanged(result.agentId);
    return {
      ...result,
      projectAgent: cloneProjectAgentInfoValue(
        result.projectAgent,
      ) as NonNullable<AgentDescriptor["projectAgent"]>,
    };
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent:
      | {
          whenToUse: string;
          systemPrompt?: string;
          handle?: string;
          capabilities?: ProjectAgentCapability[];
          placement?: ProjectAgentPlacement;
        }
      | null,
  ): Promise<{
    profileId: string;
    projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null;
  }> {
    const descriptor = this.options.access.getRequiredBuilderSession(
      agentId,
      "promote Builder sessions to project agents",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    this.options.access.assertSessionSupportsProjectAgent(descriptor);
    const previous = descriptor.projectAgent;
    const placement = projectAgent ? normalizeProjectAgentPlacement(projectAgent.placement) : "local";
    if (projectAgent && placement === "repo") {
      if (previous) {
        throw new Error("Cannot change Project Agent placement after promotion. Demote and re-promote to place the definition in the repository.");
      }
      const written = await this.writeRepoDefinitionForPlacement({
        descriptor,
        handle: projectAgent.handle ?? descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId,
        displayName: descriptor.sessionLabel ?? descriptor.displayName,
        whenToUse: projectAgent.whenToUse,
        capabilities: projectAgent.capabilities,
        prompt: projectAgent.systemPrompt ?? "",
      });
      try {
        const activated = await this.activateWrittenRepoDefinition({
          sourceDescriptor: descriptor,
          definition: written.definition,
          forgeDirRealpath: written.forgeDir,
          workspaceKey: written.workspaceKey,
          mode: "link",
          targetAgentId: descriptor.agentId,
          applyRecommendedModel: false,
          approvedCapabilities: projectAgent.capabilities ?? [],
        });
        return {
          profileId: activated.profileId,
          projectAgent: cloneProjectAgentInfoValue(activated.projectAgent) ?? activated.projectAgent,
        };
      } catch (error) {
        await this.removeWrittenDefinitionIfUnreferenced(written, {
          operation: "link",
          agentId: descriptor.agentId,
        });
        throw error;
      }
    }
    const result = await this.options.projectAgents.setSessionProjectAgent(agentId, projectAgent);
    const next = this.options.descriptors.get(agentId)?.projectAgent;
    const promptChanged = previous?.systemPrompt !== next?.systemPrompt;
    const directoryChanged =
      previous?.handle !== next?.handle ||
      previous?.whenToUse !== next?.whenToUse ||
      JSON.stringify(previous?.capabilities ?? []) !== JSON.stringify(next?.capabilities ?? []);

    if (promptChanged && !directoryChanged) {
      await this.notifyPromptSourceChanged(agentId);
    }
    if (directoryChanged) {
      await this.notifySharedTargetsChanged(agentId);
    }
    return result;
  }

  async requestRecommendations(agentId: string): Promise<ProjectAgentRecommendations> {
    const descriptor = this.options.access.getRequiredBuilderSession(
      agentId,
      "request project-agent recommendations for Builder sessions",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    this.options.access.assertSessionSupportsProjectAgent(descriptor);

    const [conversationHistory, currentSystemPrompt, analysisModel] = await Promise.all([
      Promise.resolve(this.options.prompt.getConversationHistory(agentId)),
      this.options.prompt.buildResolvedManagerPrompt(descriptor, {
        ignoreProjectAgentSystemPrompt: true,
      }),
      this.resolveAnalysisModel(),
    ]);

    return this.analyzeSession(analysisModel.model, {
      conversationHistory,
      currentSystemPrompt,
      sessionAgentId: descriptor.agentId,
      sessionLabel: descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId,
      displayName: descriptor.displayName,
      profileId: descriptor.profileId,
      sessionCwd: descriptor.cwd,
      apiKey: analysisModel.apiKey,
      headers: analysisModel.headers,
    });
  }

  getProjectAgentConfig(agentId: string) {
    this.options.access.getRequiredBuilderSession(
      agentId,
      "inspect Builder project-agent settings",
    );
    return this.options.projectAgents.getProjectAgentConfig(agentId);
  }

  async getProjectAgentSharing(agentId: string) {
    this.getMutableProjectAgent(agentId, "manage project-agent sharing");
    return this.options.sharing.getSharingSnapshot(agentId);
  }

  async setProjectAgentSharing(agentId: string, targetProfileIds: readonly string[]) {
    this.getMutableProjectAgent(agentId, "manage project-agent sharing");
    const result = await this.options.sharing.replaceSharingTargets(agentId, targetProfileIds);
    await this.notifySharedTargetsChanged(agentId, [
      ...result.addedTargetProfileIds,
      ...result.removedTargetProfileIds,
    ]);
    return result;
  }

  async getExternalDirectory(profileId: string): Promise<ProjectAgentExternalDirectoryEntry[]> {
    const profile = this.options.profiles.get(profileId);
    if (profile && isSystemProfile(profile)) {
      return [];
    }

    const entries = this.options.sharing.getExternalDirectoryEntries(profileId);
    const filteredEntries: ProjectAgentExternalDirectoryEntry[] = [];
    for (const entry of entries) {
      const sourceDescriptor = this.options.descriptors.get(entry.agentId);
      if (!isRepoProjectAgentDescriptor(sourceDescriptor)) {
        filteredEntries.push(entry);
        continue;
      }

      try {
        await this.assertRepoSourceAvailableForDirectory(sourceDescriptor);
        filteredEntries.push(entry);
      } catch (error) {
        this.options.logDebug("project_agent:external_directory:exclude_unavailable_repo_source", {
          profileId,
          sourceAgentId: entry.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return filteredEntries;
  }

  listReferences(agentId: string): Promise<string[]> {
    this.options.access.getRequiredBuilderSession(
      agentId,
      "list Builder project-agent references",
    );
    return this.options.projectAgents.listProjectAgentReferences(agentId);
  }

  getReference(agentId: string, fileName: string): Promise<string> {
    this.options.access.getRequiredBuilderSession(
      agentId,
      "read Builder project-agent references",
    );
    return this.options.projectAgents.getProjectAgentReference(agentId, fileName);
  }

  async setReference(agentId: string, fileName: string, content: string): Promise<void> {
    const descriptor = this.options.access.getRequiredBuilderSession(
      agentId,
      "edit Builder project-agent references",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    const flags = await this.options.projectAgents.setProjectAgentReference(
      agentId,
      fileName,
      content,
    );
    if (flags.referenceChanged) {
      await this.notifyPromptSourceChanged(agentId);
    }
  }

  async deleteReference(agentId: string, fileName: string): Promise<void> {
    const descriptor = this.options.access.getRequiredBuilderSession(
      agentId,
      "delete Builder project-agent references",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    const flags = await this.options.projectAgents.deleteProjectAgentReference(agentId, fileName);
    if (flags.referenceChanged) {
      await this.notifyPromptSourceChanged(agentId);
    }
  }

  async reconcileSharing(): Promise<boolean> {
    return this.options.sharing.reconcile();
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.options.listSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) =>
        this.options.runtime.recycleManager(
          session.agentId,
          "project_agent_directory_change",
        )),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  async notifySharedTargetsChanged(
    sourceAgentId: string,
    targetProfileIds?: readonly string[],
  ): Promise<void> {
    const sourceDescriptor = this.options.descriptors.get(sourceAgentId);
    const fallbackTargetProfileIds = this.options.sharing
      .listGrantsForSourceAgent(sourceAgentId)
      .map((grant) => grant.targetProfileId);
    const uniqueTargetProfileIds = Array.from(
      new Set(targetProfileIds ?? fallbackTargetProfileIds),
    );
    if (uniqueTargetProfileIds.length === 0) {
      return;
    }

    if (sourceDescriptor?.role === "manager" && sourceDescriptor.profileId) {
      this.options.events.emitSessionProjectAgentUpdated(
        sourceDescriptor.agentId,
        sourceDescriptor.profileId,
        sourceDescriptor.projectAgent ?? null,
      );
    }
    await Promise.allSettled(
      uniqueTargetProfileIds.map((profileId) => this.notifyProfileChanged(profileId)),
    );
  }

  async assertRepoSourceAvailableForExternalDelivery(
    descriptor: ActiveProjectAgentDescriptor,
  ): Promise<void> {
    let resolution: RepoProjectAgentSourceResolution | undefined;
    try {
      resolution = await this.resolveSource(descriptor);
      assertRepoProjectAgentSourceAvailable(resolution);
    } catch {
      if (resolution) {
        await this.notifyUnavailableSharedRepoSource(descriptor, resolution);
      } else {
        await this.notifySharedTargetsChanged(descriptor.agentId);
      }
      throw new Error(this.formatUnavailableSharedRepoSourceError(descriptor, resolution));
    }
  }

  async preflightRuntime(descriptor: AgentDescriptor): Promise<void> {
    if (!isRepoProjectAgentDescriptor(descriptor)) {
      return;
    }

    const resolution = await this.resolveSource(descriptor);
    let definition;
    try {
      definition = assertRepoProjectAgentSourceAvailable(resolution);
    } catch (error) {
      await this.notifyUnavailableSharedRepoSource(descriptor, resolution);
      throw error;
    }
    const currentSource = descriptor.projectAgent.source;
    const signatureChanged = currentSource.signature !== definition.signature;
    const whenToUseChanged = descriptor.projectAgent.whenToUse !== definition.config.whenToUse;
    if (!signatureChanged && !whenToUseChanged) {
      return;
    }

    if (this.options.runtime.hasRuntime(descriptor.agentId)) {
      const disposition = await this.options.runtime.recycleManager(
        descriptor.agentId,
        "prompt_mode_change",
      );
      if (disposition !== "recycled") {
        throw new Error(
          `Repository project-agent source ${currentSource.definitionId} changed while ${descriptor.agentId} has an active runtime. Wait for the current turn to finish before sending another message.`,
        );
      }
    }

    descriptor.projectAgent = {
      ...descriptor.projectAgent,
      whenToUse: definition.config.whenToUse,
      source: { ...currentSource, signature: definition.signature },
    };
    descriptor.updatedAt = this.options.now();
    this.options.persistence.upsertDescriptorInLiveMaps(descriptor);
    await this.options.persistence.saveStore();
    this.options.events.emitAgentsSnapshot();
    await Promise.allSettled([
      this.notifyProfileChanged(descriptor.profileId ?? descriptor.agentId),
      this.notifySharedTargetsChanged(descriptor.agentId),
    ]);
  }

  async validateSourceForRead(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (isRepoProjectAgentDescriptor(descriptor)) {
      await this.preflightRuntime(descriptor);
    }
  }

  async resolveSystemPromptForRead(agentId: string): Promise<string | null> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return null;
    }
    const session = descriptor as ProjectAgentManagerDescriptor;
    if (isRepoProjectAgentSource(session.projectAgent?.source)) {
      await this.preflightRuntime(session);
      return this.options.prompt.resolveLiveSystemPrompt(session);
    }
    return this.options.prompt.readPersistedSystemPrompt(session);
  }

  private async writeRepoDefinitionForPlacement(options: {
    descriptor: ProjectAgentSessionDescriptor;
    handle: string;
    displayName?: string;
    whenToUse: string;
    capabilities?: ProjectAgentCapability[];
    prompt: string;
  }): Promise<WrittenRepoProjectAgentDefinition & { workspaceKey: string }> {
    const resolver = this.createWorkspaceResolver();
    const resolution = await resolver.resolve({
      profileId: options.descriptor.profileId,
      sessionAgentId: options.descriptor.agentId,
      cwd: options.descriptor.cwd,
    });
    const placementForgeDir = getRepoProjectAgentPlacementForgeDir(resolution);
    if (!placementForgeDir.ok) {
      throw new Error(placementForgeDir.error);
    }
    const written = await writeRepoProjectAgentDefinition({
      forgeDir: placementForgeDir.forgeDir,
      handle: options.handle,
      displayName: options.displayName,
      whenToUse: options.whenToUse,
      capabilities: options.capabilities,
      prompt: options.prompt,
      containmentRoot: placementForgeDir.containmentRoot,
    });
    return {
      ...written,
      workspaceKey: resolution.workspaceKey,
    };
  }

  private hasLiveRepoDefinitionReference(written: {
    definition: WrittenRepoProjectAgentDefinition["definition"];
    definitionId: string;
    forgeDir: string;
    workspaceKey: string;
  }): boolean {
    return Array.from(this.options.descriptors.values()).some((descriptor) => {
      const source = descriptor.projectAgent?.source;
      return source?.type === "repo"
        && source.workspaceKey === written.workspaceKey
        && source.forgeDirRealpath === written.forgeDir
        && source.definitionId === written.definitionId
        && source.signature === written.definition.signature;
    });
  }

  private async removeWrittenDefinitionIfUnreferenced(
    written: WrittenRepoProjectAgentDefinition & { workspaceKey: string },
    context: { operation: "create" | "link"; agentId: string },
  ): Promise<void> {
    if (this.hasLiveRepoDefinitionReference(written)) {
      return;
    }
    try {
      await rollbackWrittenRepoProjectAgentDefinition(written);
    } catch (cleanupError) {
      this.options.logDebug("project_agent:repo_placement:cleanup_error", {
        operation: context.operation,
        agentId: context.agentId,
        definitionId: written.definitionId,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  private activateWrittenRepoDefinition(options: {
    sourceDescriptor: ProjectAgentSessionDescriptor;
    definition: WrittenRepoProjectAgentDefinition["definition"];
    forgeDirRealpath: string;
    workspaceKey: string;
    mode: "create" | "link";
    targetAgentId?: string;
    applyRecommendedModel: boolean;
    approvedCapabilities?: ProjectAgentCapability[];
    creatorSessionId?: string;
  }) {
    const resolver = this.createWorkspaceResolver();
    return this.options.projectAgents.activateRepoProjectAgent({
      profileId: options.sourceDescriptor.profileId,
      sourceSessionAgentId: options.sourceDescriptor.agentId,
      mode: options.mode,
      definition: options.definition,
      source: {
        type: "repo",
        workspaceKey: options.workspaceKey,
        forgeDirRealpath: options.forgeDirRealpath,
        definitionId: options.definition.definitionId,
        activatedAt: this.options.now(),
        signature: options.definition.signature,
      },
      ...(options.targetAgentId ? { targetAgentId: options.targetAgentId } : {}),
      applyRecommendedModel: options.applyRecommendedModel,
      approvedCapabilities: options.approvedCapabilities,
      ...(options.creatorSessionId !== undefined ? { creatorSessionId: options.creatorSessionId } : {}),
      explicitBindToSourceWorkspace: false,
      resolveSessionWorkspaceSource: async (descriptor) => {
        const targetResolution = await resolver.resolve({
          profileId: descriptor.profileId ?? descriptor.agentId,
          sessionAgentId: descriptor.agentId,
          cwd: descriptor.cwd,
        });
        return {
          workspaceKey: targetResolution.workspaceKey,
          ...(targetResolution.effectiveForgeDirRealpath
            ? { forgeDirRealpath: targetResolution.effectiveForgeDirRealpath }
            : {}),
        };
      },
    });
  }

  private getMutableProjectAgent(
    agentId: string,
    operation: string,
  ): ActiveProjectAgentDescriptor {
    const descriptor = this.options.access.getRequiredBuilderSession(agentId, operation);
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    if (!descriptor.projectAgent) {
      throw new Error("Session is not a project agent");
    }
    return descriptor as ActiveProjectAgentDescriptor;
  }

  private async assertRepoSourceAvailableForDirectory(
    descriptor: ActiveProjectAgentDescriptor,
  ): Promise<void> {
    const resolution = await this.resolveSource(descriptor);
    try {
      assertRepoProjectAgentSourceAvailable(resolution);
    } catch (error) {
      await this.notifyUnavailableSharedRepoSource(descriptor, resolution);
      throw error;
    }
  }

  private resolveSource(
    descriptor: ActiveProjectAgentDescriptor,
  ): Promise<RepoProjectAgentSourceResolution> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    return this.resolveRepoSource(
      {
        descriptor: {
          ...descriptor,
          profileId,
        },
        profileId,
        handle: descriptor.projectAgent.handle,
      },
      { dataDir: this.options.config.paths.dataDir },
    );
  }

  private async notifyUnavailableSharedRepoSource(
    descriptor: ActiveProjectAgentDescriptor,
    resolution: RepoProjectAgentSourceResolution,
  ): Promise<void> {
    if (resolution.source.status !== "valid") {
      await this.notifySharedTargetsChanged(descriptor.agentId);
    }
  }

  private formatUnavailableSharedRepoSourceError(
    descriptor: ActiveProjectAgentDescriptor,
    resolution?: RepoProjectAgentSourceResolution,
  ): string {
    const handle = descriptor.projectAgent.handle ? ` @${descriptor.projectAgent.handle}` : "";
    const status = resolution?.source.status ?? "unavailable";
    return `Shared project agent${handle} is unavailable because its repository source is ${status}. Ask the source project to restore or refresh the repository project-agent definition.`;
  }

  private async notifyPromptSourceChanged(agentId: string): Promise<void> {
    try {
      await this.options.runtime.recycleManager(agentId, "prompt_mode_change");
    } catch (error) {
      this.options.logDebug("project_agent:prompt_source_change:recycle:error", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifyProfileChanged(profileId: string): Promise<void> {
    return this.options.notifyProjectAgentsChanged?.(profileId) ??
      this.notifyProjectAgentsChanged(profileId);
  }

  private async resolveDefaultAnalysisModel(): Promise<ProjectAgentAnalysisModel> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.options.config);
    const authStorage = AuthStorage.create(authFilePath);
    const modelRegistry = createPiModelRegistry(
      authStorage,
      this.options.getPiModelsJsonPath(),
    );
    const candidates = [
      { provider: "anthropic", modelId: "claude-opus-4-6" },
      { provider: "openai-codex", modelId: "gpt-5.6-terra" },
      { provider: "openai-codex", modelId: "gpt-5.5" },
    ] as const;
    const failureMessages: string[] = [];

    for (const candidate of candidates) {
      const model =
        modelRegistry.find(candidate.provider, candidate.modelId) ??
        (getModel(
          candidate.provider as never,
          candidate.modelId as never,
        ) as Model<Api> | undefined);
      if (!model) {
        failureMessages.push(`Model ${candidate.provider}/${candidate.modelId} is unavailable.`);
        continue;
      }
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        failureMessages.push(`${candidate.provider}/${candidate.modelId}: ${auth.error}`);
        continue;
      }
      return {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        modelLabel: `${candidate.provider}/${candidate.modelId}`,
      };
    }

    throw new Error(
      [
        "No configured model is available for project agent analysis.",
        "Tried anthropic/claude-opus-4-6, openai-codex/gpt-5.6-terra, then openai-codex/gpt-5.5.",
        failureMessages.join(" "),
      ]
        .filter((part) => part.trim().length > 0)
        .join(" "),
    );
  }
}

function isRepoProjectAgentDescriptor(
  descriptor: AgentDescriptor | undefined,
): descriptor is ActiveProjectAgentDescriptor & {
  projectAgent: ActiveProjectAgentDescriptor["projectAgent"] & {
    source: Extract<
      NonNullable<AgentDescriptor["projectAgent"]>["source"],
      { type: "repo" }
    >;
  };
} {
  return Boolean(
    descriptor &&
      descriptor.role === "manager" &&
      descriptor.projectAgent &&
      isRepoProjectAgentSource(descriptor.projectAgent.source),
  );
}
