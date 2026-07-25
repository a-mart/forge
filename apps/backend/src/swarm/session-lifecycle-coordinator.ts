import type { ManagerExactModelSelection } from "@forge/protocol";
import {
  ARCHIVED_PROJECT_OPERATION_MESSAGE,
  ARCHIVED_SESSION_OPERATION_MESSAGE,
  isProfileArchived,
  isSessionDirectlyArchived,
} from "./archive/archive-resolver.js";
import type {
  ArchiveLastUsedHydrationResult,
  ArchiveLastUsedHydrator,
} from "./archive/archive-last-used-hydrator.js";
import type {
  ArchiveProfileResult,
  ArchiveService,
  ArchiveSessionResult,
  RestoreProfileResult,
  RestoreSessionResult,
} from "./archive/archive-service.js";
import type { BrowserAutomationService } from "./browser-automation/browser-automation-service.js";
import type { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import type { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import {
  normalizeThinkingLevelForModelDescriptor,
  parseSwarmModelPreset,
  parseSwarmReasoningLevel,
  resolveModelDescriptorFromPreset,
} from "./model-presets.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type {
  SessionCreationBaseDescriptor,
  SessionCreationOptions,
} from "./session-descriptor-factory.js";
import type { SwarmAgentLifecycleService } from "./swarm-agent-lifecycle-service.js";
import {
  assertBuilderSession,
  assertCollabSession,
  cloneDescriptor,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
} from "./swarm-manager-utils.js";
import type { SwarmProjectAgentService } from "./swarm-project-agent-service.js";
import type { SwarmSessionService } from "./swarm-session-service.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ManagerProfile,
  SessionLifecycleEvent,
  SwarmModelPreset,
  SwarmReasoningLevel,
} from "./types.js";

export interface SessionCreationOverrides {
  model?: AgentModelDescriptor;
  cwd?: string;
  sessionSystemPrompt?: string;
  sessionSurface?: AgentDescriptor["sessionSurface"];
  collab?: AgentDescriptor["collab"];
}

export interface CreateSessionFromAgentInput {
  sessionName: string;
  cwd?: string;
  model?: unknown;
  reasoningLevel?: unknown;
  systemPrompt?: string;
  initialMessage?: string;
}

export interface CreateProjectAgentInput {
  sessionName: string;
  handle?: string;
  whenToUse: string;
  systemPrompt: string;
  capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
}

export interface TerminalArchiveHooks {
  suspendProfileTerminals(profileId: string): Promise<unknown>;
  restoreProfileTerminals(profileId: string): Promise<unknown>;
}

export interface SecureSessionLifecyclePort {
  beginLifecycleFence(
    profileId: string,
    sessionAgentIds: readonly string[],
  ): Promise<string>;
  cancelLifecycleFence(fenceId: string): Promise<void>;
  completeLifecycleFence(
    fenceId: string,
    outcome: "archived" | "deleted" | "updated",
  ): Promise<void>;
  clearLifecycleFenceForRestore(
    profileId: string,
    sessionAgentIds: readonly string[],
  ): Promise<void>;
  prepareSessionForDeletion(sessionAgentId: string): Promise<void>;
  deleteSessionStateAfterCoreDeletion(sessionAgentId: string): Promise<void>;
  stopForLifecycle(agentId: string, options?: { deleteState?: boolean }): Promise<void>;
  deleteProjectState(profileId: string): Promise<void>;
}

