import { writeFile } from "node:fs/promises";
import { assertBuilderSession } from "./swarm-manager-utils.js";
import { savePins, type PinRegistry } from "./message-pins.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { AgentDescriptor, AgentModelDescriptor, ManagerProfile, SessionLifecycleEvent } from "./types.js";

interface StopSessionInternalOptions {
  saveStore: boolean;
  emitSnapshots: boolean;
  emitStatus?: boolean;
  deleteWorkers?: boolean;
}

export interface SwarmSessionServiceOptions {
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  provisioner: SessionProvisioner;
  prepareSessionCreation: (
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ) => { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number };
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>;
  stopSessionInternal: (
    agentId: string,
    options: StopSessionInternalOptions
  ) => Promise<{ terminatedWorkerIds: string[] }>;
  assertSessionIsDeletable: (descriptor: AgentDescriptor) => void;
  saveStore: () => Promise<void>;
  writeInitialSessionMeta: (descriptor: AgentDescriptor) => Promise<void>;
  deleteProjectAgentRecord: (profileId: string, handle: string) => Promise<void>;
  notifyProjectAgentsChanged: (profileId: string) => Promise<void>;
  emitSessionLifecycle: (event: SessionLifecycleEvent) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  emitConversationReset: (agentId: string, source: string) => void;
  injectAgentCreatorContext: (agentId: string, profileId: string) => Promise<void>;
  cancelAllPendingChoicesForAgent: (agentId: string) => void;
  getSessionDirForDescriptor: (descriptor: { agentId: string; profileId?: string }) => string;
  syncPinnedContentForManagerRuntime: (
    descriptor: ProvisionedSessionDescriptor,
    options?: {
      registry?: PinRegistry;
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: { suppressRecycle?: boolean };
    }
  ) => Promise<void>;
  resetConversationHistory: (agentId: string) => void;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  appendSessionRenameHistoryEntry: (
    descriptor: ProvisionedSessionDescriptor,
    entry: { from: string; to: string; renamedAt: string }
  ) => Promise<void>;
  copySessionHistoryForFork: (
    sourceSessionFile: string,
    targetSessionFile: string,
    fromMessageId?: string
  ) => Promise<void>;
  copyPinnedMessagesForFork: (
    sourceDescriptor: ProvisionedSessionDescriptor,
    forkedDescriptor: ProvisionedSessionDescriptor
  ) => Promise<void>;
  writeForkedSessionMemoryHeader: (
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string
  ) => Promise<void>;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  now: () => string;
}

export class SwarmSessionService {
  constructor(private readonly options: SwarmSessionServiceOptions) {}

  async createSession(
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    return this.createSessionWithOverrides(profileId, options);
  }

