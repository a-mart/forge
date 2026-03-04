import { normalizeManagerId } from "../../utils/normalize.js";
import { TelegramBotApiClient } from "./telegram-client.js";
import { TelegramPollingBridge } from "./telegram-polling.js";
import type { TelegramInboundRouter } from "./telegram-router.js";
import type { TelegramConnectionState } from "./telegram-status.js";
import type { TelegramTopicManager } from "./telegram-topic-manager.js";
import type { TelegramIntegrationConfig, TelegramMessage, TelegramUpdate } from "./telegram-types.js";

interface TelegramPollingPoolEntry {
  botToken: string;
  poller: TelegramPollingBridge;
  pollerStarted: boolean;
  nextUpdateOffset: number | undefined;
  state: TelegramConnectionState;
  stateMessage: string | undefined;
  consumers: Map<string, TelegramPollingPoolConsumer>;
}

export interface TelegramPollingPoolConsumer {
  managerId: string;
  topicManager: TelegramTopicManager;
  router: TelegramInboundRouter;
  getBotId: () => string | undefined;
  getConfig: () => TelegramIntegrationConfig;
  onStateChange?: (state: TelegramConnectionState, message?: string) => void;
}

const DEFAULT_POLLING_TIMEOUT_SECONDS = 25;
const DEFAULT_POLLING_LIMIT = 100;

export class TelegramPollingPool {
  private readonly entries = new Map<string, TelegramPollingPoolEntry>();
  private lifecycle: Promise<void> = Promise.resolve();

  async register(botToken: string, consumer: TelegramPollingPoolConsumer): Promise<void> {
    const normalizedBotToken = botToken.trim();
    const normalizedManagerId = normalizeManagerId(consumer.managerId);

    if (!normalizedBotToken) {
      return;
    }

    await this.runExclusive(async () => {
      const normalizedConsumer: TelegramPollingPoolConsumer = {
        ...consumer,
        managerId: normalizedManagerId
      };

      const entry = this.ensureEntry(normalizedBotToken);
      const existing = entry.consumers.get(normalizedManagerId);
      entry.consumers.set(normalizedManagerId, normalizedConsumer);

      if (entry.pollerStarted) {
        if (!existing) {
          normalizedConsumer.onStateChange?.(entry.state, entry.stateMessage);
        }
        return;
      }

      try {
        await entry.poller.start();
        entry.pollerStarted = true;
      } catch (error) {
        entry.consumers.delete(normalizedManagerId);

        if (entry.consumers.size === 0) {
          this.entries.delete(normalizedBotToken);
        }

        throw error;
      }
    });
  }

  async unregister(botToken: string, managerId: string): Promise<void> {
    const normalizedBotToken = botToken.trim();
    const normalizedManagerId = normalizeManagerId(managerId);

    if (!normalizedBotToken) {
      return;
    }

    await this.runExclusive(async () => {
      const entry = this.entries.get(normalizedBotToken);
      if (!entry) {
        return;
      }

      entry.consumers.delete(normalizedManagerId);

      if (entry.consumers.size > 0) {
        return;
      }

      await this.stopEntry(normalizedBotToken, entry);
    });
  }

  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      const entries = Array.from(this.entries.entries());
      for (const [botToken, entry] of entries) {
        await this.stopEntry(botToken, entry);
      }

