import { rm } from "node:fs/promises";
import {
  getProfileMemoryPath,
  getSessionDir,
  getSessionFilePath,
  getSessionMetaPath,
  getWorkersDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
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

export interface SessionProvisionerOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  pinnedMessageIdsBySessionAgentId: Map<string, Set<string>>;
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
  ) => Promise<{ timedOut: boolean; runtimeToken?: number }>;
  detachRuntime: (agentId: string, runtimeToken?: number) => boolean;
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

    this.options.descriptors.set(descriptor.agentId, descriptor);
    if (profile) {
      this.options.profiles.set(profile.profileId, profile);
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

      await this.rollbackCreatedSession(descriptor, {
        removeProfileId: removeProfileOnRollback && profile ? profile.profileId : undefined
      });
      throw error;
    }
  }

  async disposeSession(descriptor: AgentDescriptor, options: DisposeSessionOptions = {}): Promise<void> {
    if (options.terminateRuntime ?? true) {
      const runtime = this.options.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      }
    }

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

    this.options.descriptors.delete(descriptor.agentId);
    this.options.pinnedMessageIdsBySessionAgentId.delete(descriptor.agentId);
    this.options.conversationProjector.deleteConversationHistory(descriptor.agentId, descriptor.sessionFile);

    if (descriptor.sessionFile === canonicalSessionFile) {
      await rm(sessionDir, { recursive: true, force: true });
    } else {
      await this.options.deleteManagerSessionFile(descriptor.sessionFile);
      await rm(sessionMetaPath, { force: true });
      await rm(sessionMemoryPath, { force: true });
      await rm(workersDir, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    }

    if (options.removeProfileId) {
      this.options.profiles.delete(options.removeProfileId);
    }
  }

  async rollbackCreatedSession(
    descriptor: AgentDescriptor,
    options: { removeProfileId?: string } = {}
  ): Promise<void> {
    const runtime = this.options.runtimes.get(descriptor.agentId);
    if (runtime) {
      try {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      } catch (error) {
        this.options.logDebug("session:rollback:runtime_error", {
          agentId: descriptor.agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      await this.disposeSession(descriptor, {
        terminateRuntime: false,
        removeProfileId: options.removeProfileId
      });
    } catch (error) {
      this.options.logDebug("session:rollback:cleanup_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
