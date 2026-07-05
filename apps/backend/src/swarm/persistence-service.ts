import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import { getConversationHistoryCacheFilePath } from "./conversation-history-cache.js";
import {
  getGlobalForgeExtensionsDir,
  getProfileForgeExtensionsDir,
  getProfileKnowledgeDir,
  getProfileMemoryPath,
  getProfilePiExtensionsDir,
  getProfilePiPromptsDir,
  getProfilePiSkillsDir,
  getProfilePiThemesDir,
  getSharedCacheGeneratedDir,
  getSharedKnowledgeDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "./types.js";
import { isEnoentError } from "../utils/fs-errors.js";

export const DEFAULT_MEMORY_FILE_CONTENT = `# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)

## Open Follow-ups
- (none yet)
`;

interface PersistenceServiceDependencies {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  sortedDescriptors: () => AgentDescriptor[];
  sortedProfiles: () => ManagerProfile[];
  getConfiguredManagerId: () => string | undefined;
  resolveMemoryOwnerAgentId: (descriptor: AgentDescriptor) => string;
  validateAgentDescriptor: (value: unknown) => AgentDescriptor | string;
  extractDescriptorAgentId: (value: unknown) => string | undefined;
  logDebug: (message: string, details?: unknown) => void;
}

export class PersistenceService {
  constructor(private readonly deps: PersistenceServiceDependencies) {}

  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.deps.config.paths.dataDir,
      getGlobalForgeExtensionsDir(this.deps.config.paths.dataDir),
      this.deps.config.paths.swarmDir,
      this.deps.config.paths.profilesDir,
      this.deps.config.paths.sharedDir,
      this.deps.config.paths.sharedConfigDir,
      this.deps.config.paths.sharedAuthDir,
      this.deps.config.paths.sharedIntegrationsDir,
      this.deps.config.paths.sharedCacheDir,
      getSharedCacheGeneratedDir(this.deps.config.paths.dataDir),
      this.deps.config.paths.sharedStateDir,
      getSharedKnowledgeDir(this.deps.config.paths.dataDir),
      getProfileKnowledgeDir(this.deps.config.paths.dataDir),

      this.deps.config.paths.uploadsDir,
      this.deps.config.paths.agentDir,
      this.deps.config.paths.managerAgentDir,

      // Pi extension/skill discovery directories (auto-discovered by Pi's DefaultPackageManager)
      resolve(this.deps.config.paths.agentDir, "extensions"),
      resolve(this.deps.config.paths.agentDir, "skills"),
      resolve(this.deps.config.paths.managerAgentDir, "extensions"),
      resolve(this.deps.config.paths.managerAgentDir, "skills"),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureMemoryFilesForBoot(options?: {
    resolveMemoryTemplateContent?: (profileId: string) => Promise<string>;
  }): Promise<void> {
    const memoryFilePaths = new Map<string, string>();
    const knownProfileIds = new Set<string>();
    const configuredManagerId = this.deps.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredDescriptor = this.deps.descriptors.get(configuredManagerId);
      if (configuredDescriptor?.role === "manager") {
        const profileId = configuredDescriptor.profileId ?? configuredDescriptor.agentId;
        knownProfileIds.add(profileId);
        memoryFilePaths.set(this.getAgentMemoryPath(configuredDescriptor), profileId);
      } else {
        knownProfileIds.add(configuredManagerId);
        memoryFilePaths.set(
          this.getAgentMemoryPath({
            agentId: configuredManagerId,
            role: "manager",
            profileId: configuredManagerId,
            managerId: configuredManagerId
          }),
          configuredManagerId
        );
      }
    }

    for (const profile of this.deps.sortedProfiles()) {
      knownProfileIds.add(profile.profileId);
    }

    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      const profileId = descriptor.profileId ?? descriptor.agentId;
      knownProfileIds.add(profileId);
      memoryFilePaths.set(this.getAgentMemoryPath(descriptor), profileId);
      memoryFilePaths.set(getProfileMemoryPath(this.deps.config.paths.dataDir, profileId), profileId);
    }

    for (const profileId of knownProfileIds) {
      await this.ensureProfileDirectories(profileId);
    }

    for (const [memoryFilePath, profileId] of memoryFilePaths.entries()) {
      const memoryTemplateContent = options?.resolveMemoryTemplateContent
        ? await options.resolveMemoryTemplateContent(profileId)
        : DEFAULT_MEMORY_FILE_CONTENT;
      await this.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent);
    }
  }

  async ensureAgentMemoryFile(memoryFilePath: string, memoryTemplateContent = DEFAULT_MEMORY_FILE_CONTENT): Promise<void> {
    try {
      await readFile(memoryFilePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, memoryTemplateContent, "utf8");
  }

  async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await Promise.all([
      deleteFileIfPresent(sessionFile),
      deleteFileIfPresent(getConversationHistoryCacheFilePath(sessionFile))
    ]);
  }

  async deleteManagerSchedulesFile(profileId: string): Promise<void> {
    const schedulesFile = getScheduleFilePath(this.deps.config.paths.dataDir, profileId);

    try {
      await unlink(schedulesFile);
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      throw error;
    }
  }

  async loadStore(): Promise<AgentsStoreFile> {
    const store = new AgentDescriptorStore({
      dataDir: this.deps.config.paths.dataDir,
      storeFilePath: this.deps.config.paths.agentsStoreFile,
      configuredManagerId: this.deps.getConfiguredManagerId(),
      logDebug: this.deps.logDebug
    });

    return store.load();
  }

  async saveStore(): Promise<void> {
    const store = new AgentDescriptorStore({
      dataDir: this.deps.config.paths.dataDir,
      storeFilePath: this.deps.config.paths.agentsStoreFile,
      configuredManagerId: this.deps.getConfiguredManagerId(),
      logDebug: this.deps.logDebug
    });
    store.replace({
      agents: this.deps.sortedDescriptors(),
      profiles: this.deps.sortedProfiles()
    });
    await store.save();
  }

  async ensureProfileDirectories(profileId: string): Promise<void> {
    const dataDir = this.deps.config.paths.dataDir;
    const profileDirs = [
      getProfileForgeExtensionsDir(dataDir, profileId),
      getProfilePiExtensionsDir(dataDir, profileId),
      getProfilePiSkillsDir(dataDir, profileId),
      getProfilePiPromptsDir(dataDir, profileId),
      getProfilePiThemesDir(dataDir, profileId)
    ];

    for (const dir of profileDirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureProfilePiDirectories(profileId: string): Promise<void> {
    await this.ensureProfileDirectories(profileId);
  }

  private getAgentMemoryPath(
    descriptor: Pick<AgentDescriptor, "agentId" | "role" | "profileId" | "managerId">
  ): string {
    return resolveMemoryFilePath(this.deps.config.paths.dataDir, {
      agentId: descriptor.agentId,
      role: descriptor.role,
      profileId: descriptor.profileId,
      managerId: descriptor.managerId
    });
  }
}

async function deleteFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }
}
