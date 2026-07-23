import type {
  ClientCommand,
  ServerEvent,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeStrategy
} from "@forge/protocol";
import type { WebSocket } from "ws";
import { ArchiveOperationError } from "../../swarm/archive/archive-service.js";
import { inferSwarmModelPresetFromDescriptor, parseSwarmModelPreset } from "../../swarm/model-presets.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  requireNonSystemProfile,
  requireNonSystemSessionProfile,
  resolveProfileIdForSessionAgent,
} from "../../swarm/system-profile-guards.js";
import type { UnreadTracker } from "../../swarm/unread-tracker.js";

export interface SessionCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
  unreadTracker?: UnreadTracker;
  broadcastUnreadCountUpdate?: (sessionAgentId: string, count: number) => void;
  supportsGoalControlRequestId?: boolean;
}

export async function handleSessionCommand(context: SessionCommandRouteContext): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    resolveManagerContextAgentId,
    send,
    handleDeletedAgentSubscriptions,
    unreadTracker,
    broadcastUnreadCountUpdate,
    supportsGoalControlRequestId = false,
  } = context;

  if (
    command.type !== "create_session" &&
    command.type !== "stop_session" &&
    command.type !== "resume_session" &&
    command.type !== "archive_session" &&
    command.type !== "restore_session" &&
    command.type !== "delete_session" &&
    command.type !== "clear_session" &&
    command.type !== "session_goal_control" &&
    command.type !== "rename_session" &&
    command.type !== "pin_session" &&
    command.type !== "update_session_model" &&
    command.type !== "set_session_project_agent" &&
    command.type !== "get_project_agent_config" &&
    command.type !== "list_project_agent_references" &&
    command.type !== "get_project_agent_reference" &&
    command.type !== "set_project_agent_reference" &&
    command.type !== "delete_project_agent_reference" &&
    command.type !== "request_project_agent_recommendations" &&
    command.type !== "get_project_agent_sharing" &&
    command.type !== "set_project_agent_sharing" &&
    command.type !== "get_project_agent_external_directory" &&
    command.type !== "fork_session" &&
    command.type !== "merge_session_memory"
  ) {
    return false;
  }

  const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
  if (!managerContextId) {
    send(socket, {
      type: "error",
      code: "UNKNOWN_AGENT",
      message: `Agent ${subscribedAgentId} does not exist.`,
      requestId: command.type === "session_goal_control" && !supportsGoalControlRequestId
        ? undefined
        : "requestId" in command ? command.requestId : undefined
    });
    return true;
  }

  if (command.type === "create_session") {
    try {
      requireNonSystemProfile(command.profileId, swarmManager.listProfiles());

      const created = await swarmManager.createSession(command.profileId, {
        label: command.label,
        name: command.name,
        sessionPurpose: command.sessionPurpose
      });

      send(socket, {
        type: "session_created",
        profile: created.profile,
        sessionAgent: created.sessionAgent,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CREATE_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "stop_session") {
    try {
      // Check if target is a worker agent (supports stop/resume for workers too)
      const targetAgent = swarmManager.getAgent(command.agentId);
      if (targetAgent?.role === "worker") {
        await swarmManager.stopWorker(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, targetAgent.managerId);

        send(socket, {
          type: "session_stopped",
          agentId: command.agentId,
          profileId,
          terminatedWorkerIds: [],
          requestId: command.requestId
        });
      } else {
        const { terminatedWorkerIds } = await swarmManager.stopSession(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, command.agentId);
        if (terminatedWorkerIds.length > 0) {
          handleDeletedAgentSubscriptions(new Set(terminatedWorkerIds));
        }

        send(socket, {
          type: "session_stopped",
          agentId: command.agentId,
          profileId,
          terminatedWorkerIds,
          requestId: command.requestId
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "resume_session") {
    try {
      // Check if target is a worker agent (supports stop/resume for workers too)
      const targetAgent = swarmManager.getAgent(command.agentId);
      if (targetAgent?.role === "worker") {
        await swarmManager.resumeWorker(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, targetAgent.managerId);

        send(socket, {
          type: "session_resumed",
          agentId: command.agentId,
          profileId,
          requestId: command.requestId
        });
      } else {
        await swarmManager.resumeSession(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, command.agentId);

        send(socket, {
          type: "session_resumed",
          agentId: command.agentId,
          profileId,
          requestId: command.requestId
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RESUME_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "archive_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      const result = await swarmManager.archiveSession(command.agentId);
      if (result.terminatedWorkerIds.length > 0) {
        handleDeletedAgentSubscriptions(new Set(result.terminatedWorkerIds));
      }
      send(socket, {
        type: "session_archived",
        agentId: result.agentId,
        profileId: result.profileId,
        archivedAt: result.archivedAt,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: archiveErrorCode(error, "ARCHIVE_SESSION_FAILED"),
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "restore_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      const result = await swarmManager.restoreSession(command.agentId);
      send(socket, {
        type: "session_restored",
        agentId: result.agentId,
        profileId: result.profileId,
        openAgentId: result.openAgentId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: archiveErrorCode(error, "RESTORE_SESSION_FAILED"),
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "delete_session") {
    const profileId = resolveSessionProfileId(swarmManager, command.agentId);

    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));

      const { terminatedWorkerIds } = await swarmManager.deleteSession(command.agentId);
      handleDeletedAgentSubscriptions(new Set([command.agentId, ...terminatedWorkerIds]));
      unreadTracker?.clearSession(profileId, command.agentId);
      broadcastUnreadCountUpdate?.(command.agentId, 0);

      send(socket, {
        type: "session_deleted",
        agentId: command.agentId,
        profileId,
        terminatedWorkerIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "DELETE_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "clear_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      await swarmManager.clearSessionConversation(command.agentId);
      const profileId = resolveSessionProfileId(swarmManager, command.agentId);
      unreadTracker?.clearSession(profileId, command.agentId);
      broadcastUnreadCountUpdate?.(command.agentId, 0);

      send(socket, {
        type: "session_cleared",
        agentId: command.agentId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CLEAR_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "session_goal_control") {
    const responseRequestId = supportsGoalControlRequestId ? command.requestId : undefined;
    try {
      requireNonSystemSessionProfile(
        command.agentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );
      // Capture the origin-scoped response context before control yields. Subscription and
      // capability state may change on this socket while the domain operation is in flight.
      const responseContext = responseRequestId === undefined
        ? undefined
        : {
            socket,
            requestId: responseRequestId,
            sessionAgentId: command.agentId,
            profileId: resolveSessionProfileId(swarmManager, command.agentId),
          };
      const snapshot = await swarmManager.controlSessionGoal(command.agentId, command);
      if (responseContext) {
        send(responseContext.socket, {
          type: "session_goal_snapshot",
          sessionAgentId: responseContext.sessionAgentId,
          profileId: responseContext.profileId,
          ...snapshot,
          requestId: responseContext.requestId,
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "SESSION_GOAL_CONTROL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }
    return true;
  }

  if (command.type === "rename_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      await swarmManager.renameSession(command.agentId, command.label);

      send(socket, {
        type: "session_renamed",
        agentId: command.agentId,
        label: command.label,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RENAME_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "pin_session") {
    try {
      requireNonSystemSessionProfile(
        command.agentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const result = await swarmManager.pinSession(command.agentId, command.pinned);

      send(socket, {
        type: "session_pinned",
        agentId: command.agentId,
        pinned: command.pinned,
        pinnedAt: result.pinnedAt,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "PIN_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "update_session_model") {
    try {
      requireNonSystemSessionProfile(
        command.sessionAgentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const canonicalPreset = command.mode === "override" && !command.modelSelection
        ? parseSwarmModelPreset(command.model, "update_session_model.model")
        : undefined;
      const eventModel = command.mode === "inherit"
        ? undefined
        : command.modelSelection
          ? inferEventModelPreset(
              await swarmManager.updateSessionExactModel(
                command.sessionAgentId,
                command.modelSelection,
                command.reasoningLevel,
              )
            )
          : canonicalPreset;

      if (command.mode === "override" && !command.modelSelection) {
        await swarmManager.updateSessionModel(
          command.sessionAgentId,
          command.mode,
          canonicalPreset,
          command.reasoningLevel,
        );
      }

      if (command.mode === "inherit") {
        await swarmManager.updateSessionModel(
          command.sessionAgentId,
          command.mode,
          undefined,
          undefined,
        );
      }

      send(socket, {
        type: "session_model_updated",
        sessionAgentId: command.sessionAgentId,
        mode: command.mode,
        model: eventModel,
        reasoningLevel: command.reasoningLevel,
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_SESSION_MODEL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  if (command.type === "set_session_project_agent") {
    try {
      const result = await swarmManager.setSessionProjectAgent(
        command.agentId,
        command.projectAgent
          ? {
              whenToUse: command.projectAgent.whenToUse,
              ...(command.projectAgent.systemPrompt !== undefined
                ? { systemPrompt: command.projectAgent.systemPrompt }
                : {}),
              ...(command.projectAgent.handle !== undefined
                ? { handle: command.projectAgent.handle }
                : {}),
              ...(command.projectAgent.capabilities !== undefined
                ? { capabilities: command.projectAgent.capabilities }
                : {})
            }
          : null
      );

      send(socket, {
        type: "session_project_agent_updated",
        agentId: command.agentId,
        profileId: result.profileId,
        projectAgent: result.projectAgent,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "SET_SESSION_PROJECT_AGENT_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "get_project_agent_config") {
    try {
      const result = await swarmManager.getProjectAgentConfig(command.agentId);
      send(socket, {
        type: "project_agent_config",
        agentId: command.agentId,
        config: result.config,
        systemPrompt: result.systemPrompt,
        references: result.references,
        ...(result.source ? { source: result.source } : {}),
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "NOT_A_PROJECT_AGENT",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "list_project_agent_references") {
    try {
      const references = await swarmManager.listProjectAgentReferences(command.agentId);
      send(socket, {
        type: "project_agent_references",
        agentId: command.agentId,
        references,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "LIST_PROJECT_AGENT_REFERENCES_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "get_project_agent_reference") {
    try {
      const content = await swarmManager.getProjectAgentReference(command.agentId, command.fileName);
      send(socket, {
        type: "project_agent_reference",
        agentId: command.agentId,
        fileName: command.fileName,
        content,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_PROJECT_AGENT_REFERENCE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "set_project_agent_reference") {
    try {
      await swarmManager.setProjectAgentReference(command.agentId, command.fileName, command.content);
      send(socket, {
        type: "project_agent_reference_saved",
        agentId: command.agentId,
        fileName: command.fileName,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "SET_PROJECT_AGENT_REFERENCE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "delete_project_agent_reference") {
    try {
      await swarmManager.deleteProjectAgentReference(command.agentId, command.fileName);
      send(socket, {
        type: "project_agent_reference_deleted",
        agentId: command.agentId,
        fileName: command.fileName,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "DELETE_PROJECT_AGENT_REFERENCE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "request_project_agent_recommendations") {
    void swarmManager
      .requestProjectAgentRecommendations(command.agentId)
      .then((recommendations) => {
        send(socket, {
          type: "project_agent_recommendations",
          agentId: command.agentId,
          whenToUse: recommendations.whenToUse,
          systemPrompt: recommendations.systemPrompt,
          requestId: command.requestId
        });
      })
      .catch((error) => {
        send(socket, {
          type: "project_agent_recommendations_error",
          agentId: command.agentId,
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      });

    return true;
  }

  if (command.type === "get_project_agent_sharing") {
    try {
      const snapshot = await swarmManager.getProjectAgentSharing(command.agentId);
      send(socket, {
        type: "project_agent_sharing",
        agentId: snapshot.agentId,
        grants: snapshot.grants,
        eligibleTargets: snapshot.eligibleTargets,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_PROJECT_AGENT_SHARING_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "set_project_agent_sharing") {
    try {
      const result = await swarmManager.setProjectAgentSharing(command.agentId, command.targetProfileIds);
      send(socket, {
        type: "project_agent_sharing_updated",
        agentId: result.snapshot.agentId,
        grants: result.snapshot.grants,
        eligibleTargets: result.snapshot.eligibleTargets,
        addedTargetProfileIds: result.addedTargetProfileIds,
        removedTargetProfileIds: result.removedTargetProfileIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "SET_PROJECT_AGENT_SHARING_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "get_project_agent_external_directory") {
    try {
      const profileId = resolveProfileIdForSessionAgent(managerContextId, (agentId) =>
        swarmManager.getAgent(agentId),
      );
      const entries = await swarmManager.getProjectAgentExternalDirectory(profileId);
      send(socket, {
        type: "project_agent_external_directory",
        profileId,
        entries,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_PROJECT_AGENT_EXTERNAL_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "fork_session") {
    try {
      requireNonSystemSessionProfile(
        command.sourceAgentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const forked = await swarmManager.forkSession(command.sourceAgentId, {
        label: command.label,
        fromMessageId: command.fromMessageId
      });

      send(socket, {
        type: "session_forked",
        sourceAgentId: command.sourceAgentId,
        newSessionAgent: forked.sessionAgent,
        profile: forked.profile,
        fromMessageId: command.fromMessageId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "FORK_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  send(socket, {
    type: "session_memory_merge_started",
    agentId: command.agentId,
    requestId: command.requestId
  });

  try {
    const result = await swarmManager.mergeSessionMemory(command.agentId);

    send(socket, {
      type: "session_memory_merged",
      ...result,
      requestId: command.requestId
    });
  } catch (error) {
    const diagnostics = getSessionMemoryMergeFailureDiagnostics(error);
    send(socket, {
      type: "session_memory_merge_failed",
      agentId: command.agentId,
      message: error instanceof Error ? error.message : String(error),
      status: "failed",
      ...(diagnostics.strategy ? { strategy: diagnostics.strategy } : {}),
      ...(diagnostics.stage ? { stage: diagnostics.stage } : {}),
      ...(diagnostics.auditPath ? { auditPath: diagnostics.auditPath } : {}),
      requestId: command.requestId
    });
  }

  return true;
}

function getSessionMemoryMergeFailureDiagnostics(error: unknown): {
  strategy?: SessionMemoryMergeStrategy;
  stage?: SessionMemoryMergeFailureStage;
  auditPath?: string;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const diagnostics = error as {
    strategy?: unknown;
    stage?: unknown;
    auditPath?: unknown;
  };

  return {
    strategy:
      typeof diagnostics.strategy === "string"
        ? (diagnostics.strategy as SessionMemoryMergeStrategy)
        : undefined,
    stage:
      typeof diagnostics.stage === "string"
        ? (diagnostics.stage as SessionMemoryMergeFailureStage)
        : undefined,
    auditPath: typeof diagnostics.auditPath === "string" ? diagnostics.auditPath : undefined
  };
}

function archiveErrorCode(error: unknown, fallback: string): string {
  return error instanceof ArchiveOperationError ? error.code : fallback;
}

function resolveSessionProfileId(swarmManager: SwarmManager, sessionAgentId: string): string {
  return resolveProfileIdForSessionAgent(sessionAgentId, (agentId) => swarmManager.getAgent(agentId));
}

function inferEventModelPreset(descriptor: { provider: string; modelId: string }): string {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor);
  if (!preset) {
    throw new Error(`Could not infer manager model preset for ${descriptor.provider}/${descriptor.modelId}`);
  }

  return preset;
}
