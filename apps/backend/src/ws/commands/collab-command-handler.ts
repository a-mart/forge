import type { CollaborationAuthContext } from "../../collaboration/auth/collaboration-auth-middleware.js";
import type {
  DispatchCollaborationChannelMessageResult,
} from "../../collaboration/channel-message-service.js";
import {
  createCollaborationDbHelpers,
  type CollaborationChannelUserStateRecord,
  type CollaborationDbHelpers,
} from "../../collaboration/collab-db-helpers.js";
import { CollaborationCategoryService } from "../../collaboration/category-service.js";
import { CollaborationChannelService } from "../../collaboration/channel-service.js";
import type { CollaborationReadinessRequestService } from "../../collaboration/readiness-service.js";
import { CollaborationWorkspaceService } from "../../collaboration/workspace-service.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { attachEffectiveChannelModelSettings } from "../../collaboration/channel-service.js";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  CollaborationBootstrapChannel,
  CollaborationBootstrapCurrentUser,
  CollaborationBootstrapEvent,
  CollaborationChannel,
  CollaborationChannelHistoryEvent,
  CollaborationChannelReadyEvent,
  CollaborationChannelStatusEvent,
  CollaborationChoiceRequestEvent,
  CollaborationClientCommand,
  CollaborationMarkChannelReadCommand,
  CollaborationMessagePinnedEvent,
  CollaborationReadState,
  CollaborationReadStateUpdatedEvent,
  CollaborationSessionActivityEntry,
  CollaborationSessionActivitySnapshotEvent,
  CollaborationSessionWorkersSnapshotEvent,
  CollaborationTranscriptMessage,
  ConversationAttachment,
  ConversationEntry,
  ErrorEvent,
  ServerEvent,
} from "@forge/protocol";
import type { WebSocket } from "ws";
import { DEFAULT_SUBSCRIBE_MESSAGE_COUNT } from "../ws-bootstrap.js";
import type { CollabSubscriptionManager } from "../collab-subscription-manager.js";

function validateAnswersAgainstQuestions(
  questions: ChoiceQuestion[],
  answers: ChoiceAnswer[],
): string | null {
  const questionMap = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();

  for (const answer of answers) {
    const question = questionMap.get(answer.questionId);
    if (!question) return `Unknown questionId: ${answer.questionId}`;
    if (seen.has(answer.questionId)) return `Duplicate answer for questionId: ${answer.questionId}`;
    seen.add(answer.questionId);

    if (question.options) {
      const allowed = new Set(question.options.map((option) => option.id));
      for (const optionId of answer.selectedOptionIds) {
        if (!allowed.has(optionId)) return `Unknown optionId ${optionId} for question ${answer.questionId}`;
      }
    }
  }

  return null;
}

interface CollaborationWsServices {
  dbHelpers: CollaborationDbHelpers;
  workspaceService: CollaborationWorkspaceService;
  channelService: CollaborationChannelService;
  categoryService: CollaborationCategoryService;
}

export interface CollaborationChannelMessageDispatcher {
  dispatchUserMessage(params: {
    channelId: string;
    userId: string;
    text: string;
    attachments?: ConversationAttachment[];
  }): Promise<DispatchCollaborationChannelMessageResult>;
}

export class CollabCommandHandler {
  private servicesPromise: Promise<CollaborationWsServices> | null = null;

  constructor(
    private readonly swarmManager: SwarmManager,
    private readonly subscriptionManager: CollabSubscriptionManager,
    private readonly send: (socket: WebSocket, event: ServerEvent) => void,
    private readonly getChannelMessageService: () => Promise<CollaborationChannelMessageDispatcher>,
    private readonly readinessService?: CollaborationReadinessRequestService,
  ) {}

