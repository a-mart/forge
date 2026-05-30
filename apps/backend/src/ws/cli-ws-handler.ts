import { isChoiceAnswer, isSystemProfile, validateChoiceAnswers } from "@forge/protocol";
import type {
  ChoiceQuestion,
  CliChoiceCancelCommand,
  CliChoiceResponseCommand,
  CliCreateSessionCommand,
  CliFieldError,
  CliRunCommand,
  CliSendMessageCommand,
  CliSessionMutationCommand,
  CliWsCommand,
  MessageSourceContext,
  ServerEvent,
} from "@forge/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { requireNonSystemProfile } from "../swarm/system-profile-guards.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { AgentDescriptor, ConversationAttachment, RequestedDeliveryMode } from "../swarm/types.js";
import { sendWsEvent } from "./ws-send.js";
import { CliHeadlessSubscriptions } from "./cli-headless-subscriptions.js";
import { getCliChoiceOwner } from "./cli-choice-owners.js";
import { toPublicCliAgentDescriptor } from "./cli-public-descriptors.js";

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
    const parsed = parseCliCommand(raw);
    if (!parsed.ok) {
      this.sendRequestError(
        socket,
        parsed.context,
        "bad_request",
        "Invalid CLI WebSocket command.",
        400,
        parsed.fieldErrors,
      );
      return;
    }

    const command = parsed.command;

    try {
      if (command.type === "subscribe_headless") {
        await this.subscriptions.subscribe(socket, command);
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

      if (command.type === "cli_choice_response") {
        this.handleChoiceResponse(socket, command);
        return;
      }

      if (command.type === "cli_choice_cancel") {
        this.handleChoiceCancel(socket, command);
        return;
      }

      if (isCliSessionMutationCommand(command)) {
        await this.handleSessionMutation(socket, command);
        return;
      }

      this.sendRequestError(socket, command, "unsupported_command", "Unsupported CLI command.", 400);
    } catch (error) {
      if (error instanceof CliCommandError) {
        this.sendRequestError(socket, command, error.code, error.message, error.status, error.fieldErrors);
        return;
      }

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
    this.requireCliWritableProfile(command.profileId);

    const created = await this.swarmManager.createSession(command.profileId, {
      label: command.label,
      name: command.name,
      cli: command.cli,
    });

    this.sendRequestSuccess(socket, command, {
      session: toPublicCliAgentDescriptor(created.sessionAgent),
      profile: created.profile,
      ...(created.sessionAgent.cli !== undefined ? { cli: created.sessionAgent.cli } : {}),
    });
  }

  private async handleSendMessage(socket: WebSocket, command: CliSendMessageCommand): Promise<void> {
    const target = command.target.kind === "project_agent"
      ? this.requireCliProjectAgentSession(command.target.profileId, command.target.handle)
      : this.requireCliSession(command.target.agentId);
    const sourceContext = buildCliSourceContext(command);
    await this.dispatchCliMessage(target.agentId, command.text, command.attachments, command.delivery, sourceContext);
    this.sendRequestSuccess(socket, command, {
      sessionAgentId: target.agentId,
      profileId: target.profileId,
      messageId: sourceContext.messageId,
      sourceContext,
      acceptedAt: new Date().toISOString(),
    });
  }

  private async handleRun(socket: WebSocket, command: CliRunCommand): Promise<void> {
    const target = command.target.kind === "new_session"
      ? await this.createCliRunSession(command)
      : command.target.kind === "project_agent"
        ? this.requireCliProjectAgentSession(command.target.profileId, command.target.handle)
        : this.requireCliSession(command.target.agentId);

    const sourceContext = buildCliSourceContext(command);
    await this.dispatchCliMessage(target.agentId, command.text, command.attachments, command.delivery, sourceContext);
    this.sendRequestSuccess(socket, command, {
      sessionAgentId: target.agentId,
      profileId: target.profileId,
      messageId: sourceContext.messageId,
      sourceContext,
      acceptedAt: new Date().toISOString(),
    });
  }

  private handleChoiceResponse(socket: WebSocket, command: CliChoiceResponseCommand): void {
    const pending = this.requireCliPendingChoice(command.choiceId, command.sessionAgentId);
    const validationError = validateChoiceAnswers(pending.questions, command.answers);
    if (validationError) {
      throw new CliCommandError(
        "choice_invalid_response",
        `Invalid choice response: ${validationError}`,
        400,
        [{ field: "answers", message: validationError }],
      );
    }

    this.swarmManager.resolveChoiceRequest(command.choiceId, command.answers);
    this.sendRequestSuccess(socket, command, {
      choiceId: command.choiceId,
      sessionAgentId: pending.sessionAgentId,
      status: "answered",
    });
  }

  private handleChoiceCancel(socket: WebSocket, command: CliChoiceCancelCommand): void {
    const pending = this.requireCliPendingChoice(command.choiceId, command.sessionAgentId);
    this.swarmManager.cancelChoiceRequest(command.choiceId, "cancelled");
    this.sendRequestSuccess(socket, command, {
      choiceId: command.choiceId,
      sessionAgentId: pending.sessionAgentId,
      status: "cancelled",
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
        if (this.subscriptions.getSubscribedSessionAgentId(socket) === command.agentId) {
          this.subscriptions.remove(socket);
        }
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
          session: toPublicCliAgentDescriptor(forked.sessionAgent),
          profile: forked.profile,
          fromMessageId: command.fromMessageId,
        });
      }
    }
  }

  private async createCliRunSession(command: CliRunCommand): Promise<AgentDescriptor & { role: "manager" }> {
    if (command.target.kind !== "new_session") {
      throw new CliCommandError("bad_request", "CLI run target must be a new session.", 400);
    }

    this.requireCliWritableProfile(command.target.profileId);
    const created = await this.swarmManager.createSession(command.target.profileId, {
      label: command.target.label,
      name: command.target.name,
      cli: command.cli,
    });
    return created.sessionAgent as AgentDescriptor & { role: "manager" };
  }

  private async dispatchCliMessage(
    targetAgentId: string,
    text: string,
    attachments: ConversationAttachment[] | undefined,
    delivery: RequestedDeliveryMode | undefined,
    sourceContext: MessageSourceContext,
  ): Promise<void> {
    await this.swarmManager.handleUserMessage(text, {
      targetAgentId,
      delivery,
      attachments,
      sourceContext,
    });
  }

  private requireCliWritableProfile(profileId: string): void {
    const profile = this.swarmManager.listProfiles().find((candidate) => candidate.profileId === profileId);
    if (!profile) {
      throw new CliCommandError(
        "unknown_profile",
        `Unknown profile: ${profileId}`,
        404,
        [{ field: "profileId", message: "Profile not found." }],
      );
    }

    try {
      requireNonSystemProfile(profileId, [profile]);
    } catch (error) {
      throw new CliCommandError(
        "system_profile",
        error instanceof Error ? error.message : String(error),
        403,
        [{ field: "profileId", message: "System-managed profiles cannot be targeted by CLI session creation." }],
      );
    }
  }

  private requireCliPendingChoice(choiceId: string, requestedSessionAgentId?: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } {
    const owner = getCliChoiceOwner(this.swarmManager, choiceId);
    if (!owner) {
      throw new CliCommandError(
        "choice_not_pending",
        `Choice ${choiceId} is not pending`,
        404,
        [{ field: "choiceId", message: "Choice is not pending or is not available to the builder CLI." }],
      );
    }

    if (requestedSessionAgentId !== undefined && requestedSessionAgentId !== owner.sessionAgentId) {
      throw new CliCommandError(
        "choice_session_mismatch",
        `Choice ${choiceId} does not belong to session ${requestedSessionAgentId}`,
        409,
        [{ field: "sessionAgentId", message: "Choice belongs to a different session." }],
      );
    }

    const pending = this.swarmManager.getPendingChoice(choiceId);
    if (!pending) {
      throw new CliCommandError(
        "choice_not_pending",
        `Choice ${choiceId} is not pending`,
        404,
        [{ field: "choiceId", message: "Choice is not pending." }],
      );
    }

    return pending;
  }

  private requireCliProjectAgentSession(
    profileId: string,
    handle: string,
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    this.requireCliWritableProfile(profileId);
    const descriptor = this.swarmManager
      .listAgents()
      .find(
        (agent) =>
          agent.role === "manager" &&
          agent.profileId === profileId &&
          agent.projectAgent?.handle === handle,
      );

    if (!descriptor) {
      throw new CliCommandError(
        "unknown_project_agent",
        `Unknown project agent: ${handle}`,
        404,
        [{ field: "target.handle", message: "Project agent not found." }],
      );
    }

    return this.requireCliSession(descriptor.agentId);
  }

  private requireCliSession(agentId: string): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (!descriptor) {
      throw new CliCommandError(
        "unknown_session",
        `Unknown session agent: ${agentId}`,
        404,
        [{ field: "agentId", message: "Session not found." }],
      );
    }

    if (descriptor.role !== "manager") {
      throw new CliCommandError(
        "invalid_session_target",
        `Agent ${agentId} is not a session manager.`,
        400,
        [{ field: "agentId", message: "CLI target must be a manager session." }],
      );
    }

    if (descriptor.sessionSurface === "collab") {
      throw new CliCommandError(
        "unsupported_session_surface",
        `Session ${agentId} is not available to the builder CLI.`,
        403,
        [{ field: "agentId", message: "Collaboration sessions cannot be targeted by the builder CLI." }],
      );
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.swarmManager.listProfiles().find((candidate) => candidate.profileId === profileId);
    if (!profile) {
      throw new CliCommandError(
        "unknown_profile",
        `Unknown profile for session: ${profileId}`,
        404,
        [{ field: "agentId", message: "Session profile not found." }],
      );
    }

    if (isSystemProfile(profile)) {
      throw new CliCommandError(
        "system_profile",
        `Session ${agentId} belongs to a system-managed profile.`,
        403,
        [{ field: "agentId", message: "System-managed sessions cannot be targeted by the builder CLI." }],
      );
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
    command: CliRequestContext | undefined,
    code: string,
    message: string,
    status?: number,
    fieldErrors?: CliFieldError[],
  ): void {
    const commandType = command?.type && isKnownCliCommandType(command.type) ? command.type : undefined;
    this.send(socket, {
      type: "cli_request_error",
      ...(command?.requestId !== undefined ? { requestId: command.requestId } : {}),
      ...(commandType !== undefined ? { commandType } : {}),
      code,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(fieldErrors !== undefined && fieldErrors.length > 0 ? { fieldErrors } : {}),
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

type CliCommandType = CliWsCommand["type"];

type CliRequestContext = {
  type?: string;
  requestId?: string;
};

type CliCommandParseResult =
  | { ok: true; command: CliWsCommand }
  | { ok: false; context?: CliRequestContext; fieldErrors: CliFieldError[] };

const KNOWN_CLI_COMMAND_TYPES = new Set<CliCommandType>([
  "subscribe_headless",
  "cli_create_session",
  "cli_send_message",
  "cli_run",
  "stop_session",
  "resume_session",
  "delete_session",
  "clear_session",
  "rename_session",
  "pin_session",
  "fork_session",
  "cli_choice_response",
  "cli_choice_cancel",
]);

class CliCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly fieldErrors?: CliFieldError[],
  ) {
    super(message);
  }
}

function parseCliCommand(raw: RawData): CliCommandParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return {
      ok: false,
      fieldErrors: [{ field: "$", message: "Must be valid JSON." }],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      fieldErrors: [{ field: "$", message: "Must be a JSON object." }],
    };
  }

  const context = buildRequestContext(parsed);
  if (typeof parsed.type !== "string") {
    return {
      ok: false,
      context,
      fieldErrors: [{ field: "type", message: "Required field must be a string." }],
    };
  }

  if (!isKnownCliCommandType(parsed.type)) {
    return {
      ok: false,
      context,
      fieldErrors: [{ field: "type", message: `Unsupported CLI command type: ${parsed.type}` }],
    };
  }

  const fieldErrors = validateCliCommand(parsed, parsed.type);
  if (fieldErrors.length > 0) {
    return { ok: false, context, fieldErrors };
  }

  return { ok: true, command: parsed as unknown as CliWsCommand };
}

