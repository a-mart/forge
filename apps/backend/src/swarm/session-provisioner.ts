import { rm } from "node:fs/promises";
import {
  getProfileMemoryPath,
  getSessionDir,
  getSessionFilePath,
  getSessionMetaPath,
  getWorkersDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import type { RuntimeShutdownResult, SwarmAgentRuntime } from "./runtime-contracts.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

export type ProvisionedSessionDescriptor = AgentDescriptor & { role: "manager"; profileId: string };

interface SessionProvisionerConversationProjector {
  deleteConversationHistory(agentId: string, sessionFile: string): void;
}

export interface ProvisionSessionOptions {
  descriptor: ProvisionedSessionDescriptor;
  profile?: ManagerProfile;
  ensureProfilePiDirectories?: boolean;
  ensureSessionMemoryFile?: boolean;
  ensureProfileMemoryFile?: boolean;
  beforeRuntime?: () => Promise<void>;
  initializeRuntime?: () => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
  removeProfileOnRollback?: boolean;
}

export interface DisposeSessionOptions {
  terminateRuntime?: boolean;
  removeProfileId?: string;
}

export type SessionRollbackDisposition =
  | { status: "removed" }
  | { status: "retained"; reason: "runtime_shutdown_failed" | "runtime_shutdown_pending" | "cleanup_failed"; message: string };

export interface SessionProvisionerDescriptorMutations {
  upsertDescriptor(descriptor: AgentDescriptor): void;
  deleteDescriptor(agentId: string): void;
  upsertProfile(profile: ManagerProfile): void;
  deleteProfile(profileId: string): void;
}

export interface SessionProvisionerOptions {
  dataDir: string;
  descriptorMutations: SessionProvisionerDescriptorMutations;
  runtimes: Map<string, SwarmAgentRuntime>;
  forgetPinnedMessages: (agentId: string) => void;
  conversationProjector: SessionProvisionerConversationProjector;
  ensureProfilePiDirectories: (profileId: string) => Promise<void>;
  ensureSessionFileParentDirectory: (sessionFile: string) => Promise<void>;
  ensureAgentMemoryFile: (memoryFilePath: string, profileId?: string) => Promise<void>;
  getAgentMemoryPath: (agentId: string) => string;
  writeInitialSessionMeta: (descriptor: AgentDescriptor) => Promise<void>;
  runRuntimeShutdown: (
    descriptor: AgentDescriptor,
    action: "terminate",
    options?: { abort?: boolean }
  ) => Promise<RuntimeShutdownResult>;
  detachRuntime: (agentId: string, runtimeToken?: number) => boolean;
  clearAgentTurnState: (agentId: string) => void;
  deleteManagerSessionFile: (sessionFile: string) => Promise<void>;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export class SessionProvisioner {
  constructor(private readonly options: SessionProvisionerOptions) {}

  async provisionSession(options: ProvisionSessionOptions): Promise<void> {
    const {
      descriptor,
      profile,
      ensureProfilePiDirectories = false,
      ensureSessionMemoryFile = true,
      ensureProfileMemoryFile = true,
      beforeRuntime,
      initializeRuntime,
      onError,
      removeProfileOnRollback = Boolean(profile)
    } = options;

    this.options.descriptorMutations.upsertDescriptor(descriptor);
    if (profile) {
      this.options.descriptorMutations.upsertProfile(profile);
    }

    try {
      if (ensureProfilePiDirectories) {
        await this.options.ensureProfilePiDirectories(descriptor.profileId);
      }

      await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);

      if (ensureSessionMemoryFile) {
        await this.options.ensureAgentMemoryFile(this.options.getAgentMemoryPath(descriptor.agentId), descriptor.profileId);
      }

      if (ensureProfileMemoryFile) {
        await this.options.ensureAgentMemoryFile(getProfileMemoryPath(this.options.dataDir, descriptor.profileId), descriptor.profileId);
      }

      await this.options.writeInitialSessionMeta(descriptor);
      await beforeRuntime?.();
      await initializeRuntime?.();
    } catch (error) {
      if (onError) {
        try {
          await onError(error);
        } catch (cleanupError) {
          this.options.logDebug("session:provision:on_error_cleanup_failed", {
            agentId: descriptor.agentId,
            message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }

      const rollback = await this.rollbackCreatedSession(descriptor, {
        removeProfileId: removeProfileOnRollback && profile ? profile.profileId : undefined
      });
      if (rollback.status === "retained") {
        this.options.logDebug("session:provision:rollback_retained", {
          agentId: descriptor.agentId,
          reason: rollback.reason,
          message: rollback.message
        });
      }
      throw error;
    }
  }

  async disposeSession(descriptor: AgentDescriptor, options: DisposeSessionOptions = {}): Promise<void> {
    if (options.terminateRuntime ?? true) {
      const runtime = this.options.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
        assertRuntimeShutdownClean(shutdown, descriptor.agentId);
      }
    }

    this.options.clearAgentTurnState(descriptor.agentId);
    this.options.descriptorMutations.deleteDescriptor(descriptor.agentId);
    this.options.forgetPinnedMessages(descriptor.agentId);
    this.options.conversationProjector.deleteConversationHistory(descriptor.agentId, descriptor.sessionFile);

    await this.removeSessionFiles(descriptor);

    if (options.removeProfileId) {
      this.options.descriptorMutations.deleteProfile(options.removeProfileId);
    }
  }

  async rollbackCreatedSession(
    descriptor: AgentDescriptor,
    options: { removeProfileId?: string } = {}
  ): Promise<SessionRollbackDisposition> {
    const runtime = this.options.runtimes.get(descriptor.agentId);
    if (runtime) {
      try {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
        assertRuntimeShutdownClean(shutdown, descriptor.agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logDebug("session:rollback:runtime_error", {
          agentId: descriptor.agentId,
          message
        });
        return {
          status: "retained",
          reason: message.includes("still pending") ? "runtime_shutdown_pending" : "runtime_shutdown_failed",
          message
        };
      }
    }

    try {
      this.options.descriptorMutations.deleteDescriptor(descriptor.agentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logDebug("session:rollback:cleanup_error", {
        agentId: descriptor.agentId,
        message
      });
      return { status: "retained", reason: "cleanup_failed", message };
    }

    const removeProfileId = options.removeProfileId;
    const cleanupSteps: Array<() => Promise<void> | void> = [
      () => this.options.clearAgentTurnState(descriptor.agentId),
      () => this.options.forgetPinnedMessages(descriptor.agentId),
      () => this.options.conversationProjector.deleteConversationHistory(descriptor.agentId, descriptor.sessionFile),
      () => this.removeSessionFiles(descriptor),
      ...(removeProfileId
        ? [() => this.options.descriptorMutations.deleteProfile(removeProfileId)]
        : [])
    ];
    for (const cleanup of cleanupSteps) {
      try {
        await cleanup();
      } catch (error) {
        this.options.logDebug("session:rollback:cleanup_error", {
          agentId: descriptor.agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { status: "removed" };
  }

  private async removeSessionFiles(descriptor: AgentDescriptor): Promise<void> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sessionDir = getSessionDir(this.options.dataDir, profileId, descriptor.agentId);
    const workersDir = getWorkersDir(this.options.dataDir, profileId, descriptor.agentId);
    const canonicalSessionFile = getSessionFilePath(this.options.dataDir, profileId, descriptor.agentId);
    const sessionMetaPath = getSessionMetaPath(this.options.dataDir, profileId, descriptor.agentId);
    const sessionMemoryPath = resolveMemoryFilePath(this.options.dataDir, {
      agentId: descriptor.agentId,
      role: "manager",
      profileId,
      managerId: descriptor.managerId
    });

    if (descriptor.sessionFile === canonicalSessionFile) {
      await rm(sessionDir, { recursive: true, force: true });
      return;
    }
    await this.options.deleteManagerSessionFile(descriptor.sessionFile);
    await rm(sessionMetaPath, { force: true });
    await rm(sessionMemoryPath, { force: true });
    await rm(workersDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
}

function assertRuntimeShutdownClean(result: RuntimeShutdownResult, agentId: string): void {
  if (result.status === "clean") return;
  if (result.status === "failed") throw result.error;
  throw new Error(`Runtime shutdown is still pending: ${agentId}`);
}
