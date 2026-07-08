import { randomUUID } from "node:crypto";
import type { AuthCredential } from "@mariozechner/pi-coding-agent";
import {
  type OpenAIBrokerInviteRedeemResponse,
  type OpenAIBrokerSettingsResponse,
  type OpenAIBrokerTestResponse,
  type RedeemOpenAIBrokerInviteRequest,
  type UpdateOpenAIBrokerSettingsRequest,
  getCatalogModelKey,
  type CredentialPoolState,
  type ManagerExactModelSelection,
  type CredentialPoolStrategy,
  type PooledCredentialInfo,
  type SkillBundleManifestV1,
  type SkillFileContentResponse,
  type SkillFilesResponse,
  type SkillImportPreviewResponse,
  type SkillImportResultResponse,
  type SkillImportTarget,
  type SkillInventoryEntry,
  type SkillShareResponse
} from "@forge/protocol";
import type { CredentialPoolService } from "./credential-pool.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import { normalizeThinkingLevelForModelDescriptor, resolveModelDescriptorFromPreset } from "./model-presets.js";
import {
  appendModelChangeContinuityRequest,
  createModelChangeContinuityRequest,
  findLatestUnappliedModelChangeContinuityRequestForSession,
  loadModelChangeContinuityState
} from "./runtime/model-change-continuity.js";
import {
  getManagedModelProviderCredentialAvailability,
  type SecretsEnvService
} from "./secrets-env-service.js";
import { OpenAIAuthSettingsService } from "./openai-auth/openai-auth-settings-service.js";
import type { SkillFileService } from "./skill-file-service.js";
import type { SkillMetadataService } from "./skill-metadata-service.js";
import {
  SkillSharingError,
  SkillSharingService,
  type ImportSkillOptions
} from "./skills/skill-sharing-service.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { resolveExactManagerModelSelection } from "./catalog/manager-model-selection.js";
import type {
  AgentDescriptor,
  ManagerProfile,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";

interface SettingsDescriptorTransactionStore {
  patchDescriptor: (
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor)
  ) => AgentDescriptor;
  patchProfile: (
    profileId: string,
    patch: Partial<ManagerProfile> | ((profile: ManagerProfile) => ManagerProfile)
  ) => ManagerProfile;
}

export type ManagerRuntimeRecycleReason = "model_change" | "cwd_change" | "prompt_mode_change" | "auth_source_change";

type ManagerRuntimeRecycleDisposition = "recycled" | "deferred" | "none";
type SessionDescriptor = AgentDescriptor & { role: "manager"; profileId: string };

export interface SwarmSettingsServiceOptions {
  config: SwarmConfig;
  profiles: Map<string, ManagerProfile>;
  skillMetadataService: SkillMetadataService;
  skillFileService: SkillFileService;
  secretsEnvService: SecretsEnvService;
  getSessionsForProfile: (profileId: string) => SessionDescriptor[];
  getAllManagerSessions: () => SessionDescriptor[];
  getSessionById: (agentId: string) => SessionDescriptor | undefined;
  resolveAndValidateCwd: (cwd: string) => Promise<string>;
  assertCanChangeManagerCwd: (profileId: string, sessions: SessionDescriptor[]) => void;
  applyManagerRuntimeRecyclePolicy: (
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ) => Promise<ManagerRuntimeRecycleDisposition>;
  now?: () => string;
  transactionDescriptors?: <T>(callback: (store: SettingsDescriptorTransactionStore) => T | Promise<T>) => Promise<T>;
  saveStore: () => Promise<void>;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export class SwarmSettingsService {
  private readonly openAIAuthSettingsService: OpenAIAuthSettingsService;

  constructor(private readonly options: SwarmSettingsServiceOptions) {
    this.openAIAuthSettingsService = new OpenAIAuthSettingsService({ config: options.config });
  }

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const profile = this.options.profiles.get(managerId);
    if (profile) {
      await this.updateProfileDefaultModel(profile.profileId, modelPreset, reasoningLevel);
      return;
    }

    const session = this.options.getSessionById(managerId);
    if (!session) {
      throw new Error(`Unknown manager profile or session: ${managerId}`);
    }

    await this.setSessionModelOverride(session.agentId, modelPreset, reasoningLevel, {
      allowMetadataOnlyOriginChange: true,
      logContext: "manager:update_model:compat_session"
    });
  }

  async updateManagerExactModel(
    managerId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    const profile = this.options.profiles.get(managerId);
    if (profile) {
      return this.updateProfileDefaultExactModel(profile.profileId, modelSelection, reasoningLevel);
    }

    const session = this.options.getSessionById(managerId);
    if (!session) {
      throw new Error(`Unknown manager profile or session: ${managerId}`);
    }

    return this.setSessionExactModelOverride(session.agentId, modelSelection, reasoningLevel, {
      allowMetadataOnlyOriginChange: true,
      logContext: "manager:update_model:compat_session"
    });
  }