function validateCliCommand(record: Record<string, unknown>, type: CliCommandType): CliFieldError[] {
  const errors: CliFieldError[] = [];

  switch (type) {
    case "subscribe_headless":
      optionalString(record, "requestId", errors);
      optionalString(record, "agentId", errors);
      optionalString(record, "profileId", errors);
      break;

    case "cli_create_session":
      requireString(record, "requestId", errors);
      requireString(record, "profileId", errors);
      optionalString(record, "label", errors);
      optionalString(record, "name", errors);
      validateCliMetadata(record.cli, "cli", errors);
      break;

    case "cli_send_message":
      requireString(record, "requestId", errors);
      validateCliMessageTarget(record.target, "target", errors);
      requireString(record, "text", errors);
      validateOptionalAttachments(record.attachments, errors);
      validateOptionalDelivery(record.delivery, errors);
      break;

    case "cli_run":
      requireString(record, "requestId", errors);
      validateCliRunTarget(record.target, "target", errors);
      requireString(record, "text", errors);
      validateOptionalAttachments(record.attachments, errors);
      validateOptionalDelivery(record.delivery, errors);
      validateCliMetadata(record.cli, "cli", errors);
      break;

    case "stop_session":
    case "resume_session":
    case "delete_session":
    case "clear_session":
      requireString(record, "requestId", errors);
      requireString(record, "agentId", errors);
      break;

    case "rename_session":
      requireString(record, "requestId", errors);
      requireString(record, "agentId", errors);
      requireString(record, "label", errors);
      break;

    case "pin_session":
      requireString(record, "requestId", errors);
      requireString(record, "agentId", errors);
      requireBoolean(record, "pinned", errors);
      break;

    case "fork_session":
      requireString(record, "requestId", errors);
      requireString(record, "sourceAgentId", errors);
      optionalString(record, "label", errors);
      optionalString(record, "fromMessageId", errors);
      break;

    case "cli_choice_response":
      requireString(record, "requestId", errors);
      requireString(record, "choiceId", errors);
      optionalString(record, "sessionAgentId", errors);
      if (!Array.isArray(record.answers) || !record.answers.every(isChoiceAnswer)) {
        errors.push({ field: "answers", message: "Required field must be an array of valid choice answers." });
      }
      break;

    case "cli_choice_cancel":
      requireString(record, "requestId", errors);
      requireString(record, "choiceId", errors);
      optionalString(record, "sessionAgentId", errors);
      break;

  }

  return errors;
}

