import type {
  AgentMessageEvent,
  AgentStatusEvent,
  AgentToolCallEvent,
  ChoiceRequestEvent,
  CollaborationCategory,
  CollaborationCategoryReorderedEvent,
  CollaborationChannel,
  CollaborationChannelActivityUpdatedEvent,
  CollaborationChannelArchivedEvent,
  CollaborationChannelCreatedEvent,
  CollaborationChannelMessageEvent,
  CollaborationChannelReorderedEvent,
  CollaborationChannelStatusEvent,
  CollaborationChannelUpdatedEvent,
  CollaborationChoiceRequestEvent,
  CollaborationMessagePinnedEvent,
  CollaborationReadStateUpdatedEvent,
  CollaborationServerEvent,
  CollaborationSessionActivityEntry,
  CollaborationSessionActivityEvent,
  CollaborationSessionAgentStatusEvent,
  CollaborationSessionWorkersSnapshotEvent,
  CollaborationTranscriptMessage,
  ConversationMessageEvent,
  SessionWorkersSnapshotEvent,
} from "@forge/protocol";
import { WebSocket, type WebSocketServer } from "ws";
import {
  getCollaborationSocketAuthContext,
  type CollaborationAuthContext,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import type { CollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";

const COLLAB_READY_SUBSCRIPTION_ID = "__collaboration__";
const COLLAB_SESSION_INVALIDATED_CLOSE_CODE = 4001;
const COLLAB_SESSION_INVALIDATED_CLOSE_REASON = "collaboration_session_invalidated";

interface ChannelSubscriptionContext {
  channelId: string;
  workspaceId: string;
  backingSessionAgentId: string;
}

export class CollabSubscriptionManager {
  private readonly channelSubscribers = new Map<string, Set<WebSocket>>();
  private readonly workspaceSubscribers = new Set<WebSocket>();
  private readonly socketActiveChannelIds = new Map<WebSocket, string>();
  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly channelContexts = new Map<string, ChannelSubscriptionContext>();
  private readonly channelByBackingSessionId = new Map<string, string>();
  private dbHelpersPromise: Promise<
    Pick<
      CollaborationDbHelpers,
      | "advanceChannelActivity"
      | "getChannelByBackingSessionAgentId"
      | "getChannelUserState"
      | "upsertChannelReadState"
    >
  > | null = null;

  constructor(
    private readonly send: (socket: WebSocket, event: CollaborationServerEvent) => void,
    private readonly getDbHelpersFactory: () => Promise<
      Pick<
        CollaborationDbHelpers,
        | "advanceChannelActivity"
        | "getChannelByBackingSessionAgentId"
        | "getChannelUserState"
        | "upsertChannelReadState"
      >
    >,
  ) {}

  attach(server: WebSocketServer): void {
    server.on("connection", (socket) => {
      socket.on("close", () => {
        this.remove(socket);
      });

      socket.on("error", () => {
        this.remove(socket);
      });
    });
  }

  clear(): void {
    this.channelSubscribers.clear();
    this.workspaceSubscribers.clear();
    this.socketActiveChannelIds.clear();
    this.userSockets.clear();
    this.channelContexts.clear();
    this.channelByBackingSessionId.clear();
    this.dbHelpersPromise = null;
  }

  remove(socket: WebSocket): void {
    this.detachSocketFromActiveChannel(socket);
    this.workspaceSubscribers.delete(socket);

    const authContext = getCollaborationSocketAuthContext(socket);
    if (!authContext) {
      return;
    }

    const sockets = this.userSockets.get(authContext.userId);
    sockets?.delete(socket);
    if (!sockets || sockets.size === 0) {
      this.userSockets.delete(authContext.userId);
    }
  }

  registerSocket(socket: WebSocket, authContext: CollaborationAuthContext): void {
    let sockets = this.userSockets.get(authContext.userId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.userSockets.set(authContext.userId, sockets);
    }
    sockets.add(socket);
    this.workspaceSubscribers.add(socket);
  }

  subscribe(socket: WebSocket, authContext: CollaborationAuthContext, channel: CollaborationChannel): void {
    this.registerSocket(socket, authContext);

    const previousChannelId = this.socketActiveChannelIds.get(socket);
    if (previousChannelId && previousChannelId !== channel.channelId) {
      this.detachSocketFromChannel(socket, previousChannelId);
    }

    this.socketActiveChannelIds.set(socket, channel.channelId);

    let subscribers = this.channelSubscribers.get(channel.channelId);
    if (!subscribers) {
      subscribers = new Set<WebSocket>();
      this.channelSubscribers.set(channel.channelId, subscribers);
    }
    subscribers.add(socket);

    this.workspaceSubscribers.add(socket);
    this.rememberChannelContext({
      channelId: channel.channelId,
      workspaceId: channel.workspaceId,
      backingSessionAgentId: channel.sessionAgentId,
    });
  }

  unsubscribe(socket: WebSocket, channelId: string): void {
    if (this.socketActiveChannelIds.get(socket) !== channelId) {
      return;
    }

    this.detachSocketFromActiveChannel(socket);
  }

  getPrimarySubscribedChannelId(socket: WebSocket): string | undefined {
    return this.socketActiveChannelIds.get(socket);
  }

  getReadySubscriptionId(socket: WebSocket): string {
    return this.getPrimarySubscribedChannelId(socket) ?? COLLAB_READY_SUBSCRIPTION_ID;
  }

  broadcastReadStateUpdated(userId: string, event: CollaborationReadStateUpdatedEvent): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      this.send(socket, event);
    }
  }

  disconnectUserSockets(userId: string, options?: { excludeSessionId?: string }): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) {
      return;
    }

    for (const socket of Array.from(sockets)) {
      const authContext = getCollaborationSocketAuthContext(socket);
      if (options?.excludeSessionId && authContext?.sessionId === options.excludeSessionId) {
        continue;
      }

      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      try {
        socket.close(COLLAB_SESSION_INVALIDATED_CLOSE_CODE, COLLAB_SESSION_INVALIDATED_CLOSE_REASON);
      } catch {
        this.remove(socket);
      }
    }
  }

  broadcastMessagePinned(channelId: string, messageId: string, pinned: boolean): void {
    const event: CollaborationMessagePinnedEvent = {
      type: "collab_message_pinned",
      channelId,
      messageId,
      pinned,
    };
    this.broadcastChannelScopedEvent(channelId, event);
  }

  broadcastChannelCreated(channel: CollaborationChannel): void {
    this.rememberChannelContext({
      channelId: channel.channelId,
      workspaceId: channel.workspaceId,
      backingSessionAgentId: channel.sessionAgentId,
    });

    const event: CollaborationChannelCreatedEvent = { type: "collab_channel_created", channel };
    this.broadcastWorkspaceEvent(event);
  }

  broadcastChannelUpdated(channel: CollaborationChannel): void {
    this.rememberChannelContext({
      channelId: channel.channelId,
      workspaceId: channel.workspaceId,
      backingSessionAgentId: channel.sessionAgentId,
    });

    const event: CollaborationChannelUpdatedEvent = { type: "collab_channel_updated", channel };
    this.broadcastWorkspaceEvent(event);
  }

  broadcastChannelArchived(workspaceId: string, channelId: string): void {
    const event: CollaborationChannelArchivedEvent = {
      type: "collab_channel_archived",
      workspaceId,
      channelId,
    };
    this.broadcastWorkspaceEvent(event);
  }

  broadcastChannelReordered(channels: CollaborationChannel[]): void {
    const workspaceId = channels[0]?.workspaceId ?? "";
    const event: CollaborationChannelReorderedEvent = {
      type: "collab_channel_reordered",
      workspaceId,
      channels,
    };
    this.broadcastWorkspaceEvent(event);
  }

  broadcastCategoryCreated(category: CollaborationCategory): void {
    this.broadcastWorkspaceEvent({ type: "collab_category_created", category });
  }

  broadcastCategoryUpdated(category: CollaborationCategory): void {
    this.broadcastWorkspaceEvent({ type: "collab_category_updated", category });
  }

  broadcastCategoryDeleted(workspaceId: string, categoryId: string): void {
    this.broadcastWorkspaceEvent({ type: "collab_category_deleted", workspaceId, categoryId });
  }

  broadcastCategoryReordered(categories: CollaborationCategory[]): void {
    const workspaceId = categories[0]?.workspaceId ?? "";
    const event: CollaborationCategoryReorderedEvent = {
      type: "collab_category_reordered",
      workspaceId,
      categories,
    };
    this.broadcastWorkspaceEvent(event);
  }

  async broadcastChannelActivityUpdated(
    channel: Pick<
      CollaborationChannel,
      "channelId" | "workspaceId" | "sessionAgentId" | "lastMessageSeq"
    > & {
      lastMessageId?: string | null;
      lastMessageAt?: string | null;
    },
  ): Promise<void> {
    this.rememberChannelContext({
      channelId: channel.channelId,
      workspaceId: channel.workspaceId,
      backingSessionAgentId: channel.sessionAgentId,
    });

    if (this.userSockets.size === 0) {
      return;
    }

    const dbHelpers = await this.getDbHelpers();
    const unreadCountByUserId = new Map<string, number>();

    if (channel.lastMessageSeq > 0) {
      const readStateTimestamp = channel.lastMessageAt ?? new Date().toISOString();

      for (const userId of this.getActiveViewerUserIds(channel.channelId)) {
        const existingState = dbHelpers.getChannelUserState(channel.channelId, userId);
        if ((existingState?.lastReadMessageSeq ?? 0) >= channel.lastMessageSeq) {
          unreadCountByUserId.set(userId, 0);
          continue;
        }

        const updatedReadState = dbHelpers.upsertChannelReadState({
          channelId: channel.channelId,
          userId,
          lastReadMessageId: channel.lastMessageId ?? null,
          lastReadMessageSeq: channel.lastMessageSeq,
          lastReadAt: readStateTimestamp,
          createdAt: existingState?.createdAt ?? readStateTimestamp,
          updatedAt: readStateTimestamp,
        });
        unreadCountByUserId.set(userId, 0);
        this.broadcastReadStateUpdated(userId, {
          type: "collab_read_state_updated",
          channelId: channel.channelId,
          readState: toReadState(channel, updatedReadState),
        });
      }
    }

    for (const [userId, sockets] of this.userSockets.entries()) {
      let unreadCount = unreadCountByUserId.get(userId);
      if (unreadCount === undefined) {
        const readState = dbHelpers.getChannelUserState(channel.channelId, userId);
        unreadCount = Math.max(channel.lastMessageSeq - (readState?.lastReadMessageSeq ?? 0), 0);
        unreadCountByUserId.set(userId, unreadCount);
      }

      const activityEvent: CollaborationChannelActivityUpdatedEvent = {
        type: "collab_channel_activity_updated",
        channelId: channel.channelId,
        lastMessageSeq: channel.lastMessageSeq,
        ...(channel.lastMessageId ? { lastMessageId: channel.lastMessageId } : {}),
        ...(channel.lastMessageAt ? { lastMessageAt: channel.lastMessageAt } : {}),
        unreadCount,
      };

      for (const socket of sockets) {
        this.send(socket, activityEvent);
      }
    }
  }

  handleConversationMessage(event: ConversationMessageEvent): void {
    void this.handleConversationMessageInternal(event);
  }

  private async handleConversationMessageInternal(event: ConversationMessageEvent): Promise<void> {
    const context = await this.resolveChannelContextForBackingSession(event.agentId);
    if (!context) {
      return;
    }

    const messageEvent: CollaborationChannelMessageEvent = {
      type: "collab_channel_message",
      channelId: context.channelId,
      message: toCollaborationTranscriptMessage(event, context.channelId),
    };
    this.broadcastChannelScopedEvent(context.channelId, messageEvent);

    if (!isUnreadWorthyCollabMessage(event)) {
      return;
    }

    const dbHelpers = await this.getDbHelpers();
    const updatedChannel = dbHelpers.advanceChannelActivity(context.channelId, {
      lastMessageId: event.id ?? null,
      lastMessageAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    if (!updatedChannel) {
      return;
    }

    await this.broadcastChannelActivityUpdated({
      channelId: updatedChannel.channelId,
      workspaceId: updatedChannel.workspaceId,
      sessionAgentId: updatedChannel.backingSessionAgentId,
      lastMessageSeq: updatedChannel.lastMessageSeq,
      lastMessageId: updatedChannel.lastMessageId,
      lastMessageAt: updatedChannel.lastMessageAt,
    });
  }

  handleAgentMessage(event: AgentMessageEvent): void {
    void this.handleSessionActivityInternal(event);
  }

  handleAgentToolCall(event: AgentToolCallEvent): void {
    void this.handleSessionActivityInternal(event);
  }

  handleAgentStatus(event: AgentStatusEvent): void {
    if (event.managerId) {
      void this.handleSessionAgentStatusInternal(event);
      return;
    }

    void this.handleManagerStatusInternal(event);
  }

  handleSessionWorkersSnapshot(event: SessionWorkersSnapshotEvent): void {
    void this.handleSessionWorkersSnapshotInternal(event);
  }

  private async handleManagerStatusInternal(event: AgentStatusEvent): Promise<void> {
    const context = await this.resolveChannelContextForBackingSession(event.agentId);
    if (!context) {
      return;
    }

    const subscribers = this.channelSubscribers.get(context.channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const statusEvent: CollaborationChannelStatusEvent = {
      type: "collab_channel_status",
      channelId: context.channelId,
      status: event.status === "streaming" ? "responding" : "idle",
      agentStatus: event.status,
      pendingCount: event.pendingCount,
      ...(event.contextRecoveryInProgress !== undefined
        ? { contextRecoveryInProgress: event.contextRecoveryInProgress }
        : {}),
      ...(event.streamingStartedAt !== undefined ? { streamingStartedAt: event.streamingStartedAt } : {}),
    };

    for (const socket of subscribers) {
      this.send(socket, statusEvent);
    }
  }

  private async handleSessionActivityInternal(activity: CollaborationSessionActivityEntry): Promise<void> {
    const context = await this.resolveChannelContextForBackingSession(activity.agentId);
    if (!context) {
      return;
    }

    const subscribers = this.channelSubscribers.get(context.channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const activityEvent: CollaborationSessionActivityEvent = {
      type: "collab_session_activity",
      channelId: context.channelId,
      sessionAgentId: context.backingSessionAgentId,
      activity,
    };

    for (const socket of subscribers) {
      this.send(socket, activityEvent);
    }
  }

  private async handleSessionAgentStatusInternal(event: AgentStatusEvent): Promise<void> {
    if (!event.managerId) {
      return;
    }

    const context = await this.resolveChannelContextForBackingSession(event.managerId);
    if (!context) {
      return;
    }

    const subscribers = this.channelSubscribers.get(context.channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const statusEvent: CollaborationSessionAgentStatusEvent = {
      type: "collab_session_agent_status",
      channelId: context.channelId,
      sessionAgentId: context.backingSessionAgentId,
      agentId: event.agentId,
      managerId: event.managerId,
      status: event.status,
      pendingCount: event.pendingCount,
      ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
      ...(event.contextRecoveryInProgress !== undefined
        ? { contextRecoveryInProgress: event.contextRecoveryInProgress }
        : {}),
      ...(event.streamingStartedAt !== undefined ? { streamingStartedAt: event.streamingStartedAt } : {}),
    };

    for (const socket of subscribers) {
      this.send(socket, statusEvent);
    }
  }

  private async handleSessionWorkersSnapshotInternal(event: SessionWorkersSnapshotEvent): Promise<void> {
    const context = await this.resolveChannelContextForBackingSession(event.sessionAgentId);
    if (!context) {
      return;
    }

    const subscribers = this.channelSubscribers.get(context.channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const snapshotEvent: CollaborationSessionWorkersSnapshotEvent = {
      type: "collab_session_workers_snapshot",
      channelId: context.channelId,
      sessionAgentId: event.sessionAgentId,
      workers: event.workers,
    };

    for (const socket of subscribers) {
      this.send(socket, snapshotEvent);
    }
  }

  handleChoiceRequest(event: ChoiceRequestEvent, backingSessionAgentId: string): void {
    void this.handleChoiceRequestInternal(event, backingSessionAgentId);
  }

  private async handleChoiceRequestInternal(
    event: ChoiceRequestEvent,
    backingSessionAgentId: string,
  ): Promise<void> {
    const context = await this.resolveChannelContextForBackingSession(backingSessionAgentId);
    if (!context) {
      return;
    }

    const subscribers = this.channelSubscribers.get(context.channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const choiceEvent: CollaborationChoiceRequestEvent = {
      type: "collab_choice_request",
      channelId: context.channelId,
      request: {
        agentId: event.agentId,
        choiceId: event.choiceId,
        questions: event.questions,
        status: event.status,
        ...(event.answers ? { answers: event.answers } : {}),
        timestamp: event.timestamp,
      },
    };

    for (const socket of subscribers) {
      this.send(socket, choiceEvent);
    }
  }

  private async resolveChannelContextForBackingSession(
    backingSessionAgentId: string,
  ): Promise<ChannelSubscriptionContext | null> {
    const cachedChannelId = this.channelByBackingSessionId.get(backingSessionAgentId);
    if (cachedChannelId) {
      return this.channelContexts.get(cachedChannelId) ?? null;
    }

    const dbHelpers = await this.getDbHelpers();
    const channel = dbHelpers.getChannelByBackingSessionAgentId(backingSessionAgentId);
    if (!channel) {
      return null;
    }

    const context = {
      channelId: channel.channelId,
      workspaceId: channel.workspaceId,
      backingSessionAgentId: channel.backingSessionAgentId,
    } satisfies ChannelSubscriptionContext;
    this.rememberChannelContext(context);
    return context;
  }

  private rememberChannelContext(context: ChannelSubscriptionContext): void {
    this.channelContexts.set(context.channelId, context);
    this.channelByBackingSessionId.set(context.backingSessionAgentId, context.channelId);
  }

  private getActiveViewerUserIds(channelId: string): string[] {
    const activeUserIds: string[] = [];

    for (const [userId, sockets] of this.userSockets.entries()) {
      for (const socket of sockets) {
        if (this.socketActiveChannelIds.get(socket) === channelId) {
          activeUserIds.push(userId);
          break;
        }
      }
    }

    return activeUserIds;
  }

  private detachSocketFromActiveChannel(socket: WebSocket): void {
    const activeChannelId = this.socketActiveChannelIds.get(socket);
    if (!activeChannelId) {
      return;
    }

    this.socketActiveChannelIds.delete(socket);
    this.detachSocketFromChannel(socket, activeChannelId);
  }

  private detachSocketFromChannel(socket: WebSocket, channelId: string): void {
    const context = this.channelContexts.get(channelId);
    const subscribers = this.channelSubscribers.get(channelId);
    subscribers?.delete(socket);
    if (!subscribers || subscribers.size === 0) {
      this.channelSubscribers.delete(channelId);
      if (context) {
        this.channelByBackingSessionId.delete(context.backingSessionAgentId);
        this.channelContexts.delete(channelId);
      }
    }
  }

  private broadcastWorkspaceEvent(event: CollaborationServerEvent): void {
    if (this.workspaceSubscribers.size === 0) {
      return;
    }

    for (const socket of this.workspaceSubscribers) {
      this.send(socket, event);
    }
  }

  private broadcastChannelScopedEvent(channelId: string, event: CollaborationServerEvent): void {
    const subscribers = this.channelSubscribers.get(channelId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const socket of subscribers) {
      this.send(socket, event);
    }
  }

  private async getDbHelpers(): Promise<
    Pick<
      CollaborationDbHelpers,
      | "advanceChannelActivity"
      | "getChannelByBackingSessionAgentId"
      | "getChannelUserState"
      | "upsertChannelReadState"
    >
  > {
    if (!this.dbHelpersPromise) {
      this.dbHelpersPromise = this.getDbHelpersFactory();
    }

    return this.dbHelpersPromise;
  }
}

function toReadState(
  channel: Pick<CollaborationChannel, "channelId" | "lastMessageSeq">,
  readState: {
    lastReadMessageId: string | null;
    lastReadMessageSeq: number;
    lastReadAt: string | null;
  },
) {
  return {
    channelId: channel.channelId,
    ...(readState.lastReadMessageId ? { lastReadMessageId: readState.lastReadMessageId } : {}),
    lastReadMessageSeq: readState.lastReadMessageSeq,
    ...(readState.lastReadAt ? { lastReadAt: readState.lastReadAt } : {}),
    unreadCount: Math.max(channel.lastMessageSeq - readState.lastReadMessageSeq, 0),
  };
}

function toCollaborationTranscriptMessage(
  event: ConversationMessageEvent,
  channelId: string,
): CollaborationTranscriptMessage {
  const maybeWithCollaborationAuthor = event as ConversationMessageEvent & {
    collaborationAuthor?: CollaborationTranscriptMessage["collaborationAuthor"];
  };

  return {
    channelId,
    ...(event.id ? { id: event.id } : {}),
    role: event.role,
    text: event.text,
    ...(event.attachments ? { attachments: event.attachments } : {}),
    timestamp: event.timestamp,
    source: event.source,
    ...(event.sourceContext ? { sourceContext: event.sourceContext } : {}),
    ...(event.projectAgentContext ? { projectAgentContext: event.projectAgentContext } : {}),
    ...(event.pinned !== undefined ? { pinned: event.pinned } : {}),
    ...(maybeWithCollaborationAuthor.collaborationAuthor
      ? { collaborationAuthor: maybeWithCollaborationAuthor.collaborationAuthor }
      : {}),
  };
}

function isUnreadWorthyCollabMessage(event: ConversationMessageEvent): boolean {
  return (
    (event.role === "assistant" && event.source === "speak_to_user") ||
    event.source === "project_agent_input"
  );
}