  async handleCommand(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: CollaborationClientCommand,
  ): Promise<boolean> {
    if (authContext.passwordChangeRequired) {
      this.send(socket, toCollaborationCommandError(
        "COLLAB_PASSWORD_CHANGE_REQUIRED",
        "Password change required",
      ));
      return true;
    }

    switch (command.type) {
      case "collab_bootstrap":
        await this.runCommand(socket, "COLLAB_BOOTSTRAP_FAILED", () => this.handleBootstrap(socket, authContext));
        return true;

      case "collab_subscribe_channel":
        await this.runCommand(
          socket,
          "COLLAB_SUBSCRIBE_CHANNEL_FAILED",
          () => this.handleSubscribeChannel(socket, authContext, command.channelId),
        );
        return true;

      case "collab_unsubscribe_channel":
        this.subscriptionManager.unsubscribe(socket, command.channelId);
        return true;

      case "collab_user_message":
        await this.runCommand(
          socket,
          "COLLAB_USER_MESSAGE_FAILED",
          () => this.handleUserMessage(socket, authContext, command),
        );
        return true;

      case "collab_mark_channel_read":
        await this.runCommand(
          socket,
          "COLLAB_MARK_CHANNEL_READ_FAILED",
          () => this.handleMarkChannelRead(socket, authContext, command),
        );
        return true;

      case "collab_choice_response":
        await this.runCommand(
          socket,
          "COLLAB_CHOICE_RESPONSE_FAILED",
          () => this.handleChoiceResponse(socket, authContext, command),
        );
        return true;

      case "collab_choice_cancel":
        await this.runCommand(
          socket,
          "COLLAB_CHOICE_CANCEL_FAILED",
          () => this.handleChoiceCancel(socket, authContext, command),
        );
        return true;

      case "collab_pin_message":
        await this.runCommand(
          socket,
          "COLLAB_PIN_MESSAGE_FAILED",
          () => this.handlePinMessage(socket, authContext, command),
        );
        return true;
    }
  }

  private async handleBootstrap(socket: WebSocket, authContext: CollaborationAuthContext): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    const { workspaceService, channelService, categoryService, dbHelpers } = await this.getServices();
    const workspace = this.readinessService
      ? await this.requireReadyWorkspace()
      : await workspaceService.ensureDefaultWorkspace();
    const categories = workspace ? categoryService.listCategories(workspace.workspaceId) : [];
    const channels = workspace
      ? channelService
          .listChannels({ workspaceId: workspace.workspaceId })
          .map((channel) =>
            toBootstrapChannel(
              attachEffectiveChannelModelSettings(this.swarmManager, channel),
              dbHelpers.getChannelUserState(channel.channelId, authContext.userId),
            ),
          )
      : [];

    const event: CollaborationBootstrapEvent = {
      type: "collab_bootstrap",
      currentUser: toBootstrapCurrentUser(authContext),
      workspace,
      categories,
      channels,
    };