  createSessionWithOverrides(
    profileId: string,
    options: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] } = {},
    overrides: {
      model?: AgentModelDescriptor;
      cwd?: string;
      sessionSystemPrompt?: string;
    } = {}
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {

    const prepared = this.options.prepareSessionCreation(profileId, options);
    const sessionDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;

    if (overrides.model) {
      sessionDescriptor.model = overrides.model;
    }

    if (overrides.cwd) {
      sessionDescriptor.cwd = overrides.cwd;
    }

    if (overrides.sessionSystemPrompt !== undefined) {
      sessionDescriptor.sessionSystemPrompt = overrides.sessionSystemPrompt;
    }

    return this.createSessionWithPreparedDescriptor(prepared, sessionDescriptor);
  }

  private async createSessionWithPreparedDescriptor(
    prepared: { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number },
    sessionDescriptor: ProvisionedSessionDescriptor
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    await this.options.provisioner.provisionSession({
      descriptor: sessionDescriptor,
      initializeRuntime: async () => {
        const runtime = await this.options.getOrCreateRuntimeForDescriptor(sessionDescriptor);
        sessionDescriptor.contextUsage = runtime.getContextUsage();
      }
    });

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId: prepared.profile.profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      await this.options.injectAgentCreatorContext(sessionDescriptor.agentId, prepared.profile.profileId);
    }

    return {
      profile: { ...prepared.profile },
      sessionAgent: cloneDescriptor(sessionDescriptor)
    };
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, "delete Builder sessions");
    this.options.assertSessionIsDeletable(descriptor);
    const wasProjectAgent = Boolean(descriptor.projectAgent);
    const projectAgentHandle = descriptor.projectAgent?.handle;

    const { terminatedWorkerIds } = await this.options.stopSessionInternal(agentId, {
      saveStore: false,
      emitSnapshots: false,
      emitStatus: false,
      deleteWorkers: true
    });

    await this.options.provisioner.disposeSession(descriptor, { terminateRuntime: false });

    if (wasProjectAgent && projectAgentHandle) {
      await this.options.deleteProjectAgentRecord(descriptor.profileId, projectAgentHandle);
    }

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "deleted",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (wasProjectAgent) {
      await this.options.notifyProjectAgentsChanged(descriptor.profileId);
    }

    return { terminatedWorkerIds };
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, "clear Builder conversations");
    this.options.cancelAllPendingChoicesForAgent(agentId);

    if (descriptor.sessionFile) {
      try {
        await writeFile(descriptor.sessionFile, "");
      } catch {
        // File may not exist yet — that's fine
      }
    }

    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await savePins(this.options.getSessionDirForDescriptor(descriptor), emptyRegistry);
    await this.options.syncPinnedContentForManagerRuntime(descriptor, {
      registry: emptyRegistry,
      setPinnedContentOptions: { suppressRecycle: true }
    });

    this.options.resetConversationHistory(agentId);

    const runtime = this.options.runtimes.get(agentId);
    if (runtime?.runtimeType === "claude") {
      try {
        await runtime.recycle();
      } catch (error) {
        this.options.logDebug("session:clear:claude_recycle_error", {
          agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (runtime) {
      await this.options.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    this.options.emitConversationReset(agentId, "api_reset");
    this.options.logDebug("session:clear", { agentId });
  }

  async renameSession(agentId: string, label: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, "rename Builder sessions");
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      throw new Error("Session label must be non-empty");
    }

    const previousLabel = descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId;
    const renamedAt = this.options.now();

    descriptor.sessionLabel = normalizedLabel;

    await this.options.writeInitialSessionMeta(descriptor);
    await this.options.appendSessionRenameHistoryEntry(descriptor, {
      from: previousLabel,
      to: normalizedLabel,
      renamedAt
    });
    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "renamed",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId,
      label: normalizedLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (descriptor.projectAgent) {
      await this.options.notifyProjectAgentsChanged(descriptor.profileId);
    }
  }

  async forkSession(
    sourceAgentId: string,
    options?: { label?: string; fromMessageId?: string }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = this.options.getRequiredSessionDescriptor(sourceAgentId);
    assertBuilderSession(sourceDescriptor, "fork Builder sessions");
    const profile = this.options.profiles.get(sourceDescriptor.profileId);
    const normalizedFromMessageId = options?.fromMessageId?.trim() || undefined;
    if (!profile) {
      throw new Error(`Unknown profile: ${sourceDescriptor.profileId}`);
    }

    const prepared = this.options.prepareSessionCreation(profile.profileId, {
      label: options?.label,
      name: options?.label
    });
    const forkedDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;

    await this.options.provisioner.provisionSession({
      descriptor: forkedDescriptor,
      ensureSessionMemoryFile: false,
      ensureProfileMemoryFile: false,
      beforeRuntime: async () => {
        await this.options.copySessionHistoryForFork(
          sourceDescriptor.sessionFile,
          forkedDescriptor.sessionFile,
          normalizedFromMessageId
        );
        await this.options.copyPinnedMessagesForFork(sourceDescriptor, forkedDescriptor);
        await this.options.writeForkedSessionMemoryHeader(
          sourceDescriptor,
          forkedDescriptor.agentId,
          normalizedFromMessageId
        );
      },
      initializeRuntime: async () => {
        const runtime = await this.options.getOrCreateRuntimeForDescriptor(forkedDescriptor);
        forkedDescriptor.contextUsage = runtime.getContextUsage();
      }
    });

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "forked",
      sessionAgentId: forkedDescriptor.agentId,
      sourceAgentId: sourceDescriptor.agentId,
      profileId: profile.profileId,
      label: forkedDescriptor.sessionLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    return {
      profile: { ...profile },
      sessionAgent: cloneDescriptor(forkedDescriptor)
    };
  }
}

function cloneDescriptor<T extends AgentDescriptor>(descriptor: T): T {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: descriptor.contextUsage ? { ...descriptor.contextUsage } : undefined,
    ...(descriptor.projectAgent
      ? {
          projectAgent: {
            ...descriptor.projectAgent,
            ...(descriptor.projectAgent.capabilities
              ? { capabilities: [...descriptor.projectAgent.capabilities] }
              : {})
          }
        }
      : {})
  };
}
