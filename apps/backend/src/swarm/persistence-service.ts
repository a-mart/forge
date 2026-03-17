import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import { getConversationHistoryCacheFilePath } from "./conversation-history-cache.js";
import { getProfileKnowledgeDir, getProfileMemoryPath, getSharedKnowledgeDir, resolveMemoryFilePath } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "./types.js";

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
      this.deps.config.paths.swarmDir,
      this.deps.config.paths.profilesDir,
      this.deps.config.paths.sharedDir,
      this.deps.config.paths.sharedAuthDir,
      this.deps.config.paths.sharedIntegrationsDir,
      getSharedKnowledgeDir(this.deps.config.paths.dataDir),
      getProfileKnowledgeDir(this.deps.config.paths.dataDir),

      this.deps.config.paths.uploadsDir,
      this.deps.config.paths.agentDir,
      this.deps.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureMemoryFilesForBoot(options?: {
    resolveMemoryTemplateContent?: (profileId: string) => Promise<string>;
  }): Promise<void> {
    const memoryFilePaths = new Map<string, string>();
    const configuredManagerId = this.deps.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredDescriptor = this.deps.descriptors.get(configuredManagerId);
      if (configuredDescriptor?.role === "manager") {
        memoryFilePaths.set(
          this.getAgentMemoryPath(configuredDescriptor),
          configuredDescriptor.profileId ?? configuredDescriptor.agentId
        );
      } else {
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

    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      const profileId = descriptor.profileId ?? descriptor.agentId;
      memoryFilePaths.set(this.getAgentMemoryPath(descriptor), profileId);
      memoryFilePaths.set(getProfileMemoryPath(this.deps.config.paths.dataDir, profileId), profileId);
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
    try {
      const raw = await readFile(this.deps.config.paths.agentsStoreFile, "utf8");
      const parsed = JSON.parse(raw) as AgentsStoreFile;
      if (!Array.isArray(parsed.agents)) {
        return { agents: [], profiles: [] };
      }

      const validAgents: AgentDescriptor[] = [];
      let normalizedPathCount = 0;
      for (const [index, candidate] of parsed.agents.entries()) {
        const validated = this.deps.validateAgentDescriptor(candidate);
        if (typeof validated === "string") {
          const maybeAgentId = this.deps.extractDescriptorAgentId(candidate);
          const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
          console.warn(
            `[swarm] Skipping invalid descriptor (${descriptorHint}) in ${this.deps.config.paths.agentsStoreFile}: ${validated}`
          );
          continue;
        }

        const normalizedDescriptor = normalizeDescriptorPaths(validated, this.deps.config.paths.dataDir);
        if (normalizedDescriptor !== validated) {
          normalizedPathCount += 1;
        }

        validAgents.push(normalizedDescriptor);
      }

      if (normalizedPathCount > 0) {
        this.deps.logDebug("Normalized legacy descriptor sessionFile paths during store load", {
          normalizedPathCount,
          dataDir: this.deps.config.paths.dataDir
        });
      }

      return {
        agents: validAgents,
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : []
      };
    } catch {
      return { agents: [], profiles: [] };
    }
  }

  async saveStore(): Promise<void> {
    const payload: AgentsStoreFile = {
      agents: this.deps.sortedDescriptors(),
      profiles: this.deps.sortedProfiles()
    };

    const target = this.deps.config.paths.agentsStoreFile;
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
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

function normalizeDescriptorPaths(descriptor: AgentDescriptor, dataDir: string): AgentDescriptor {
  const normalizedDataDir = resolve(dataDir);
  const legacyDataDir = resolveLegacyDataDirForCurrentDataDir(normalizedDataDir);
  if (!legacyDataDir) {
    return descriptor;
  }

  const normalizedSessionFile = resolve(descriptor.sessionFile);
  if (!isPathWithinDirectory(normalizedSessionFile, legacyDataDir)) {
    return descriptor;
  }

  const relativeSessionPath = normalizedSessionFile.slice(legacyDataDir.length).replace(/^[/\\]+/, "");
  if (!relativeSessionPath) {
    return descriptor;
  }

  if (relativeSessionPath === ".." || relativeSessionPath.startsWith(`..${sep}`)) {
    return descriptor;
  }

  const rewrittenSessionFile = resolve(normalizedDataDir, relativeSessionPath);
  if (rewrittenSessionFile === descriptor.sessionFile) {
    return descriptor;
  }

  return {
    ...descriptor,
    sessionFile: rewrittenSessionFile
  };
}

function resolveLegacyDataDirForCurrentDataDir(dataDir: string): string | undefined {
  const normalized = dataDir.toLowerCase();

  if (normalized.endsWith(`${sep}.forge`)) {
    return `${dataDir.slice(0, -(".forge".length))}.middleman`;
  }

  if (normalized.endsWith(`${sep}forge`)) {
    return `${dataDir.slice(0, -("forge".length))}middleman`;
  }

  return undefined;
}

function isPathWithinDirectory(pathValue: string, directoryPath: string): boolean {
  return pathValue === directoryPath || pathValue.startsWith(`${directoryPath}${sep}`);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
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