    this.send(socket, event);
  }

  private async handleSubscribeChannel(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    channelId: string,
  ): Promise<void> {
    const { channelService } = await this.getServices();
    const channel = attachEffectiveChannelModelSettings(this.swarmManager, channelService.getChannel(channelId));
    this.subscriptionManager.subscribe(socket, authContext, channel);

    this.send(socket, {
      type: "collab_channel_ready",
      channel,
    } satisfies CollaborationChannelReadyEvent);

    const conversationHistory = this.swarmManager.getConversationHistory(channel.sessionAgentId);
    const history = conversationHistory
      .filter(isCollaborationTranscriptEntry)
      .slice(-DEFAULT_SUBSCRIBE_MESSAGE_COUNT)
      .map((entry) => toTranscriptMessage(entry, channelId));

    this.send(socket, {
      type: "collab_channel_history",
      channelId,
      messages: history,
    } satisfies CollaborationChannelHistoryEvent);

    for (const historicalChoiceRequest of conversationHistory
      .filter(isHistoricalChoiceRequest)
      .slice(-DEFAULT_SUBSCRIBE_MESSAGE_COUNT)) {
      this.send(socket, toCollaborationChoiceRequestEvent(channelId, historicalChoiceRequest));
    }

    for (const pendingChoiceId of this.swarmManager.getPendingChoiceIdsForSession(channel.sessionAgentId)) {
      const pendingChoice = this.swarmManager.getPendingChoice(pendingChoiceId);
      if (!pendingChoice || pendingChoice.sessionAgentId !== channel.sessionAgentId) {
        continue;
      }

      this.send(
        socket,
        toCollaborationChoiceRequestEvent(channelId, {
          agentId: pendingChoice.agentId,
          choiceId: pendingChoiceId,
          questions: pendingChoice.questions,
          status: "pending",
          timestamp: new Date().toISOString(),
        }),
      );
    }

    const descriptor = this.swarmManager.getAgent(channel.sessionAgentId);
    if (descriptor?.role === "manager") {
      this.send(socket, {
        type: "collab_channel_status",
        channelId,
        status: descriptor.status === "streaming" ? "responding" : "idle",
        agentStatus: descriptor.status,
        ...(descriptor.streamingStartedAt !== undefined
          ? { streamingStartedAt: descriptor.streamingStartedAt }
          : {}),
      } satisfies CollaborationChannelStatusEvent);
    }

    this.send(socket, {
      type: "collab_session_workers_snapshot",
      channelId,
      sessionAgentId: channel.sessionAgentId,
      workers: this.swarmManager.listWorkersForSession(channel.sessionAgentId),
    } satisfies CollaborationSessionWorkersSnapshotEvent);

    this.send(socket, {
      type: "collab_session_activity_snapshot",
      channelId,
      sessionAgentId: channel.sessionAgentId,
      activity: this.swarmManager
        .getConversationHistory(channel.sessionAgentId)
        .filter(isCollaborationSessionActivity)
        .slice(-DEFAULT_SUBSCRIBE_MESSAGE_COUNT),
    } satisfies CollaborationSessionActivitySnapshotEvent);
  }

  private async handleUserMessage(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: Extract<CollaborationClientCommand, { type: "collab_user_message" }>,
  ): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    await this.requireWritableChannel(command.channelId, "send messages to");

    const channelMessageService = await this.getChannelMessageService();
    const result = await channelMessageService.dispatchUserMessage({
      channelId: command.channelId,
      userId: authContext.userId,
      text: command.content,
      attachments: command.attachments,
    });

    await this.subscriptionManager.broadcastChannelActivityUpdated(result.channel);

    const readStateEvent: CollaborationReadStateUpdatedEvent = {
      type: "collab_read_state_updated",
      channelId: command.channelId,
      readState: toOwnMessageReadState(command.channelId, result),
    };
    this.subscriptionManager.broadcastReadStateUpdated(authContext.userId, readStateEvent);
  }

  private async handleMarkChannelRead(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: CollaborationMarkChannelReadCommand,
  ): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    const { channelService, dbHelpers } = await this.getServices();
    const channel = channelService.getChannel(command.channelId);
    const now = new Date().toISOString();
    const existingState = dbHelpers.getChannelUserState(channel.channelId, authContext.userId);
    const readStateRecord = dbHelpers.upsertChannelReadState({
      channelId: channel.channelId,
      userId: authContext.userId,
      lastReadMessageId: channel.lastMessageId ?? null,
      lastReadMessageSeq: channel.lastMessageSeq,
      lastReadAt: channel.lastMessageAt ?? now,
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now,
    });

    this.subscriptionManager.broadcastReadStateUpdated(authContext.userId, {
      type: "collab_read_state_updated",
      channelId: channel.channelId,
      readState: toReadState(channel, readStateRecord),
    });
  }

  private async handleChoiceResponse(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: Extract<CollaborationClientCommand, { type: "collab_choice_response" }>,
  ): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    const channel = await this.requireWritableChannel(command.channelId, "answer choices in");
    const pendingChoice = this.swarmManager.getPendingChoice(command.choiceId);
    if (!pendingChoice) {
      this.sendChoiceError(socket, "CHOICE_NOT_PENDING", `Choice ${command.choiceId} is not pending`);
      return;
    }

    if (pendingChoice.sessionAgentId !== channel.sessionAgentId) {
      this.sendChoiceError(
        socket,
        "CHOICE_OWNER_MISMATCH",
        `Choice ${command.choiceId} does not belong to channel ${command.channelId}`,
      );
      return;
    }

    const validationError = validateAnswersAgainstQuestions(pendingChoice.questions, command.answers);
    if (validationError) {
      this.sendChoiceError(socket, "CHOICE_INVALID_RESPONSE", `Invalid choice response: ${validationError}`);
      return;
    }

    this.swarmManager.resolveChoiceRequest(command.choiceId, command.answers);
  }

  private async handleChoiceCancel(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: Extract<CollaborationClientCommand, { type: "collab_choice_cancel" }>,
  ): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    const channel = await this.requireWritableChannel(command.channelId, "cancel choices in");
    const pendingChoice = this.swarmManager.getPendingChoice(command.choiceId);
    if (!pendingChoice) {
      this.sendChoiceError(socket, "CHOICE_NOT_PENDING", `Choice ${command.choiceId} is not pending`);
      return;
    }

    if (pendingChoice.sessionAgentId !== channel.sessionAgentId) {
      this.sendChoiceError(
        socket,
        "CHOICE_OWNER_MISMATCH",
        `Choice ${command.choiceId} does not belong to channel ${command.channelId}`,
      );
      return;
    }

    this.swarmManager.cancelChoiceRequest(command.choiceId, "cancelled");
  }

  private async handlePinMessage(
    socket: WebSocket,
    authContext: CollaborationAuthContext,
    command: Extract<CollaborationClientCommand, { type: "collab_pin_message" }>,
  ): Promise<void> {
    this.subscriptionManager.registerSocket(socket, authContext);

    const channel = await this.requireWritableChannel(command.channelId, "pin messages in");
    const result = await this.swarmManager.pinMessage(
      channel.sessionAgentId,
      command.messageId,
      command.pinned,
    );

    const event: CollaborationMessagePinnedEvent = {
      type: "collab_message_pinned",
      channelId: channel.channelId,
      messageId: command.messageId,
      pinned: result.pinned,
    };
    this.subscriptionManager.broadcastMessagePinned(event.channelId, event.messageId, event.pinned);
  }

  private async getServices(): Promise<CollaborationWsServices> {
    if (!this.servicesPromise) {
      this.servicesPromise = this.createServices();
    }
    return this.servicesPromise;
  }

  private async requireWritableChannel(channelId: string, action: string): Promise<CollaborationChannel> {
    const { channelService } = await this.getServices();
    const channel = channelService.getChannel(channelId);
    if (channel.archived) {
      throw new Error(`Cannot ${action} archived collaboration channel ${channelId}`);
    }

    return channel;
  }

  private async requireReadyWorkspace() {
    const readiness = await this.readinessService?.ensureCollaborationReady();
    if (!readiness?.workspace) {
      throw new Error(
        "Collaboration bootstrap is degraded: missing workspace record, workspace defaults, storage profile, or storage root session. Check /api/collaboration/status for details.",
      );
    }

    return readiness.workspace;
  }

  private async runCommand(
    socket: WebSocket,
    code: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.send(socket, toCollaborationCommandError(
        code,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  private sendChoiceError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, {
      type: "error",
      code,
      message,
    });
  }

  private async createServices(): Promise<CollaborationWsServices> {
    const dbHelpers = await createCollaborationDbHelpers(this.swarmManager.getConfig());
    return {
      dbHelpers,
      workspaceService: new CollaborationWorkspaceService(dbHelpers, this.swarmManager, this.swarmManager.getConfig()),
      channelService: new CollaborationChannelService(
        dbHelpers,
        this.swarmManager,
        this.swarmManager.getConfig().paths.dataDir,
      ),
      categoryService: new CollaborationCategoryService(dbHelpers),
    };
  }
}

