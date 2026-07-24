import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import type {
  CredentialPoolState,
  CredentialPoolStrategy,
  ManagerExactModelSelection,
  OpenAIBrokerInviteRedeemResponse,
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerTestResponse,
  PooledCredentialInfo,
  PromptPreviewResponse,
  RedeemOpenAIBrokerInviteRequest,
  SkillBundleManifestV1,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillImportPreviewResponse,
  SkillImportResultResponse,
  SkillImportTarget,
  SkillInventoryEntry,
  SkillShareResponse,
  SpecialistTargetSpace,
  UpdateOpenAIBrokerSettingsRequest,
} from "@forge/protocol";
import type { CredentialPoolService } from "./credential-pool.js";
import {
  normalizeAllowlistRoots,
  validateDirectoryPath,
  type CreateDirectoryResult,
  type DirectoryListingResult,
  type DirectoryValidationResult,
} from "./cwd-policy.js";
import { generatePiProjection } from "./model-catalog-projection.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { getModelCacheVisualizationEnabled } from "./model-cache-visualization-settings.js";
import { resolveModelDescriptorFromPreset } from "./model-presets.js";
import {
  PromptResourceCoordinator,
  type PromptResourceCoordinatorOptions,
  type ResolvedSpecialistDefinitionLike,
  type SpecialistRegistryModule,
} from "./prompt-resource-coordinator.js";
import { normalizeArchetypeId, type PromptRegistry } from "./prompt-registry.js";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { RuntimeErrorEvent } from "./runtime-contracts.js";
import type { SecretsEnvService } from "./secrets-env-service.js";
import type { SkillFileService } from "./skill-file-service.js";
import type { SkillMetadata, SkillMetadataService } from "./skill-metadata-service.js";
import type { ImportSkillOptions } from "./skills/skill-sharing-service.js";
import { SwarmPromptService, type SwarmPromptServiceOptions } from "./swarm-prompt-service.js";
import {
  SwarmSettingsService,
  type ManagerRuntimeRecycleReason,
  type SwarmSettingsServiceOptions,
} from "./swarm-settings-service.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ManagerProfile,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";

type ManagerSessionDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface SwarmConfigurationAccessPolicy {
  assertManagerSettingsTargetNotArchived(managerId: string, action: string): void;
  assertProfileNotArchived(profileId: string): void;
  getRequiredBuilderSessionDescriptor(agentId: string, action: string): AgentDescriptor;
  getRequiredCollaborationSessionDescriptor(agentId: string, action: string): AgentDescriptor;
  assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void;
}

export interface SwarmConfigurationSessionIndex {
  getSessionsForProfile(profileId: string): ManagerSessionDescriptor[];
  getAllManagerSessions(): ManagerSessionDescriptor[];
  getSessionById(agentId: string): ManagerSessionDescriptor | undefined;
}

export interface SwarmConfigurationPersistence {
  transactionDescriptors: NonNullable<SwarmSettingsServiceOptions["transactionDescriptors"]>;
  saveStore(): Promise<void>;
  emitAgentsSnapshot(): void;
  emitProfilesSnapshot(): void;
}

export type SwarmConfigurationPromptHost = Omit<
  SwarmPromptServiceOptions,
  | "config"
  | "descriptors"
  | "profiles"
  | "promptRegistry"
  | "skillMetadataService"
  | "getSessionsForProfile"
  | "loadSpecialistRegistryModule"
  | "resolveSpecialistRosterForManager"
  | "resolveSkillRosterForDescriptor"
  | "logDebug"
>;

export interface SwarmConfigurationCoordinatorOptions {
  config: SwarmConfig;
  defaultModelPreset: SwarmModelPreset;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  promptRegistry: PromptRegistry;
  skillMetadataService: SkillMetadataService;
  skillFileService: SkillFileService;
  secretsEnvService: SecretsEnvService;
  secureSessions: {
    hasActiveSession(agentId: string): boolean;
    stopForLifecycle(agentId: string): Promise<void>;
  };
  sessions: SwarmConfigurationSessionIndex;
  access: SwarmConfigurationAccessPolicy;
  persistence: SwarmConfigurationPersistence;
  prompt: SwarmConfigurationPromptHost;
  applySpecialistAvailability: PromptResourceCoordinatorOptions["applySpecialistAvailability"];
  applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason,
  ): Promise<"recycled" | "deferred" | "none">;
  now: () => string;
  logDebug(message: string, details?: unknown): void;
}

