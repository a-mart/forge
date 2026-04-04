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

type IntegrationProvider = "telegram";

const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME = "managers";

export class IntegrationRegistryService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly dataDir: string;
  private readonly defaultManagerId: string | undefined;
  private readonly telegramProfiles = new Map<string, TelegramIntegrationService>();
  private readonly telegramPollingPool = new TelegramPollingPool();
  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

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
        await this.startProfileInternal(managerId, "telegram");
      }
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.started) {
        return;
      }

      for (const profile of this.telegramProfiles.values()) {
        await profile.stop();
        profile.off("telegram_status", this.forwardTelegramStatus);
      }

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

  async stopProfile(managerId: string, _provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      const normalizedManagerId = this.resolveProfileId(managerId);
      if (isSharedIntegrationManagerId(normalizedManagerId)) {
        return;
      }

      await this.telegramProfiles.get(normalizedManagerId)?.stop();
    });
  }

  getStatus(managerId: string, _provider: "telegram"): TelegramStatusEvent {
    const normalizedManagerId = this.resolveProfileId(managerId);

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
    const telegramKnownChatIds = telegramProfile?.getKnownChatIds() ?? [];

    return {
      telegram:
        telegramProfile && (telegramProfile.isEnabled() || telegramKnownChatIds.length > 0)
          ? {
              connected: telegramProfile.isConnected(),
              botUsername: telegramProfile.getBotUsername(),
              knownChatIds: telegramKnownChatIds
            }
          : undefined
    };
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

  private async ensureTelegramProfileStarted(managerId: string): Promise<TelegramIntegrationService> {
    const normalizedManagerId = this.resolveProfileId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      throw new Error("Shared Telegram config does not have a runtime profile");
    }

    await this.startProfile(normalizedManagerId, "telegram");
    return this.getOrCreateTelegramProfile(normalizedManagerId);
  }

  private async startProfileInternal(managerId: string, _provider: IntegrationProvider): Promise<void> {
    const normalizedManagerId = normalizeManagerId(managerId);
    if (isSharedIntegrationManagerId(normalizedManagerId)) {
      return;
    }

    const profile = this.getOrCreateTelegramProfile(normalizedManagerId);
    await profile.start();
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

    if (!this.swarmManager.getConfig().cortexEnabled) {
      managerIds.delete("cortex");
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