function toBootstrapCurrentUser(
  authContext: CollaborationAuthContext,
): CollaborationBootstrapCurrentUser {
  return {
    userId: authContext.userId,
    email: authContext.email,
    name: authContext.name,
    role: authContext.role,
    disabled: authContext.disabled,
  };
}

function toBootstrapChannel(
  channel: CollaborationChannel,
  readStateRecord: CollaborationChannelUserStateRecord | null,
): CollaborationBootstrapChannel {
  return {
    ...channel,
    readState: toReadState(channel, readStateRecord),
  };
}

function toReadState(
  channel: Pick<CollaborationChannel, "channelId" | "lastMessageSeq">,
  readStateRecord: CollaborationChannelUserStateRecord | null,
): CollaborationReadState {
  const lastReadMessageSeq = readStateRecord?.lastReadMessageSeq ?? 0;
  const unreadCount = Math.max(channel.lastMessageSeq - lastReadMessageSeq, 0);

  return {
    channelId: channel.channelId,
    ...(readStateRecord?.lastReadMessageId ? { lastReadMessageId: readStateRecord.lastReadMessageId } : {}),
    lastReadMessageSeq,
    ...(readStateRecord?.lastReadAt ? { lastReadAt: readStateRecord.lastReadAt } : {}),
    unreadCount,
  };
}

