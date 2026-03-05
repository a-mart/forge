import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { getProfileIntegrationsDir, getProfilesDir } from "../swarm/data-paths.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { normalizeManagerId } from "../utils/normalize.js";
import type { IntegrationContextInfo } from "./integration-context.js";
import {
  SHARED_INTEGRATION_MANAGER_ID,
  isSharedIntegrationManagerId
} from "./shared-config.js";
import {
  hasSlackOverrideConfig,
  loadSlackConfig,
  maskSlackConfig,
  mergeSlackConfig,
  saveSlackConfig
} from "./slack/slack-config.js";
import { SlackWebApiClient, testSlackAppToken } from "./slack/slack-client.js";
import { SlackIntegrationService } from "./slack/slack-integration.js";
import type { SlackStatusEvent } from "./slack/slack-status.js";
import type {
  SlackChannelDescriptor,
  SlackConnectionTestResult,
  SlackIntegrationConfigPublic
} from "./slack/slack-types.js";
import {
  hasTelegramOverrideConfig,
  loadTelegramConfig,
  maskTelegramConfig,
  mergeTelegramConfig,
  saveTelegramConfig
} from "./telegram/telegram-config.js";
import { TelegramBotApiClient } from "./telegram/telegram-client.js";
import { TelegramIntegrationService } from "./telegram/telegram-integration.js";
import { TelegramPollingPool } from "./telegram/telegram-polling-pool.js";
import type { TelegramStatusEvent } from "./telegram/telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfigPublic
} from "./telegram/telegram-types.js";

type IntegrationProvider = "slack" | "telegram";

const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME = "managers";

