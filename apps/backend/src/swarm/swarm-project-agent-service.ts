import type { PersistedProjectAgentConfig } from "@forge/protocol";
import {
  deleteProjectAgentRecord,
  readProjectAgentRecord,
  writeProjectAgentRecord
} from "./project-agent-storage.js";
import {
  findProjectAgentByHandle,
  getProjectAgentHandleCollisionError,
  normalizeProjectAgentHandle,
  normalizeProjectAgentInlineText
} from "./project-agents.js";
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
  buildProjectAgentInfoForSession: (
    descriptor: ProvisionedSessionDescriptor,
    whenToUse: string,
    systemPrompt?: string,
    handle?: string
  ) => NonNullable<AgentDescriptor["projectAgent"]>;
  getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<{ getContextUsage(): AgentDescriptor["contextUsage"] }>;
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
  constructor(private readonly options: SwarmProjectAgentServiceOptions) {}

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: { sessionName: string; handle?: string; whenToUse: string; systemPrompt: string }
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

    const collision = findProjectAgentByHandle(this.options.descriptors.values(), profileId, handle);
    if (collision) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }

    const onDiskCollision = await readProjectAgentRecord(this.options.dataDir, profileId, handle);
    if (onDiskCollision) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }

    const prepared = this.options.prepareSessionCreation(profileId, {
      name: trimmedName,
      label: trimmedName
    });
    const sessionDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;
    sessionDescriptor.projectAgent = {
      handle,
      whenToUse: trimmedWhenToUse,
      systemPrompt: trimmedSystemPrompt,
      creatorSessionId: creatorAgentId
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
          this.options.descriptors.set(creatorDescriptor.agentId, creatorDescriptor);
        },
        onError: async () => {
          if (previousCreatorResult) {
            creatorDescriptor.agentCreatorResult = previousCreatorResult;
          } else {
            delete creatorDescriptor.agentCreatorResult;
          }
          this.options.descriptors.set(creatorDescriptor.agentId, creatorDescriptor);
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
      this.options.descriptors.set(creatorDescriptor.agentId, creatorDescriptor);

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
    projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string } | null
  ): Promise<{ profileId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    this.options.assertSessionSupportsProjectAgent(descriptor);

    const profileId = descriptor.profileId;
    const previousProjectAgent = descriptor.projectAgent;
    const nextHandle = projectAgent?.handle !== undefined ? normalizeProjectAgentHandle(projectAgent.handle) : undefined;
    if (previousProjectAgent && nextHandle && nextHandle !== previousProjectAgent.handle) {
      throw new Error("Cannot change project agent handle after promotion. Demote and re-promote to change the handle.");
    }

    const nextProjectAgent = projectAgent
      ? this.options.buildProjectAgentInfoForSession(
          descriptor,
          projectAgent.whenToUse,
          projectAgent.systemPrompt,
          projectAgent.handle ?? descriptor.projectAgent?.handle
        )
      : null;

    if (nextProjectAgent) {
      const onDiskCollision = await readProjectAgentRecord(this.options.dataDir, profileId, nextProjectAgent.handle);
      if (onDiskCollision && onDiskCollision.config.agentId !== descriptor.agentId) {
        throw new Error(getProjectAgentHandleCollisionError(nextProjectAgent.handle));
      }

      const persistedProjectAgentConfig: PersistedProjectAgentConfig = {
        version: 1,
        agentId: descriptor.agentId,
        handle: nextProjectAgent.handle,
        whenToUse: nextProjectAgent.whenToUse,
        ...(nextProjectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: nextProjectAgent.creatorSessionId }
          : {}),
        promotedAt: descriptor.createdAt,
        updatedAt: this.options.now()
      };
      await writeProjectAgentRecord(
        this.options.dataDir,
        profileId,
        persistedProjectAgentConfig,
        nextProjectAgent.systemPrompt ?? null
      );
    } else if (previousProjectAgent?.handle) {
      await deleteProjectAgentRecord(this.options.dataDir, profileId, previousProjectAgent.handle);
    }

    descriptor.projectAgent = nextProjectAgent ?? undefined;
    this.options.descriptors.set(agentId, descriptor);

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
    await this.options.notifyProjectAgentsChanged(profileId);

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
    const { descriptor, profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    const references = await listProjectAgentReferenceDocs(this.options.dataDir, profileId, handle);
    const record = await readProjectAgentRecord(this.options.dataDir, profileId, handle);
    if (record) {
      return { config: record.config, systemPrompt: record.systemPrompt, references };
    }

    return {
      config: {
        version: 1,
        agentId,
        handle,
        whenToUse: descriptor.projectAgent.whenToUse,
        ...(descriptor.projectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: descriptor.projectAgent.creatorSessionId }
          : {}),
        promotedAt: descriptor.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      systemPrompt: descriptor.projectAgent.systemPrompt ?? null,
      references
    };
  }

  async listProjectAgentReferences(agentId: string): Promise<string[]> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    return listProjectAgentReferenceDocs(this.options.dataDir, profileId, handle);
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    const content = await readProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName);
    if (content === null) {
      throw new Error(`Reference document ${fileName} does not exist`);
    }
    return content;
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string): Promise<void> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    await writeProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName, content);
  }

  async deleteProjectAgentReference(agentId: string, fileName: string): Promise<void> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    await deleteProjectAgentReferenceDoc(this.options.dataDir, profileId, handle, fileName);
  }

  private assertProjectAgentReferenceScope(agentId: string): {
    descriptor: AgentDescriptor & { projectAgent: NonNullable<AgentDescriptor["projectAgent"]> };
    profileId: string;
    handle: string;
  } {
    const descriptor = this.options.descriptors.get(agentId);
    const handle = descriptor?.projectAgent?.handle?.trim();
    if (!descriptor?.projectAgent || !handle) {
      throw new Error(`Agent ${agentId} is not a project agent`);
    }

    return {
      descriptor: descriptor as AgentDescriptor & { projectAgent: NonNullable<AgentDescriptor["projectAgent"]> },
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle
    };
  }
}