  async updateProfileDefaultModel(
    profileId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const targetModel = resolveModelDescriptor(modelPreset, reasoningLevel);
    await this.applyProfileDefaultModel(profileId, targetModel, {
      modelPreset,
      reasoningLevel,
      logContext: "manager:update_profile_default_model"
    });
  }

  async updateProfileDefaultExactModel(
    profileId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    const targetModel = await this.resolveExactManagerModel(modelSelection, "change", reasoningLevel);
    await this.applyProfileDefaultModel(profileId, targetModel, {
      modelSelection,
      reasoningLevel,
      logContext: "manager:update_profile_default_model"
    });
    return { ...targetModel };
  }

  async updateSessionModel(
    sessionAgentId: string,
    mode: "inherit" | "override",
    modelPreset?: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    if (mode === "inherit") {
      await this.setSessionModelInheritance(sessionAgentId);
      return;
    }

    await this.setSessionModelOverride(sessionAgentId, modelPreset, reasoningLevel, {
      allowMetadataOnlyOriginChange: true,
      logContext: "session:update_model"
    });
  }

  async updateSessionExactModel(
    sessionAgentId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    return this.setSessionExactModelOverride(sessionAgentId, modelSelection, reasoningLevel, {
      allowMetadataOnlyOriginChange: true,
      logContext: "session:update_model"
    });
  }

