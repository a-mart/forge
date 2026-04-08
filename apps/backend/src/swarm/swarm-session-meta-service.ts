import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeStrategy,
  SessionMeta
} from "@forge/protocol";
import { getProfileMemoryPath } from "./data-paths.js";
import {
  backfillCompactionCounts,
  computePromptFingerprint,
  incrementSessionCompactionCount,
  readSessionMeta,
  rebuildSessionMeta,
  updateSessionMetaStats,
  updateSessionMetaWorker,
  writeSessionMeta
} from "./session-manifest.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";
import type { AgentDescriptor, AgentStatus } from "./types.js";

const MANAGER_ARCHETYPE_ID = "manager";

export interface SessionMemoryMergeAttemptMetaUpdate {
  attemptId?: string | null;
  timestamp: string;
  status: SessionMemoryMergeAttemptStatus;
  strategy?: SessionMemoryMergeStrategy | null;
  failureStage?: SessionMemoryMergeFailureStage | null;
  sessionContentHash?: string | null;
  profileContentHashBefore?: string | null;
  profileContentHashAfter?: string | null;
  appliedSourceHash?: string | null;
  error?: string;
}

export interface SwarmSessionMetaServiceOptions {
  dataDir: string;
  agentsStoreFile: string;
  descriptors: Map<string, AgentDescriptor>;
  getSortedDescriptors: () => AgentDescriptor[];
  now: () => string;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  emitAgentsSnapshot: () => void;
  ensureSkillMetadataLoaded: () => Promise<void>;
  getAdditionalSkillPaths: () => string[];
  getAgentMemoryPath: (agentId: string) => string;
  resolveSystemPromptForDescriptor: (descriptor: AgentDescriptor) => Promise<string>;
}

export class SwarmSessionMetaService {
  constructor(private readonly options: SwarmSessionMetaServiceOptions) {}

  async rebuildSessionManifestForBoot(): Promise<void> {
    try {
      await rebuildSessionMeta({
        dataDir: this.options.dataDir,
        agentsStoreFile: this.options.agentsStoreFile,
        descriptors: this.options.getSortedDescriptors(),
        now: this.options.now
      });
    } catch (error) {
      this.options.logDebug("session:meta:rebuild_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async hydrateCompactionCountsForBoot(): Promise<void> {
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager") continue;
      const profileId = descriptor.profileId ?? descriptor.agentId;
      try {
        const meta = await readSessionMeta(this.options.dataDir, profileId, descriptor.agentId);
        if (meta?.compactionCount) {
          descriptor.compactionCount = meta.compactionCount;
        }
      } catch {
        // Ignore — compactionCount remains undefined
      }
    }
  }

  startCompactionCountBackfill(): void {
    void backfillCompactionCounts(this.options.dataDir)
      .then((result) => {
        for (const [sessionId, count] of result.counts) {
          const descriptor = this.options.descriptors.get(sessionId);
          if (descriptor && descriptor.role === "manager") {
            descriptor.compactionCount = count;
          }
        }
        if (result.counts.size > 0) {
          this.options.emitAgentsSnapshot();
        }
        this.options.logDebug("boot:compaction-count-backfill:done", { sessionsUpdated: result.counts.size });
      })
      .catch((error) => {
        this.options.logDebug("boot:compaction-count-backfill:error", { error: String(error) });
      });
  }

  async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const existingMeta = await readSessionMeta(this.options.dataDir, profileId, descriptor.agentId);
    const base = existingMeta ?? this.createSessionMetaSkeleton(descriptor);

    const next: SessionMeta = {
      ...base,
      sessionId: descriptor.agentId,
      profileId,
      label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? base.label,
      model: {
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId
      },
      createdAt: descriptor.createdAt,
      updatedAt: this.options.now(),
      cwd: descriptor.cwd,
      stats: this.buildSessionMetaStats(base.workers, {
        sessionFileSize: base.stats.sessionFileSize,
        memoryFileSize: base.stats.memoryFileSize
      })
    };

    await writeSessionMeta(this.options.dataDir, next);
  }

  async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;

