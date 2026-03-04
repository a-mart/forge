import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getSharedKnowledgeDir, resolveMemoryFilePath } from "./data-paths.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "./types.js";

const DEFAULT_MEMORY_FILE_CONTENT = `# Swarm Memory

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

      this.deps.config.paths.uploadsDir,
      this.deps.config.paths.agentDir,
      this.deps.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureMemoryFilesForBoot(): Promise<void> {
    const memoryFilePaths = new Set<string>();
    const configuredManagerId = this.deps.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredDescriptor = this.deps.descriptors.get(configuredManagerId);
      if (configuredDescriptor?.role === "manager") {
        memoryFilePaths.add(this.getAgentMemoryPath(configuredDescriptor));
      } else {
        memoryFilePaths.add(
          this.getAgentMemoryPath({
            agentId: configuredManagerId,
            role: "manager",
            profileId: configuredManagerId,
            managerId: configuredManagerId
          })
        );
      }
    }

    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      memoryFilePaths.add(this.getAgentMemoryPath(descriptor));
    }

    for (const memoryFilePath of memoryFilePaths) {
      await this.ensureAgentMemoryFile(memoryFilePath);
    }
  }

  async ensureAgentMemoryFile(memoryFilePath: string): Promise<void> {
    try {
      await readFile(memoryFilePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, DEFAULT_MEMORY_FILE_CONTENT, "utf8");
  }

  async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    try {
      await unlink(sessionFile);
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

        validAgents.push(validated);
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
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
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

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
