import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type { ProviderAccountUsage, ProviderUsageWindow } from "@forge/protocol";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import {
  OpenAIAuthBrokerClient,
  type OpenAIAuthBrokerLease,
  type OpenAIAuthBrokerRuntimeIdentity,
} from "./openai-auth-broker-client.js";
import { redactOpenAIAuthBrokerText } from "./openai-auth-redaction.js";
import { OpenAIAuthSettingsService } from "./openai-auth-settings-service.js";

export interface OpenAIAuthBrokerLeaseHandle {
  leaseId: string;
  lease: OpenAIAuthBrokerLease;
  identity: OpenAIAuthBrokerRuntimeIdentity;
  renewedAtMs: number;
}

export class OpenAIAuthBrokerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIAuthBrokerRuntimeError";
  }
}

export class OpenAIAuthBrokerRuntimeService {
  private readonly settingsService: OpenAIAuthSettingsService;

  constructor(private readonly options: { config: SwarmConfig; now?: () => Date }) {
    this.settingsService = new OpenAIAuthSettingsService({ config: options.config, now: options.now });
  }

  async isBrokerModeActive(): Promise<boolean> {
    return (await this.settingsService.getEffectiveMode()) === "central_broker";
  }

  async acquireForRuntime(descriptor: AgentDescriptor): Promise<{
    authStorage: AuthStorage;
    handle: OpenAIAuthBrokerLeaseHandle;
  }> {
    const effective = await this.settingsService.resolveEffectiveSettings();
    const client = await this.createClientFromResolved(effective.broker.url, effective.broker.token, effective.broker.timeoutMs);
    const identity = buildRuntimeIdentity(descriptor, effective.broker);
    const lease = await client.acquireLease(identity);
    const authStorage = AuthStorage.inMemory({
      "openai-codex": buildOpenAICodexAuthCredentialFromLease(lease),
    });
    return {
      authStorage,
      handle: {
        leaseId: lease.leaseId,
        lease,
        identity,
        renewedAtMs: Date.now(),
      },
    };
  }

  async renewIfNeeded(handle: OpenAIAuthBrokerLeaseHandle): Promise<OpenAIAuthBrokerLeaseHandle> {
    if (!isBrokerLeaseRenewalDue(handle, Date.now())) {
      return handle;
    }

    const client = await this.createClient();
    const lease = await client.renewLease(handle.leaseId, handle.identity);
    return {
      ...handle,
      lease,
      leaseId: lease.leaseId,
      renewedAtMs: Date.now(),
    };
  }

  async applyLeaseToAuthStorage(
    authStorage: { set: (key: string, value: AuthCredential) => void },
    handle: OpenAIAuthBrokerLeaseHandle
  ): Promise<OpenAIAuthBrokerLeaseHandle> {
    authStorage.set("openai-codex", buildOpenAICodexAuthCredentialFromLease(handle.lease));
    return handle;
  }

  async release(handle: OpenAIAuthBrokerLeaseHandle, reason: string): Promise<void> {
    try {
      const client = await this.createClient();
      await client.releaseLease(handle.leaseId, reason, handle.identity);
    } catch {
      // Best-effort release during shutdown.
    }
  }

  async report(
    handle: OpenAIAuthBrokerLeaseHandle,
    event: "used" | "success" | "auth_error" | "capacity_error" | "runtime_error",
    details: { retryAfterMs?: number; errorCode?: string; errorMessage?: string; message?: string; requestReplacement?: boolean } = {}
  ): Promise<OpenAIAuthBrokerLeaseHandle> {
    const client = await this.createClient();
    const replacement = await client.reportLease(handle.leaseId, event, handle.identity, details);
    if (!replacement) {
      return handle;
    }

    return {
      ...handle,
      lease: replacement,
      leaseId: replacement.leaseId,
      renewedAtMs: Date.now(),
    };
  }

  async fetchUsageSnapshot(): Promise<ProviderAccountUsage[] | null> {
    const settings = await this.settingsService.getSettingsState();
    if (settings.effectiveMode !== "central_broker") {
      return null;
    }

    const effective = await this.settingsService.resolveEffectiveSettings();
    const redactionSecrets = [effective.broker.token];

    if (!settings.broker.configured) {
      return [unavailableBrokerUsage(settings.broker.status?.message, redactionSecrets)];
    }

    try {
      const client = await this.createClientFromResolved(
        effective.broker.url,
        effective.broker.token,
        effective.broker.timeoutMs,
      );
      const payload = await client.getUsageSnapshot();
      return mapBrokerUsageSnapshot(payload, redactionSecrets);
    } catch (error) {
      return [unavailableBrokerUsage(error, redactionSecrets)];
    }
  }

  private async createClient(): Promise<OpenAIAuthBrokerClient> {
    const effective = await this.settingsService.resolveEffectiveSettings();
    return this.createClientFromResolved(
      effective.broker.url,
      effective.broker.token,
      effective.broker.timeoutMs,
    );
  }

  private createClientFromResolved(
    url: string | undefined,
    token: string | undefined,
    timeoutMs: number,
  ): OpenAIAuthBrokerClient {
    if (!url || !token) {
      throw new OpenAIAuthBrokerRuntimeError(
        "Forge Auth broker is enabled for OpenAI/Codex but broker URL and token are not configured."
      );
    }

    return new OpenAIAuthBrokerClient({
      baseUrl: url,
      bearerToken: token,
      timeoutMs,
      now: this.options.now,
    });
  }
}