/**
 * Owns live model, skill, secret, directory, and prompt configuration.
 *
 * This is the application boundary above the focused settings, prompt, and
 * resource services. It deliberately receives named state/capability groups;
 * it never reaches back into SwarmManager or performs late service lookup.
 */
export class SwarmConfigurationCoordinator {
  readonly settings: SwarmSettingsService;
  readonly promptResources: PromptResourceCoordinator;
  readonly prompts: SwarmPromptService;
  readonly skills: SkillMetadataService;
  readonly secrets: SecretsEnvService;

  private modelCacheVisualizationEnabled = false;
  private piModelsJsonPath: string | null = null;

  constructor(private readonly options: SwarmConfigurationCoordinatorOptions) {
    this.skills = options.skillMetadataService;
    this.secrets = options.secretsEnvService;
    this.promptResources = new PromptResourceCoordinator({
      config: options.config,
      promptRegistry: options.promptRegistry,
      skillMetadataService: options.skillMetadataService,
      getDescriptor: (agentId) => options.descriptors.get(agentId),
      applySpecialistAvailability: options.applySpecialistAvailability,
      now: options.now,
      logDebug: options.logDebug,
    });
    this.settings = new SwarmSettingsService({
      config: options.config,
      profiles: options.profiles,
      skillMetadataService: options.skillMetadataService,
      skillFileService: options.skillFileService,
      secretsEnvService: options.secretsEnvService,
      stopSecureSessionForLifecycle: (agentId) =>
        options.secureSessions.stopForLifecycle(agentId),
      getSessionsForProfile: options.sessions.getSessionsForProfile,
      getAllManagerSessions: options.sessions.getAllManagerSessions,
      getSessionById: options.sessions.getSessionById,
      resolveAndValidateCwd: (cwd) => this.resolveAndValidateCwd(cwd),
      assertCanChangeManagerCwd: (profileId, sessions) =>
        this.assertCanChangeManagerCwd(profileId, sessions),
      applyManagerRuntimeRecyclePolicy: options.applyManagerRuntimeRecyclePolicy,
      hasActiveSecureSession: (agentId) =>
        options.secureSessions.hasActiveSession(agentId),
      now: options.now,
      transactionDescriptors: options.persistence.transactionDescriptors,
      saveStore: options.persistence.saveStore,
      emitAgentsSnapshot: options.persistence.emitAgentsSnapshot,
      emitProfilesSnapshot: options.persistence.emitProfilesSnapshot,
      logDebug: options.logDebug,
    });
    this.prompts = new SwarmPromptService({
      config: options.config,
      descriptors: options.descriptors,
      profiles: options.profiles,
      promptRegistry: options.promptRegistry,
      skillMetadataService: options.skillMetadataService,
      ...options.prompt,
      getSessionsForProfile: options.sessions.getSessionsForProfile,
      loadSpecialistRegistryModule: () => this.loadSpecialistRegistryModule(),
      resolveSpecialistRosterForManager: (manager, targetSpace) =>
        this.resolveSpecialistRosterForManager(manager, targetSpace),
      resolveSkillRosterForDescriptor: (descriptor) =>
        this.resolveSkillRosterForDescriptor(descriptor),
      logDebug: options.logDebug,
    });
  }

  async loadModelCacheVisualizationSettings(): Promise<void> {
    this.modelCacheVisualizationEnabled = await getModelCacheVisualizationEnabled(
      this.options.config.paths.dataDir,
    );
  }

  isModelCacheVisualizationEnabled(): boolean {
    return this.modelCacheVisualizationEnabled;
  }

