import type { ServerEvent } from "@middleman/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import { TelegramBotApiClient } from "./telegram-client.js";
import { markdownToTelegramHtml } from "./telegram-markdown.js";
import type { TelegramIntegrationConfig } from "./telegram-types.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export class TelegramDeliveryBridge {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly getConfig: () => TelegramIntegrationConfig;
  private readonly getProfileId: () => string;
  private readonly getTelegramClient: () => TelegramBotApiClient | null;
  private readonly onError?: (message: string, error?: unknown) => void;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") {
      return;
    }

    void this.forwardConversationMessage(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    managerId: string;
    getConfig: () => TelegramIntegrationConfig;
    getProfileId: () => string;
    getTelegramClient: () => TelegramBotApiClient | null;
    onError?: (message: string, error?: unknown) => void;
  }) {
    this.swarmManager = options.swarmManager;
    this.managerId = normalizeManagerId(options.managerId);
    this.getConfig = options.getConfig;
    this.getProfileId = options.getProfileId;
    this.getTelegramClient = options.getTelegramClient;
    this.onError = options.onError;
  }

  start(): void {
    this.swarmManager.on("conversation_message", this.onConversationMessage);
  }

  stop(): void {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
  }

  private async forwardConversationMessage(
    event: Extract<ServerEvent, { type: "conversation_message" }>
  ): Promise<void> {
    if (!event.sourceContext || event.sourceContext.channel !== "telegram") {
      return;
    }

    if (event.source === "user_input") {
      return;
    }

    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }

    if (event.agentId !== this.managerId) {
      return;
    }

    const eventProfileId = normalizeOptionalString(event.sourceContext.integrationProfileId);
    const profileId = normalizeOptionalString(this.getProfileId());
    if (eventProfileId && profileId && eventProfileId !== profileId) {
      return;
    }

    const telegramClient = this.getTelegramClient();
    if (!telegramClient) {
      return;
    }

    const channelId = normalizeOptionalString(event.sourceContext.channelId);
    if (!channelId) {
      return;
    }

    const chunks = toTelegramHtmlChunks(event.text, TELEGRAM_MESSAGE_LIMIT);
    if (chunks.length === 0) {
      return;
    }

    let replyToMessageId =
      config.delivery.replyToInboundMessageByDefault
        ? parseOptionalMessageId(event.sourceContext.messageId)
        : undefined;

    for (const chunk of chunks) {
      try {
        await telegramClient.sendMessage({
          chatId: channelId,
          text: chunk,
          parseMode: config.delivery.parseMode,
          disableWebPagePreview: config.delivery.disableLinkPreview,
          replyToMessageId
        });

        replyToMessageId = undefined;
      } catch (error) {
        this.onError?.("Failed to deliver Telegram message", error);
        return;
      }
    }
  }
}

function toTelegramHtmlChunks(markdown: string, maxLength: number): string[] {
  const normalized = markdown.trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  splitMarkdownChunk(normalized, maxLength, chunks, 0);
  return chunks;
}

function splitMarkdownChunk(markdown: string, maxLength: number, chunks: string[], depth: number): void {
  const normalized = markdown.trim();
  if (!normalized) {
    return;
  }

  const html = markdownToTelegramHtml(normalized);
  if (!html) {
    return;
  }

  if (html.length <= maxLength) {
    chunks.push(html);
    return;
  }

  if (normalized.length <= 1 || depth > 18) {
    chunks.push(html.slice(0, maxLength));
    return;
  }

  const splitIndex = findSplitIndex(normalized);
  const left = normalized.slice(0, splitIndex).trim();
  const right = normalized.slice(splitIndex).trim();

  if (!left || !right) {
    const midpoint = Math.max(1, Math.floor(normalized.length / 2));
    splitMarkdownChunk(normalized.slice(0, midpoint), maxLength, chunks, depth + 1);
    splitMarkdownChunk(normalized.slice(midpoint), maxLength, chunks, depth + 1);
    return;
  }

  splitMarkdownChunk(left, maxLength, chunks, depth + 1);
  splitMarkdownChunk(right, maxLength, chunks, depth + 1);
}

function findSplitIndex(value: string): number {
  const midpoint = Math.floor(value.length / 2);
  const candidate = value.slice(0, midpoint + 1);
  const newlineIndex = candidate.lastIndexOf("\n");
  const spaceIndex = candidate.lastIndexOf(" ");
  const splitIndex = Math.max(newlineIndex, spaceIndex);

  if (splitIndex > value.length * 0.25) {
    return splitIndex;
  }

  return Math.max(1, midpoint);
}

function parseOptionalMessageId(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
