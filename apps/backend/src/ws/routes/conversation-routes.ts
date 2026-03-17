import type { ClientCommand, ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface ConversationCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  allowNonManagerSubscriptions: boolean;
  send: (socket: WebSocket, event: ServerEvent) => void;
  logDebug: (message: string, details?: unknown) => void;
  resolveConfiguredManagerId: () => string | undefined;
}

export async function handleConversationCommand(context: ConversationCommandRouteContext): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    allowNonManagerSubscriptions,
    send,
    logDebug,
    resolveConfiguredManagerId
  } = context;

  if (command.type !== "user_message") {
    return false;
  }

  const managerId = resolveConfiguredManagerId();
  const targetAgentId = command.agentId ?? subscribedAgentId;

  logDebug("user_message:received", {
    subscribedAgentId,
    targetAgentId,
    managerId,
    requestedDelivery: command.delivery ?? "auto",
    textPreview: previewForLog(command.text),
    attachmentCount: command.attachments?.length ?? 0
  });

  if (!allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
    logDebug("user_message:rejected:subscription_not_supported", {
      targetAgentId,
      managerId
    });
    send(socket, {
      type: "error",
      code: "SUBSCRIPTION_NOT_SUPPORTED",
      message: `Messages are currently limited to ${managerId}.`
    });
    return true;
  }

  const targetDescriptor = swarmManager.getAgent(targetAgentId);
  if (!targetDescriptor) {
    logDebug("user_message:rejected:unknown_agent", {
      targetAgentId
    });
    send(socket, {
      type: "error",
      code: "UNKNOWN_AGENT",
      message: `Agent ${targetAgentId} does not exist.`
    });
    return true;
  }

  try {
    if (targetDescriptor.role === "manager" && command.text.trim() === "/new") {
      logDebug("user_message:manager_reset", {
        targetAgentId: targetDescriptor.agentId
      });
      await swarmManager.resetManagerSession(targetDescriptor.agentId, "user_new_command");
      return true;
    }

    logDebug("user_message:dispatch:start", {
      targetAgentId,
      targetRole: targetDescriptor.role,
      persistedAttachmentCount: command.attachments?.length ?? 0
    });

    await swarmManager.handleUserMessage(command.text, {
      targetAgentId,
      delivery: command.delivery,
      attachments: command.attachments,
      sourceContext: { channel: "web" }
    });

    logDebug("user_message:dispatch:complete", {
      targetAgentId,
      targetRole: targetDescriptor.role
    });
  } catch (error) {
    logDebug("user_message:dispatch:error", {
      targetAgentId,
      targetRole: targetDescriptor.role,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    send(socket, {
      type: "error",
      code: "USER_MESSAGE_FAILED",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return true;
}

function previewForLog(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}