function validateCliMessageTarget(value: unknown, field: string, errors: CliFieldError[]): void {
  const target = requireRecordValue(value, field, errors);
  if (!target) {
    return;
  }

  if (target.kind === "session") {
    requireStringValue(target.agentId, `${field}.agentId`, errors);
    return;
  }

  if (target.kind === "project_agent") {
    requireStringValue(target.profileId, `${field}.profileId`, errors);
    requireStringValue(target.handle, `${field}.handle`, errors);
    return;
  }

  errors.push({ field: `${field}.kind`, message: "Must be one of: session, project_agent." });
}

function validateCliRunTarget(value: unknown, field: string, errors: CliFieldError[]): void {
  const target = requireRecordValue(value, field, errors);
  if (!target) {
    return;
  }

  if (target.kind === "new_session") {
    requireStringValue(target.profileId, `${field}.profileId`, errors);
    optionalStringValue(target.label, `${field}.label`, errors);
    optionalStringValue(target.name, `${field}.name`, errors);
    return;
  }

  if (target.kind === "session") {
    requireStringValue(target.agentId, `${field}.agentId`, errors);
    return;
  }

  if (target.kind === "project_agent") {
    requireStringValue(target.profileId, `${field}.profileId`, errors);
    requireStringValue(target.handle, `${field}.handle`, errors);
    return;
  }

  errors.push({ field: `${field}.kind`, message: "Must be one of: new_session, session, project_agent." });
}

