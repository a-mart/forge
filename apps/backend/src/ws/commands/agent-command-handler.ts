import type { ClientCommand, ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface AgentCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handleAgentCommand(context: AgentCommandRouteContext): Promise<boolean> {
  const { command, socket, subscribedAgentId, swarmManager, resolveManagerContextAgentId, send } = context;

  if (command.type === "kill_agent") {
    const target = swarmManager.getAgent(command.agentId);
    if (!target) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${command.agentId} does not exist.`
      });
      return true;
    }

    if (target.role !== "worker") {
      send(socket, {
        type: "error",
        code: "KILL_AGENT_FAILED",
        message: "Manager cannot be killed"
      });
      return true;
    }

    try {
      await swarmManager.killAgent(target.managerId, target.agentId);
    } catch (error) {
      send(socket, {
        type: "error",
        code: "KILL_AGENT_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return true;
  }

  if (command.type === "stop_all_agents") {
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

    try {
      const stopped = await swarmManager.stopAllAgents(managerContextId, command.managerId);
      send(socket, {
        type: "stop_all_agents_result",
        managerId: stopped.managerId,
        stoppedWorkerIds: stopped.stoppedWorkerIds,
        managerStopped: stopped.managerStopped,
        // Backward compatibility for older clients still expecting terminated-oriented fields.
        terminatedWorkerIds: stopped.terminatedWorkerIds,
        managerTerminated: stopped.managerTerminated,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_ALL_AGENTS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "get_session_workers") {
    const manager = swarmManager.getAgent(command.sessionAgentId);
    if (!manager || manager.role !== "manager") {
      send(socket, {
        type: "error",
        code: "UNKNOWN_SESSION",
        message: `Unknown or non-manager session: ${command.sessionAgentId}`,
        requestId: command.requestId
      });
      return true;
    }

    send(socket, {
      type: "session_workers_snapshot",
      sessionAgentId: command.sessionAgentId,
      workers: swarmManager.listWorkersForSession(command.sessionAgentId),
      requestId: command.requestId
    });

    return true;
  }

  if (command.type === "list_directories") {
    try {
      const listed = await swarmManager.listDirectories(command.path);
      send(socket, {
        type: "directories_listed",
        path: listed.resolvedPath,
        directories: listed.directories.map((entry) => entry.path),
        requestId: command.requestId,
        requestedPath: listed.requestedPath,
        resolvedPath: listed.resolvedPath,
        roots: listed.roots,
        entries: listed.directories
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "LIST_DIRECTORIES_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "validate_directory") {
    try {
      const validation = await swarmManager.validateDirectory(command.path);
      send(socket, {
        type: "directory_validated",
        path: validation.requestedPath,
        valid: validation.valid,
        message: validation.message,
        requestId: command.requestId,
        requestedPath: validation.requestedPath,
        roots: validation.roots,
        resolvedPath: validation.resolvedPath
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "VALIDATE_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "pick_directory") {
    try {
      const pickedPath = await swarmManager.pickDirectory(command.defaultPath);
      send(socket, {
        type: "directory_picked",
        path: pickedPath,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "PICK_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}