  async applyModelCacheVisualizationSettingsChange(enabled: boolean): Promise<void> {
    this.modelCacheVisualizationEnabled = enabled;
  }

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    this.options.access.assertManagerSettingsTargetNotArchived(
      managerId,
      "update manager model",
    );
    await this.settings.updateManagerModel(managerId, modelPreset, reasoningLevel);
  }

  async updateCollaborationSessionModel(
    sessionAgentId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    const descriptor = this.options.access.getRequiredCollaborationSessionDescriptor(
      sessionAgentId,
      "update collaboration session model",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.settings.updateManagerModel(sessionAgentId, modelPreset, reasoningLevel);
  }

  async updateManagerExactModel(
    managerId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    this.options.access.assertManagerSettingsTargetNotArchived(
      managerId,
      "update manager model",
    );
    return this.settings.updateManagerExactModel(managerId, modelSelection, reasoningLevel);
  }

  async updateProfileDefaultModel(
    profileId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    this.options.access.assertProfileNotArchived(profileId);
    await this.settings.updateProfileDefaultModel(profileId, modelPreset, reasoningLevel);
  }

  async updateProfileDefaultExactModel(
    profileId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    this.options.access.assertProfileNotArchived(profileId);
    return this.settings.updateProfileDefaultExactModel(profileId, modelSelection, reasoningLevel);
  }

  async updateSessionModel(
    sessionAgentId: string,
    mode: "inherit" | "override",
    modelPreset?: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    const descriptor = this.options.access.getRequiredBuilderSessionDescriptor(
      sessionAgentId,
      "update Builder session model",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.settings.updateSessionModel(sessionAgentId, mode, modelPreset, reasoningLevel);
  }

  async updateSessionExactModel(
    sessionAgentId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    const descriptor = this.options.access.getRequiredBuilderSessionDescriptor(
      sessionAgentId,
      "update Builder session model",
    );
    this.options.access.assertDescriptorNotEffectivelyArchived(descriptor);
    return this.settings.updateSessionExactModel(sessionAgentId, modelSelection, reasoningLevel);
  }

  async updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    this.options.access.assertProfileNotArchived(managerId);
    return this.settings.updateManagerCwd(managerId, newCwd);
  }

  async notifyModelSpecificInstructionsChanged(modelKeys: string[]): Promise<void> {
    await this.settings.notifyModelSpecificInstructionsChanged(modelKeys);
  }

  async previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    return this.prompts.previewManagerSystemPrompt(profileId);
  }

  async previewManagerSystemPromptForAgent(agentId: string): Promise<PromptPreviewResponse> {
    return this.prompts.previewManagerSystemPromptForAgent(agentId);
  }

  listDirectories(path?: string): Promise<DirectoryListingResult> {
    return this.settings.listDirectories(path);
  }

  validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return this.settings.validateDirectory(path);
  }

  createDirectory(parentPath: string, name: string): Promise<CreateDirectoryResult> {
    return this.settings.createDirectory(parentPath, name);
  }

  pickDirectory(defaultPath?: string): Promise<string | null> {
    return this.settings.pickDirectory(defaultPath);
  }

  async reloadModelCatalogOverridesAndProjection(): Promise<void> {
    await modelCatalogService.loadOverrides(this.options.config.paths.dataDir);
    await this.refreshPiModelsJsonProjection();
  }

  async reloadOpenRouterModelsAndProjection(): Promise<void> {
    await modelCatalogService.reloadOpenRouterModels();
    await this.refreshPiModelsJsonProjection();
  }

  listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.settings.listSettingsEnv();
  }

  listSkillMetadata(
    profileId?: string,
    sessionAgentId?: string,
  ): Promise<SkillInventoryEntry[]> {
    return this.settings.listSkillMetadata(profileId, sessionAgentId);
  }

  getCollaborationGlobalSkillHandles(): Iterable<string> {
    return this.skills.getSkillMetadata().map((skill) => skill.directoryName);
  }

  listSkillFiles(
    skillId: string,
    relativePath = "",
    context?: { profileId?: string; sessionAgentId?: string },
  ): Promise<SkillFilesResponse> {
    return this.settings.listSkillFiles(skillId, relativePath, context);
  }

  getSkillFileContent(
    skillId: string,
    relativePath: string,
    context?: { profileId?: string; sessionAgentId?: string },
  ): Promise<SkillFileContentResponse> {
    return this.settings.getSkillFileContent(skillId, relativePath, context);
  }

  shareSkill(skillId: string): Promise<SkillShareResponse> {
    return this.settings.shareSkill(skillId);
  }

  previewSkillImportFromUrl(
    url: string,
    target?: SkillImportTarget,
  ): Promise<SkillImportPreviewResponse> {
    return this.settings.previewSkillImportFromUrl(url, target);
  }

  previewSkillImportBundle(
    bundle: SkillBundleManifestV1,
    target?: SkillImportTarget,
  ): Promise<SkillImportPreviewResponse> {
    return this.settings.previewSkillImportBundle(bundle, target);
  }

  importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse> {
    return this.settings.importSkill(options);
  }

  updateSettingsEnv(values: Record<string, string>): Promise<void> {
    return this.settings.updateSettingsEnv(values);
  }

  deleteSettingsEnv(name: string): Promise<void> {
    return this.settings.deleteSettingsEnv(name);
  }

  listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.settings.listSettingsAuth();
  }

  updateSettingsAuth(values: Record<string, string>): Promise<void> {
    return this.settings.updateSettingsAuth(values);
  }

  deleteSettingsAuth(provider: string): Promise<void> {
    return this.settings.deleteSettingsAuth(provider);
  }

  updateSettingsAuthCredential(provider: string, credential: AuthCredential): Promise<void> {
    return this.settings.updateSettingsAuthCredential(provider, credential);
  }

  getOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settings.getOpenAIAuthBrokerSettings();
  }

  updateOpenAIAuthBrokerSettings(
    request: UpdateOpenAIBrokerSettingsRequest,
  ): Promise<OpenAIBrokerSettingsResponse> {
    return this.settings.updateOpenAIAuthBrokerSettings(request);
  }

  redeemOpenAIAuthBrokerInvite(
    request: RedeemOpenAIBrokerInviteRequest,
  ): Promise<OpenAIBrokerInviteRedeemResponse> {
    return this.settings.redeemOpenAIAuthBrokerInvite(request);
  }

  disableOpenAIAuthBroker(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settings.disableOpenAIAuthBroker();
  }

  clearOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settings.clearOpenAIAuthBrokerSettings();
  }

  testOpenAIAuthBrokerSettings(
    request?: Partial<UpdateOpenAIBrokerSettingsRequest>,
  ): Promise<OpenAIBrokerTestResponse> {
    return this.settings.testOpenAIAuthBrokerSettings(request);
  }

  isOpenAIAuthBrokerModeActive(): Promise<boolean> {
    return this.settings.isOpenAIAuthBrokerModeActive();
  }

  getCredentialPoolService(): CredentialPoolService {
    return this.settings.getCredentialPoolService();
  }

  getOpenAIAuthBrokerRuntimeService() {
    return this.secrets.getOpenAIAuthBrokerRuntimeService();
  }

  listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.settings.listCredentialPool(provider);
  }

  renamePooledCredential(
    provider: string,
    credentialId: string,
    label: string,
  ): Promise<void> {
    return this.settings.renamePooledCredential(provider, credentialId, label);
  }

  removePooledCredential(provider: string, credentialId: string): Promise<void> {
    return this.settings.removePooledCredential(provider, credentialId);
  }

  setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    return this.settings.setPrimaryPooledCredential(provider, credentialId);
  }

  setCredentialPoolStrategy(
    provider: string,
    strategy: CredentialPoolStrategy,
  ): Promise<void> {
    return this.settings.setCredentialPoolStrategy(provider, strategy);
  }

  resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    return this.settings.resetPooledCredentialCooldown(provider, credentialId);
  }

  addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string },
  ): Promise<PooledCredentialInfo> {
    return this.settings.addPooledCredential(provider, oauthCredential, identity);
  }

  resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.options.defaultModelPreset);
  }

  maybeRecordModelCapacityBlock(
    agentId: string,
    descriptor: AgentDescriptor,
    error: RuntimeErrorEvent,
  ): void {
    this.promptResources.maybeRecordModelCapacityBlock(agentId, descriptor, error);
  }

  resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string,
  ): Promise<string | undefined> {
    return this.promptResources.resolveSpawnWorkerArchetypeId(
      input,
      normalizedAgentId,
      profileId,
    );
  }

  loadSpecialistRegistryModule(): Promise<SpecialistRegistryModule> {
    return this.promptResources.loadSpecialistRegistryModule();
  }

  resolveSpecialistRosterForProfile(
    profileId: string,
    targetSpace: SpecialistTargetSpace = "builder",
    workspaceSpecialistsDir?: string,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    return this.promptResources.resolveSpecialistRosterForProfile(
      profileId,
      targetSpace,
      workspaceSpecialistsDir,
    );
  }

  resolveSpecialistRosterForManager(
    manager: AgentDescriptor,
    targetSpace: SpecialistTargetSpace = "builder",
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    return this.promptResources.resolveSpecialistRosterForManager(manager, targetSpace);
  }

  resolveSkillRosterForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[] | null> {
    return this.promptResources.resolveSkillRosterForDescriptor(descriptor);
  }

  resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    return this.prompts.resolveProjectAgentSystemPromptOverride(descriptor, options);
  }

  buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<string> {
    return this.prompts.buildResolvedManagerPrompt(descriptor, options);
  }

  resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    return this.prompts.resolveSystemPromptForDescriptor(descriptor);
  }

  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    return this.prompts.injectWorkerIdentityContext(descriptor, systemPrompt);
  }

  getMemoryRuntimeResources(
    descriptor: AgentDescriptor,
  ): ReturnType<SwarmPromptService["getMemoryRuntimeResources"]> {
    return this.prompts.getMemoryRuntimeResources(descriptor);
  }

  getSwarmContextFiles(
    cwd: string,
  ): Promise<Array<{ path: string; content: string }>> {
    return this.prompts.getSwarmContextFiles(cwd);
  }

  resolveAndValidateCwd(
    cwd: string,
    options?: { enforceAllowlist?: boolean },
  ): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy(options));
  }

  getPiModelsJsonPathOrThrow(): string {
    if (!this.piModelsJsonPath) {
      throw new Error(
        "Pi model projection path is unavailable before SwarmManager boot completes.",
      );
    }
    return this.piModelsJsonPath;
  }

  reloadSkillMetadata(): Promise<void> {
    return this.skills.reloadSkillMetadata();
  }

  loadSecretsStore(): Promise<void> {
    return this.secrets.loadSecretsStore();
  }

  private assertCanChangeManagerCwd(
    profileId: string,
    sessions: ManagerSessionDescriptor[],
  ): void {
    if (
      profileId === CORTEX_PROFILE_ID ||
      sessions.some(
        (descriptor) =>
          normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID,
      )
    ) {
      throw new Error("Cannot change working directory for Cortex profile");
    }
  }

  private getCwdPolicy(options?: { enforceAllowlist?: boolean }): {
    rootDir: string;
    allowlistRoots: string[];
    enforceAllowlist: boolean;
  } {
    const collabServer = isCollaborationServerRuntimeTarget(this.options.config.runtimeTarget);
    return {
      rootDir: this.options.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.options.config.cwdAllowlistRoots),
      enforceAllowlist: options?.enforceAllowlist ?? collabServer,
    };
  }

  private async refreshPiModelsJsonProjection(): Promise<void> {
    this.piModelsJsonPath = await generatePiProjection(this.options.config.paths.dataDir);
    this.options.logDebug("model_catalog:projection:generated", {
      path: this.piModelsJsonPath,
    });
  }
}
