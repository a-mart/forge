import type {
  TelegramApiResponse,
  TelegramFile,
  TelegramGetMeResult,
  TelegramSendMessageResult,
  TelegramUpdate
} from "./telegram-types.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

interface TelegramAuthResult {
  botId: string;
  botUsername?: string;
  botDisplayName?: string;
}

interface TelegramGetUpdatesInput {
  offset?: number;
  timeoutSeconds?: number;
  limit?: number;
  signal?: AbortSignal;
}

interface TelegramSendMessageInput {
  chatId: string;
  text: string;
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
  messageThreadId?: number;
}

interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
}

interface TelegramDownloadedFile {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  size: number;
}

interface TelegramApiError extends Error {
  statusCode?: number;
  errorCode?: number;
  retryAfterSeconds?: number;
}

export class TelegramBotApiClient {
  private readonly botToken: string;
  private readonly apiBaseUrl: string;

  constructor(botToken: string) {
    this.botToken = botToken.trim();
    if (!this.botToken) {
      throw new Error("Missing Telegram bot token");
    }

    this.apiBaseUrl = `${TELEGRAM_API_BASE_URL}/bot${this.botToken}`;
  }

  async testAuth(): Promise<TelegramAuthResult> {
    const me = await this.getMe();

    return {
      botId: String(me.id),
      botUsername: normalizeOptionalString(me.username),
      botDisplayName: normalizeOptionalString(me.first_name)
    };
  }

  async getMe(): Promise<TelegramGetMeResult> {
    return this.request<TelegramGetMeResult>("getMe", {
      method: "GET"
    });
  }

  async getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdate[]> {
    const query = new URLSearchParams();

    if (typeof input.offset === "number" && Number.isFinite(input.offset)) {
      query.set("offset", String(Math.trunc(input.offset)));
    }

    if (typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)) {
      query.set("timeout", String(Math.max(0, Math.trunc(input.timeoutSeconds))));
    }