export class IntegrationRegistryService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly dataDir: string;
  private readonly defaultManagerId: string | undefined;
  private readonly slackProfiles = new Map<string, SlackIntegrationService>();
  private readonly telegramProfiles = new Map<string, TelegramIntegrationService>();
  private readonly telegramPollingPool = new TelegramPollingPool();
  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

  private readonly forwardSlackStatus = (event: SlackStatusEvent): void => {
    this.emit("slack_status", event);
  };

  private readonly forwardTelegramStatus = (event: TelegramStatusEvent): void => {
    this.emit("telegram_status", event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    dataDir: string;
    defaultManagerId?: string;
  }) {
    super();
    this.swarmManager = options.swarmManager;
    this.dataDir = options.dataDir;
    this.defaultManagerId =
      normalizeOptionalManagerId(options.defaultManagerId) ??
      normalizeOptionalManagerId(this.swarmManager.getConfig().managerId);
  }

  async start(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.started) {
        return;
      }

      this.started = true;

      const managerIds = await this.discoverKnownManagerIds();
      for (const managerId of managerIds) {
        await this.startProfileInternal(managerId, "slack");
        await this.startProfileInternal(managerId, "telegram");
      }
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.started) {
        return;
      }

      for (const profile of this.slackProfiles.values()) {
        await profile.stop();
        profile.off("slack_status", this.forwardSlackStatus);
      }

      for (const profile of this.telegramProfiles.values()) {
        await profile.stop();
        profile.off("telegram_status", this.forwardTelegramStatus);
      }

      this.slackProfiles.clear();
      this.telegramProfiles.clear();
      await this.telegramPollingPool.stop();
      this.started = false;
    });
  }

  async startProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      const normalizedManagerId = this.resolveProfileId(managerId);
      if (isSharedIntegrationManagerId(normalizedManagerId)) {
        return;
      }

      this.started = true;
      await this.startProfileInternal(normalizedManagerId, provider);
    });
  }

  async stopProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      const normalizedManagerId = this.resolveProfileId(managerId);
      if (isSharedIntegrationManagerId(normalizedManagerId)) {
        return;
      }

      if (provider === "slack") {
        await this.slackProfiles.get(normalizedManagerId)?.stop();
        return;
      }

      await this.telegramProfiles.get(normalizedManagerId)?.stop();
    });
  }

  getStatus(managerId: string, provider: "slack"): SlackStatusEvent;
  getStatus(managerId: string, provider: "telegram"): TelegramStatusEvent;
  getStatus(managerId: string, provider: IntegrationProvider): SlackStatusEvent | TelegramStatusEvent {
    const normalizedManagerId = this.resolveProfileId(managerId);

    if (provider === "slack") {
      const profile = this.slackProfiles.get(normalizedManagerId);
      if (profile) {
        return profile.getStatus();
      }

      return {
        type: "slack_status",
        managerId: normalizedManagerId,
        integrationProfileId: `slack:${normalizedManagerId}`,
        state: "disabled",
        enabled: false,
        updatedAt: new Date().toISOString(),
        message: "Slack integration disabled"
      };
    }

    const profile = this.telegramProfiles.get(normalizedManagerId);
    if (profile) {
      return profile.getStatus();
    }

    return {
      type: "telegram_status",
      managerId: normalizedManagerId,
      integrationProfileId: `telegram:${normalizedManagerId}`,
      state: "disabled",
      enabled: false,
      updatedAt: new Date().toISOString(),
      message: "Telegram integration disabled"
    };
  }

  getIntegrationContext(managerId: string): IntegrationContextInfo {
    const normalizedManagerId = this.resolveProfileId(managerId);

    const telegramProfile = this.telegramProfiles.get(normalizedManagerId);
    const slackProfile = this.slackProfiles.get(normalizedManagerId);

    const telegramKnownChatIds = telegramProfile?.getKnownChatIds() ?? [];
    const slackKnownChannelIds = slackProfile?.getKnownChannelIds() ?? [];

    return {
      telegram:
        telegramProfile && (telegramProfile.isEnabled() || telegramKnownChatIds.length > 0)
          ? {
              connected: telegramProfile.isConnected(),
              botUsername: telegramProfile.getBotUsername(),
              knownChatIds: telegramKnownChatIds
            }
          : undefined,
      slack:
        slackProfile && (slackProfile.isEnabled() || slackKnownChannelIds.length > 0)
          ? {
              connected: slackProfile.isConnected(),
              knownChannelIds: slackKnownChannelIds
            }
          : undefined
    };
  }

  async getSlackSnapshot(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.getSharedSlackSnapshot();
    }

    const profile = await this.ensureSlackProfileStarted(normalizedManagerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateSlackConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.updateSharedSlackConfig(patch);
    }

    const profile = await this.ensureSlackProfileStarted(normalizedManagerId);
    return profile.updateConfig(patch);
  }

  async disableSlack(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.updateSharedSlackConfig({ enabled: false });
    }

    const profile = await this.ensureSlackProfileStarted(normalizedManagerId);
    return profile.disable();
  }

  async testSlackConnection(managerId: string, patch?: unknown): Promise<SlackConnectionTestResult> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.testSharedSlackConnection(patch);
    }

    const profile = await this.ensureSlackProfileStarted(normalizedManagerId);
    return profile.testConnection(patch);
  }

  async listSlackChannels(
    managerId: string,
    options?: { includePrivateChannels?: boolean }
  ): Promise<SlackChannelDescriptor[]> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.listSharedSlackChannels(options);
    }

    const profile = await this.ensureSlackProfileStarted(normalizedManagerId);
    return profile.listChannels(options);
  }

  async getTelegramSnapshot(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.getSharedTelegramSnapshot();
    }

    const profile = await this.ensureTelegramProfileStarted(normalizedManagerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateTelegramConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.updateSharedTelegramConfig(patch);
    }

    const profile = await this.ensureTelegramProfileStarted(normalizedManagerId);
    return profile.updateConfig(patch);
  }

  async disableTelegram(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.updateSharedTelegramConfig({ enabled: false });
    }

    const profile = await this.ensureTelegramProfileStarted(normalizedManagerId);
    return profile.disable();
  }

  async testTelegramConnection(
    managerId: string,
    patch?: unknown
  ): Promise<TelegramConnectionTestResult> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return this.testSharedTelegramConnection(patch);
    }

    const profile = await this.ensureTelegramProfileStarted(normalizedManagerId);
    return profile.testConnection(patch);
  }

  private async getSharedSlackSnapshot(): Promise<{
    config: SlackIntegrationConfigPublic;
    status: SlackStatusEvent;
  }> {
    const config = await loadSlackConfig({
      dataDir: this.dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID
    });

    return {
      config: maskSlackConfig(config),
      status: this.buildSharedSlackStatus({
        enabled: config.enabled,
        integrationProfileId: config.profileId
      })
    };
  }

  private async updateSharedSlackConfig(
    patch: unknown
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    return this.runExclusive(async () => {
      const current = await loadSlackConfig({
        dataDir: this.dataDir,
        managerId: SHARED_INTEGRATION_MANAGER_ID
      });
      const next = mergeSlackConfig(current, patch);

      await saveSlackConfig({
        dataDir: this.dataDir,
        managerId: SHARED_INTEGRATION_MANAGER_ID,
        config: next
      });

      await this.restartSlackProfilesUsingSharedConfig();

      const status = this.buildSharedSlackStatus({
        enabled: next.enabled,
        integrationProfileId: next.profileId,
        message: "Shared Slack configuration updated"
      });

      return {
        config: maskSlackConfig(next),
        status
      };
    });
  }

  private async testSharedSlackConnection(patch?: unknown): Promise<SlackConnectionTestResult> {
    const config = await loadSlackConfig({
      dataDir: this.dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID
    });
    const effectiveConfig = patch ? mergeSlackConfig(config, patch) : config;

    const appToken = effectiveConfig.appToken.trim();
    const botToken = effectiveConfig.botToken.trim();

    if (!appToken) {
      throw new Error("Slack app token is required");
    }

    if (!botToken) {
      throw new Error("Slack bot token is required");
    }

    const client = new SlackWebApiClient(botToken);
    const auth = await client.testAuth();
    await testSlackAppToken(appToken);

    return {
      ok: true,
      teamId: auth.teamId,
      teamName: auth.teamName,
      botUserId: auth.botUserId
    };
  }

  private async listSharedSlackChannels(options?: {
    includePrivateChannels?: boolean;
  }): Promise<SlackChannelDescriptor[]> {
    const config = await loadSlackConfig({
      dataDir: this.dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID
    });

    const includePrivateChannels =
      options?.includePrivateChannels ?? config.listen.includePrivateChannels;

    const token = config.botToken.trim();
    if (!token) {
      throw new Error("Slack bot token is required before listing channels");
    }

    const client = new SlackWebApiClient(token);
    return client.listChannels({ includePrivateChannels });
  }

  private async restartSlackProfilesUsingSharedConfig(): Promise<void> {
    for (const [managerId, profile] of this.slackProfiles.entries()) {
      if (isSharedIntegrationManagerId(managerId)) {
        continue;
      }

      if (await hasSlackOverrideConfig({ dataDir: this.dataDir, managerId })) {
        continue;
      }

      await profile.restart();
    }
  }

  private buildSharedSlackStatus(options: {
    enabled: boolean;
    integrationProfileId: string;
    message?: string;
  }): SlackStatusEvent {
    return {
      type: "slack_status",
      managerId: SHARED_INTEGRATION_MANAGER_ID,
      integrationProfileId: options.integrationProfileId,
      state: options.enabled ? "disconnected" : "disabled",
      enabled: options.enabled,
      updatedAt: new Date().toISOString(),
      message:
        options.message ??
        (options.enabled
          ? "Shared Slack configuration enabled (applies to managers without overrides)"
          : "Shared Slack configuration disabled")
    };
  }

  private async getSharedTelegramSnapshot(): Promise<{
    config: TelegramIntegrationConfigPublic;
    status: TelegramStatusEvent;
  }> {
    const config = await loadTelegramConfig({
      dataDir: this.dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID
    });

    return {
      config: maskTelegramConfig(config),
      status: this.buildSharedTelegramStatus({
        enabled: config.enabled,
        integrationProfileId: config.profileId
      })
    };
  }

  private async updateSharedTelegramConfig(
    patch: unknown
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    return this.runExclusive(async () => {
      const current = await loadTelegramConfig({
        dataDir: this.dataDir,
        managerId: SHARED_INTEGRATION_MANAGER_ID
      });
      const next = mergeTelegramConfig(current, patch);

      await saveTelegramConfig({
        dataDir: this.dataDir,
        managerId: SHARED_INTEGRATION_MANAGER_ID,
        config: next
      });

      await this.restartTelegramProfilesUsingSharedConfig();

      const status = this.buildSharedTelegramStatus({
        enabled: next.enabled,
        integrationProfileId: next.profileId,
        message: "Shared Telegram configuration updated"
      });

      return {
        config: maskTelegramConfig(next),
        status
      };
    });
  }

  private async testSharedTelegramConnection(
    patch?: unknown
  ): Promise<TelegramConnectionTestResult> {
    const config = await loadTelegramConfig({
      dataDir: this.dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID
    });
    const effectiveConfig = patch ? mergeTelegramConfig(config, patch) : config;

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

  private async restartTelegramProfilesUsingSharedConfig(): Promise<void> {
    for (const [managerId, profile] of this.telegramProfiles.entries()) {
      if (isSharedIntegrationManagerId(managerId)) {
        continue;
      }

      if (await hasTelegramOverrideConfig({ dataDir: this.dataDir, managerId })) {
        continue;
      }

      await profile.restart();
    }
  }

  private buildSharedTelegramStatus(options: {
    enabled: boolean;
    integrationProfileId: string;
    message?: string;
  }): TelegramStatusEvent {
    return {
      type: "telegram_status",
      managerId: SHARED_INTEGRATION_MANAGER_ID,
      integrationProfileId: options.integrationProfileId,
      state: options.enabled ? "disconnected" : "disabled",
      enabled: options.enabled,
      updatedAt: new Date().toISOString(),
      message:
        options.message ??
        (options.enabled
          ? "Shared Telegram configuration enabled (applies to managers without overrides)"
          : "Shared Telegram configuration disabled")
    };
  }

  private async ensureSlackProfileStarted(managerId: string): Promise<SlackIntegrationService> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      throw new Error("Shared Slack config does not have a runtime profile");
    }

    await this.startProfile(normalizedManagerId, "slack");
    return this.getOrCreateSlackProfile(normalizedManagerId);
  }

  private async ensureTelegramProfileStarted(managerId: string): Promise<TelegramIntegrationService> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      throw new Error("Shared Telegram config does not have a runtime profile");
    }

    await this.startProfile(normalizedManagerId, "telegram");
    return this.getOrCreateTelegramProfile(normalizedManagerId);
  }

  private async startProfileInternal(managerId: string, provider: IntegrationProvider): Promise<void> {
    const normalizedManagerId = normalizeManagerId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return;
    }

    if (provider === "slack") {
      const profile = this.getOrCreateSlackProfile(normalizedManagerId);
      await profile.start();
      return;
    }

    const profile = this.getOrCreateTelegramProfile(normalizedManagerId);
    await profile.start();
  }

  private getOrCreateSlackProfile(managerId: string): SlackIntegrationService {
    const normalizedManagerId = normalizeManagerId(managerId);
    const existing = this.slackProfiles.get(normalizedManagerId);
    if (existing) {
      return existing;
    }

    const profile = new SlackIntegrationService({
      swarmManager: this.swarmManager,
      dataDir: this.dataDir,
      managerId: normalizedManagerId
    });
    profile.on("slack_status", this.forwardSlackStatus);
    this.slackProfiles.set(normalizedManagerId, profile);
    return profile;
  }

  private getOrCreateTelegramProfile(managerId: string): TelegramIntegrationService {
    const normalizedManagerId = normalizeManagerId(managerId);
    const existing = this.telegramProfiles.get(normalizedManagerId);
    if (existing) {
      return existing;
    }

    const profile = new TelegramIntegrationService({
      swarmManager: this.swarmManager,
      dataDir: this.dataDir,
      managerId: normalizedManagerId,
      pollingPool: this.telegramPollingPool
    });
    profile.on("telegram_status", this.forwardTelegramStatus);
    this.telegramProfiles.set(normalizedManagerId, profile);
    return profile;
  }

  private resolveProfileId(managerId: string): string {
    const normalizedManagerId = normalizeManagerId(managerId);
    const descriptor = this.swarmManager.getAgent(normalizedManagerId);
    if (descriptor?.role === "manager") {
      const profileId =
        typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
          ? descriptor.profileId.trim()
          : descriptor.agentId;
      return normalizeManagerId(profileId);
    }

    return normalizedManagerId;
  }

  private async discoverKnownManagerIds(): Promise<Set<string>> {
    const managerIds = new Set<string>();
    if (this.defaultManagerId) {
      managerIds.add(this.resolveProfileId(this.defaultManagerId));
    }

    for (const descriptor of this.swarmManager.listAgents()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      const profileId =
        typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
          ? descriptor.profileId.trim()
          : descriptor.agentId;
      managerIds.add(normalizeManagerId(profileId));
    }

    const managerIdsOnDisk = await this.loadManagerIdsFromDisk();
    for (const managerId of managerIdsOnDisk) {
      managerIds.add(this.resolveProfileId(managerId));
    }

    return managerIds;
  }

  private async loadManagerIdsFromDisk(): Promise<string[]> {
    const profilesRoot = getProfilesDir(this.dataDir);

    let profileEntries: Dirent[];
    try {
      profileEntries = await readdir(profilesRoot, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        return this.loadLegacyManagerIdsFromDisk();
      }

      throw error;
    }

    const managerIds: string[] = [];

    for (const entry of profileEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const managerId = normalizeManagerId(entry.name);
      const integrationsDir = getProfileIntegrationsDir(this.dataDir, managerId);

      try {
        await readdir(integrationsDir, { withFileTypes: true });
      } catch (error) {
        if (isEnoentError(error)) {
          continue;
        }

        throw error;
      }

      managerIds.push(managerId);
    }

    return managerIds;
  }

  private async loadLegacyManagerIdsFromDisk(): Promise<string[]> {
    const managersRoot = resolve(
      this.dataDir,
      LEGACY_INTEGRATIONS_DIR_NAME,
      LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME
    );

    let entries: Dirent[];
    try {
      entries = await readdir(managersRoot, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }

      throw error;
    }

    const managerIds: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const managerId = normalizeManagerId(entry.name);
      managerIds.push(managerId);
    }

    return managerIds;
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

function normalizeOptionalManagerId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
