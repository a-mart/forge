import type { ServerEvent } from "@middleman/protocol";
import { isNonRunningAgentStatus } from "../swarm/agent-state-machine.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { ExpoPushClient, type ExpoPushMessage, type ExpoSendResult } from "./expo-push-client.js";
import {
  MobilePushStore,
  type MobileNotificationPreferences,
  type MobileNotificationPreferencesPatch,
  type MobilePushDevice
} from "./mobile-push-store.js";

const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_SEND_RETRY_BACKOFF_MS = [250, 1000, 2_500] as const;
const RECEIPTS_CHUNK_SIZE = 100;
const DEFAULT_PUSH_TITLE = "Middleman";
const DEFAULT_TEST_BODY = "Forge push notifications are configured.";

type PushNotificationType = "unread" | "agent_status" | "error" | "test";

interface AgentRoutingContext {
  sessionAgentId: string;
  profileId: string;
  agentDisplayName: string;
  route: string;
}

interface PendingReceiptRecord {
  token: string;
  createdAt: string;
}

export class MobilePushService {
  private readonly swarmManager: SwarmManager;
  private readonly store: MobilePushStore;
  private readonly expoPushClient: ExpoPushClient;
  private readonly isSessionActive: (sessionAgentId: string) => boolean;
  private readonly receiptPollIntervalMs: number;
  private readonly sendRetryBackoffMs: readonly number[];

