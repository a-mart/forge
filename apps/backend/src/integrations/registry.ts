import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { normalizeManagerId } from "../utils/normalize.js";
import { SlackIntegrationService } from "./slack/slack-integration.js";
import type { SlackStatusEvent } from "./slack/slack-status.js";
import type { SlackChannelDescriptor, SlackConnectionTestResult, SlackIntegrationConfigPublic } from "./slack/slack-types.js";
import { TelegramIntegrationService } from "./telegram/telegram-integration.js";
import type { TelegramStatusEvent } from "./telegram/telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfigPublic
} from "./telegram/telegram-types.js";

type IntegrationProvider = "slack" | "telegram";

const INTEGRATIONS_DIR_NAME = "integrations";
const INTEGRATIONS_MANAGERS_DIR_NAME = "managers";

export class IntegrationRegistryService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly dataDir: string;
  private readonly defaultManagerId: string | undefined;
  private readonly slackProfiles = new Map<string, SlackIntegrationService>();
  private readonly telegramProfiles = new Map<string, TelegramIntegrationService>();
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
      this.started = false;
    });
  }

  async startProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      this.started = true;
      await this.startProfileInternal(managerId, provider);
    });
  }

  async stopProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      const normalizedManagerId = normalizeManagerId(managerId);
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
    const normalizedManagerId = normalizeManagerId(managerId);

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

  async getSlackSnapshot(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateSlackConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.updateConfig(patch);
  }

  async disableSlack(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.disable();
  }

  async testSlackConnection(managerId: string, patch?: unknown): Promise<SlackConnectionTestResult> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.testConnection(patch);
  }

  async listSlackChannels(
    managerId: string,
    options?: { includePrivateChannels?: boolean }
  ): Promise<SlackChannelDescriptor[]> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.listChannels(options);
  }

  async getTelegramSnapshot(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateTelegramConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.updateConfig(patch);
  }

  async disableTelegram(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.disable();
  }

  async testTelegramConnection(
    managerId: string,
    patch?: unknown
  ): Promise<TelegramConnectionTestResult> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.testConnection(patch);
  }

  private async ensureSlackProfileStarted(managerId: string): Promise<SlackIntegrationService> {
    const normalizedManagerId = normalizeManagerId(managerId);
    await this.startProfile(normalizedManagerId, "slack");
    return this.getOrCreateSlackProfile(normalizedManagerId);
  }

  private async ensureTelegramProfileStarted(managerId: string): Promise<TelegramIntegrationService> {
    const normalizedManagerId = normalizeManagerId(managerId);
    await this.startProfile(normalizedManagerId, "telegram");
    return this.getOrCreateTelegramProfile(normalizedManagerId);
  }

  private async startProfileInternal(managerId: string, provider: IntegrationProvider): Promise<void> {
    const normalizedManagerId = normalizeManagerId(managerId);

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
      managerId: normalizedManagerId
    });
    profile.on("telegram_status", this.forwardTelegramStatus);
    this.telegramProfiles.set(normalizedManagerId, profile);
    return profile;
  }

  private async discoverKnownManagerIds(): Promise<Set<string>> {
    const managerIds = new Set<string>();
    if (this.defaultManagerId) {
      managerIds.add(this.defaultManagerId);
    }

    for (const descriptor of this.swarmManager.listAgents()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      managerIds.add(descriptor.agentId);
    }

    const managerIdsOnDisk = await this.loadManagerIdsFromDisk();
    for (const managerId of managerIdsOnDisk) {
      managerIds.add(managerId);
    }

    return managerIds;
  }

  private async loadManagerIdsFromDisk(): Promise<string[]> {
    const managersRoot = resolve(this.dataDir, INTEGRATIONS_DIR_NAME, INTEGRATIONS_MANAGERS_DIR_NAME);

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