function toOwnMessageReadState(
  channelId: string,
  result: DispatchCollaborationChannelMessageResult,
): CollaborationReadState {
  return {
    channelId,
    ...(result.messageId ? { lastReadMessageId: result.messageId } : {}),
    lastReadMessageSeq: result.lastMessageSeq,
    lastReadAt: result.timestamp,
    unreadCount: 0,
  };
}

function toTranscriptMessage(
  entry: {
    id?: string;
    role: CollaborationTranscriptMessage["role"];
    text: string;
    attachments?: CollaborationTranscriptMessage["attachments"];
    timestamp: string;
    source: CollaborationTranscriptMessage["source"];
    sourceContext?: CollaborationTranscriptMessage["sourceContext"];
    projectAgentContext?: CollaborationTranscriptMessage["projectAgentContext"];
    pinned?: boolean;
    collaborationAuthor?: CollaborationTranscriptMessage["collaborationAuthor"];
  },
  channelId: string,
): CollaborationTranscriptMessage {
  return {
    channelId,
    ...(entry.id ? { id: entry.id } : {}),
    role: entry.role,
    text: entry.text,
    ...(entry.attachments ? { attachments: entry.attachments } : {}),
    timestamp: entry.timestamp,
    source: entry.source,
    ...(entry.sourceContext ? { sourceContext: entry.sourceContext } : {}),
    ...(entry.projectAgentContext ? { projectAgentContext: entry.projectAgentContext } : {}),
    ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
    ...(entry.collaborationAuthor ? { collaborationAuthor: entry.collaborationAuthor } : {}),
  };
}

function isCollaborationTranscriptEntry(
  entry: ConversationEntry,
): entry is Extract<ConversationEntry, { type: "conversation_message" }> {
  return entry.type === "conversation_message";
}

function isHistoricalChoiceRequest(
  entry: ConversationEntry,
): entry is Extract<ConversationEntry, { type: "choice_request" }> {
  return entry.type === "choice_request";
}

function toCollaborationChoiceRequestEvent(
  channelId: string,
  entry: Pick<
    Extract<ConversationEntry, { type: "choice_request" }>,
    "agentId" | "choiceId" | "questions" | "status" | "answers" | "timestamp"
  >,
): CollaborationChoiceRequestEvent {
  return {
    type: "collab_choice_request",
    channelId,
    request: {
      agentId: entry.agentId,
      choiceId: entry.choiceId,
      questions: entry.questions,
      status: entry.status,
      ...(entry.answers ? { answers: entry.answers } : {}),
      timestamp: entry.timestamp,
    },
  };
}

function isCollaborationSessionActivity(entry: ConversationEntry): entry is CollaborationSessionActivityEntry {
  return entry.type === "agent_message" || entry.type === "agent_tool_call";
}

export function isCollaborationClientCommand(command: { type: string }): command is CollaborationClientCommand {
  return command.type.startsWith("collab_");
}

export function toCollaborationCommandError(code: string, message: string): ErrorEvent {
  return {
    type: "error",
    code,
    message,
  };
}