  private started = false;
  private receiptTimer: NodeJS.Timeout | null = null;
  private receiptPollingInFlight = false;
  private readonly pendingReceipts = new Map<string, PendingReceiptRecord>();
  private readonly lastSeenStatusByAgentId = new Map<string, string>();

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") {
      return;
    }

    void this.handleConversationMessage(event).catch((error) => {
      this.logError("conversation_message", error);
    });
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") {
      return;
    }

    void this.handleAgentStatus(event).catch((error) => {
      this.logError("agent_status", error);
    });
  };

  constructor(options: {
    swarmManager: SwarmManager;
    dataDir: string;
    isSessionActive?: (sessionAgentId: string) => boolean;
    expoPushClient?: ExpoPushClient;
    now?: () => Date;
    receiptPollIntervalMs?: number;
    sendRetryBackoffMs?: number[];
  }) {
    this.swarmManager = options.swarmManager;
    this.store = new MobilePushStore({ dataDir: options.dataDir, now: options.now });
    this.expoPushClient = options.expoPushClient ?? new ExpoPushClient();
    this.isSessionActive = options.isSessionActive ?? (() => false);
    this.receiptPollIntervalMs = options.receiptPollIntervalMs ?? DEFAULT_RECEIPT_POLL_INTERVAL_MS;
    this.sendRetryBackoffMs =
      options.sendRetryBackoffMs && options.sendRetryBackoffMs.length > 0
        ? options.sendRetryBackoffMs
        : DEFAULT_SEND_RETRY_BACKOFF_MS;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("agent_status", this.onAgentStatus);

    this.receiptTimer = setInterval(() => {
      void this.pollReceipts().catch((error) => {
        this.logError("poll_receipts", error);
      });
    }, this.receiptPollIntervalMs);
    this.receiptTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("agent_status", this.onAgentStatus);

    if (this.receiptTimer) {
      clearInterval(this.receiptTimer);
      this.receiptTimer = null;
    }
  }

  async registerDevice(payload: unknown): Promise<MobilePushDevice> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object");
    }

    const maybe = payload as {
      token?: unknown;
      platform?: unknown;
      deviceName?: unknown;
      enabled?: unknown;
    };

    return this.store.registerDevice({
      token: maybe.token,
      platform: maybe.platform,
      deviceName: maybe.deviceName,
      enabled: maybe.enabled
    });
  }

  async unregisterDevice(payload: unknown): Promise<boolean> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object");
    }

    const maybe = payload as { token?: unknown };
    return this.store.unregisterDevice(maybe.token);
  }

  async getNotificationPreferences(): Promise<MobileNotificationPreferences> {
    return this.store.getPreferences();
  }

  async updateNotificationPreferences(payload: unknown): Promise<MobileNotificationPreferences> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object");
    }

    const maybe = payload as MobileNotificationPreferencesPatch;
    return this.store.updatePreferences(maybe);
  }

  async sendTestNotification(payload: unknown): Promise<{
    ok: boolean;
    ticketId?: string;
    error?: string;
  }> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object");
    }

    const maybe = payload as {
      token?: unknown;
      title?: unknown;
      body?: unknown;
      route?: unknown;
      profileId?: unknown;
      agentId?: unknown;
    };

    const token = normalizeRequiredString(maybe.token, "token");
    const title = normalizeOptionalString(maybe.title) ?? DEFAULT_PUSH_TITLE;
    const body = normalizeOptionalString(maybe.body) ?? DEFAULT_TEST_BODY;
    const profileId = normalizeOptionalString(maybe.profileId) ?? "mobile";
    const agentId = normalizeOptionalString(maybe.agentId) ?? "mobile";
    const route =
      normalizeOptionalString(maybe.route) ??
      buildSessionRoute({
        profileId,
        sessionAgentId: agentId
      });

    const result = await this.sendToDeviceWithRetry(token, {
      title,
      body,
      sound: "default",
      data: {
        v: 1,
        type: "test",
        agentId,
        profileId,
        route
      }
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Failed to send Expo push notification"
      };
    }

    return {
      ok: true,
      ticketId: result.ticketId
    };
  }

  private async handleConversationMessage(
    event: Extract<ServerEvent, { type: "conversation_message" }>
  ): Promise<void> {
    if (event.role === "assistant" && event.source === "speak_to_user") {
      await this.dispatchNotification({
        type: "unread",
        agentId: event.agentId,
        title: "New message",
        body: truncateText(event.text, 180)
      });
      return;
    }

    if (event.role === "system" && isSystemErrorMessage(event.text)) {
      await this.dispatchNotification({
        type: "error",
        agentId: event.agentId,
        title: "Agent error",
        body: truncateText(event.text, 220)
      });
    }
  }

  private async handleAgentStatus(event: Extract<ServerEvent, { type: "agent_status" }>): Promise<void> {
    const previous = this.lastSeenStatusByAgentId.get(event.agentId);
    if (previous === event.status) {
      return;
    }

    this.lastSeenStatusByAgentId.set(event.agentId, event.status);

    if (!isNonRunningAgentStatus(event.status)) {
      return;
    }

    const context = this.resolveAgentRoutingContext(event.agentId);
    const statusLabel = event.status.toUpperCase();

    await this.dispatchNotification({
      type: event.status === "error" ? "error" : "agent_status",
      agentId: event.agentId,
      title: `${context.agentDisplayName} status update`,
      body: `${context.agentDisplayName} is now ${statusLabel}.`
    });
  }

  private async dispatchNotification(notification: {
    type: PushNotificationType;
    agentId: string;
    title: string;
    body: string;
  }): Promise<void> {
    if (!this.started) {
      return;
    }

    const preferences = await this.store.getPreferences();
    if (!isNotificationTypeEnabled(preferences, notification.type)) {
      return;
    }

    const context = this.resolveAgentRoutingContext(notification.agentId);
    if (preferences.suppressWhenActive && this.isSessionActive(context.sessionAgentId)) {
      return;
    }

    const devices = await this.store.getEnabledDevices();
    if (devices.length === 0) {
      return;
    }

    const payload: Omit<ExpoPushMessage, "to"> = {
      title: notification.title,
      body: notification.body,
      sound: "default",
      data: {
        v: 1,
        type: notification.type,
        agentId: context.sessionAgentId,
        profileId: context.profileId,
        route: context.route
      }
    };

    for (const device of devices) {
      const sendResult = await this.sendToDeviceWithRetry(device.token, payload);
      if (!sendResult.ok) {
        this.logError("send_push", sendResult.error ?? "Unknown Expo send error");
      }
    }
  }

  private async sendToDeviceWithRetry(
    token: string,
    payload: Omit<ExpoPushMessage, "to">
  ): Promise<{ ok: boolean; ticketId?: string; error?: string }> {
    let lastResult: ExpoSendResult | null = null;

    for (let attempt = 0; attempt < this.sendRetryBackoffMs.length; attempt += 1) {
      const result = await this.expoPushClient.send({
        ...payload,
        to: token
      });
      lastResult = result;

      if (result.ok) {
        if (result.ticketId) {
          this.pendingReceipts.set(result.ticketId, {
            token,
            createdAt: new Date().toISOString()
          });
        }

        return {
          ok: true,
          ticketId: result.ticketId
        };
      }

      if (result.errorCode === "DeviceNotRegistered") {
        await this.store.disableDevice(token, "DeviceNotRegistered");
        return {
          ok: false,
          error: result.error ?? "Device token is not registered"
        };
      }

      if (!result.retryable || attempt === this.sendRetryBackoffMs.length - 1) {
        return {
          ok: false,
          error: result.error ?? "Expo push request failed"
        };
      }

      const delayMs = this.sendRetryBackoffMs[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return {
      ok: false,
      error: lastResult?.error ?? "Expo push request failed"
    };
  }

  private async pollReceipts(): Promise<void> {
    if (!this.started || this.receiptPollingInFlight || this.pendingReceipts.size === 0) {
      return;
    }

    this.receiptPollingInFlight = true;

    try {
      const receiptIds = Array.from(this.pendingReceipts.keys());

      for (let index = 0; index < receiptIds.length; index += RECEIPTS_CHUNK_SIZE) {
        const chunk = receiptIds.slice(index, index + RECEIPTS_CHUNK_SIZE);
        let receipts: Record<string, { status: "ok" | "error"; details?: { error?: string } }>;

        try {
          receipts = await this.expoPushClient.getReceipts(chunk);
        } catch (error) {
          this.logError("fetch_receipts", error);
          return;
        }

        for (const receiptId of chunk) {
          const record = this.pendingReceipts.get(receiptId);
          if (!record) {
            continue;
          }

          const receipt = receipts[receiptId];
          if (!receipt) {
            continue;
          }

          if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
            await this.store.disableDevice(record.token, "DeviceNotRegistered");
          }

          this.pendingReceipts.delete(receiptId);
        }
      }
    } finally {
      this.receiptPollingInFlight = false;
    }
  }

  private resolveAgentRoutingContext(agentId: string): AgentRoutingContext {
    const descriptor = this.swarmManager.getAgent(agentId);

    if (descriptor?.role === "manager") {
      const profileId = normalizeOptionalString(descriptor.profileId) ?? descriptor.agentId;
      return {
        sessionAgentId: descriptor.agentId,
        profileId,
        agentDisplayName: descriptor.displayName,
        route: buildSessionRoute({
          profileId,
          sessionAgentId: descriptor.agentId
        })
      };
    }

    if (descriptor?.role === "worker") {
      const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
      const profileId =
        managerDescriptor?.role === "manager"
          ? normalizeOptionalString(managerDescriptor.profileId) ?? managerDescriptor.agentId
          : descriptor.managerId;

      return {
        sessionAgentId: descriptor.managerId,
        profileId,
        agentDisplayName: descriptor.displayName,
        route: buildSessionRoute({
          profileId,
          sessionAgentId: descriptor.managerId
        })
      };
    }

    return {
      sessionAgentId: agentId,
      profileId: agentId,
      agentDisplayName: agentId,
      route: buildSessionRoute({
        profileId: agentId,
        sessionAgentId: agentId
      })
    };
  }

  private logError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mobile-push] ${scope}: ${message}`);
  }
}

function isNotificationTypeEnabled(
  preferences: MobileNotificationPreferences,
  type: PushNotificationType
): boolean {
  if (!preferences.enabled) {
    return false;
  }

  switch (type) {
    case "unread":
      return preferences.unreadMessages;
    case "agent_status":
      return preferences.agentStatusChanges;
    case "error":
      return preferences.errors;
    case "test":
      return true;
    default:
      return false;
  }
}

function isSystemErrorMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("⚠️") ||
    normalized.startsWith("🚨") ||
    normalized.includes("error") ||
    normalized.includes("failed")
  );
}

function buildSessionRoute(options: { profileId: string; sessionAgentId: string }): string {
  return `/profiles/${encodeURIComponent(options.profileId)}/sessions/${encodeURIComponent(options.sessionAgentId)}`;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return trimmed;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