    if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
      query.set("limit", String(clamp(Math.trunc(input.limit), 1, 100)));
    }

    const updates = await this.request<TelegramUpdate[]>("getUpdates", {
      method: "GET",
      query,
      signal: input.signal
    });

    return Array.isArray(updates) ? updates : [];
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    const chatId = input.chatId.trim();
    const text = input.text.trim();

    if (!chatId) {
      throw new Error("Telegram chat id is required for outbound delivery");
    }

    if (!text) {
      throw new Error("Telegram message text is required for outbound delivery");
    }

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        const response = await this.request<{ message_id?: number; chat?: { id?: number | string } }>(
          "sendMessage",
          {
            method: "POST",
            body: {
              chat_id: chatId,
              text,
              parse_mode: input.parseMode ?? "HTML",
              disable_web_page_preview: input.disableWebPagePreview === true,
              reply_to_message_id:
                typeof input.replyToMessageId === "number" && Number.isFinite(input.replyToMessageId)
                  ? Math.trunc(input.replyToMessageId)
                  : undefined,
              message_thread_id:
                typeof input.messageThreadId === "number" && Number.isFinite(input.messageThreadId)
                  ? Math.trunc(input.messageThreadId)
                  : undefined
            }
          }
        );

        return {
          chatId: String(response.chat?.id ?? chatId),
          messageId:
            typeof response.message_id === "number" && Number.isFinite(response.message_id)
              ? response.message_id
              : 0
        };
      } catch (error) {
        const retryAfterMs = getRateLimitDelayMs(error);
        if (retryAfterMs === undefined || attempt >= maxAttempts) {
          throw error;
        }

        await sleep(retryAfterMs);
      }
    }

    throw new Error("Telegram sendMessage failed after retries");
  }

  async createForumTopic(input: {
    chatId: string;
    name: string;
    iconColor?: number;
  }): Promise<TelegramForumTopic> {
    const chatId = input.chatId.trim();
    const topicName = normalizeForumTopicName(input.name);

    if (!chatId) {
      throw new Error("Telegram chat id is required for createForumTopic");
    }

    return this.request<TelegramForumTopic>("createForumTopic", {
      method: "POST",
      body: {
        chat_id: chatId,
        name: topicName,
        icon_color:
          typeof input.iconColor === "number" && Number.isFinite(input.iconColor)
            ? Math.trunc(input.iconColor)
            : undefined
      }
    });
  }

  async editForumTopic(input: {
    chatId: string;
    messageThreadId: number;
    name?: string;
  }): Promise<true> {
    const chatId = input.chatId.trim();

    if (!chatId) {
      throw new Error("Telegram chat id is required for editForumTopic");
    }

    if (!Number.isFinite(input.messageThreadId)) {
      throw new Error("Telegram messageThreadId is required for editForumTopic");
    }

    return this.request<true>("editForumTopic", {
      method: "POST",
      body: {
        chat_id: chatId,
        message_thread_id: Math.trunc(input.messageThreadId),
        name: input.name ? normalizeForumTopicName(input.name) : undefined
      }
    });
  }

  async closeForumTopic(input: {
    chatId: string;
    messageThreadId: number;
  }): Promise<true> {
    const chatId = input.chatId.trim();

    if (!chatId) {
      throw new Error("Telegram chat id is required for closeForumTopic");
    }

    if (!Number.isFinite(input.messageThreadId)) {
      throw new Error("Telegram messageThreadId is required for closeForumTopic");
    }

    return this.request<true>("closeForumTopic", {
      method: "POST",
      body: {
        chat_id: chatId,
        message_thread_id: Math.trunc(input.messageThreadId)
      }
    });
  }

  async deleteForumTopic(input: {
    chatId: string;
    messageThreadId: number;
  }): Promise<true> {
    const chatId = input.chatId.trim();

    if (!chatId) {
      throw new Error("Telegram chat id is required for deleteForumTopic");
    }

    if (!Number.isFinite(input.messageThreadId)) {
      throw new Error("Telegram messageThreadId is required for deleteForumTopic");
    }

    return this.request<true>("deleteForumTopic", {
      method: "POST",
      body: {
        chat_id: chatId,
        message_thread_id: Math.trunc(input.messageThreadId)
      }
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) {
      throw new Error("Telegram file id is required");
    }

    return this.request<TelegramFile>("getFile", {
      method: "POST",
      body: {
        file_id: normalizedFileId
      }
    });
  }

  async downloadFile(options: {
    filePath: string;
    mimeType?: string;
    fileName?: string;
  }): Promise<TelegramDownloadedFile> {
    const filePath = options.filePath.trim();
    if (!filePath) {
      throw new Error("Telegram file path is required");
    }

    const url = `${TELEGRAM_API_BASE_URL}/file/bot${this.botToken}/${filePath}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Telegram file download failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      size: buffer.byteLength,
      mimeType: normalizeOptionalString(options.mimeType) ?? "application/octet-stream",
      fileName: normalizeOptionalString(options.fileName) ?? "attachment"
    };
  }

  private async request<T>(
    method: string,
    options: {
      method: "GET" | "POST";
      query?: URLSearchParams;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}/${method}`);
    if (options.query) {
      url.search = options.query.toString();
    }

    const response = await fetch(url, {
      method: options.method,
      signal: options.signal,
      headers:
        options.method === "POST"
          ? {
              "content-type": "application/json"
            }
          : undefined,
      body: options.method === "POST" ? JSON.stringify(removeUndefined(options.body ?? {})) : undefined
    });

    let payload: TelegramApiResponse<T> | null = null;

    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw toTelegramApiError(method, response.status, payload);
    }

    if (!payload || payload.ok !== true || payload.result === undefined) {
      throw toTelegramApiError(method, response.status, payload);
    }

    return payload.result;
  }
}

function toTelegramApiError(
  method: string,
  statusCode: number,
  payload: TelegramApiResponse<unknown> | null
): TelegramApiError {
  const errorCode = payload?.error_code;
  const description = normalizeOptionalString(payload?.description) ?? "unknown_error";
  const retryAfterSeconds =
    typeof payload?.parameters?.retry_after === "number" && Number.isFinite(payload.parameters.retry_after)
      ? payload.parameters.retry_after
      : undefined;

  const error = new Error(`Telegram ${method} failed: ${description}`) as TelegramApiError;
  error.statusCode = statusCode;
  if (typeof errorCode === "number") {
    error.errorCode = errorCode;
  }

  if (
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    error.retryAfterSeconds = retryAfterSeconds;
  }

  return error;
}

function getRateLimitDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybe = error as TelegramApiError;
  const isRateLimited = maybe.errorCode === 429 || maybe.statusCode === 429;

  if (!isRateLimited) {
    return undefined;
  }

  const retryAfterSeconds = maybe.retryAfterSeconds;
  if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 1000;
  }

  return retryAfterSeconds * 1000;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeForumTopicName(value: string): string {
  const normalized = value.trim().slice(0, 128);
  if (!normalized) {
    throw new Error("Telegram forum topic name is required");
  }

  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
