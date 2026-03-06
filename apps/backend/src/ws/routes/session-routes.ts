import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

interface SessionMemoryMergeCapable {
  mergeSessionMemory(agentId: string): Promise<void>;
}

export interface SessionCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
}

export async function handleSessionCommand(context: SessionCommandRouteContext): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    resolveManagerContextAgentId,
    send,
    handleDeletedAgentSubscriptions
  } = context;

  if (
    command.type !== "create_session" &&
    command.type !== "stop_session" &&
    command.type !== "resume_session" &&
    command.type !== "delete_session" &&
    command.type !== "rename_session" &&
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
      requestId: command.requestId
    });
    return true;
  }

  if (command.type === "create_session") {
    try {
      const created = await swarmManager.createSession(command.profileId, {
        label: command.label,
        name: command.name
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

  if (command.type === "delete_session") {
    const profileId = resolveSessionProfileId(swarmManager, command.agentId);

    try {
      const { terminatedWorkerIds } = await swarmManager.deleteSession(command.agentId);
      handleDeletedAgentSubscriptions(new Set([command.agentId, ...terminatedWorkerIds]));

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

  if (command.type === "rename_session") {
    try {
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

  if (command.type === "fork_session") {
    try {
      const forked = await swarmManager.forkSession(command.sourceAgentId, {
        label: command.label
      });

      send(socket, {
        type: "session_forked",
        sourceAgentId: command.sourceAgentId,
        newSessionAgent: forked.sessionAgent,
        profile: forked.profile,
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
    const mergeCapable = swarmManager as unknown as Partial<SessionMemoryMergeCapable>;
    if (typeof mergeCapable.mergeSessionMemory !== "function") {
      throw new Error("Session memory merge is not available.");
    }

    await mergeCapable.mergeSessionMemory.call(swarmManager, command.agentId);

    const descriptor = swarmManager.getAgent(command.agentId);
    send(socket, {
      type: "session_memory_merged",
      agentId: command.agentId,
      mergedAt: descriptor?.mergedAt ?? new Date().toISOString(),
      requestId: command.requestId
    });
  } catch (error) {
    send(socket, {
      type: "session_memory_merge_failed",
      agentId: command.agentId,
      message: error instanceof Error ? error.message : String(error),
      requestId: command.requestId
    });
  }

  return true;
}

function resolveSessionProfileId(swarmManager: SwarmManager, sessionAgentId: string): string {
  const descriptor = swarmManager.getAgent(sessionAgentId);
  if (!descriptor || descriptor.role !== "manager") {
    return sessionAgentId;
  }

  return descriptor.profileId ?? descriptor.agentId;
}