export interface SessionLifecycleCoordinatorOptions {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: ReadonlyMap<string, ManagerProfile>;
  sessions: Pick<
    SwarmSessionService,
    | "createSession"
    | "createSessionWithOverrides"
    | "createSessionFromBaseDescriptor"
    | "deleteSession"
    | "deleteCollaborationSession"
    | "clearSessionConversation"
    | "renameSession"
    | "forkSession"
  >;
  lifecycle: Pick<
    SwarmAgentLifecycleService,
    "stopSession" | "resumeSession" | "stopAllAgents" | "createManager" | "deleteManager"
  >;
  archive: Pick<
    ArchiveService,
    "archiveSession" | "restoreSession" | "archiveProfile" | "restoreProfile"
  >;
  archiveHydrator: Pick<ArchiveLastUsedHydrator, "hydrateArchivedRowsIfMissing">;
  projectAgents: Pick<SwarmProjectAgentService, "createAndPromoteProjectAgent">;
  capture: Pick<CaptureCascadeCoordinator, "run">;
  plans: Pick<SessionPlanCoordinator, "forget">;
  goals: Pick<
    SessionGoalCoordinator,
    "cancelScheduledContinuation" | "forget" | "scheduleContinuation"
  >;
  extensions: Pick<ForgeExtensionHost, "dispatchSessionLifecycle">;
  codex: {
    closeManagerScopesAndRetry(agentId: string): void;
  };
  activeTools: {
    clearSession(agentId: string): void;
  };
  browser: Pick<
    BrowserAutomationService,
    | "cancelSession"
    | "releaseSessionForLifecycle"
    | "recordFailedLifecycleRelease"
    | "archiveSession"
    | "restoreSession"
    | "deleteSession"
  >;
  secureSessions: SecureSessionLifecyclePort;
  events: {
    emitAgentsSnapshot(): void;
    emitProfilesSnapshot(): void;
    emitSessionLifecycle(event: SessionLifecycleEvent): void;
  };
  terminal: {
    getHooks(): TerminalArchiveHooks | undefined;
  };
  descriptorMutations: {
    patchDescriptor(agentId: string, patch: Partial<AgentDescriptor>): Promise<AgentDescriptor>;
  };
  runtime: {
    resolveAndValidateCwd(cwd: string): Promise<string>;
    beforeResumeSession(descriptor: AgentDescriptor & { role: "manager" }): Promise<void>;
    sendInitialMessage(
      creatorAgentId: string,
      targetAgentId: string,
      message: string,
    ): Promise<void>;
  };
  projectAgentAccess: {
    assertExternalCapability(
      agentId: string,
      capability: "create_session" | "create_project_agent",
    ): void;
    notifySharedTargetsChanged(agentId: string): Promise<void>;
  };
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/**
 * Application layer for session lifecycle use cases.
 *
 * Focused services continue to own persistence and their local invariants. This
 * coordinator owns only the cross-feature order: capture, Codex cleanup,
 * archive/delete/stop calls, plan and active-tool cleanup, terminal hooks,
 * snapshots, and extension notifications.
 */
export class SessionLifecycleCoordinator {
  constructor(private readonly options: SessionLifecycleCoordinatorOptions) {}

  async createSession(
    profileId: string,
    options?: SessionCreationOptions,
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const created = await this.options.sessions.createSession(profileId, options);
    await this.emitExtensionLifecycle("created", created.sessionAgent);
    return created;
  }

  async createSessionWithOverrides(
    profileId: string,
    options: SessionCreationOptions = {},
    overrides: SessionCreationOverrides = {},
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const created = await this.options.sessions.createSessionWithOverrides(
      profileId,
      options,
      overrides,
    );
    await this.emitExtensionLifecycle("created", created.sessionAgent);
    return created;
  }

  async createSessionFromBaseDescriptor(
    profileId: string,
    base: SessionCreationBaseDescriptor,
    options: SessionCreationOptions = {},
    overrides: Pick<SessionCreationOverrides, "sessionSurface" | "collab"> = {},
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const created = await this.options.sessions.createSessionFromBaseDescriptor(
      profileId,
      base,
      options,
      overrides,
    );
    await this.emitExtensionLifecycle("created", created.sessionAgent);
    return created;
  }

