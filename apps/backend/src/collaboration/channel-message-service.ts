import type { CollaborationAuthor, CollaborationChannel } from "@forge/protocol";
import type {
  AppendConversationUserMessageResult,
  DispatchRuntimeUserMessageOptions,
} from "../swarm/swarm-manager.js";
import type { ConversationAttachment } from "../swarm/types.js";
import type { CollaborationDbHelpers } from "./collab-db-helpers.js";
import type { CollaborationChannelService } from "./channel-service.js";
import type { CollaborationUserService } from "./user-service.js";

export interface CollaborationChannelMessageServiceSwarmManager {
  appendConversationUserMessage(
    text: string,
    options: {
      targetAgentId: string;
      attachments?: ConversationAttachment[];
      sourceContext: {
        channel: "web";
        channelId: string;
        userId: string;
      };
      collaborationAuthor: CollaborationAuthor;
    },
  ): Promise<AppendConversationUserMessageResult>;
  dispatchRuntimeUserMessage(options: DispatchRuntimeUserMessageOptions): Promise<void>;
}

export interface DispatchCollaborationChannelMessageParams {
  channelId: string;
  userId: string;
  text: string;
  attachments?: ConversationAttachment[];
}

export interface DispatchCollaborationChannelMessageResult {
  channel: CollaborationChannel;
  backingSessionAgentId: string;
  messageId?: string;
  aiEnabled: boolean;
  lastMessageSeq: number;
  timestamp: string;
}

export class CollaborationChannelMessageServiceError extends Error {
  constructor(
    public readonly code: "channel_not_found" | "channel_archived" | "user_not_found" | "user_disabled",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationChannelMessageServiceError";
  }
}

export class CollaborationChannelMessageService {
  constructor(
    private readonly swarmManager: CollaborationChannelMessageServiceSwarmManager,
    private readonly channelService: Pick<CollaborationChannelService, "getChannel">,
    private readonly dbHelpers: Pick<
      CollaborationDbHelpers,
      "database" | "advanceChannelActivity" | "getChannelUserState" | "upsertChannelReadState"
    >,
    private readonly userService: Pick<CollaborationUserService, "getUser">,
  ) {}

  async dispatchUserMessage(
    params: DispatchCollaborationChannelMessageParams,
  ): Promise<DispatchCollaborationChannelMessageResult> {
    const channelId = normalizeRequiredString(params.channelId, "channelId");
    const userId = normalizeRequiredString(params.userId, "userId");
    const channel = this.channelService.getChannel(channelId);
    if (channel.archived) {
      throw new CollaborationChannelMessageServiceError(
        "channel_archived",
        `Collaboration channel ${channelId} is archived`,
      );
    }

    const user = this.userService.getUser(userId);
    if (!user) {
      throw new CollaborationChannelMessageServiceError(
        "user_not_found",
        `Unknown collaboration user: ${userId}`,
      );
    }
    if (user.disabled) {
      throw new CollaborationChannelMessageServiceError(
        "user_disabled",
        `Collaboration user ${userId} is disabled`,
      );
    }

    const collaborationAuthor: CollaborationAuthor = {
      userId: user.userId,
      displayName: user.name,
      role: user.role,
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
    };

    const appendedMessage = await this.swarmManager.appendConversationUserMessage(params.text, {
      targetAgentId: channel.sessionAgentId,
      attachments: params.attachments,
      sourceContext: {
        channel: "web",
        channelId: channel.channelId,
        userId: user.userId,
      },
      collaborationAuthor,
    });

    const activity = this.updateChannelActivityAndReadState(
      channel.channelId,
      user.userId,
      appendedMessage,
    );
    const nextChannel: CollaborationChannel = {
      ...channel,
      lastMessageSeq: activity.lastMessageSeq,
      ...(activity.lastMessageId ? { lastMessageId: activity.lastMessageId } : {}),
      ...(activity.lastMessageAt ? { lastMessageAt: activity.lastMessageAt } : {}),
      updatedAt: activity.updatedAt,
    };

    if (channel.aiEnabled) {
      await this.swarmManager.dispatchRuntimeUserMessage({
        targetAgentId: channel.sessionAgentId,
        text: appendedMessage.text,
        sourceContext: appendedMessage.sourceContext,
        collaborationAuthor: appendedMessage.event.collaborationAuthor,
        runtimeAttachments: appendedMessage.runtimeAttachments,
        persistedAttachmentCount: appendedMessage.persistedAttachments.length,
      });
    }

    return {
      channel: nextChannel,
      backingSessionAgentId: channel.sessionAgentId,
      messageId: appendedMessage.event.id,
      aiEnabled: channel.aiEnabled,
      lastMessageSeq: activity.lastMessageSeq,
      timestamp: appendedMessage.receivedAt,
    };
  }

  private updateChannelActivityAndReadState(
    channelId: string,
    userId: string,
    appendedMessage: AppendConversationUserMessageResult,
  ): { lastMessageSeq: number; lastMessageId: string | null; lastMessageAt: string | null; updatedAt: string } {
    const transaction = this.dbHelpers.database.transaction(() => {
      const currentState = this.dbHelpers.getChannelUserState(channelId, userId);
      const messageId = appendedMessage.event.id ?? null;
      const timestamp = appendedMessage.receivedAt;
      const updatedChannel = this.dbHelpers.advanceChannelActivity(channelId, {
        lastMessageId: messageId,
        lastMessageAt: timestamp,
        updatedAt: timestamp,
      });

      if (!updatedChannel) {
        throw new CollaborationChannelMessageServiceError(
          "channel_not_found",
          `Unknown collaboration channel: ${channelId}`,
        );
      }

      this.dbHelpers.upsertChannelReadState({
        channelId,
        userId,
        lastReadMessageId: messageId,
        lastReadMessageSeq: updatedChannel.lastMessageSeq,
        lastReadAt: timestamp,
        createdAt: currentState?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });

      return {
        lastMessageSeq: updatedChannel.lastMessageSeq,
        lastMessageId: updatedChannel.lastMessageId,
        lastMessageAt: updatedChannel.lastMessageAt,
        updatedAt: updatedChannel.updatedAt,
      };
    });

    return transaction();
  }
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration channel message ${fieldName}`);
  }

  return normalized;
}
