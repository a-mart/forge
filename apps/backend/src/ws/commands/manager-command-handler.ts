import { MANAGER_MODEL_PRESETS, type ClientCommand, type ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  filterSystemProfileIds,
  requireNonSystemProfile,
  requireNonSystemSessionProfile,
} from "../../swarm/system-profile-guards.js";
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
      requireNonSystemProfile(command.managerId, swarmManager.listProfiles());

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

  if (command.type === "update_profile_default_model") {
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
      requireNonSystemProfile(command.profileId, swarmManager.listProfiles());

      if (!MANAGER_MODEL_PRESETS.includes(command.model)) {
        throw new Error(`Invalid model preset: ${command.model}`);
      }

      await swarmManager.updateProfileDefaultModel(
        command.profileId,
        command.model as SwarmModelPreset,
        command.reasoningLevel as SwarmReasoningLevel | undefined
      );

      broadcastToSubscribed({
        type: "profile_default_model_updated",
        profileId: command.profileId,
        model: command.model,
        reasoningLevel: command.reasoningLevel,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_PROFILE_DEFAULT_MODEL_FAILED",
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
      if (swarmManager.getAgent(command.managerId)?.role === "manager") {
        requireNonSystemSessionProfile(command.managerId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      } else {
        requireNonSystemProfile(command.managerId, swarmManager.listProfiles());
      }

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

  if (command.type === "update_manager_cwd") {
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
      requireNonSystemProfile(command.managerId, swarmManager.listProfiles());

      const resolvedCwd = await swarmManager.updateManagerCwd(
        command.managerId,
        command.cwd
      );

      broadcastToSubscribed({
        type: "manager_cwd_updated",
        managerId: command.managerId,
        cwd: resolvedCwd,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_MANAGER_CWD_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "rename_profile") {
    try {
      requireNonSystemProfile(command.profileId, swarmManager.listProfiles());
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
      await swarmManager.reorderProfiles(
        filterSystemProfileIds(command.profileIds, swarmManager.listProfiles()),
      );
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
