import type {
  OpenAIBrokerAccountCounts,
  OpenAIBrokerDegradedReason,
  OpenAIBrokerSettingsStatus,
} from "@forge/protocol";
import { redactOpenAIAuthBrokerText } from "./openai-auth-redaction.js";

export interface OpenAIAuthBrokerClientOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  redactionSecrets?: readonly (string | undefined)[];
}

export interface OpenAIAuthBrokerRuntimeIdentity {
  clientId: string;
  instanceId: string;
  instanceLabel?: string;
  userLabel?: string;
  sessionId?: string;
  projectId?: string;
  projectLabel?: string;
  agentId?: string;
  forgeVersion?: string;
}

export interface OpenAIAuthBrokerLeaseCredential {
  type: "oauth" | "api_key";
  access: string;
  expires: number;
  accountId: string;
}

export interface OpenAIAuthBrokerLease {
  leaseId: string;
  credential: OpenAIAuthBrokerLeaseCredential;
  accountId?: string;
  accountLabel?: string;
  renewAfterMs?: number;
  expiresAtMs?: number;
}

export interface OpenAIAuthBrokerLeaseReportDetails {
  retryAfterMs?: number;
  errorCode?: string;
  errorMessage?: string;
  message?: string;
  requestReplacement?: boolean;
}

export class OpenAIAuthBrokerClientError extends Error {
  constructor(
    message: string,
    public readonly code: string = "broker_request_failed",
    public readonly status?: number
  ) {
    super(redactOpenAIAuthBrokerText(message));
    this.name = "OpenAIAuthBrokerClientError";
  }
}

export class OpenAIAuthBrokerClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly redactionSecrets: readonly (string | undefined)[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: OpenAIAuthBrokerClientOptions) {
    const normalizedBaseUrl = normalizeBrokerBaseUrl(options.baseUrl);
    if (!normalizedBaseUrl) {
      throw new OpenAIAuthBrokerClientError("Forge Auth broker URL is not configured for OpenAI/Codex.", "missing_broker_url");
    }

    const bearerToken = options.bearerToken.trim();
    if (!bearerToken) {
      throw new OpenAIAuthBrokerClientError("Forge Auth broker token is not configured for OpenAI/Codex.", "missing_broker_token");
    }

    this.baseUrl = normalizedBaseUrl;
    this.bearerToken = bearerToken;
    this.redactionSecrets = [bearerToken, ...(options.redactionSecrets ?? [])];
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getStatus(): Promise<OpenAIBrokerSettingsStatus> {
    const payload = await this.requestJson("/v1/status", { method: "GET" });
    return normalizeStatusPayload(payload, this.now(), this.redactionSecrets);
  }

  async getUsageSnapshot(): Promise<unknown> {
    return this.requestJson("/v1/usage/snapshot", { method: "GET" });
  }

  async acquireLease(identity: OpenAIAuthBrokerRuntimeIdentity): Promise<OpenAIAuthBrokerLease> {
    const payload = await this.requestJson("/v1/leases", {
      method: "POST",
      body: JSON.stringify({ provider: "openai-codex", client: sanitizeIdentity(identity) }),
    });
    return parseLease(payload);
  }

  async renewLease(leaseId: string, identity: OpenAIAuthBrokerRuntimeIdentity): Promise<OpenAIAuthBrokerLease> {
    const payload = await this.requestJson(`/v1/leases/${encodeURIComponent(leaseId)}/renew`, {
      method: "POST",
      body: JSON.stringify({ client: sanitizeIdentity(identity) }),
    });
    return parseLease(payload);
  }

  async releaseLease(leaseId: string, reason: string, identity: OpenAIAuthBrokerRuntimeIdentity): Promise<void> {
    await this.requestJson(`/v1/leases/${encodeURIComponent(leaseId)}/release`, {
      method: "POST",
      body: JSON.stringify({ client: sanitizeIdentity(identity), reason }),
    });
  }

  async reportLease(
    leaseId: string,
    event: "used" | "success" | "auth_error" | "capacity_error" | "runtime_error",
    identity: OpenAIAuthBrokerRuntimeIdentity,
    details: OpenAIAuthBrokerLeaseReportDetails = {}
  ): Promise<OpenAIAuthBrokerLease | null> {
    const payload = await this.requestJson(`/v1/leases/${encodeURIComponent(leaseId)}/report`, {
      method: "POST",
      body: JSON.stringify({ client: sanitizeIdentity(identity), event, ...sanitizeReportDetails(details) }),
    });

    if (payload && typeof payload === "object") {
      if ("replacement" in payload) {
        return parseLease((payload as { replacement: unknown }).replacement);
      }
      if ("lease" in payload) {
        return parseLease((payload as { lease: unknown }).lease);
      }
    }

    return null;
  }