  async updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    const profile = this.options.profiles.get(managerId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${managerId}`);
    }

    const sessions = this.options.getSessionsForProfile(profile.profileId);
    this.options.assertCanChangeManagerCwd(profile.profileId, sessions);

    const resolvedCwd = await this.options.resolveAndValidateCwd(newCwd);
    if (sessions.every((session) => session.cwd === resolvedCwd)) {
      this.options.logDebug("manager:update_cwd:noop", {
        managerId,
        newCwd: resolvedCwd,
        updatedSessions: []
      });
      return resolvedCwd;
    }

    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];
    const recycleFailures: Array<{ agentId: string; error: string }> = [];

    await this.runDescriptorTransaction(async (store) => {
      for (const session of sessions) {
        store.patchDescriptor(session.agentId, { cwd: resolvedCwd });
      }
    }, async () => {
      const originalCwds = sessions.map((session) => ({ session, cwd: session.cwd }));
      try {
        for (const session of sessions) {
          session.cwd = resolvedCwd;
        }
        await this.options.saveStore();
      } catch (error) {
        for (const originalState of originalCwds) {
          originalState.session.cwd = originalState.cwd;
        }
        throw error;
      }
    });

    for (const session of sessions) {
      try {
        const recycleDisposition = await this.options.applyManagerRuntimeRecyclePolicy(session.agentId, "cwd_change");
        if (recycleDisposition === "recycled") {
          recycledSessions.push(session.agentId);
        } else if (recycleDisposition === "deferred") {
          deferredSessions.push(session.agentId);
        }
      } catch (error) {
        recycleFailures.push({
          agentId: session.agentId,
          error: errorToMessage(error)
        });
      }
    }

    if (recycleFailures.length > 0) {
      console.warn(`[swarm] manager:update_cwd:recycle_failed managerId=${managerId} failures=${JSON.stringify(recycleFailures)}`);
    }

    this.options.emitAgentsSnapshot();

    this.options.logDebug("manager:update_cwd", {
      managerId,
      newCwd: resolvedCwd,
      updatedSessions: sessions.map((session) => session.agentId),
      recycledSessions,
      deferredSessions,
      recycleFailures
    });

    return resolvedCwd;
  }

  async notifyModelSpecificInstructionsChanged(modelKeys: string[]): Promise<void> {
    const normalizedModelKeys = new Set(
      modelKeys
        .map((modelKey) => modelKey.trim())
        .filter((modelKey) => modelKey.length > 0)
    );

    if (normalizedModelKeys.size === 0) {
      return;
    }

    const sessions = Array.from(this.options.profiles.values()).flatMap((profile) =>
      this.options.getSessionsForProfile(profile.profileId)
    );
    const affectedSessions = sessions.filter((session) => {
      const catalogModel = modelCatalogService.getModel(session.model.modelId, session.model.provider);
      return catalogModel ? normalizedModelKeys.has(getCatalogModelKey(catalogModel)) : false;
    });

    if (affectedSessions.length === 0) {
      this.options.logDebug("manager:model_specific_instructions_change:noop", {
        modelKeys: Array.from(normalizedModelKeys),
        affectedSessions: []
      });
      return;
    }

    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];
    const recycleFailures: Array<{ agentId: string; error: string }> = [];

    for (const session of affectedSessions) {
      try {
        const recycleDisposition = await this.options.applyManagerRuntimeRecyclePolicy(session.agentId, "prompt_mode_change");
        if (recycleDisposition === "recycled") {
          recycledSessions.push(session.agentId);
        } else if (recycleDisposition === "deferred") {
          deferredSessions.push(session.agentId);
        }
      } catch (error) {
        recycleFailures.push({
          agentId: session.agentId,
          error: errorToMessage(error)
        });
      }
    }

    this.options.logDebug("manager:model_specific_instructions_change", {
      modelKeys: Array.from(normalizedModelKeys),
      affectedSessions: affectedSessions.map((session) => session.agentId),
      recycledSessions,
      deferredSessions,
      recycleFailures
    });
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.options.secretsEnvService.listSettingsEnv();
  }

  async listSkillMetadata(profileId?: string, sessionAgentId?: string): Promise<SkillInventoryEntry[]> {
    await this.options.skillMetadataService.reloadSkillMetadata();

    const workspaceContext = await this.resolveWorkspaceSkillContext(profileId, sessionAgentId);
    const metadata = typeof profileId === "string"
      ? await this.options.skillMetadataService.getProfileSkillMetadataForWorkspace(profileId, workspaceContext.forgeDir)
      : this.options.skillMetadataService.getSkillMetadata();

    return metadata
      .map((entry) => ({
        skillId: entry.skillId,
        name: entry.skillName,
        directoryName: entry.directoryName,
        description: entry.description,
        envCount: entry.env.length,
        hasRichConfig: entry.directoryName.trim().toLowerCase() === "chrome-cdp",
        sourceKind: entry.sourceKind,
        ...(entry.profileId ? { profileId: entry.profileId } : {}),
        rootPath: entry.rootPath,
        skillFilePath: entry.path,
        isInherited: entry.isInherited,
        isEffective: entry.isEffective,
        ...(entry.conflictWarning ? { conflictWarning: entry.conflictWarning } : {})
      }))
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        if (byName !== 0) {
          return byName;
        }

        return left.directoryName.localeCompare(right.directoryName);
      });
  }

  async listSkillFiles(
    skillId: string,
    relativePath = "",
    context?: { profileId?: string; sessionAgentId?: string }
  ): Promise<SkillFilesResponse> {
    const workspaceContext = await this.resolveWorkspaceSkillContext(context?.profileId, context?.sessionAgentId);
    const skill = await this.options.skillMetadataService.resolveSkillById(skillId, {
      profileId: context?.profileId,
      forgeDir: workspaceContext.forgeDir,
    });
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.options.skillFileService.listDirectory(skill, relativePath);
  }

  async getSkillFileContent(
    skillId: string,
    relativePath: string,
    context?: { profileId?: string; sessionAgentId?: string }
  ): Promise<SkillFileContentResponse> {
    const workspaceContext = await this.resolveWorkspaceSkillContext(context?.profileId, context?.sessionAgentId);
    const skill = await this.options.skillMetadataService.resolveSkillById(skillId, {
      profileId: context?.profileId,
      forgeDir: workspaceContext.forgeDir,
    });
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.options.skillFileService.getFileContent(skill, relativePath);
  }

  private async resolveWorkspaceSkillContext(
    profileId?: string,
    sessionAgentId?: string
  ): Promise<{ forgeDir?: string }> {
    if (!profileId || !sessionAgentId) {
      return {};
    }
    const session = this.options.getSessionById(sessionAgentId);
    if (!session || session.profileId !== profileId) {
      return {};
    }
    const resolution = await new ProjectWorkspaceResolver({
      dataDir: this.options.config.paths.dataDir,
      settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
    }).resolvePassive({
      profileId,
      sessionAgentId: session.agentId,
      cwd: session.cwd,
    });
    return { forgeDir: resolution.effectiveForgeDirRealpath };
  }

  async shareSkill(skillId: string): Promise<SkillShareResponse> {
    return this.createSkillSharingService().shareSkill(skillId);
  }

  async previewSkillImportFromUrl(
    url: string,
    target?: SkillImportTarget
  ): Promise<SkillImportPreviewResponse> {
    return this.createSkillSharingService().previewImportFromUrl({
      url,
      target: this.validateSkillImportTarget(target)
    });
  }

  async previewSkillImportBundle(
    bundle: SkillBundleManifestV1,
    target?: SkillImportTarget
  ): Promise<SkillImportPreviewResponse> {
    return this.createSkillSharingService().previewImportBundle({
      bundle,
      target: this.validateSkillImportTarget(target)
    });
  }

  async importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse> {
    return this.createSkillSharingService().importSkill({
      ...options,
      target: this.validateSkillImportTarget(options.target)
    });
  }

  private validateSkillImportTarget(target: SkillImportTarget | undefined): SkillImportTarget | undefined {
    if (!target) {
      return undefined;
    }
    if (target.scope === "global") {
      return { scope: "global" };
    }
    if (target.scope === "profile") {
      const profileId = typeof target.profileId === "string" ? target.profileId.trim() : "";
      if (!profileId) {
        throw new SkillSharingError("invalid_import_target", "Profile imports require profileId.", 400);
      }
      if (!this.options.profiles.has(profileId)) {
        throw new SkillSharingError("unknown_profile", `Unknown profile: ${profileId}`, 404);
      }
      return { scope: "profile", profileId };
    }
    throw new SkillSharingError("invalid_import_target", "Import target scope must be global or profile.", 400);
  }

  private createSkillSharingService(): SkillSharingService {
    return new SkillSharingService({
      config: this.options.config,
      skillMetadataService: this.options.skillMetadataService,
      now: this.options.now ? () => new Date(this.options.now!()) : undefined,
      validateProfileTarget: (profileId) => this.options.profiles.has(profileId)
    });
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.options.secretsEnvService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.options.secretsEnvService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const [providers, brokerSettings] = await Promise.all([
      this.options.secretsEnvService.listSettingsAuth(),
      this.openAIAuthSettingsService.getSettingsState(),
    ]);
    if (brokerSettings.effectiveMode !== "central_broker") {
      return providers;
    }

    return providers.map((provider) => {
      if (provider.provider !== "openai-codex") {
        return provider;
      }
      return {
        provider: "openai-codex",
        configured: brokerSettings.broker.configured,
        authType: brokerSettings.broker.configured ? "oauth" : undefined,
        maskedValue: brokerSettings.broker.tokenMasked,
        source: "central_broker",
        readOnly: true,
        statusDetail: brokerSettings.broker.status?.message ?? brokerSettings.broker.status?.degraded,
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const providers = Object.keys(values);
    await this.assertLocalOpenAIAuthMutationAllowed(providers);
    await this.options.secretsEnvService.updateSettingsAuth(values);
    await this.recycleManagersForAuthProviderChange(providers);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.options.secretsEnvService.deleteSettingsAuth(provider);
    await this.recycleManagersForAuthProviderChange([provider]);
  }

  async updateSettingsAuthCredential(provider: string, credential: AuthCredential): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.options.secretsEnvService.updateSettingsAuthCredential(provider, credential);
    await this.recycleManagersForAuthProviderChange([provider]);
  }

  async getOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.openAIAuthSettingsService.getSettings();
  }

  async updateOpenAIAuthBrokerSettings(request: UpdateOpenAIBrokerSettingsRequest): Promise<OpenAIBrokerSettingsResponse> {
    const before = await this.openAIAuthSettingsService.getSettings();
    const result = await this.openAIAuthSettingsService.updateSettings(request);
    await this.recycleOpenAICodexManagersIfBrokerBoundaryChanged(
      before,
      result,
      shouldRecycleOpenAICodexManagersForBrokerTokenPatch(before, result, request),
    );
    return result;
  }

  async redeemOpenAIAuthBrokerInvite(request: RedeemOpenAIBrokerInviteRequest): Promise<OpenAIBrokerInviteRedeemResponse> {
    const before = await this.openAIAuthSettingsService.getSettings();
    const result = await this.openAIAuthSettingsService.redeemInvite(request);
    await this.recycleOpenAICodexManagersIfBrokerBoundaryChanged(before, result, true);
    return result;
  }

  async disableOpenAIAuthBroker(): Promise<OpenAIBrokerSettingsResponse> {
    const before = await this.openAIAuthSettingsService.getSettings();
    const result = await this.openAIAuthSettingsService.disableBroker();
    await this.recycleOpenAICodexManagersIfBrokerBoundaryChanged(before, result);
    return result;
  }

  async clearOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    const before = await this.openAIAuthSettingsService.getSettings();
    const result = await this.openAIAuthSettingsService.clearBrokerSettings();
    await this.recycleOpenAICodexManagersIfBrokerBoundaryChanged(before, result);
    return result;
  }

  async testOpenAIAuthBrokerSettings(request?: Partial<UpdateOpenAIBrokerSettingsRequest>): Promise<OpenAIBrokerTestResponse> {
    return this.openAIAuthSettingsService.testSettings(request);
  }

  async isOpenAIAuthBrokerModeActive(): Promise<boolean> {
    return (await this.openAIAuthSettingsService.getEffectiveMode()) === "central_broker";
  }

  private async recycleOpenAICodexManagersIfBrokerBoundaryChanged(
    before: OpenAIBrokerSettingsResponse,
    after: OpenAIBrokerSettingsResponse,
    forceRecycle = false,
  ): Promise<void> {
    if (!forceRecycle && !hasOpenAIAuthBrokerRuntimeBoundaryChanged(before, after)) {
      return;
    }

    await this.recycleManagersForAuthProviderChange(["openai-codex"], "openai_auth_broker:runtime_recycle:error");
  }

  private async recycleManagersForAuthProviderChange(
    providers: string[],
    errorLogContext = "settings_auth:runtime_recycle:error"
  ): Promise<void> {
    const normalizedProviders = new Set(
      providers
        .map((provider) => provider.trim().toLowerCase())
        .filter((provider) => provider.length > 0)
    );
    if (normalizedProviders.size === 0) {
      return;
    }

    const seenAgentIds = new Set<string>();
    const sessions = this.options.getAllManagerSessions().filter((session) => {
      if (seenAgentIds.has(session.agentId)) {
        return false;
      }
      if (!normalizedProviders.has(session.model.provider.trim().toLowerCase())) {
        return false;
      }
      seenAgentIds.add(session.agentId);
      return true;
    });

    const results = await Promise.allSettled(
      sessions.map((session) => this.options.applyManagerRuntimeRecyclePolicy(session.agentId, "auth_source_change"))
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug(errorLogContext, {
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  private async assertLocalOpenAIAuthMutationAllowed(providers: string[]): Promise<void> {
    const touchesOpenAI = providers.some((provider) => provider.trim().toLowerCase() === "openai-codex");
    if (!touchesOpenAI) {
      return;
    }
    if (await this.isOpenAIAuthBrokerModeActive()) {
      throw new Error("central_broker_mode_active: Switch OpenAI auth source back to local before editing local OpenAI credentials.");
    }
  }

  getCredentialPoolService(): CredentialPoolService {
    return this.options.secretsEnvService.getCredentialPoolService();
  }

  async listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.getCredentialPoolService().listPool(provider);
  }

  async renamePooledCredential(provider: string, credentialId: string, label: string): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.getCredentialPoolService().renameCredential(provider, credentialId, label);
  }

  async removePooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.getCredentialPoolService().removeCredential(provider, credentialId);
    await this.recycleManagersForAuthProviderChange([provider]);
  }

  async setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.getCredentialPoolService().setPrimary(provider, credentialId);
    await this.recycleManagersForAuthProviderChange([provider]);
  }

  async setCredentialPoolStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.getCredentialPoolService().setStrategy(provider, strategy);
    await this.recycleManagersForAuthProviderChange([provider]);
  }

  async resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    await this.getCredentialPoolService().resetCooldown(provider, credentialId);
  }

  async addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    await this.assertLocalOpenAIAuthMutationAllowed([provider]);
    const result = await this.getCredentialPoolService().addCredential(provider, oauthCredential, identity);
    await this.recycleManagersForAuthProviderChange([provider]);
    return result;
  }

  private async applyProfileDefaultModel(
    profileId: string,
    targetModel: AgentDescriptor["model"],
    details: {
      logContext: string;
      reasoningLevel?: SwarmReasoningLevel;
      modelPreset?: SwarmModelPreset;
      modelSelection?: ManagerExactModelSelection;
    }
  ): Promise<void> {
    const profile = this.options.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${profileId}`);
    }

    const profileDefaultChanged = !sameModelDescriptor(profile.defaultModel, targetModel);
    const mutations = this.options
      .getSessionsForProfile(profile.profileId)
      .filter((session) => session.modelOrigin !== "session_override")
      .map((session) => ({
        session,
        targetModel,
        targetModelOrigin: "profile_default" as const
      }))
      .filter(
        (mutation) =>
          !sameModelDescriptor(mutation.session.model, mutation.targetModel) ||
          mutation.session.modelOrigin !== mutation.targetModelOrigin
      );

    if (!profileDefaultChanged && mutations.length === 0) {
      this.options.logDebug(`${details.logContext}:noop`, {
        profileId,
        modelPreset: details.modelPreset,
        modelSelection: details.modelSelection,
        reasoningLevel: details.reasoningLevel,
        updatedSessions: []
      });
      return;
    }

    const stagedUpdatedAt = profileDefaultChanged ? getNow(this.options.now)() : profile.updatedAt;
    const previousDefaultModel = { ...profile.defaultModel };
    const previousUpdatedAt = profile.updatedAt;
    const applyProfileDefaultMutation = (): void => {
      profile.defaultModel = { ...targetModel };
      profile.updatedAt = stagedUpdatedAt;
    };

    if (mutations.length === 0) {
      await this.runDescriptorTransaction(async (store) => {
        store.patchProfile(profile.profileId, {
          defaultModel: { ...targetModel },
          updatedAt: stagedUpdatedAt
        });
      }, async () => {
        applyProfileDefaultMutation();
        try {
          await this.options.saveStore();
        } catch (error) {
          profile.defaultModel = previousDefaultModel;
          profile.updatedAt = previousUpdatedAt;
          throw error;
        }
      });
      this.options.emitProfilesSnapshot();
      this.options.emitAgentsSnapshot();
      this.options.logDebug(details.logContext, {
        profileId,
        modelPreset: details.modelPreset,
        modelSelection: details.modelSelection,
        reasoningLevel: details.reasoningLevel,
        updatedSessions: [],
        effectiveModelChangedSessions: [],
        recycledSessions: [],
        deferredSessions: []
      });
      return;
    }

    const result = await this.applySessionModelMutations(mutations, {
      emitProfilesSnapshot: true,
      profilePatch: {
        profileId: profile.profileId,
        defaultModel: targetModel,
        updatedAt: stagedUpdatedAt
      },
      beforeSave: applyProfileDefaultMutation,
      rollbackBeforeSave: () => {
        profile.defaultModel = previousDefaultModel;
        profile.updatedAt = previousUpdatedAt;
      }
    });

    this.options.logDebug(details.logContext, {
      profileId,
      modelPreset: details.modelPreset,
      modelSelection: details.modelSelection,
      reasoningLevel: details.reasoningLevel,
      updatedSessions: result.updatedSessions,
      effectiveModelChangedSessions: result.effectiveModelChangedSessions,
      recycledSessions: result.recycledSessions,
      deferredSessions: result.deferredSessions
    });
  }

  private async resolveExactManagerModel(
    modelSelection: ManagerExactModelSelection,
    surface: "create" | "change",
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    const credentialPoolService =
      typeof this.options.secretsEnvService.getCredentialPoolService === "function"
        ? this.options.secretsEnvService.getCredentialPoolService()
        : undefined;
    return resolveExactManagerModelSelection(modelSelection, {
      surface,
      providerAvailability: await getManagedModelProviderCredentialAvailability(this.options.config, { credentialPoolService }),
      reasoningLevel,
    });
  }

  private async setSessionExactModelOverride(
    sessionAgentId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel: SwarmReasoningLevel | undefined,
    options: { allowMetadataOnlyOriginChange: boolean; logContext: string }
  ): Promise<AgentDescriptor["model"]> {
    const targetModel = await this.resolveExactManagerModel(modelSelection, "change", reasoningLevel);
    const effectiveModel = await this.setSessionModelOverrideTarget(sessionAgentId, targetModel, {
      allowMetadataOnlyOriginChange: options.allowMetadataOnlyOriginChange,
      logContext: options.logContext,
      modelSelection,
      reasoningLevel,
    });
    return { ...effectiveModel };
  }

  private async setSessionModelOverride(
    sessionAgentId: string,
    modelPreset: SwarmModelPreset | undefined,
    reasoningLevel: SwarmReasoningLevel | undefined,
    options: { allowMetadataOnlyOriginChange: boolean; logContext: string }
  ): Promise<void> {
    if (!modelPreset) {
      throw new Error("Session model override requires a model preset");
    }

    const targetModel = resolveModelDescriptor(modelPreset, reasoningLevel);
    await this.setSessionModelOverrideTarget(sessionAgentId, targetModel, {
      allowMetadataOnlyOriginChange: options.allowMetadataOnlyOriginChange,
      logContext: options.logContext,
      modelPreset,
      reasoningLevel,
    });
  }

  private async setSessionModelOverrideTarget(
    sessionAgentId: string,
    targetModel: AgentDescriptor["model"],
    details: {
      allowMetadataOnlyOriginChange: boolean;
      logContext: string;
      reasoningLevel?: SwarmReasoningLevel;
      modelPreset?: SwarmModelPreset;
      modelSelection?: ManagerExactModelSelection;
    }
  ): Promise<AgentDescriptor["model"]> {
    const session = this.options.getSessionById(sessionAgentId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionAgentId}`);
    }

    const effectiveTargetModel = targetModel;

    const shouldUpdate =
      !sameModelDescriptor(session.model, effectiveTargetModel) ||
      (details.allowMetadataOnlyOriginChange && session.modelOrigin !== "session_override");

    if (!shouldUpdate) {
      this.options.logDebug(`${details.logContext}:noop`, {
        sessionAgentId,
        mode: "override",
        modelPreset: details.modelPreset,
        modelSelection: details.modelSelection,
        reasoningLevel: details.reasoningLevel,
        updatedSessions: []
      });
      return { ...effectiveTargetModel };
    }

    const result = await this.applySessionModelMutations(
      [{ session, targetModel: effectiveTargetModel, targetModelOrigin: "session_override" }],
      { emitProfilesSnapshot: false }
    );

    this.options.logDebug(details.logContext, {
      sessionAgentId,
      mode: "override",
      modelPreset: details.modelPreset,
      modelSelection: details.modelSelection,
      reasoningLevel: details.reasoningLevel,
      updatedSessions: result.updatedSessions,
      effectiveModelChangedSessions: result.effectiveModelChangedSessions,
      recycledSessions: result.recycledSessions,
      deferredSessions: result.deferredSessions
    });

    return { ...effectiveTargetModel };
  }

  private async setSessionModelInheritance(sessionAgentId: string): Promise<void> {
    const session = this.options.getSessionById(sessionAgentId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionAgentId}`);
    }

    const profile = this.options.profiles.get(session.profileId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${session.profileId}`);
    }

    const targetModel = cloneModelDescriptor(profile.defaultModel);
    if (sameModelDescriptor(session.model, targetModel) && session.modelOrigin === "profile_default") {
      this.options.logDebug("session:update_model:noop", {
        sessionAgentId,
        mode: "inherit",
        updatedSessions: []
      });
      return;
    }

    const result = await this.applySessionModelMutations(
      [{ session, targetModel, targetModelOrigin: "profile_default" }],
      { emitProfilesSnapshot: false }
    );

    this.options.logDebug("session:update_model", {
      sessionAgentId,
      mode: "inherit",
      updatedSessions: result.updatedSessions,
      effectiveModelChangedSessions: result.effectiveModelChangedSessions,
      recycledSessions: result.recycledSessions,
      deferredSessions: result.deferredSessions
    });
  }

  private async applySessionModelMutations(
    mutations: Array<{
      session: SessionDescriptor;
      targetModel: AgentDescriptor["model"];
      targetModelOrigin: "profile_default" | "session_override";
    }>,
    options: {
      emitProfilesSnapshot: boolean;
      profilePatch?: { profileId: string; defaultModel: AgentDescriptor["model"]; updatedAt: string };
      beforeSave?: () => void;
      rollbackBeforeSave?: () => void;
    }
  ): Promise<{
    updatedSessions: string[];
    effectiveModelChangedSessions: string[];
    recycledSessions: string[];
    deferredSessions: string[];
    recycleFailures: Array<{ agentId: string; error: string }>;
  }> {
    if (mutations.length === 0) {
      return {
        updatedSessions: [],
        effectiveModelChangedSessions: [],
        recycledSessions: [],
        deferredSessions: [],
        recycleFailures: []
      };
    }

    const effectiveModelMutations = mutations.filter(
      (mutation) => !sameModelDescriptor(mutation.session.model, mutation.targetModel)
    );
    const originalSessionStates = mutations.map((mutation) => ({
      session: mutation.session,
      model: { ...mutation.session.model },
      modelOrigin: mutation.session.modelOrigin
    }));
    const now = getNow(this.options.now);
    const continuityWrites = await Promise.all(
      effectiveModelMutations.map(async (mutation) => {
        const continuityState = await loadModelChangeContinuityState(mutation.session.sessionFile);
        const latestPendingRequest = findLatestUnappliedModelChangeContinuityRequestForSession({
          sessionAgentId: mutation.session.agentId,
          requests: continuityState.requests,
          applied: continuityState.applied
        });
        const createdAt = now();
        return {
          session: mutation.session,
          request: createModelChangeContinuityRequest({
            requestId: randomUUID(),
            createdAt,
            sessionAgentId: mutation.session.agentId,
            sourceModel: latestPendingRequest?.sourceModel ?? mutation.session.model,
            targetModel: mutation.targetModel
          })
        };
      })
    );

    for (const pendingWrite of continuityWrites) {
      await appendModelChangeContinuityRequest({
        sessionFile: pendingWrite.session.sessionFile,
        cwd: pendingWrite.session.cwd,
        request: pendingWrite.request,
        now: this.options.now
      });
    }

    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];
    const recycleFailures: Array<{ agentId: string; error: string }> = [];

    await this.runDescriptorTransaction(async (store) => {
      for (const mutation of mutations) {
        store.patchDescriptor(mutation.session.agentId, {
          model: { ...mutation.targetModel },
          modelOrigin: mutation.targetModelOrigin
        });
      }
      if (options.profilePatch) {
        store.patchProfile(options.profilePatch.profileId, {
          defaultModel: { ...options.profilePatch.defaultModel },
          updatedAt: options.profilePatch.updatedAt
        });
      }
    }, async () => {
      try {
        for (const mutation of mutations) {
          mutation.session.model = { ...mutation.targetModel };
          mutation.session.modelOrigin = mutation.targetModelOrigin;
        }

        options.beforeSave?.();
        await this.options.saveStore();
      } catch (error) {
        for (const originalState of originalSessionStates) {
          originalState.session.model = originalState.model;
          originalState.session.modelOrigin = originalState.modelOrigin;
        }
        options.rollbackBeforeSave?.();
        throw error;
      }
    });

    for (const pendingWrite of continuityWrites) {
      try {
        const recycleDisposition = await this.options.applyManagerRuntimeRecyclePolicy(
          pendingWrite.session.agentId,
          "model_change"
        );
        if (recycleDisposition === "recycled") {
          recycledSessions.push(pendingWrite.session.agentId);
        } else if (recycleDisposition === "deferred") {
          deferredSessions.push(pendingWrite.session.agentId);
        }
      } catch (error) {
        deferredSessions.push(pendingWrite.session.agentId);
        recycleFailures.push({
          agentId: pendingWrite.session.agentId,
          error: errorToMessage(error)
        });
      }
    }

    if (recycleFailures.length > 0) {
      this.options.logDebug("manager:model_change:recycle_failed", {
        updatedSessions: mutations.map((mutation) => mutation.session.agentId),
        recycleFailures
      });
    }

    this.options.emitAgentsSnapshot();
    if (options.emitProfilesSnapshot) {
      this.options.emitProfilesSnapshot();
    }

    return {
      updatedSessions: mutations.map((mutation) => mutation.session.agentId),
      effectiveModelChangedSessions: effectiveModelMutations.map((mutation) => mutation.session.agentId),
      recycledSessions,
      deferredSessions,
      recycleFailures
    };
  }

  private async runDescriptorTransaction<T>(
    transactionCallback: (store: SettingsDescriptorTransactionStore) => T | Promise<T>,
    fallbackCallback: () => T | Promise<T>
  ): Promise<T> {
    if (this.options.transactionDescriptors) {
      return this.options.transactionDescriptors(transactionCallback);
    }

    return fallbackCallback();
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.options.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.options.config.cwdAllowlistRoots)
    };
  }
}

function hasOpenAIAuthBrokerRuntimeBoundaryChanged(
  before: OpenAIBrokerSettingsResponse,
  after: OpenAIBrokerSettingsResponse,
): boolean {
  return brokerRuntimeBoundaryFingerprint(before) !== brokerRuntimeBoundaryFingerprint(after);
}

function shouldRecycleOpenAICodexManagersForBrokerTokenPatch(
  before: OpenAIBrokerSettingsResponse,
  after: OpenAIBrokerSettingsResponse,
  request: UpdateOpenAIBrokerSettingsRequest,
): boolean {
  const tokenPatch = request.broker?.token;
  const touchesToken = (typeof tokenPatch === "string" && tokenPatch.trim().length > 0) || request.broker?.clearToken === true;
  if (!touchesToken) {
    return false;
  }

  return before.settings.effectiveMode === "central_broker" || after.settings.effectiveMode === "central_broker";
}

function brokerRuntimeBoundaryFingerprint(response: OpenAIBrokerSettingsResponse): string {
  const settings = response.settings;
  const broker = settings.broker;
  return JSON.stringify({
    mode: settings.mode,
    effectiveMode: settings.effectiveMode,
    source: settings.source,
    configured: broker.configured,
    url: broker.url,
    hasToken: broker.hasToken,
    tokenMasked: broker.tokenMasked,
    clientId: broker.clientId,
    instanceId: broker.instanceId,
    instanceLabel: broker.instanceLabel,
    userLabel: broker.userLabel,
    timeoutMs: broker.timeoutMs,
  });
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneModelDescriptor(model: AgentDescriptor["model"]): AgentDescriptor["model"] {
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel
  };
}

function sameModelDescriptor(left: AgentDescriptor["model"], right: AgentDescriptor["model"]): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    normalizeThinkingLevel(left.thinkingLevel) === normalizeThinkingLevel(right.thinkingLevel)
  );
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function resolveModelDescriptor(
  modelPreset: SwarmModelPreset,
  reasoningLevel?: SwarmReasoningLevel
): AgentDescriptor["model"] {
  const modelDescriptor = resolveModelDescriptorFromPreset(modelPreset);
  modelDescriptor.thinkingLevel = normalizeThinkingLevelForModelDescriptor(modelDescriptor, reasoningLevel);
  return modelDescriptor;
}

function getNow(now: (() => string) | undefined): () => string {
  return now ?? (() => new Date().toISOString());
}
