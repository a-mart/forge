import { isSystemProfile } from "@forge/protocol";
import type {
  CliCreateSessionCommand,
  CliRunCommand,
  CliSendMessageCommand,
  CliSessionMutationCommand,
  CliWsCommand,
  ServerEvent,
} from "@forge/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { AgentDescriptor, ConversationAttachment, RequestedDeliveryMode } from "../swarm/types.js";
import { sendWsEvent } from "./ws-send.js";
import { CliHeadlessSubscriptions } from "./cli-headless-subscriptions.js";

export class CliWsHandler {
  private readonly subscriptions: CliHeadlessSubscriptions;

  constructor(private readonly swarmManager: SwarmManager) {
    this.subscriptions = new CliHeadlessSubscriptions(
      swarmManager,
      (socket, event) => this.send(socket, event),
    );
  }

  attach(server: WebSocketServer): void {
    this.subscriptions.attach(server);

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => this.subscriptions.remove(socket));
      socket.on("error", () => this.subscriptions.remove(socket));
    });
  }

  reset(): void {
    this.subscriptions.clear();
  }

  broadcast(event: ServerEvent): void {
    this.subscriptions.broadcast(event);
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const command = parseCliCommand(raw);
    if (!command) {
      this.sendRequestError(socket, undefined, "bad_request", "Invalid CLI WebSocket command.", 400);
      return;
    }

    try {
      if (command.type === "subscribe_headless") {
        this.subscriptions.subscribe(socket, command);
        return;
      }

      if (command.type === "cli_create_session") {
        await this.handleCreateSession(socket, command);
        return;
      }

      if (command.type === "cli_send_message") {
        await this.handleSendMessage(socket, command);
        return;
      }

      if (command.type === "cli_run") {
        await this.handleRun(socket, command);
        return;
      }

      if (isCliSessionMutationCommand(command)) {
        await this.handleSessionMutation(socket, command);
        return;
      }

      this.sendRequestError(socket, command, "unsupported_command", `Unsupported CLI command: ${command.type}`, 400);
    } catch (error) {
      this.sendRequestError(
        socket,
        command,
        "command_failed",
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
  }

  private async handleCreateSession(socket: WebSocket, command: CliCreateSessionCommand): Promise<void> {
    const created = await this.swarmManager.createSession(command.profileId, {
      label: command.label,
      name: command.name,
      cli: command.cli,
    });

    this.sendRequestSuccess(socket, command, {
      session: created.sessionAgent,
      profile: created.profile,
      ...(created.sessionAgent.cli !== undefined ? { cli: created.sessionAgent.cli } : {}),
    });
  }

  private async handleSendMessage(socket: WebSocket, command: CliSendMessageCommand): Promise<void> {
    if (command.target.kind !== "session") {
      this.sendRequestError(
        socket,
        command,
        "unsupported_target",
        "Project-agent CLI send targets are not enabled yet.",
        400,
      );
      return;
    }

    const target = this.requireCliSession(command.target.agentId);
    await this.dispatchCliMessage(target.agentId, command.text, command.attachments, command.delivery);
    this.sendRequestSuccess(socket, command, {
      sessionAgentId: target.agentId,
      profileId: target.profileId,
      acceptedAt: new Date().toISOString(),
    });
  }

  private async handleRun(socket: WebSocket, command: CliRunCommand): Promise<void> {
    if (command.target.kind === "project_agent") {
      this.sendRequestError(
        socket,
        command,
        "unsupported_target",
        "Project-agent CLI run targets are not enabled yet.",
        400,
      );
      return;
    }

    const target = command.target.kind === "new_session"
      ? (await this.swarmManager.createSession(command.target.profileId, {
          label: command.target.label,
          name: command.target.name,
          cli: command.cli,
        })).sessionAgent
      : this.requireCliSession(command.target.agentId);

    await this.dispatchCliMessage(target.agentId, command.text, command.attachments, command.delivery);
    this.sendRequestSuccess(socket, command, {
      sessionAgentId: target.agentId,
      profileId: target.profileId,
      acceptedAt: new Date().toISOString(),
    });
  }

  private async handleSessionMutation(socket: WebSocket, command: CliSessionMutationCommand): Promise<void> {
    switch (command.type) {
      case "stop_session": {
        this.requireCliSession(command.agentId);
        const result = await this.swarmManager.stopSession(command.agentId);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId, ...result });
        return;
      }

      case "resume_session":
        this.requireCliSession(command.agentId);
        await this.swarmManager.resumeSession(command.agentId);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId });
        return;

      case "delete_session": {
        this.requireCliSession(command.agentId);
        const result = await this.swarmManager.deleteSession(command.agentId);
        this.subscriptions.remove(socket);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId, ...result });
        return;
      }

      case "clear_session":
        this.requireCliSession(command.agentId);
        await this.swarmManager.clearSessionConversation(command.agentId);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId });
        return;

      case "rename_session":
        this.requireCliSession(command.agentId);
        await this.swarmManager.renameSession(command.agentId, command.label);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId, label: command.label });
        return;

      case "pin_session": {
        this.requireCliSession(command.agentId);
        const result = await this.swarmManager.pinSession(command.agentId, command.pinned);
        this.sendRequestSuccess(socket, command, { agentId: command.agentId, pinned: command.pinned, ...result });
        return;
      }

      case "fork_session": {
        this.requireCliSession(command.sourceAgentId);
        const forked = await this.swarmManager.forkSession(command.sourceAgentId, {
          label: command.label,
          fromMessageId: command.fromMessageId,
        });
        this.sendRequestSuccess(socket, command, {
          sourceAgentId: command.sourceAgentId,
          session: forked.sessionAgent,
          profile: forked.profile,
          fromMessageId: command.fromMessageId,
        });
      }
    }
  }

  private async dispatchCliMessage(
    targetAgentId: string,
    text: string,
    attachments: ConversationAttachment[] | undefined,
    delivery: RequestedDeliveryMode | undefined,
  ): Promise<void> {
    await this.swarmManager.handleUserMessage(text, {
      targetAgentId,
      delivery,
      attachments,
      sourceContext: { channel: "cli" },
    });
  }

  private requireCliSession(agentId: string): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (!descriptor || descriptor.role !== "manager" || descriptor.sessionSurface === "collab") {
      throw new Error(`Unknown session agent: ${agentId}`);
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.swarmManager.listProfiles().find((candidate) => candidate.profileId === profileId);
    if (!profile || isSystemProfile(profile)) {
      throw new Error(`Unknown session agent: ${agentId}`);
    }

    return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
  }

  private sendRequestSuccess(socket: WebSocket, command: CliWsCommand & { requestId: string }, result?: unknown): void {
    this.send(socket, {
      type: "cli_request_success",
      requestId: command.requestId,
      commandType: command.type,
      ...(result !== undefined ? { result } : {}),
    });
  }

  private sendRequestError(
    socket: WebSocket,
    command: CliWsCommand | undefined,
    code: string,
    message: string,
    status?: number,
  ): void {
    this.send(socket, {
      type: "cli_request_error",
      ...(command?.requestId !== undefined ? { requestId: command.requestId } : {}),
      ...(command !== undefined ? { commandType: command.type } : {}),
      code,
      message,
      ...(status !== undefined ? { status } : {}),
    });
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    sendWsEvent({
      socket,
      event,
      onDropSocket: (dropped) => this.subscriptions.remove(dropped),
    });
  }
}

function parseCliCommand(raw: RawData): CliWsCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  return parsed as CliWsCommand;
}

function isCliSessionMutationCommand(command: CliWsCommand): command is CliSessionMutationCommand {
  return (
    command.type === "stop_session" ||
    command.type === "resume_session" ||
    command.type === "delete_session" ||
    command.type === "clear_session" ||
    command.type === "rename_session" ||
    command.type === "pin_session" ||
    command.type === "fork_session"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
