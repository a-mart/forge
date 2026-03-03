import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import type { TelegramBotApiClient } from "./telegram-client.js";
import {
  addTopicMapping,
  findSessionForTopic,
  findTopicForSession,
  loadTopicStore,
  removeTopicMapping,
  saveTopicStore,
  type TelegramTopicMapping,
  type TelegramTopicStore
} from "./telegram-topic-store.js";

export class TelegramTopicManager {
  private readonly managerId: string;
  private readonly dataDir: string;
  private readonly getTelegramClient: () => TelegramBotApiClient | null;
  private readonly getSwarmManager: () => SwarmManager;
  private readonly onError?: (message: string, error?: unknown) => void;

  private store: TelegramTopicStore = { mappings: [] };

  constructor(options: {
    managerId: string;
    dataDir: string;
    getTelegramClient: () => TelegramBotApiClient | null;
    getSwarmManager: () => SwarmManager;
    onError?: (message: string, error?: unknown) => void;
  }) {
    this.managerId = normalizeManagerId(options.managerId);
    this.dataDir = options.dataDir;
    this.getTelegramClient = options.getTelegramClient;
    this.getSwarmManager = options.getSwarmManager;
    this.onError = options.onError;
  }

  async initialize(): Promise<void> {
    try {
      this.store = await loadTopicStore(this.dataDir, this.managerId);
    } catch (error) {
      this.onError?.("Failed to load Telegram topic store", error);
      this.store = { mappings: [] };
    }
  }

  getStore(): TelegramTopicStore {
    return {
      mappings: this.store.mappings.map((mapping) => ({ ...mapping }))
    };
  }

  async resolveTopicForSession(sessionAgentId: string, chatId: string): Promise<number | undefined> {
    const normalizedSessionAgentId = sessionAgentId.trim();
    const normalizedChatId = chatId.trim();

    if (!normalizedSessionAgentId || !normalizedChatId) {
      return undefined;
    }

    const existing = findTopicForSession(this.store, normalizedSessionAgentId, normalizedChatId);
    if (existing) {
      return existing.messageThreadId;
    }

    const client = this.getTelegramClient();
    if (!client) {
      return undefined;
    }

    const descriptor = this.getSwarmManager().getAgent(normalizedSessionAgentId);
    const topicName = normalizeTopicName(
      descriptor?.sessionLabel ?? descriptor?.displayName ?? normalizedSessionAgentId
    );

    try {
      const topic = await client.createForumTopic({
        chatId: normalizedChatId,
        name: topicName
      });

      const mapping: TelegramTopicMapping = {
        sessionAgentId: normalizedSessionAgentId,
        chatId: normalizedChatId,
        messageThreadId: topic.message_thread_id,
        topicName,
        createdAt: new Date().toISOString()
      };

      addTopicMapping(this.store, mapping);
      await this.persistStore();

      return topic.message_thread_id;
    } catch (error) {
      return this.handleTopicOperationFailure("Failed to create Telegram forum topic", error);
    }
  }

  resolveSessionForTopic(chatId: string, messageThreadId: number | undefined): string | undefined {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    if (typeof messageThreadId !== "number" || !Number.isFinite(messageThreadId)) {
      return undefined;
    }

    const mapping = findSessionForTopic(this.store, normalizedChatId, Math.trunc(messageThreadId));
    return mapping?.sessionAgentId;
  }

  async renameTopicForSession(sessionAgentId: string, newName: string): Promise<void> {
    const normalizedSessionAgentId = sessionAgentId.trim();
    if (!normalizedSessionAgentId) {
      return;
    }

    const mappings = this.store.mappings.filter(
      (mapping) => mapping.sessionAgentId === normalizedSessionAgentId
    );
    if (mappings.length === 0) {
      return;
    }

    const client = this.getTelegramClient();
    if (!client) {
      return;
    }

    const normalizedName = normalizeTopicName(newName);
    let storeUpdated = false;

    for (const mapping of mappings) {
      try {
        await client.editForumTopic({
          chatId: mapping.chatId,
          messageThreadId: mapping.messageThreadId,
          name: normalizedName
        });
        mapping.topicName = normalizedName;
        storeUpdated = true;
      } catch (error) {
        this.onError?.("Failed to rename Telegram forum topic", error);
      }
    }

    if (storeUpdated) {
      await this.persistStore();
    }
  }

  async closeTopicForSession(sessionAgentId: string): Promise<void> {
    const normalizedSessionAgentId = sessionAgentId.trim();
    if (!normalizedSessionAgentId) {
      return;
    }

    const removedMappings: TelegramTopicMapping[] = [];
    while (true) {
      const removed = removeTopicMapping(this.store, normalizedSessionAgentId);
      if (!removed) {
        break;
      }

      removedMappings.push(removed);
    }

    if (removedMappings.length === 0) {
      return;
    }

    const client = this.getTelegramClient();
    if (client) {
      for (const mapping of removedMappings) {
        try {
          await client.closeForumTopic({
            chatId: mapping.chatId,
            messageThreadId: mapping.messageThreadId
          });
        } catch (error) {
          this.onError?.("Failed to close Telegram forum topic", error);
        }
      }
    }

    await this.persistStore();
  }

  async createTopicForFork(
    sourceAgentId: string,
    forkAgentId: string,
    forkLabel: string
  ): Promise<void> {
    const normalizedSourceAgentId = sourceAgentId.trim();
    const normalizedForkAgentId = forkAgentId.trim();

    if (!normalizedSourceAgentId || !normalizedForkAgentId || normalizedForkAgentId === this.managerId) {
      return;
    }

    const sourceMappings = this.store.mappings.filter(
      (mapping) => mapping.sessionAgentId === normalizedSourceAgentId
    );

    const client = this.getTelegramClient();
    if (!client || sourceMappings.length === 0) {
      return;
    }

    const topicName = normalizeTopicName(forkLabel || normalizedForkAgentId);
    let created = false;

    for (const sourceMapping of sourceMappings) {
      try {
        const topic = await client.createForumTopic({
          chatId: sourceMapping.chatId,
          name: topicName
        });

        addTopicMapping(this.store, {
          sessionAgentId: normalizedForkAgentId,
          chatId: sourceMapping.chatId,
          messageThreadId: topic.message_thread_id,
          topicName,
          createdAt: new Date().toISOString()
        });

        created = true;
      } catch (error) {
        this.onError?.("Failed to create Telegram forum topic for forked session", error);
      }
    }

    if (created) {
      await this.persistStore();
    }
  }

  private async persistStore(): Promise<void> {
    await saveTopicStore(this.dataDir, this.managerId, this.store);
  }

  private handleTopicOperationFailure(
    message: string,
    error: unknown
  ): number | undefined {
    this.onError?.(message, error);
    return undefined;
  }
}

function normalizeTopicName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Session";
  }

  return trimmed.slice(0, 128);
}
