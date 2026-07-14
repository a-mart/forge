import { readdir } from "node:fs/promises";
import {
  getWorkerIdFromCanonicalTranscriptFileName,
  isWorkerTranscriptSidecarAgentId,
  isWorkerTranscriptSidecarSessionFile,
} from "../../session/worker-transcript-files.js";
import { getWorkersDir, getWorkerSessionFilePath } from "../../data-paths.js";
import { normalizePersistedSwarmModelDescriptor } from "../../model-presets.js";
import { readFileHead } from "../../swarm-manager-utils.js";
import type { AgentDescriptor, AgentsStoreFile } from "../../types.js";

export interface WorkerBootRecoveryOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  upsertDescriptor(descriptor: AgentDescriptor): void;
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/** Removes cache-sidecar rows that were accidentally persisted as real workers. */
export function prunePersistedWorkerSidecars(
  store: AgentsStoreFile,
  logDebug?: WorkerBootRecoveryOptions["logDebug"],
): { store: AgentsStoreFile; pruned: boolean } {
  const agents = Array.isArray(store.agents) ? store.agents : [];
  const filteredAgents = agents.filter((descriptor) => {
    if (descriptor.role !== "worker") return true;
    return !(
      isWorkerTranscriptSidecarAgentId(descriptor.agentId) ||
      (typeof descriptor.sessionFile === "string" &&
        isWorkerTranscriptSidecarSessionFile(descriptor.sessionFile))
    );
  });
  const removedAgents = agents.length - filteredAgents.length;
  if (removedAgents > 0) {
    logDebug?.("boot:worker_sidecar_descriptors:pruned", { removedAgents });
  }
  return {
    store: { ...store, agents: filteredAgents },
    pruned: removedAgents > 0,
  };
}

/** Reconstructs terminated worker descriptors from canonical transcript files. */
export class WorkerBootRecovery {
  constructor(private readonly options: WorkerBootRecoveryOptions) {}

  async recoverMissingDescriptors(): Promise<string[]> {
    const recoveredIds: string[] = [];
    const knownWorkerIds = new Set(
      [...this.options.descriptors.values()]
        .filter((descriptor) => descriptor.role === "worker")
        .map((descriptor) => descriptor.agentId),
    );

    for (const manager of this.options.descriptors.values()) {
      if (manager.role !== "manager" || !manager.profileId) continue;
      const workersDir = getWorkersDir(
        this.options.dataDir,
        manager.profileId,
        manager.agentId,
      );
      let workerFiles: string[];
      try {
        workerFiles = await readdir(workersDir);
      } catch {
        continue;
      }

      for (const filename of workerFiles) {
        const workerId = getWorkerIdFromCanonicalTranscriptFileName(filename);
        if (!workerId || knownWorkerIds.has(workerId)) continue;
        const sessionFile = getWorkerSessionFilePath(
          this.options.dataDir,
          manager.profileId,
          manager.agentId,
          workerId,
        );
        try {
          const header = await readWorkerHeader(sessionFile);
          const descriptor: AgentDescriptor = {
            agentId: workerId,
            displayName: workerId,
            role: "worker",
            managerId: manager.agentId,
            profileId: manager.profileId,
            status: "terminated",
            createdAt: header.createdAt ?? manager.createdAt,
            updatedAt: header.updatedAt ?? manager.updatedAt,
            cwd: header.cwd ?? manager.cwd,
            model: header.model ?? manager.model,
            sessionFile,
          };
          this.options.upsertDescriptor(descriptor);
          knownWorkerIds.add(workerId);
          recoveredIds.push(workerId);
        } catch {
          // An unreadable transcript is not a boot blocker.
        }
      }
    }

    if (recoveredIds.length > 0) {
      this.options.logDebug("boot:recover_missing_workers", {
        recoveredCount: recoveredIds.length,
        recoveredIds: recoveredIds.slice(0, 20),
        truncated: recoveredIds.length > 20,
      });
    }
    return recoveredIds;
  }
}

interface WorkerHeader {
  createdAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  model: AgentDescriptor["model"] | null;
}

export async function readWorkerHeader(filePath: string): Promise<WorkerHeader> {
  const lines = (await readFileHead(filePath, 4096))
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, 10);
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let cwd: string | null = null;
  let model: AgentDescriptor["model"] | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "session") {
        createdAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
        cwd = typeof entry.cwd === "string" ? entry.cwd : null;
      }
      if (entry.type === "model_change") {
        const provider = typeof entry.provider === "string" ? entry.provider : null;
        const modelId = typeof entry.modelId === "string" ? entry.modelId : null;
        if (provider && modelId) {
          model = normalizePersistedSwarmModelDescriptor({
            provider,
            modelId,
            thinkingLevel: "none",
          }) ?? { provider, modelId, thinkingLevel: "none" };
        }
        if (!updatedAt && typeof entry.timestamp === "string") {
          updatedAt = entry.timestamp;
        }
      }
      if (entry.type === "thinking_level_change" && model) {
        const thinkingLevel =
          typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
        if (thinkingLevel) {
          model = normalizePersistedSwarmModelDescriptor({
            ...model,
            thinkingLevel,
          }) ?? { ...model, thinkingLevel };
        }
      }
    } catch {
      // Ignore malformed header lines; later valid entries remain useful.
    }
  }
  return { createdAt, updatedAt: updatedAt ?? createdAt, cwd, model };
}