    try {
      await this.options.ensureSkillMetadataLoaded();

      const memoryFilePath = this.options.getAgentMemoryPath(descriptor.agentId);
      const profileMemoryPath = getProfileMemoryPath(this.options.dataDir, profileId);

      const agentsFileCandidate = join(descriptor.cwd, "AGENTS.md");
      const promptComponents: NonNullable<SessionMeta["promptComponents"]> = {
        archetype: descriptor.archetypeId ?? MANAGER_ARCHETYPE_ID,
        agentsFile: existsSync(agentsFileCandidate) ? agentsFileCandidate : null,
        skills: this.options.getAdditionalSkillPaths(),
        memoryFile: memoryFilePath,
        profileMemoryFile: profileMemoryPath
      };

      const resolvedSystemPromptForMeta = resolvedSystemPrompt === undefined
        ? await this.options.resolveSystemPromptForDescriptor(descriptor)
        : resolvedSystemPrompt;
      const existingMeta = await readSessionMeta(this.options.dataDir, profileId, descriptor.agentId);
      const base = existingMeta ?? this.createSessionMetaSkeleton(descriptor);

      const next: SessionMeta = {
        ...base,
        sessionId: descriptor.agentId,
        profileId,
        label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? base.label,
        model: {
          provider: descriptor.model.provider,
          modelId: descriptor.model.modelId
        },
        cwd: descriptor.cwd,
        resolvedSystemPrompt: resolvedSystemPromptForMeta,
        promptComponents,
        promptFingerprint: computePromptFingerprint(promptComponents),
        updatedAt: this.options.now()
      };

      await writeSessionMeta(this.options.dataDir, next);
    } catch (error) {
      this.options.logDebug("session:meta:prompt_capture_error", {
        sessionAgentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    if (descriptor.role !== "worker") {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return;
    }

    const profileId = managerDescriptor.profileId ?? managerDescriptor.agentId;

    try {
      await updateSessionMetaWorker(
        this.options.dataDir,
        profileId,
        managerDescriptor.agentId,
        {
          id: descriptor.agentId,
          model: this.buildWorkerModelIdentifier(descriptor),
          specialistId: normalizeOptionalAgentId(descriptor.specialistId) ?? null,
          status: this.mapWorkerStatusForMeta(descriptor.status),
          createdAt: descriptor.createdAt,
          terminatedAt: descriptor.status === "terminated" ? descriptor.updatedAt : null,
          tokens: {
            input:
              typeof descriptor.contextUsage?.tokens === "number"
                ? Math.max(0, Math.round(descriptor.contextUsage.tokens))
                : null,
            output: null
          },
          systemPrompt: resolvedSystemPrompt
        },
        this.options.now
      );
    } catch (error) {
      this.options.logDebug("session:meta:worker_update_error", {
        workerId: descriptor.agentId,
        managerId: descriptor.managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const memoryFilePath = this.options.getAgentMemoryPath(descriptor.agentId);

    try {
      const updated = await updateSessionMetaStats(this.options.dataDir, profileId, descriptor.agentId, {
        sessionFilePath: sessionFileOverride ?? descriptor.sessionFile,
        memoryFilePath,
        now: this.options.now
      });

      if (!updated) {
        await this.writeInitialSessionMeta(descriptor);
        await updateSessionMetaStats(this.options.dataDir, profileId, descriptor.agentId, {
          sessionFilePath: sessionFileOverride ?? descriptor.sessionFile,
          memoryFilePath,
          now: this.options.now
        });
      }
    } catch (error) {
      this.options.logDebug("session:meta:stats_update_error", {
        sessionAgentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    const descriptor = this.options.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    await this.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  async incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined> {
    return incrementSessionCompactionCount(this.options.dataDir, profileId, sessionId).catch((error) => {
      this.options.logDebug(failureLogKey, { agentId: sessionId, error: String(error) });
      return undefined;
    });
  }

  async readSessionMetaForDescriptor(descriptor: AgentDescriptor): Promise<SessionMeta | undefined> {
    const target = this.resolveSessionMetaTarget(descriptor);
    if (!target) {
      return undefined;
    }

    return readSessionMeta(this.options.dataDir, target.profileId, target.sessionId);
  }

  async writeSessionMemoryMergeAttemptMeta(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate
  ): Promise<void> {
    const target = this.resolveSessionMetaTarget(descriptor);
    if (!target) {
      throw new Error(`Cannot resolve session meta target for ${descriptor.agentId}`);
    }

    const existingMeta = await readSessionMeta(this.options.dataDir, target.profileId, target.sessionId);
    const base = existingMeta ?? this.createSessionMetaSkeleton(target.descriptor);

    const next: SessionMeta = {
      ...base,
      sessionId: target.sessionId,
      profileId: target.profileId,
      label: normalizeOptionalAgentId(target.descriptor.sessionLabel) ?? base.label,
      model: {
        provider: target.descriptor.model.provider,
        modelId: target.descriptor.model.modelId
      },
      cwd: target.descriptor.cwd,
      updatedAt: attempt.timestamp,
      memoryMergeAttemptCount: (base.memoryMergeAttemptCount ?? 0) + 1,
      lastMemoryMergeAttemptId: attempt.attemptId ?? (base.lastMemoryMergeAttemptId ?? null),
      lastMemoryMergeAttemptAt: attempt.timestamp,
      lastMemoryMergeAppliedAt:
        attempt.status === "applied"
          ? attempt.timestamp
          : attempt.appliedSourceHash
            ? attempt.timestamp
            : (base.lastMemoryMergeAppliedAt ?? null),
      lastMemoryMergeStatus: attempt.status,
      lastMemoryMergeStrategy: attempt.strategy ?? null,
      lastMemoryMergeFailureStage: attempt.failureStage ?? null,
      lastMemoryMergeSourceHash: attempt.sessionContentHash ?? null,
      lastMemoryMergeProfileHashBefore:
        attempt.profileContentHashBefore ?? (base.lastMemoryMergeProfileHashBefore ?? null),
      lastMemoryMergeProfileHashAfter:
        attempt.profileContentHashAfter ?? (base.lastMemoryMergeProfileHashAfter ?? null),
      lastMemoryMergeAppliedSourceHash: attempt.appliedSourceHash ?? (base.lastMemoryMergeAppliedSourceHash ?? null),
      lastMemoryMergeError: attempt.error ?? null
    };

    await writeSessionMeta(this.options.dataDir, next);
  }

  private resolveSessionMetaTarget(
    descriptor: AgentDescriptor
  ): { descriptor: AgentDescriptor & { role: "manager"; profileId: string }; profileId: string; sessionId: string } | null {
    if (descriptor.role === "manager") {
      const profileId = descriptor.profileId ?? descriptor.agentId;
      return {
        descriptor: {
          ...descriptor,
          profileId,
          role: "manager"
        },
        profileId,
        sessionId: descriptor.agentId
      };
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return null;
    }

    const profileId = managerDescriptor.profileId ?? managerDescriptor.agentId;
    return {
      descriptor: {
        ...managerDescriptor,
        profileId,
        role: "manager"
      },
      profileId,
      sessionId: managerDescriptor.agentId
    };
  }

  private createSessionMetaSkeleton(descriptor: AgentDescriptor): SessionMeta {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const timestamp = this.options.now();

    return {
      sessionId: descriptor.agentId,
      profileId,
      label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? null,
      model: {
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId
      },
      createdAt: descriptor.createdAt,
      updatedAt: timestamp,
      cwd: descriptor.cwd,
      resolvedSystemPrompt: null,
      promptFingerprint: null,
      promptComponents: null,
      feedbackFileSize: null,
      lastFeedbackAt: null,
      cortexReviewedFeedbackBytes: 0,
      cortexReviewedFeedbackAt: null,
      memoryMergeAttemptCount: 0,
      lastMemoryMergeAttemptId: null,
      lastMemoryMergeAttemptAt: null,
      lastMemoryMergeAppliedAt: null,
      lastMemoryMergeStatus: null,
      lastMemoryMergeStrategy: null,
      lastMemoryMergeFailureStage: null,
      lastMemoryMergeSourceHash: null,
      lastMemoryMergeProfileHashBefore: null,
      lastMemoryMergeProfileHashAfter: null,
      lastMemoryMergeAppliedSourceHash: null,
      lastMemoryMergeError: null,
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    };
  }

  private buildSessionMetaStats(
    workers: SessionMeta["workers"],
    fileSizes: { sessionFileSize: string | null; memoryFileSize: string | null }
  ): SessionMeta["stats"] {
    const inputTokens = workers
      .map((worker) => worker.tokens.input)
      .filter((value): value is number => typeof value === "number");
    const outputTokens = workers
      .map((worker) => worker.tokens.output)
      .filter((value): value is number => typeof value === "number");

    return {
      totalWorkers: workers.length,
      activeWorkers: workers.filter((worker) => worker.status === "streaming").length,
      totalTokens: {
        input: inputTokens.length > 0 ? inputTokens.reduce((sum, value) => sum + value, 0) : null,
        output: outputTokens.length > 0 ? outputTokens.reduce((sum, value) => sum + value, 0) : null
      },
      sessionFileSize: fileSizes.sessionFileSize,
      memoryFileSize: fileSizes.memoryFileSize
    };
  }

  private mapWorkerStatusForMeta(status: AgentStatus): SessionMeta["workers"][number]["status"] {
    if (status === "terminated") {
      return "terminated";
    }

    if (status === "streaming") {
      return "streaming";
    }

    return "idle";
  }

  private buildWorkerModelIdentifier(descriptor: AgentDescriptor): string | null {
    const provider = normalizeOptionalAgentId(descriptor.model.provider);
    const modelId = normalizeOptionalAgentId(descriptor.model.modelId);

    if (!provider || !modelId) {
      return null;
    }

    return `${provider}/${modelId}`;
  }
}