  async createSessionFromAgent(
    creatorAgentId: string,
    params: CreateSessionFromAgentInput,
  ): Promise<{ sessionAgentId: string; sessionLabel: string; profileId: string }> {
    this.options.projectAgentAccess.assertExternalCapability(creatorAgentId, "create_session");

    const creator = this.getRequiredSessionDescriptor(creatorAgentId);
    this.assertDescriptorNotEffectivelyArchived(creator);
    if (!creator.projectAgent?.capabilities?.includes("create_session")) {
      throw new Error("Session creation is not allowed for this project agent");
    }

    const profileId = creator.profileId ?? creator.agentId;
    const sessionName = params.sessionName.trim();
    if (!sessionName) {
      throw new Error("sessionName must be a non-empty string");
    }

    const model = this.resolveCreateSessionModel(creator, params);
    const cwd = params.cwd?.trim();
    const systemPrompt = params.systemPrompt?.trim();
    const created = await this.options.sessions.createSessionWithOverrides(
      profileId,
      { name: sessionName, label: sessionName, sessionPurpose: undefined },
      {
        ...(model ? { model } : {}),
        ...(cwd ? { cwd: await this.options.runtime.resolveAndValidateCwd(cwd) } : {}),
        ...(systemPrompt !== undefined ? { sessionSystemPrompt: systemPrompt } : {}),
      },
    );

    const targetAgentId = created.sessionAgent.agentId;
    const target = await this.options.descriptorMutations.patchDescriptor(targetAgentId, {
      creatorAgentId: creator.agentId,
    });
    this.options.events.emitAgentsSnapshot();
    this.options.events.emitProfilesSnapshot();

    const initialMessage = params.initialMessage?.trim();
    if (initialMessage) {
      try {
        await this.options.runtime.sendInitialMessage(
          creatorAgentId,
          targetAgentId,
          initialMessage,
        );
      } catch (error) {
        await this.rollbackFailedAgentCreatedSession(creatorAgentId, targetAgentId);
        throw error;
      }
    }

    await this.emitExtensionLifecycle("created", cloneDescriptor(target));
    return {
      sessionAgentId: targetAgentId,
      sessionLabel: target.sessionLabel ?? target.displayName,
      profileId,
    };
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: CreateProjectAgentInput,
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    this.options.projectAgentAccess.assertExternalCapability(
      creatorAgentId,
      "create_project_agent",
    );
    const created = await this.options.projectAgents.createAndPromoteProjectAgent(
      creatorAgentId,
      params,
    );
    await this.emitExtensionLifecycle(
      "created",
      cloneDescriptor(this.getRequiredSessionDescriptor(created.agentId)),
    );
    return created;
  }

  async archiveSession(agentId: string): Promise<ArchiveSessionResult> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    return await this.withSecureLifecycleFence(
      descriptor.profileId,
      [agentId],
      "archived",
      async () => {
        await this.options.secureSessions.stopForLifecycle(agentId);
        this.options.goals.cancelScheduledContinuation(agentId);
        this.options.browser.cancelSession(agentId);
        await this.options.browser.releaseSessionForLifecycle(
          descriptor.profileId,
          agentId,
          "archive",
        );
        await this.options.capture.run(agentId, "archive");
        this.cleanupCodex(agentId);
        const result = await this.options.archive.archiveSession(agentId);
        await this.options.browser.archiveSession(descriptor.profileId, agentId);
        this.options.activeTools.clearSession(agentId);
        this.options.events.emitAgentsSnapshot();
        return result;
      },
    );
  }