function validateCliMetadata(value: unknown, field: string, errors: CliFieldError[]): void {
  if (value === undefined) {
    return;
  }

  const cli = requireRecordValue(value, field, errors);
  if (!cli) {
    return;
  }

  if (cli.createdBy !== "forge-cli") {
    errors.push({ field: `${field}.createdBy`, message: "Must be forge-cli." });
  }
  requireStringValue(cli.runId, `${field}.runId`, errors);
  if (cli.command !== "run" && cli.command !== "launch" && cli.command !== "sessions create") {
    errors.push({ field: `${field}.command`, message: "Must be one of: run, launch, sessions create." });
  }
  requireStringValue(cli.startedAt, `${field}.startedAt`, errors);
  optionalStringValue(cli.invocationCwd, `${field}.invocationCwd`, errors);
  optionalStringValue(cli.label, `${field}.label`, errors);
}

function validateOptionalAttachments(value: unknown, errors: CliFieldError[]): void {
  if (value !== undefined && !Array.isArray(value)) {
    errors.push({ field: "attachments", message: "Must be an array when provided." });
  }
}

function validateOptionalDelivery(value: unknown, errors: CliFieldError[]): void {
  if (value === undefined) {
    return;
  }

  if (value !== "auto" && value !== "followUp" && value !== "steer") {
    errors.push({ field: "delivery", message: "Must be one of: auto, followUp, steer." });
  }
}