      this.entries.clear();
    });
  }

  private ensureEntry(botToken: string): TelegramPollingPoolEntry {
    const existing = this.entries.get(botToken);
    if (existing) {
      return existing;
    }

    const entry: TelegramPollingPoolEntry = {
      botToken,
      poller: this.createPoller(botToken),
      pollerStarted: false,
      nextUpdateOffset: undefined,
      state: "disconnected",
      stateMessage: "Telegram polling stopped",
      consumers: new Map()
    };

    this.entries.set(botToken, entry);
    return entry;
  }

  private createPoller(botToken: string): TelegramPollingBridge {
    return new TelegramPollingBridge({
      telegramClient: new TelegramBotApiClient(botToken),
      getPollingConfig: () => this.resolvePollingConfig(botToken),
      getOffset: () => this.entries.get(botToken)?.nextUpdateOffset,
      setOffset: (offset) => {
        const entry = this.entries.get(botToken);
        if (!entry) {
          return;
        }

        entry.nextUpdateOffset = offset;
      },
      onUpdate: async (update) => {
        await this.dispatch(botToken, update);
      },
      onStateChange: (state, message) => {
        this.notifyStateChange(botToken, state, message);
      }
    });
  }

  private resolvePollingConfig(botToken: string): {
    timeoutSeconds: number;
    limit: number;
    dropPendingUpdatesOnStart: boolean;
  } {
    const entry = this.entries.get(botToken);
    const defaultConsumer = entry ? this.getDefaultConsumer(entry) : undefined;
    const polling = defaultConsumer?.getConfig().polling;

    return {
      timeoutSeconds: normalizePollingTimeout(polling?.timeoutSeconds),
      limit: normalizePollingLimit(polling?.limit),
      dropPendingUpdatesOnStart: polling?.dropPendingUpdatesOnStart === true
    };
  }

  private async dispatch(botToken: string, update: TelegramUpdate): Promise<void> {
    const entry = this.entries.get(botToken);
    if (!entry || entry.consumers.size === 0) {
      return;
    }

    const message = extractSupportedMessage(update);
    const chatId = getMessageChatId(message);
    const messageThreadId = getMessageThreadId(message);

    console.debug(
      `[telegram-pool] dispatch update=${update.update_id} chatId=${chatId ?? "n/a"} threadId=${messageThreadId ?? "n/a"} consumers=${entry.consumers.size}`
    );

    let consumer: TelegramPollingPoolConsumer | undefined;

    if (messageThreadId !== undefined) {
      if (!chatId) {
        console.debug(
          `[telegram-pool] drop update=${update.update_id}: thread_id present but chat id missing`
        );
        return;
      }

      for (const candidate of entry.consumers.values()) {
        const resolvedSession = candidate.topicManager.resolveSessionForTopic(chatId, messageThreadId);
        console.debug(
          `[telegram-pool] candidate manager=${candidate.managerId} topicMatch=${resolvedSession ?? "none"}`
        );

        if (resolvedSession) {
          consumer = candidate;
          break;
        }
      }

      if (!consumer) {
        consumer = this.getDefaultConsumer(entry);
        console.debug(
          `[telegram-pool] no topic mapping for chatId=${chatId} threadId=${messageThreadId}; falling back to default manager=${consumer?.managerId ?? "none"}`
        );
      }
    } else {
      consumer = this.getDefaultConsumer(entry);
      console.debug(
        `[telegram-pool] non-thread message; selected default manager=${consumer?.managerId ?? "none"}`
      );
    }

    if (!consumer) {
      console.debug(`[telegram-pool] drop update=${update.update_id}: no consumer available`);
      return;
    }

    console.debug(`[telegram-pool] routing update=${update.update_id} to manager=${consumer.managerId}`);
    await consumer.router.handleUpdate(update);
  }

  private notifyStateChange(
    botToken: string,
    state: TelegramConnectionState,
    message: string | undefined
  ): void {
    const entry = this.entries.get(botToken);
    if (!entry) {
      return;
    }

    entry.state = state;
    entry.stateMessage = normalizeOptionalString(message);

    for (const consumer of entry.consumers.values()) {
      consumer.onStateChange?.(state, entry.stateMessage);
    }
  }

  private getDefaultConsumer(entry: TelegramPollingPoolEntry): TelegramPollingPoolConsumer | undefined {
    const iterator = entry.consumers.values();
    const next = iterator.next();
    return next.done ? undefined : next.value;
  }

  private async stopEntry(botToken: string, entry: TelegramPollingPoolEntry): Promise<void> {
    this.entries.delete(botToken);

    if (!entry.pollerStarted) {
      return;
    }

    entry.pollerStarted = false;

    try {
      await entry.poller.stop();
    } catch {
      // Ignore polling shutdown errors.
    }
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function extractSupportedMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

function getMessageChatId(message: TelegramMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  if (!message.chat || typeof message.chat.id !== "number" || !Number.isFinite(message.chat.id)) {
    return undefined;
  }

  return String(message.chat.id);
}

function getMessageThreadId(message: TelegramMessage | undefined): number | undefined {
  if (!message) {
    return undefined;
  }

  if (typeof message.message_thread_id !== "number" || !Number.isFinite(message.message_thread_id)) {
    return undefined;
  }

  return Math.trunc(message.message_thread_id);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePollingTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLLING_TIMEOUT_SECONDS;
  }

  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return 0;
  }

  if (normalized > 60) {
    return 60;
  }

  return normalized;
}

function normalizePollingLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLLING_LIMIT;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 100) {
    return 100;
  }

  return normalized;
}
