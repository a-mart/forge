import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type {
  ConversationAttachment,
  MessageSourceContext
} from "../../swarm/types.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import type {
  TelegramIntegrationConfig,
  TelegramMessage,
  TelegramUpdate
} from "./telegram-types.js";

const DEDUPE_TTL_MS = 30 * 60 * 1000;

export class TelegramInboundRouter {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly integrationProfileId: string;
  private readonly getConfig: () => TelegramIntegrationConfig;
  private readonly getBotId: () => string | undefined;
  private readonly onError?: (message: string, error?: unknown) => void;
  private readonly seenUpdateIds = new Map<number, number>();

  constructor(options: {
    swarmManager: SwarmManager;
    managerId: string;
    integrationProfileId: string;
    getConfig: () => TelegramIntegrationConfig;
    getBotId: () => string | undefined;
    onError?: (message: string, error?: unknown) => void;
  }) {
    this.swarmManager = options.swarmManager;
    this.managerId = normalizeManagerId(options.managerId);
    this.integrationProfileId = options.integrationProfileId.trim();
    this.getConfig = options.getConfig;
    this.getBotId = options.getBotId;
    this.onError = options.onError;
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const updateId = normalizeUpdateId(update.update_id);
    if (updateId === undefined || this.isDuplicate(updateId)) {
      return;
    }

    const message = this.extractSupportedMessage(update);
    if (!message) {
      return;
    }

    if (this.shouldIgnoreMessage(message)) {
      return;
    }

    const config = this.getConfig();
    if (this.shouldIgnoreByAllowlist(message, config.allowedUserIds)) {
      return;
    }

    const text = normalizeInboundText(message.text ?? message.caption ?? "");
    const attachments: ConversationAttachment[] = [];

    if (!text && attachments.length === 0) {
      return;
    }

    const sourceContext: MessageSourceContext = {
      channel: "telegram",
      channelId: String(message.chat.id),
      userId: message.from ? String(message.from.id) : undefined,
      messageId: String(message.message_id),
      integrationProfileId: this.integrationProfileId,
      threadTs:
        typeof message.message_thread_id === "number" && Number.isFinite(message.message_thread_id)
          ? String(message.message_thread_id)
          : undefined,
      channelType: resolveChannelType(message.chat.type)
    };

    try {
      await this.swarmManager.handleUserMessage(text, {
        targetAgentId: this.managerId,
        attachments,
        sourceContext
      });
    } catch (error) {
      this.onError?.("Failed to route Telegram message to swarm manager", error);
    }
  }

  private extractSupportedMessage(update: TelegramUpdate): TelegramMessage | null {
    if (update.message) {
      return update.message;
    }

    if (update.channel_post) {
      return update.channel_post;
    }

    return null;
  }

  private shouldIgnoreMessage(message: TelegramMessage): boolean {
    if (!message.chat || typeof message.chat.id !== "number" || !Number.isFinite(message.chat.id)) {
      return true;
    }

    if (typeof message.message_id !== "number" || !Number.isFinite(message.message_id)) {
      return true;
    }

    if (message.from?.is_bot) {
      return true;
    }

    const botId = this.getBotId();
    if (botId && message.from && String(message.from.id) === botId) {
      return true;
    }

    return false;
  }

  private shouldIgnoreByAllowlist(message: TelegramMessage, allowedUserIds: string[]): boolean {
    if (allowedUserIds.length === 0) {
      return false;
    }

    const userId = message.from ? String(message.from.id) : undefined;
    if (userId && allowedUserIds.includes(userId)) {
      return false;
    }

    const reason = userId ? `user ${userId} is not allowlisted` : "message has no sender user id";
    console.debug(
      `[telegram] Ignoring inbound message ${message.message_id} from chat ${message.chat.id}: ${reason}`
    );
    return true;
  }

  private isDuplicate(updateId: number): boolean {
    this.pruneSeenUpdateIds();

    if (this.seenUpdateIds.has(updateId)) {
      return true;
    }

    this.seenUpdateIds.set(updateId, Date.now());
    return false;
  }

  private pruneSeenUpdateIds(): void {
    const now = Date.now();

    for (const [updateId, seenAt] of this.seenUpdateIds.entries()) {
      if (now - seenAt > DEDUPE_TTL_MS) {
        this.seenUpdateIds.delete(updateId);
      }
    }
  }
}

function resolveChannelType(chatType: TelegramMessage["chat"]["type"]): MessageSourceContext["channelType"] {
  if (chatType === "private") {
    return "dm";
  }

  if (chatType === "channel") {
    return "channel";
  }

  if (chatType === "group" || chatType === "supergroup") {
    return "group";
  }

  return undefined;
}

function normalizeInboundText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUpdateId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.trunc(value);
}