function requireRecordValue(value: unknown, field: string, errors: CliFieldError[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push({ field, message: "Required field must be an object." });
    return undefined;
  }

  return value;
}

function requireString(record: Record<string, unknown>, field: string, errors: CliFieldError[]): void {
  requireStringValue(readField(record, field), field, errors);
}

function requireStringValue(value: unknown, field: string, errors: CliFieldError[]): void {
  if (value === undefined) {
    errors.push({ field, message: "Required field must be a string." });
    return;
  }

  if (typeof value !== "string") {
    errors.push({ field, message: "Must be a string." });
  }
}

function optionalString(record: Record<string, unknown>, field: string, errors: CliFieldError[]): void {
  optionalStringValue(readField(record, field), field, errors);
}

function optionalStringValue(value: unknown, field: string, errors: CliFieldError[]): void {
  if (value !== undefined && typeof value !== "string") {
    errors.push({ field, message: "Must be a string when provided." });
  }
}

function requireBoolean(record: Record<string, unknown>, field: string, errors: CliFieldError[]): void {
  const value = readField(record, field);
  if (value === undefined) {
    errors.push({ field, message: "Required field must be a boolean." });
    return;
  }

  if (typeof value !== "boolean") {
    errors.push({ field, message: "Must be a boolean." });
  }
}

function readField(record: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, record);
}

function buildRequestContext(record: Record<string, unknown>): CliRequestContext {
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
  };
}

function buildCliSourceContext(command: CliSendMessageCommand | CliRunCommand): MessageSourceContext {
  const messageId = command.type === "cli_run" ? command.cli?.runId ?? command.requestId : command.requestId;
  return { channel: "cli", messageId };
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

function isKnownCliCommandType(type: string): type is CliCommandType {
  return KNOWN_CLI_COMMAND_TYPES.has(type as CliCommandType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