  private async requestJson(pathname: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
        ...init,
        headers: {
          "authorization": `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = text ? parseJson(text) : null;
      if (!response.ok) {
        const brokerError = normalizeBrokerError(payload);
        throw new OpenAIAuthBrokerClientError(
          this.redactSecrets(`Forge Auth broker request failed: ${brokerError.message}`),
          brokerError.code,
          response.status
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof OpenAIAuthBrokerClientError) {
        throw error;
      }
      const message = error instanceof Error && error.name === "AbortError"
        ? "Forge Auth broker request timed out."
        : `Forge Auth broker request failed: ${redactOpenAIAuthBrokerText(error)}`;
      throw new OpenAIAuthBrokerClientError(this.redactSecrets(message), "unreachable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private redactSecrets(message: string): string {
    return redactOpenAIAuthBrokerText(message, this.redactionSecrets);
  }
}

function normalizeBrokerBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return 10_000;
  }
  return Math.max(1_000, Math.min(60_000, Math.trunc(value)));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeBrokerError(payload: unknown): { code: string; message: string } {
  if (!payload || typeof payload !== "object") {
    return { code: "broker_request_failed", message: "Unexpected broker response." };
  }
  const record = payload as { error?: unknown; code?: unknown };
  return {
    code: typeof record.code === "string" && record.code.trim() ? record.code.trim() : "broker_request_failed",
    message: typeof record.error === "string" && record.error.trim() ? record.error.trim() : "Unexpected broker response.",
  };
}

function normalizeStatusPayload(
  payload: unknown,
  checkedAt: Date,
  exactSecrets: readonly (string | undefined)[] = []
): OpenAIBrokerSettingsStatus {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const ok = typeof record.ok === "boolean" ? record.ok : false;
  const degraded = normalizeDegradedReason(record.degraded ?? record.reason ?? record.code);
  const message = typeof record.message === "string" ? redactOpenAIAuthBrokerText(record.message, exactSecrets) : undefined;
  const earliestResetAtMs = typeof record.earliestResetAtMs === "number" ? record.earliestResetAtMs : undefined;
  const accounts = normalizeAccountCounts(record.accounts);
  return {
    ok,
    ...(degraded ? { degraded } : {}),
    ...(accounts ? { accounts } : {}),
    ...(earliestResetAtMs ? { earliestResetAtMs } : {}),
    ...(message ? { message } : {}),
    checkedAt: checkedAt.toISOString(),
  };
}

function normalizeDegradedReason(value: unknown): OpenAIBrokerDegradedReason | undefined {
  switch (value) {
    case "unreachable":
    case "invalid_bearer":
    case "no_accounts":
    case "all_cooldown":
    case "auth_errors":
    case "usage_unavailable":
    case "token_shape_unverified":
      return value;
    default:
      return undefined;
  }
}

function normalizeAccountCounts(value: unknown): OpenAIBrokerAccountCounts | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    healthy: normalizeCount(record.healthy),
    cooldown: normalizeCount(record.cooldown),
    auth_error: normalizeCount(record.auth_error),
    disabled: normalizeCount(record.disabled),
    draining: normalizeCount(record.draining),
    unknown: normalizeCount(record.unknown),
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function sanitizeIdentity(identity: OpenAIAuthBrokerRuntimeIdentity): OpenAIAuthBrokerRuntimeIdentity {
  return Object.fromEntries(
    Object.entries(identity).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as OpenAIAuthBrokerRuntimeIdentity;
}

function sanitizeReportDetails(details: OpenAIAuthBrokerLeaseReportDetails): Omit<OpenAIAuthBrokerLeaseReportDetails, "message"> {
  return {
    ...(typeof details.retryAfterMs === "number" && Number.isFinite(details.retryAfterMs)
      ? { retryAfterMs: Math.max(0, Math.trunc(details.retryAfterMs)) }
      : {}),
    ...(typeof details.errorCode === "string" && details.errorCode.trim()
      ? { errorCode: details.errorCode.trim() }
      : {}),
    ...(typeof details.errorMessage === "string" && details.errorMessage.trim()
      ? { errorMessage: details.errorMessage.trim() }
      : typeof details.message === "string" && details.message.trim()
        ? { errorMessage: details.message.trim() }
        : {}),
    ...(typeof details.requestReplacement === "boolean" ? { requestReplacement: details.requestReplacement } : {}),
  };
}

function parseLease(payload: unknown): OpenAIAuthBrokerLease {
  const lease = payload && typeof payload === "object" && "lease" in payload
    ? (payload as { lease: unknown }).lease
    : payload;
  if (!lease || typeof lease !== "object") {
    throw new OpenAIAuthBrokerClientError("Broker lease response is invalid.", "token_shape_unverified");
  }

  const record = lease as Record<string, unknown>;
  const credential = record.credential;
  if (!credential || typeof credential !== "object") {
    throw new OpenAIAuthBrokerClientError("Broker lease credential is invalid.", "token_shape_unverified");
  }

  const credentialRecord = credential as Record<string, unknown>;
  if (
    (credentialRecord.type !== "oauth" && credentialRecord.type !== "api_key") ||
    typeof credentialRecord.access !== "string" ||
    !credentialRecord.access.trim() ||
    typeof credentialRecord.expires !== "number" ||
    typeof credentialRecord.accountId !== "string" ||
    !credentialRecord.accountId.trim() ||
    typeof record.leaseId !== "string" ||
    !record.leaseId.trim()
  ) {
    throw new OpenAIAuthBrokerClientError("Broker lease credential shape is unsupported.", "token_shape_unverified");
  }

  return {
    leaseId: record.leaseId.trim(),
    credential: {
      type: credentialRecord.type,
      access: credentialRecord.access,
      expires: credentialRecord.expires,
      accountId: credentialRecord.accountId,
    },
    ...(typeof record.accountId === "string" ? { accountId: record.accountId } : {}),
    ...(typeof record.accountLabel === "string" ? { accountLabel: record.accountLabel } : {}),
    ...(typeof record.renewAfterMs === "number" ? { renewAfterMs: record.renewAfterMs } : {}),
    ...(typeof record.expiresAtMs === "number" ? { expiresAtMs: record.expiresAtMs } : {}),
  };
}
