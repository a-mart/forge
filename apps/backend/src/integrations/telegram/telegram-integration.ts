import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { SessionLifecycleEvent } from "../../swarm/types.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import {
  BaseIntegrationService,
  toIntegrationErrorMessage
} from "../base-integration-service.js";
import {
  createDefaultTelegramConfig,
  loadTelegramConfig,
  maskTelegramConfig,
  mergeTelegramConfig,
  saveTelegramConfig
} from "./telegram-config.js";
import { TelegramBotApiClient } from "./telegram-client.js";
import { TelegramDeliveryBridge } from "./telegram-delivery.js";
import {
  TelegramPollingPool,
  type TelegramPollingPoolConsumer
} from "./telegram-polling-pool.js";
import { TelegramInboundRouter } from "./telegram-router.js";
import { TelegramTopicManager } from "./telegram-topic-manager.js";
import {
  TelegramStatusTracker,
  type TelegramStatusEvent,
  type TelegramStatusUpdate
} from "./telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic
} from "./telegram-types.js";

export class TelegramIntegrationService extends BaseIntegrationService<
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic,
  TelegramStatusEvent,
  TelegramStatusUpdate
> {
  private readonly pollingPool: TelegramPollingPool;
  private telegramClient: TelegramBotApiClient | null = null;
  private inboundRouter: TelegramInboundRouter | null = null;
  private readonly topicManager: TelegramTopicManager;
  private readonly deliveryBridge: TelegramDeliveryBridge;

  private botId: string | undefined;
  private botUsername: string | undefined;
  private registeredBotToken: string | undefined;

  private readonly onSessionLifecycle = (event: SessionLifecycleEvent): void => {
    if (event.profileId !== this.managerId) {
      return;
    }

    if (!this.config.enabled || !this.telegramClient) {
      return;
    }

    void this.handleSessionLifecycle(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    dataDir: string;
    managerId: string;
    pollingPool: TelegramPollingPool;
  }) {
    const managerId = normalizeManagerId(options.managerId);
    const defaultConfig = createDefaultTelegramConfig(managerId);
    const statusTracker = new TelegramStatusTracker({
      managerId,
      integrationProfileId: defaultConfig.profileId,
      state: "disabled",
      enabled: false,
      message: "Telegram integration disabled"
    });

    super({
      swarmManager: options.swarmManager,
      dataDir: options.dataDir,
      managerId,
      defaultConfig,
      statusTracker,
      statusEventName: "telegram_status",
      loadConfig: loadTelegramConfig,
      saveConfig: saveTelegramConfig,
      mergeConfig: mergeTelegramConfig,
      maskConfig: maskTelegramConfig
    });

    this.pollingPool = options.pollingPool;

    this.topicManager = new TelegramTopicManager({
      managerId: this.managerId,
      dataDir: this.dataDir,
      getTelegramClient: () => this.telegramClient,
      getSwarmManager: () => this.swarmManager,
      onError: (message, error) => {
        console.debug(`[telegram] ${message}: ${toIntegrationErrorMessage(error)}`);
      }
    });

    this.deliveryBridge = new TelegramDeliveryBridge({
      swarmManager: this.swarmManager,
      managerId: this.managerId,
      getConfig: () => this.config,
      getProfileId: () => this.config.profileId,
      getTelegramClient: () => this.telegramClient,
      topicManager: this.topicManager,
      onError: (message, error) => {
        this.updateStatus({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: this.config.enabled,
          message: `${message}: ${toIntegrationErrorMessage(error)}`,
          botId: this.botId,
          botUsername: this.botUsername
        });
      }
    });
  }

  async testConnection(patch?: unknown): Promise<TelegramConnectionTestResult> {
    const effectiveConfig = patch ? mergeTelegramConfig(this.config, patch) : this.config;

    const botToken = effectiveConfig.botToken.trim();
    if (!botToken) {
      throw new Error("Telegram bot token is required");
    }

    const client = new TelegramBotApiClient(botToken);
    const auth = await client.testAuth();

    return {
      ok: true,
      botId: auth.botId,
      botUsername: auth.botUsername,
      botDisplayName: auth.botDisplayName
    };
  }

  getTopicManager(): TelegramTopicManager {
    return this.topicManager;
  }

  getRouter(): TelegramInboundRouter | null {
    return this.inboundRouter;
  }

  getBotId(): string | undefined {
    return this.botId;
  }

  getConfig(): TelegramIntegrationConfig {
    return this.config;
  }

  getKnownChatIds(): string[] {
    const knownChatIds = new Set<string>();

    for (const mapping of this.topicManager.getStore().mappings) {
      const normalizedChatId = normalizeOptionalString(mapping.chatId);
      if (normalizedChatId) {
        knownChatIds.add(normalizedChatId);
      }
    }

    for (const allowedUserId of this.config.allowedUserIds) {
      const normalizedUserId = normalizeOptionalString(allowedUserId);
      if (normalizedUserId) {
        knownChatIds.add(normalizedUserId);
      }
    }

    return Array.from(knownChatIds).sort((left, right) => left.localeCompare(right));
  }

  getBotUsername(): string | undefined {
    return this.botUsername;
  }

  isConnected(): boolean {
    return this.config.enabled && this.telegramClient !== null;
  }

  protected async applyConfig(): Promise<void> {
    await this.stopRuntime();

    this.telegramClient = null;
    this.inboundRouter = null;
    this.botId = undefined;
    this.botUsername = undefined;
    this.registeredBotToken = undefined;

    await this.topicManager.initialize();

    if (!this.config.enabled) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "disabled",
        enabled: false,
        message: "Telegram integration disabled",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    const botToken = this.config.botToken.trim();
    if (!botToken) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: "Telegram bot token is required",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    try {
      const telegramClient = new TelegramBotApiClient(botToken);
      const auth = await telegramClient.testAuth();

      this.telegramClient = telegramClient;
      this.botId = auth.botId;
      this.botUsername = auth.botUsername;

      const inboundRouter = new TelegramInboundRouter({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        getConfig: () => this.config,
        getBotId: () => this.botId,
        topicManager: this.topicManager,
        onError: (message, error) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state: "error",
            enabled: this.config.enabled,
            message: `${message}: ${toIntegrationErrorMessage(error)}`,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      });

      this.inboundRouter = inboundRouter;

      const consumer: TelegramPollingPoolConsumer = {
        managerId: this.managerId,
        topicManager: this.topicManager,
        router: inboundRouter,
        getBotId: () => this.botId,
        getConfig: () => this.config,
        onStateChange: (state, message) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state,
            enabled: this.config.enabled,
            message,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      };

      await this.pollingPool.register(botToken, consumer);
      this.registeredBotToken = botToken;

      this.swarmManager.on("session_lifecycle", this.onSessionLifecycle);

      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "connected",
        enabled: true,
        message: "Telegram connected",
        botId: this.botId,
        botUsername: this.botUsername
      });
    } catch (error) {
      await this.stopRuntime();
      this.telegramClient = null;
      this.inboundRouter = null;

      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: `Telegram startup failed: ${toIntegrationErrorMessage(error)}`,
        botId: this.botId,
        botUsername: this.botUsername
      });
    }
  }

  protected async stopRuntime(): Promise<void> {
    this.swarmManager.off("session_lifecycle", this.onSessionLifecycle);
    await this.unregisterPollingConsumer();
  }

  protected startDeliveryBridge(): void {
    this.deliveryBridge.start();
  }

  protected stopDeliveryBridge(): void {
    this.deliveryBridge.stop();
  }

  protected buildLoadConfigErrorStatus(error: unknown): TelegramStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: "error",
      enabled: false,
      message: `Failed to load Telegram config: ${toIntegrationErrorMessage(error)}`,
      botId: undefined,
      botUsername: undefined
    };
  }

  protected buildStoppedStatus(): TelegramStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: this.config.enabled ? "disconnected" : "disabled",
      enabled: this.config.enabled,
      message: this.config.enabled ? "Telegram integration stopped" : "Telegram integration disabled",
      botId: this.botId,
      botUsername: this.botUsername
    };
  }

  private async handleSessionLifecycle(event: SessionLifecycleEvent): Promise<void> {
    try {
      switch (event.action) {
        case "renamed":
          if (event.label) {
            await this.topicManager.renameTopicForSession(event.sessionAgentId, event.label);
          }
          break;

        case "deleted":
          await this.topicManager.closeTopicForSession(event.sessionAgentId);
          break;

        case "forked":
          if (event.sourceAgentId && event.label) {
            await this.topicManager.createTopicForFork(
              event.sourceAgentId,
              event.sessionAgentId,
              `🔀 ${event.label}`
            );
          }
          break;

        case "created":
          break;
      }
    } catch (error) {
      console.debug(
        `[telegram] Failed to sync topic for session lifecycle action ${event.action}: ${toIntegrationErrorMessage(error)}`
      );
    }
  }

  private async unregisterPollingConsumer(): Promise<void> {
    if (!this.registeredBotToken) {
      return;
    }

    const botToken = this.registeredBotToken;
    this.registeredBotToken = undefined;

    try {
      await this.pollingPool.unregister(botToken, this.managerId);
    } catch {
      // Ignore shared polling pool shutdown errors.
    }
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
