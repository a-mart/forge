import type { PersistedProjectAgentConfig, ProjectAgentCapability } from "@forge/protocol";
import {
  deleteProjectAgentRecord,
  writeProjectAgentRecord
} from "./project-agent-storage.js";
import {
  planProjectAgentReferenceDeleteMutation,
  planProjectAgentReferenceWriteMutation,
  planSetSessionProjectAgentMutation,
  type ProjectAgentMutationFlags
} from "./agents/project-agent-mutations.js";
import {
  getProjectAgentHandleCollisionError,
  normalizeProjectAgentHandle,
  normalizeProjectAgentInlineText
} from "./agents/project-agents.js";
import { ProjectAgentRegistry } from "./agents/project-agent-registry.js";
import { ProjectAgentSettingsSnapshotReader } from "./agents/project-agent-settings-snapshot.js";
import {
  deleteProjectAgentReferenceDoc,
  listProjectAgentReferenceDocs,
  readProjectAgentReferenceDoc,
  writeProjectAgentReferenceDoc
} from "./reference-docs.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import { cloneProjectAgentInfoValue } from "./swarm-manager-utils.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

export interface SwarmProjectAgentServiceOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  provisioner: SessionProvisioner;
  now: () => string;
  prepareSessionCreation: (
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ) => { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number };
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  assertSessionSupportsProjectAgent: (descriptor: ProvisionedSessionDescriptor) => void;
  getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<{ getContextUsage(): AgentDescriptor["contextUsage"] }>;
  upsertDescriptorInLiveMaps: (descriptor: AgentDescriptor) => void;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  saveStore: () => Promise<void>;
  emitSessionLifecycle: (event: {
    action: "created" | "deleted" | "renamed" | "forked";
    sessionAgentId: string;
    sourceAgentId?: string;
    profileId: string;
    label?: string;
  }) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  emitSessionProjectAgentUpdated: (
    agentId: string,
    profileId: string,
    projectAgent: AgentDescriptor["projectAgent"] | null
  ) => void;
  notifyProjectAgentsChanged: (profileId: string) => Promise<void>;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export class SwarmProjectAgentService {
  private readonly registry: ProjectAgentRegistry;
  private readonly settingsSnapshotReader: ProjectAgentSettingsSnapshotReader;

  constructor(private readonly options: SwarmProjectAgentServiceOptions) {
    this.registry = new ProjectAgentRegistry({
      dataDir: options.dataDir,
      descriptors: options.descriptors
    });
    this.settingsSnapshotReader = new ProjectAgentSettingsSnapshotReader({
      dataDir: options.dataDir,
      registry: this.registry,
      now: options.now
    });
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
      capabilities?: ProjectAgentCapability[];
    }
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    const creatorDescriptor = this.options.getRequiredSessionDescriptor(creatorAgentId);
    if (creatorDescriptor.sessionPurpose !== "agent_creator") {
      throw new Error("Only agent_creator sessions can create project agents");
    }

    const profileId = creatorDescriptor.profileId;
    const trimmedName = params.sessionName.trim();
    const trimmedWhenToUse = normalizeProjectAgentInlineText(params.whenToUse);
    const trimmedSystemPrompt = params.systemPrompt.trim();

    if (!trimmedName) {
      throw new Error("sessionName must be non-empty");
    }
    if (!trimmedWhenToUse) {
      throw new Error("whenToUse must be non-empty");
    }
    if (trimmedWhenToUse.length > 280) {
      throw new Error("whenToUse must be 280 characters or fewer");
    }
    if (!trimmedSystemPrompt) {
      throw new Error("systemPrompt must be non-empty");
    }

    const handleSource = params.handle ?? trimmedName;
    const handle = normalizeProjectAgentHandle(handleSource);
    if (!handle) {
      throw new Error("Project agent handle must contain at least one letter, number, or dash");
    }

    await this.assertProjectAgentHandleAvailable(profileId, handle);

    const prepared = this.options.prepareSessionCreation(profileId, {
      name: trimmedName,
      label: trimmedName
    });
    const sessionDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;
    sessionDescriptor.projectAgent = {
      handle,
      whenToUse: trimmedWhenToUse,
      systemPrompt: trimmedSystemPrompt,
      creatorSessionId: creatorAgentId,
      ...(params.capabilities !== undefined ? { capabilities: params.capabilities } : {})
    };

    const previousCreatorResult = creatorDescriptor.agentCreatorResult
      ? { ...creatorDescriptor.agentCreatorResult }
      : undefined;

    let provisioned = false;
    try {
      await this.options.provisioner.provisionSession({
        descriptor: sessionDescriptor,
        beforeRuntime: async () => {
          const persistedProjectAgentConfig: PersistedProjectAgentConfig = {
            version: 1,
            agentId: sessionDescriptor.agentId,
            handle,
            whenToUse: trimmedWhenToUse,
            creatorSessionId: creatorAgentId,
            ...(params.capabilities !== undefined ? { capabilities: params.capabilities } : {}),
            promotedAt: sessionDescriptor.createdAt,
            updatedAt: this.options.now()
          };
          await writeProjectAgentRecord(
            this.options.dataDir,
            profileId,
            persistedProjectAgentConfig,
            trimmedSystemPrompt
          );
        },
        initializeRuntime: async () => {
          const runtime = await this.options.getOrCreateRuntimeForDescriptor(sessionDescriptor);
          sessionDescriptor.contextUsage = runtime.getContextUsage();
          creatorDescriptor.agentCreatorResult = {
            createdAgentId: sessionDescriptor.agentId,
            createdHandle: handle,
            createdAt: new Date().toISOString()
          };
          this.options.upsertDescriptorInLiveMaps(creatorDescriptor);
        },
        onError: async () => {
          if (previousCreatorResult) {
            creatorDescriptor.agentCreatorResult = previousCreatorResult;
          } else {
            delete creatorDescriptor.agentCreatorResult;
          }
          this.options.upsertDescriptorInLiveMaps(creatorDescriptor);
          await deleteProjectAgentRecord(this.options.dataDir, profileId, handle);
        }
      });
      provisioned = true;
      await this.options.saveStore();
    } catch (error) {
      if (!provisioned) {
        throw error;
      }

      if (previousCreatorResult) {
        creatorDescriptor.agentCreatorResult = previousCreatorResult;
      } else {
        delete creatorDescriptor.agentCreatorResult;
      }
      this.options.upsertDescriptorInLiveMaps(creatorDescriptor);

      const cleanupResults = await Promise.allSettled([
        deleteProjectAgentRecord(this.options.dataDir, profileId, handle),
        this.options.provisioner.rollbackCreatedSession(sessionDescriptor)
      ]);
      for (const cleanupResult of cleanupResults) {
        if (cleanupResult.status === "rejected") {
          this.options.logDebug("project_agent:create:rollback_cleanup_error", {
            creatorAgentId,
            agentId: sessionDescriptor.agentId,
            handle,
            message: cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason)
          });
        }
      }

      try {
        await this.options.saveStore();
      } catch (rollbackSaveError) {
        this.options.logDebug("project_agent:create:rollback_save_error", {
          creatorAgentId,
          agentId: sessionDescriptor.agentId,
          handle,
          message: rollbackSaveError instanceof Error ? rollbackSaveError.message : String(rollbackSaveError)
        });
      }

      throw error;
    }
    this.options.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();
    this.options.emitSessionProjectAgentUpdated(sessionDescriptor.agentId, profileId, sessionDescriptor.projectAgent ?? null);
    await this.options.notifyProjectAgentsChanged(profileId);

    return {
      agentId: sessionDescriptor.agentId,
      handle,
      profileId
    };
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent:
      | { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: ProjectAgentCapability[] }
      | null
  ): Promise<{ profileId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    this.options.assertSessionSupportsProjectAgent(descriptor);

    const profileId = descriptor.profileId;
    const mutation = planSetSessionProjectAgentMutation({
      descriptor,
      projectAgent,
      updatedAt: this.options.now()
    });
    const nextProjectAgent = mutation.nextProjectAgent;

    if (mutation.configPlan.kind === "write") {
      await this.assertProjectAgentHandleAvailable(profileId, mutation.configPlan.handle, descriptor.agentId);

      await writeProjectAgentRecord(
        this.options.dataDir,
        profileId,
        mutation.configPlan.config,
        mutation.configPlan.systemPrompt
      );
    } else if (mutation.configPlan.kind === "delete") {
      await deleteProjectAgentRecord(this.options.dataDir, profileId, mutation.configPlan.handle);
    }

    descriptor.projectAgent = nextProjectAgent ?? undefined;
    this.options.upsertDescriptorInLiveMaps(descriptor);

    try {
      await this.options.saveStore();
      await this.options.captureSessionRuntimePromptMeta(descriptor);
    } catch (error) {
      console.warn(
        `[swarm] project-agent-storage:post_commit_sync_failed agentId=${agentId} profile=${profileId} error=${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.options.emitAgentsSnapshot();
    this.options.emitSessionProjectAgentUpdated(descriptor.agentId, profileId, nextProjectAgent);
    if (mutation.flags.directoryChanged) {
      await this.options.notifyProjectAgentsChanged(profileId);
    }

    return {
      profileId,
      projectAgent: cloneProjectAgentInfoValue(nextProjectAgent) ?? null
    };
  }

  async getProjectAgentConfig(agentId: string): Promise<{
    config: PersistedProjectAgentConfig;
    systemPrompt: string | null;
    references: string[];
  }> {
    return this.settingsSnapshotReader.read(agentId);
  }

  async listProjectAgentReferences(agentId: string): Promise<string[]> {
    const { profileId, handle } = await this.registry.assertOwnedReferenceScope(agentId);
    return listProjectAgentReferenceDocs(this.options.dataDir, profileId, handle);
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    const { profileId, handle } = await this.registry.assertOwnedReferenceScope(agentId);
    const content = await readProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName);
    if (content === null) {
      throw new Error(`Reference document ${fileName} does not exist`);
    }
    return content;
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string): Promise<ProjectAgentMutationFlags> {
    const { profileId, handle } = await this.registry.assertOwnedReferenceScope(agentId);
    const existingContent = await readProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName);
    const mutation = planProjectAgentReferenceWriteMutation({ fileName, content, existingContent });
    if (mutation.changed) {
      await writeProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, mutation.fileName, mutation.content);
    }
    return mutation.flags;
  }

  async deleteProjectAgentReference(agentId: string, fileName: string): Promise<ProjectAgentMutationFlags> {
    const { profileId, handle } = await this.registry.assertOwnedReferenceScope(agentId);
    const existingContent = await readProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName);
    const mutation = planProjectAgentReferenceDeleteMutation({ fileName, existingContent });
    if (mutation.changed) {
      await deleteProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, mutation.fileName);
    }
    return mutation.flags;
  }

  private async assertProjectAgentHandleAvailable(profileId: string, handle: string, ownerAgentId?: string): Promise<void> {
    const descriptorCollision = this.registry.findByHandle(profileId, handle);
    if (descriptorCollision && descriptorCollision.agentId !== ownerAgentId) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }

    if (await this.registry.hasOnDiskCollision(profileId, handle, ownerAgentId)) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }
  }
}