  async restoreSession(agentId: string): Promise<RestoreSessionResult> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const result = await this.options.archive.restoreSession(agentId);
    await this.options.secureSessions.clearLifecycleFenceForRestore(
      descriptor.profileId,
      [agentId],
    );
    await this.options.browser.restoreSession(descriptor.profileId, agentId);
    this.options.events.emitAgentsSnapshot();
    return result;
  }

  async hydrateArchivedLastUsed(): Promise<ArchiveLastUsedHydrationResult> {
    const result = await this.options.archiveHydrator.hydrateArchivedRowsIfMissing();
    if (result.hydratedSessionCount > 0) {
      this.options.events.emitAgentsSnapshot();
    }
    return result;
  }

  async archiveProfile(profileId: string): Promise<ArchiveProfileResult> {
    const sessions = this.getSessionsForProfile(profileId);
    const sessionAgentIds = sessions.map((session) => session.agentId);
    return await this.withSecureLifecycleFence(
      profileId,
      sessionAgentIds,
      "archived",
      async () => {
        for (const session of sessions) {
          await this.options.secureSessions.stopForLifecycle(session.agentId);
        }
        for (const session of sessions) {
          this.cleanupCodex(session.agentId);
          this.options.goals.cancelScheduledContinuation(session.agentId);
          this.options.browser.cancelSession(session.agentId);
        }
        for (const session of sessions) {
          await this.options.browser.releaseSessionForLifecycle(
            profileId,
            session.agentId,
            "archive",
          );
        }
        const result = await this.options.archive.archiveProfile(profileId);
        for (const session of sessions) {
          await this.options.browser.archiveSession(profileId, session.agentId);
          this.options.activeTools.clearSession(session.agentId);
        }
        await this.runTerminalHook("archive", profileId);
        this.options.events.emitProfilesSnapshot();
        this.options.events.emitAgentsSnapshot();
        this.options.events.emitSessionLifecycle({
          action: "archived",
          sessionAgentId: profileId,
          profileId,
        });
        return result;
      },
    );
  }

  async restoreProfile(profileId: string): Promise<RestoreProfileResult> {
    const result = await this.options.archive.restoreProfile(profileId);
    const sessions = this.getSessionsForProfile(profileId);
    await this.options.secureSessions.clearLifecycleFenceForRestore(
      profileId,
      sessions.map((session) => session.agentId),
    );
    for (const session of sessions) {
      await this.options.browser.restoreSession(profileId, session.agentId);
    }
    await this.runTerminalHook("restore", profileId);
    this.options.events.emitProfilesSnapshot();
    this.options.events.emitSessionLifecycle({
      action: "restored",
      sessionAgentId: profileId,
      profileId,
    });
    return result;
  }

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    this.getRequiredBuilderSessionDescriptor(agentId, "stop Builder sessions");
    return this.stopValidatedSession(agentId);
  }

  async stopCollaborationSession(
    agentId: string,
  ): Promise<{ terminatedWorkerIds: string[] }> {
    this.getRequiredCollaborationSessionDescriptor(agentId, "stop collaboration sessions");
    return this.stopValidatedSession(agentId);
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(
      agentId,
      "resume Builder sessions",
    );
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.options.runtime.beforeResumeSession(descriptor);
    await this.options.lifecycle.resumeSession(agentId);
    this.options.goals.scheduleContinuation(
      this.getRequiredBuilderSessionDescriptor(agentId, "resume Builder sessions"),
    );
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const requiredDescriptor = this.getRequiredBuilderSessionDescriptor(
      agentId,
      "delete Builder sessions",
    );
    const descriptor = cloneDescriptor(requiredDescriptor);
    return await this.withSecureLifecycleFence(
      requiredDescriptor.profileId,
      [agentId],
      "deleted",
      async () => {
        await this.options.secureSessions.prepareSessionForDeletion(agentId);
        this.cleanupCodex(agentId);
        this.options.goals.cancelScheduledContinuation(agentId);
        this.options.browser.cancelSession(agentId);
        await this.options.browser.releaseSessionForLifecycle(
          requiredDescriptor.profileId,
          agentId,
          "delete",
        );
        const result = await this.options.sessions.deleteSession(agentId);
        await this.cleanupSecureSessionStateAfterCoreDeletion(agentId);
        await this.options.browser.deleteSession(requiredDescriptor.profileId, agentId);
        this.options.plans.forget(agentId);
        this.options.goals.forget(agentId);
        this.options.activeTools.clearSession(agentId);
        await this.emitExtensionLifecycle("deleted", descriptor);
        return result;
      },
    );
  }

  async deleteCollaborationSession(
    agentId: string,
  ): Promise<{ terminatedWorkerIds: string[] }> {
    this.cleanupCodex(agentId);
    const requiredDescriptor = this.getRequiredCollaborationSessionDescriptor(
      agentId,
      "delete collaboration sessions",
    );
    const descriptor = cloneDescriptor(requiredDescriptor);
    this.options.browser.cancelSession(agentId);
    await this.options.browser.releaseSessionForLifecycle(requiredDescriptor.profileId, agentId, "delete");
    const result = await this.options.sessions.deleteCollaborationSession(agentId);
    await this.options.browser.deleteSession(requiredDescriptor.profileId, agentId);
    this.options.activeTools.clearSession(agentId);
    await this.emitExtensionLifecycle("deleted", descriptor);
    return result;
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(
      agentId,
      "clear Builder conversations",
    );
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.options.sessions.clearSessionConversation(agentId);
    this.options.activeTools.clearSession(agentId);
  }

  async renameSession(agentId: string, label: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(
      agentId,
      "rename Builder sessions",
    );
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const wasProjectAgent = Boolean(descriptor.projectAgent);
    await this.options.sessions.renameSession(agentId, label);
    if (wasProjectAgent) {
      await this.options.projectAgentAccess.notifySharedTargetsChanged(agentId);
    }
    await this.emitExtensionLifecycle(
      "renamed",
      cloneDescriptor(this.getRequiredSessionDescriptor(agentId)),
    );
  }

  async forkSession(
    sourceAgentId: string,
    options?: {
      label?: string;
      fromMessageId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
    },
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const source = cloneDescriptor(
      this.getRequiredBuilderSessionDescriptor(sourceAgentId, "fork Builder sessions"),
    );
    this.assertDescriptorNotEffectivelyArchived(source);
    const forked = await this.options.sessions.forkSession(sourceAgentId, options);
    await this.options.extensions.dispatchSessionLifecycle({
      action: "forked",
      sessionDescriptor: forked.sessionAgent,
      sourceDescriptor: source,
    });
    return forked;
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string,
  ): Promise<Awaited<ReturnType<SwarmAgentLifecycleService["stopAllAgents"]>>> {
    const descriptor = this.getRequiredSessionDescriptor(targetManagerId);
    await this.options.secureSessions.stopForLifecycle(targetManagerId);
    this.cleanupCodex(targetManagerId);
    this.options.goals.cancelScheduledContinuation(targetManagerId);
    this.options.browser.cancelSession(targetManagerId);
    await this.releaseBeforeStop(descriptor.profileId, targetManagerId);
    return await this.options.lifecycle.stopAllAgents(
      callerAgentId,
      targetManagerId,
    );
  }

  async createManager(
    callerAgentId: string,
    input: {
      name: string;
      cwd: string;
      model?: SwarmModelPreset;
      modelSelection?: ManagerExactModelSelection;
      reasoningLevel?: SwarmReasoningLevel;
    },
  ): Promise<AgentDescriptor> {
    const created = await this.options.lifecycle.createManager(callerAgentId, input);
    await this.emitExtensionLifecycle("created", created);
    return created;
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string,
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    const profile = this.options.profiles.get(targetManagerId);
    const sessions = profile ? this.getSessionsForProfile(profile.profileId) : [];
    if (sessions.length === 0) {
      const target = this.options.descriptors.get(targetManagerId);
      if (target?.role === "manager") {
        sessions.push(target);
      }
    }
    const profileId =
      profile?.profileId
      ?? sessions[0]?.profileId
      ?? targetManagerId;
    return await this.withSecureLifecycleFence(
      profileId,
      sessions.map((session) => session.agentId),
      "deleted",
      async () => {
        for (const session of sessions) {
          await this.options.secureSessions.prepareSessionForDeletion(
            session.agentId,
          );
        }
        for (const session of sessions) {
          this.cleanupCodex(session.agentId);
          this.options.goals.cancelScheduledContinuation(session.agentId);
          this.options.browser.cancelSession(session.agentId);
        }
        const deleted = sessions.map((session) => cloneDescriptor(session));
        for (const descriptor of deleted) {
          await this.options.browser.releaseSessionForLifecycle(
            descriptor.profileId ?? targetManagerId,
            descriptor.agentId,
            "delete",
          );
        }
        const result = await this.options.lifecycle.deleteManager(
          callerAgentId,
          targetManagerId,
        );
        for (const session of sessions) {
          await this.cleanupSecureSessionStateAfterCoreDeletion(session.agentId);
        }
        try {
          await this.options.secureSessions.deleteProjectState(profileId);
        } catch (error) {
          this.options.logDebug("secure_session:project_cleanup:deferred", {
            profileId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        for (const descriptor of deleted) {
          await this.options.browser.deleteSession(
            descriptor.profileId ?? targetManagerId,
            descriptor.agentId,
          );
          this.options.goals.forget(descriptor.agentId);
          await this.emitExtensionLifecycle("deleted", descriptor);
        }
        return result;
      },
    );
  }

  private async cleanupSecureSessionStateAfterCoreDeletion(
    sessionAgentId: string,
  ): Promise<void> {
    try {
      await this.options.secureSessions.deleteSessionStateAfterCoreDeletion(
        sessionAgentId,
      );
    } catch (error) {
      this.options.logDebug("secure_session:session_cleanup:deferred", {
        sessionAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async withSecureLifecycleFence<Result>(
    profileId: string,
    sessionAgentIds: readonly string[],
    outcome: "archived" | "deleted",
    action: () => Promise<Result>,
  ): Promise<Result> {
    const fenceId = await this.options.secureSessions.beginLifecycleFence(
      profileId,
      sessionAgentIds,
    );
    try {
      const result = await action();
      await this.options.secureSessions.completeLifecycleFence(fenceId, outcome);
      return result;
    } catch (error) {
      try {
        await this.options.secureSessions.cancelLifecycleFence(fenceId);
      } catch (cancelError) {
        this.options.logDebug("secure_session:lifecycle_fence_cancel:error", {
          profileId,
          sessionAgentIds,
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        });
      }
      throw error;
    }
  }

  private async stopValidatedSession(
    agentId: string,
  ): Promise<{ terminatedWorkerIds: string[] }> {
    await this.options.secureSessions.stopForLifecycle(agentId);
    this.cleanupCodex(agentId);
    this.options.goals.cancelScheduledContinuation(agentId);
    this.options.browser.cancelSession(agentId);
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    await this.releaseBeforeStop(descriptor.profileId, agentId);
    const result = await this.options.lifecycle.stopSession(agentId);
    this.options.activeTools.clearSession(agentId);
    return result;
  }

  private async releaseBeforeStop(profileId: string, agentId: string): Promise<void> {
    try {
      await this.options.browser.releaseSessionForLifecycle(profileId, agentId, "stop");
    } catch (error) {
      // Stop is the only lifecycle that may proceed after a bounded release
      // failure. Persist and publish the failure first; archive/delete and host
      // replacement remain fail closed.
      await this.options.browser.recordFailedLifecycleRelease(profileId, agentId, "stop", error);
    }
  }

  private async rollbackFailedAgentCreatedSession(
    creatorAgentId: string,
    targetAgentId: string,
  ): Promise<void> {
    try {
      await this.options.sessions.deleteSession(targetAgentId);
    } catch (rollbackError) {
      this.options.logDebug("createSessionFromAgent rollback failed", {
        creatorAgentId,
        targetAgentId,
        error:
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }

  private resolveCreateSessionModel(
    creator: AgentDescriptor,
    params: Pick<CreateSessionFromAgentInput, "model" | "reasoningLevel">,
  ): AgentModelDescriptor | undefined {
    const preset = parseSwarmModelPreset(params.model, "create_session.model");
    const reasoningLevel = parseSwarmReasoningLevel(
      params.reasoningLevel,
      "create_session.reasoningLevel",
    );
    if (!preset && !reasoningLevel && creator.modelOrigin !== "session_override") {
      return undefined;
    }

    const resolved = preset
      ? resolveModelDescriptorFromPreset(preset)
      : { ...creator.model };
    const normalized = {
      ...resolved,
      provider:
        normalizeOptionalAgentId(resolved.provider)?.toLowerCase() ?? resolved.provider,
      modelId:
        normalizeOptionalModelId(resolved.modelId)?.toLowerCase() ?? resolved.modelId,
    };
    return {
      ...normalized,
      thinkingLevel: normalizeThinkingLevelForModelDescriptor(normalized, reasoningLevel),
    };
  }

  private async runTerminalHook(
    action: "archive" | "restore",
    profileId: string,
  ): Promise<void> {
    try {
      const hooks = this.options.terminal.getHooks();
      if (action === "archive") {
        await hooks?.suspendProfileTerminals(profileId);
      } else {
        await hooks?.restoreProfileTerminals(profileId);
      }
    } catch (error) {
      const operation = action === "archive" ? "suspend" : "restore";
      this.options.logDebug(`archive:terminal_${operation}:error`, {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private cleanupCodex(agentId: string): void {
    this.options.codex.closeManagerScopesAndRetry(agentId);
  }

  private emitExtensionLifecycle(
    action: "created" | "deleted" | "renamed",
    sessionDescriptor: AgentDescriptor,
  ): Promise<void> {
    return this.options.extensions.dispatchSessionLifecycle({
      action,
      sessionDescriptor,
    });
  }

  private getRequiredSessionDescriptor(agentId: string): AgentDescriptor & {
    role: "manager";
    profileId: string;
  } {
    const descriptor = this.options.descriptors.get(agentId);
    if (
      !descriptor ||
      descriptor.role !== "manager" ||
      typeof descriptor.profileId !== "string" ||
      descriptor.profileId.trim().length === 0
    ) {
      throw new Error(`Unknown session agent: ${agentId}`);
    }
    return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
  }

  private getRequiredBuilderSessionDescriptor(
    agentId: string,
    action: string,
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, action);
    return descriptor;
  }

  private getRequiredCollaborationSessionDescriptor(
    agentId: string,
    action: string,
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertCollabSession(descriptor, action);
    return descriptor;
  }

  private getSessionsForProfile(profileId: string): AgentDescriptor[] {
    return Array.from(this.options.descriptors.values()).filter(
      (descriptor) =>
        descriptor.role === "manager" && descriptor.profileId === profileId,
    );
  }

  private assertProfileNotArchived(profileId: string): void {
    if (isProfileArchived(this.options.profiles.get(profileId))) {
      throw new Error(ARCHIVED_PROJECT_OPERATION_MESSAGE);
    }
  }

  private assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void {
    if (descriptor.role === "worker") {
      const manager = this.options.descriptors.get(descriptor.managerId);
      if (manager) {
        this.assertDescriptorNotEffectivelyArchived(manager);
      }
      return;
    }

    const profile = this.options.profiles.get(descriptor.profileId ?? descriptor.managerId);
    if (isProfileArchived(profile)) {
      throw new Error(ARCHIVED_PROJECT_OPERATION_MESSAGE);
    }
    if (isSessionDirectlyArchived(descriptor)) {
      throw new Error(ARCHIVED_SESSION_OPERATION_MESSAGE);
    }
  }
}