function buildRuntimeIdentity(
  descriptor: AgentDescriptor,
  broker: {
    clientId: string;
    instanceId?: string;
    instanceLabel?: string;
    userLabel?: string;
  },
): OpenAIAuthBrokerRuntimeIdentity {
  return {
    clientId: broker.clientId,
    instanceId: broker.instanceId ?? broker.clientId,
    ...(broker.instanceLabel ? { instanceLabel: broker.instanceLabel } : {}),
    ...(broker.userLabel ? { userLabel: broker.userLabel } : {}),
    sessionId: descriptor.agentId,
    projectId: descriptor.profileId,
    projectLabel: descriptor.profileId,
    agentId: descriptor.agentId,
  };
}

export function isBrokerLeaseRenewalDue(handle: OpenAIAuthBrokerLeaseHandle, nowMs: number): boolean {
  const renewAfterMs = handle.lease.renewAfterMs;
  if (renewAfterMs === undefined) {
    return true;
  }

  if (!Number.isFinite(renewAfterMs)) {
    return true;
  }

  // Broker v1 emits renewAfterMs as an absolute epoch-ms due time. Very small values
  // are treated as a legacy relative duration from the last renewal for compatibility.
  if (renewAfterMs < 946_684_800_000) {
    return nowMs - handle.renewedAtMs >= renewAfterMs;
  }

  return nowMs >= renewAfterMs;
}

export function buildOpenAICodexAuthCredentialFromLease(lease: OpenAIAuthBrokerLease): AuthCredential {
  const { credential } = lease;
  if (credential.type === "api_key") {
    return {
      type: "api_key",
      key: credential.access,
    };
  }

  const accountId =
    lease.accountId?.trim()
    || extractChatGptAccountIdFromAccessToken(credential.access)
    || credential.accountId;

  return {
    type: "oauth",
    access: credential.access,
    refresh: "",
    expires: credential.expires,
    accountId,
  };
}

export function extractChatGptAccountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") {
      return undefined;
    }
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function unavailableBrokerUsage(detail?: unknown, exactSecrets: readonly (string | undefined)[] = []): ProviderAccountUsage {
  const redactedDetail = detail === undefined ? undefined : redactOpenAIAuthBrokerText(detail, exactSecrets);
  return {
    provider: "openai",
    available: false,
    ...(redactedDetail ? { error: redactedDetail } : {}),
  };
}

function mapBrokerUsageSnapshot(payload: unknown, exactSecrets: readonly (string | undefined)[] = []): ProviderAccountUsage[] {
  if (!payload || typeof payload !== "object") {
    return [unavailableBrokerUsage("Broker usage snapshot was invalid.", exactSecrets)];
  }

  const record = payload as Record<string, unknown>;
  const accounts = Array.isArray(record.accounts) ? record.accounts : [record];
  const mapped = accounts
    .map((entry) => mapBrokerUsageAccount(entry, exactSecrets))
    .filter((entry): entry is ProviderAccountUsage => entry !== null);

  return mapped.length > 0 ? mapped : [unavailableBrokerUsage("Broker usage snapshot had no accounts.", exactSecrets)];
}

function mapBrokerUsageAccount(value: unknown, exactSecrets: readonly (string | undefined)[] = []): ProviderAccountUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const available = record.available !== false;
  const usage: ProviderAccountUsage = {
    provider: "openai",
    available,
    ...(typeof record.plan === "string" ? { plan: record.plan } : {}),
    ...(typeof record.accountEmail === "string"
      ? { accountEmail: record.accountEmail }
      : typeof record.email === "string"
        ? { accountEmail: record.email }
        : {}),
    ...(typeof record.accountBrokerId === "string"
      ? { accountId: record.accountBrokerId }
      : typeof record.accountId === "string"
        ? { accountId: record.accountId }
        : typeof record.openaiAccountId === "string"
          ? { accountId: record.openaiAccountId }
          : {}),
    ...(typeof record.accountLabel === "string" ? { accountLabel: record.accountLabel } : {}),
    ...(typeof record.error === "string"
      ? { error: redactOpenAIAuthBrokerText(record.error, exactSecrets) }
      : typeof record.detail === "string"
        ? { error: redactOpenAIAuthBrokerText(record.detail, exactSecrets) }
        : {}),
  };

  const rateLimit = record.rate_limit && typeof record.rate_limit === "object"
    ? record.rate_limit as Record<string, unknown>
    : undefined;
  const sessionUsage = normalizeUsageWindow(
    record.sessionUsage
      ?? record.primaryWindow
      ?? record.primary_window
      ?? rateLimit?.primary_window
  );
  const weeklyUsage = normalizeUsageWindow(
    record.weeklyUsage
      ?? record.secondaryWindow
      ?? record.secondary_window
      ?? rateLimit?.secondary_window
  );
  if (sessionUsage) {
    usage.sessionUsage = sessionUsage;
  }
  if (weeklyUsage) {
    usage.weeklyUsage = weeklyUsage;
  }

  return usage;
}

function normalizeUsageWindow(value: unknown): ProviderUsageWindow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const percent = readNumber(record.percent ?? record.usedPercent ?? record.used_percent ?? record.utilization);
  const resetAtMs = readResetAtMs(record.resetAtMs ?? record.resetAt ?? record.reset_at ?? record.resets_at);
  const resetInfo = typeof record.resetInfo === "string" && record.resetInfo.trim().length > 0
    ? record.resetInfo.trim()
    : undefined;
  if (percent === undefined && resetAtMs === undefined && resetInfo === undefined) {
    return undefined;
  }

  return {
    percent: percent ?? 0,
    resetInfo: resetInfo ?? (resetAtMs ? new Date(resetAtMs).toLocaleString() : "Unknown"),
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    ...(readNumber(record.windowSeconds ?? record.window_seconds ?? record.limit_window_seconds) !== undefined
      ? { windowSeconds: readNumber(record.windowSeconds ?? record.window_seconds ?? record.limit_window_seconds) }
      : {}),
  };
}

function readResetAtMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
