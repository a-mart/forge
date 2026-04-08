import type { AuthCredential } from "@mariozechner/pi-coding-agent";
import {
  getCatalogModelKey,
  type CredentialPoolState,
  type CredentialPoolStrategy,
  type PooledCredentialInfo,
  type SkillFileContentResponse,
  type SkillFilesResponse,
  type SkillInventoryEntry
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
import { resolveModelDescriptorFromPreset } from "./model-presets.js";
import type { SecretsEnvService } from "./secrets-env-service.js";
import type { SkillFileService } from "./skill-file-service.js";
import type { SkillMetadataService } from "./skill-metadata-service.js";
import { modelCatalogService } from "./model-catalog-service.js";
import type {
  AgentDescriptor,
  ManagerProfile,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";

export type ManagerRuntimeRecycleReason = "model_change" | "cwd_change" | "prompt_mode_change";

type ManagerRuntimeRecycleDisposition = "recycled" | "deferred" | "none";
type SessionDescriptor = AgentDescriptor & { role: "manager"; profileId: string };

export interface SwarmSettingsServiceOptions {
  config: SwarmConfig;
  profiles: Map<string, ManagerProfile>;
  skillMetadataService: SkillMetadataService;
  skillFileService: SkillFileService;
  secretsEnvService: SecretsEnvService;
  getSessionsForProfile: (profileId: string) => SessionDescriptor[];
  resolveAndValidateCwd: (cwd: string) => Promise<string>;
  assertCanChangeManagerCwd: (profileId: string, sessions: SessionDescriptor[]) => void;
  applyManagerRuntimeRecyclePolicy: (
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ) => Promise<ManagerRuntimeRecycleDisposition>;
  saveStore: () => Promise<void>;
  emitAgentsSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export class SwarmSettingsService {
  constructor(private readonly options: SwarmSettingsServiceOptions) {}

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const profile = this.options.profiles.get(managerId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${managerId}`);
    }

    const modelDescriptor = resolveModelDescriptorFromPreset(modelPreset);
    if (reasoningLevel) {
      modelDescriptor.thinkingLevel = reasoningLevel;
    }

    const sessions = this.options.getSessionsForProfile(profile.profileId);
    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];

    for (const session of sessions) {
      session.model = { ...modelDescriptor };
    }

    for (const session of sessions) {
      const recycleDisposition = await this.options.applyManagerRuntimeRecyclePolicy(session.agentId, "model_change");
      if (recycleDisposition === "recycled") {
        recycledSessions.push(session.agentId);
      } else if (recycleDisposition === "deferred") {
        deferredSessions.push(session.agentId);
      }
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("manager:update_model", {
      managerId,
      modelPreset,
      reasoningLevel,
      updatedSessions: sessions.map((session) => session.agentId),
      recycledSessions,
      deferredSessions
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

    for (const session of sessions) {
      session.cwd = resolvedCwd;
    }

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

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    if (recycleFailures.length > 0) {
      console.warn(`[swarm] manager:update_cwd:recycle_failed managerId=${managerId} failures=${JSON.stringify(recycleFailures)}`);
    }

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

  async listSkillMetadata(profileId?: string): Promise<SkillInventoryEntry[]> {
    await this.options.skillMetadataService.reloadSkillMetadata();

    const metadata = typeof profileId === "string"
      ? await this.options.skillMetadataService.getProfileSkillMetadata(profileId)
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
        isEffective: entry.isEffective
      }))
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        if (byName !== 0) {
          return byName;
        }

        return left.directoryName.localeCompare(right.directoryName);
      });
  }

  async listSkillFiles(skillId: string, relativePath = ""): Promise<SkillFilesResponse> {
    const skill = await this.options.skillMetadataService.resolveSkillById(skillId);
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.options.skillFileService.listDirectory(skill, relativePath);
  }

  async getSkillFileContent(skillId: string, relativePath: string): Promise<SkillFileContentResponse> {
    const skill = await this.options.skillMetadataService.resolveSkillById(skillId);
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.options.skillFileService.getFileContent(skill, relativePath);
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.options.secretsEnvService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.options.secretsEnvService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.options.secretsEnvService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.options.secretsEnvService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.options.secretsEnvService.deleteSettingsAuth(provider);
  }

  getCredentialPoolService(): CredentialPoolService {
    return this.options.secretsEnvService.getCredentialPoolService();
  }

  async listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.getCredentialPoolService().listPool(provider);
  }

  async renamePooledCredential(provider: string, credentialId: string, label: string): Promise<void> {
    await this.getCredentialPoolService().renameCredential(provider, credentialId, label);
  }

  async removePooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.getCredentialPoolService().removeCredential(provider, credentialId);
  }

  async setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.getCredentialPoolService().setPrimary(provider, credentialId);
  }

  async setCredentialPoolStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    await this.getCredentialPoolService().setStrategy(provider, strategy);
  }

  async resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    await this.getCredentialPoolService().resetCooldown(provider, credentialId);
  }

  async addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    return this.getCredentialPoolService().addCredential(provider, oauthCredential, identity);
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.options.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.options.config.cwdAllowlistRoots)
    };
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
