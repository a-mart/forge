import { MANAGER_MODEL_PRESETS, type ClientCommand, type ManagerModelPreset, type ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { UnreadTracker } from "../../swarm/unread-tracker.js";
import type { SwarmModelPreset, SwarmReasoningLevel } from "../../swarm/types.js";

export interface ManagerCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
  broadcastToSubscribed: (event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
  unreadTracker?: UnreadTracker;
}

export async function handleManagerCommand(context: ManagerCommandRouteContext): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    resolveManagerContextAgentId,
    send,
    broadcastToSubscribed,
    handleDeletedAgentSubscriptions,
    unreadTracker
  } = context;

  if (command.type === "create_manager") {
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
      const manager = await swarmManager.createManager(managerContextId, {
        name: command.name,
        cwd: command.cwd,
        model: command.model
      });

      broadcastToSubscribed({
        type: "manager_created",
        manager,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CREATE_MANAGER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "delete_manager") {
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
      const deleted = await swarmManager.deleteManager(managerContextId, command.managerId);
      handleDeletedAgentSubscriptions(new Set([deleted.managerId, ...deleted.terminatedWorkerIds]));
      unreadTracker?.clearProfile(deleted.managerId);

      broadcastToSubscribed({
        type: "manager_deleted",
        managerId: deleted.managerId,
        terminatedWorkerIds: deleted.terminatedWorkerIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "DELETE_MANAGER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "update_manager_model") {
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
      if (!MANAGER_MODEL_PRESETS.includes(command.model)) {
        throw new Error(`Invalid model preset: ${command.model}`);
      }

      await swarmManager.updateManagerModel(
        command.managerId,
        command.model as SwarmModelPreset,
        command.reasoningLevel as SwarmReasoningLevel | undefined
      );

      broadcastToSubscribed({
        type: "manager_model_updated",
        managerId: command.managerId,
        model: command.model,
        reasoningLevel: command.reasoningLevel,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_MANAGER_MODEL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "rename_profile") {
    try {
      await swarmManager.renameProfile(command.profileId, command.displayName);

      broadcastToSubscribed({
        type: "profile_renamed",
        profileId: command.profileId,
        displayName: command.displayName.trim(),
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RENAME_PROFILE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "reorder_profiles") {
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
      await swarmManager.reorderProfiles(command.profileIds);
    } catch (error) {
      send(socket, {
        type: "error",
        code: "REORDER_PROFILES_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}
