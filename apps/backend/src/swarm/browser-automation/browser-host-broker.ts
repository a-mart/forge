import { randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_HOST_PROTOCOL_VERSION,
  type BrowserAutomationErrorCode,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserHostConnectionSnapshot,
  type BrowserHostLifecycleReason,
  type BrowserHostLifecycleRequest,
  type BrowserHostLifecycleResponse,
  type BrowserHostRegistration,
} from "@forge/protocol";

export interface BrowserHostBrokerRegistration {
  connectionId: string;
  registration: BrowserHostRegistration;
  sendRequest: (request: BrowserAutomationRequest) => void | Promise<void>;
  sendLifecycleRequest?: (request: BrowserHostLifecycleRequest) => void | Promise<void>;
}

export interface BrowserHostBrokerRequest {
  sessionAgentId: string;
  profileId: string;
  tabId: string | null;
  operation: BrowserAutomationOperation;
  input: Record<string, unknown>;
  timeoutMs?: number;
  artifactDirectory?: string | null;
  requestId?: string;
  expectedHost?: { hostId: string; hostGeneration: number };
}

export type BrowserHostLifecycleRequestOptions = {
  sessionAgentId: string;
  profileId: string;
  requestId?: string;
  timeoutMs?: number;
  expectedHost?: { hostId: string; hostGeneration: number };
} & (
  | { kind: "turn-ended"; turnId: string }
  | { kind: "release-session"; reason: BrowserHostLifecycleReason }
);

export type BrowserHostResponseDisposition =
  | "accepted"
  | "duplicate"
  | "unknown-request"
  | "stale-host"
  | "wrong-connection"
  | "mismatched-response";

export class BrowserAutomationBrokerError extends Error {
  readonly failure: BrowserAutomationFailure;

  constructor(code: BrowserAutomationErrorCode, message: string, retryable = false, details?: BrowserAutomationFailure["details"]) {
    super(message);
    this.name = "BrowserAutomationBrokerError";
    this.failure = { code, message, retryable, ...(details ? { details } : {}) };
  }
}

interface CurrentHost {
  connectionId: string;
  registration: BrowserHostRegistration;
  generation: number;
  connectedAt: string;
  focused: boolean;
  sendRequest: BrowserHostBrokerRegistration["sendRequest"];
  sendLifecycleRequest?: BrowserHostBrokerRegistration["sendLifecycleRequest"];
}

type PendingRequest =
  | {
      kind: "automation";
      request: BrowserAutomationRequest;
      connectionId: string;
      maximumResponseBytes: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (response: BrowserAutomationResponse) => void;
      reject: (error: BrowserAutomationBrokerError) => void;
    }
  | {
      kind: "lifecycle";
      request: BrowserHostLifecycleRequest;
      connectionId: string;
      timer: ReturnType<typeof setTimeout>;
      resolve: (response: BrowserHostLifecycleResponse) => void;
      reject: (error: BrowserAutomationBrokerError) => void;
    };

export interface BrowserHostBrokerOptions {
  now?: () => string;
  requestId?: () => string;
  maxResponseBytes?: number;
  logDebug?: (message: string, details?: unknown) => void;
}

/** One local Desktop registration. Target selection remains private to Desktop. */
export class BrowserHostBroker {
  private readonly now: () => string;
  private readonly requestId: () => string;
  private readonly maxResponseBytes: number;
  private readonly logDebug: (message: string, details?: unknown) => void;
  private generation = 0;
  private host: CurrentHost | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completedRequestIds = new Set<string>();

  constructor(options: BrowserHostBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestId = options.requestId ?? randomUUID;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1_024 * 1_024;
    this.logDebug = options.logDebug ?? (() => undefined);
  }

  register(options: BrowserHostBrokerRegistration): BrowserHostConnectionSnapshot {
    const versions = options.registration.capabilities.protocolVersions;
    if (!versions || versions.minimum > BROWSER_HOST_PROTOCOL_VERSION || versions.maximum < BROWSER_HOST_PROTOCOL_VERSION) {
      throw brokerError("extension-update-required", "Desktop update required: browser host protocol v2 is required.", false);
    }
    if (this.host) this.rejectPendingForGeneration(this.host.generation, "stale-host-generation", "Browser host was superseded by a newer registration.");
    this.generation += 1;
    this.host = {
      ...options,
      generation: this.generation,
      connectedAt: this.now(),
      focused: false,
    };
    return this.getConnectionSnapshot();
  }

  unregister(connectionId: string, hostId?: string, hostGeneration?: number): boolean {
    const host = this.host;
    if (!host || host.connectionId !== connectionId) return false;
    if (hostId !== undefined && host.registration.hostId !== hostId) return false;
    if (hostGeneration !== undefined && host.generation !== hostGeneration) return false;
    this.host = undefined;
    this.rejectPendingForGeneration(host.generation, "host-disconnected", "Browser host disconnected.");
    return true;
  }

  setFocused(connectionId: string, hostId: string, hostGeneration: number, focused: boolean): boolean {
    if (!this.isCurrentConnection(connectionId, hostId, hostGeneration)) return false;
    this.host!.focused = focused;
    return true;
  }

  isCurrentConnection(connectionId: string, hostId: string, hostGeneration: number): boolean {
    const host = this.host;
    return !!host && host.connectionId === connectionId && host.registration.hostId === hostId && host.generation === hostGeneration;
  }

  getConnectionSnapshot(): BrowserHostConnectionSnapshot {
    const host = this.host;
    return host ? {
      connected: true,
      hostId: host.registration.hostId,
      hostGeneration: host.generation,
      focused: host.focused,
      capabilities: host.registration.capabilities,
      connectedAt: host.connectedAt,
    } : {
      connected: false,
      hostId: null,
      hostGeneration: null,
      focused: false,
      capabilities: null,
      connectedAt: null,
    };
  }

  getConnectionSnapshots(): BrowserHostConnectionSnapshot[] {
    return [this.getConnectionSnapshot()];
  }

  async request(options: BrowserHostBrokerRequest): Promise<BrowserAutomationResponse> {
    const host = this.requireHost(options.expectedHost);
    if (!host.registration.capabilities.supportedOperations.includes(options.operation)) {
      this.logDebug("browser-host-broker:unsupported-operation", { hostId: host.registration.hostId, operation: options.operation });
      throw brokerError("unsupported-operation", `The Forge browser does not support ${options.operation}.`, false, { operation: options.operation });
    }
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const requestId = this.allocateOrValidateRequestId(options.requestId);
    const request: BrowserAutomationRequest = {
      requestId,
      sessionAgentId: options.sessionAgentId,
      profileId: options.profileId,
      tabId: options.tabId,
      operation: options.operation,
      input: options.input,
      hostId: host.registration.hostId,
      hostGeneration: host.generation,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      artifactDirectory: options.artifactDirectory ?? null,
    } as BrowserAutomationRequest;
    const responsePromise = new Promise<BrowserAutomationResponse>((resolve, reject) => {
      const timer = this.timeout(requestId, timeoutMs, `Browser ${request.operation} timed out after ${timeoutMs}ms.`);
      this.pending.set(requestId, {
        kind: "automation", request, connectionId: host.connectionId,
        maximumResponseBytes: Math.min(this.maxResponseBytes, host.registration.capabilities.maxResponseBytes), timer, resolve, reject,
      });
    });
    try {
      await host.sendRequest(request);
    } catch (error) {
      this.failSend(requestId, error);
    }
    return responsePromise;
  }

  async requestLifecycle(options: BrowserHostLifecycleRequestOptions): Promise<BrowserHostLifecycleResponse> {
    const host = this.requireHost(options.expectedHost);
    if (!host.sendLifecycleRequest) throw brokerError("unsupported-operation", "Desktop does not support browser lifecycle protocol v2.", false);
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const requestId = this.allocateOrValidateLifecycleRequestId(options.requestId);
    const routing = {
      requestId, sessionAgentId: options.sessionAgentId, profileId: options.profileId,
      hostId: host.registration.hostId, hostGeneration: host.generation,
    };
    const request: BrowserHostLifecycleRequest = options.kind === "turn-ended"
      ? { ...routing, kind: options.kind, turnId: options.turnId }
      : { ...routing, kind: options.kind, reason: options.reason };
    const responsePromise = new Promise<BrowserHostLifecycleResponse>((resolve, reject) => {
      const timer = this.timeout(requestId, timeoutMs, `Browser lifecycle ${request.kind} timed out after ${timeoutMs}ms.`);
      this.pending.set(requestId, { kind: "lifecycle", request, connectionId: host.connectionId, timer, resolve, reject });
    });
    try {
      await host.sendLifecycleRequest(request);
    } catch (error) {
      this.failSend(requestId, error);
    }
    return responsePromise;
  }

  acceptResponse(connectionId: string, value: unknown, encodedBytes?: number): BrowserHostResponseDisposition {
    if (!isRecord(value) || typeof value.requestId !== "string") return "mismatched-response";
    const pending = this.pending.get(value.requestId);
    if (!pending) return this.completedRequestIds.has(value.requestId) ? "duplicate" : "unknown-request";
    if (pending.kind !== "automation" || !isAutomationResponse(value)) return "mismatched-response";
    const response = value as unknown as BrowserAutomationResponse;
    const authority = this.responseAuthorityDisposition(connectionId, response, pending);
    if (authority) return authority;
    if (!responseMatchesRequest(response, pending.request)) return "mismatched-response";
    const responseBytes = encodedBytes ?? Buffer.byteLength(safeJson(response), "utf8");
    if (responseBytes > pending.maximumResponseBytes) {
      this.finishWithError(pending, brokerError("response-too-large", "Browser host response exceeded the negotiated size limit.", false, { responseBytes, maximumResponseBytes: pending.maximumResponseBytes }));
      return "accepted";
    }
    this.finish(pending, response);
    return "accepted";
  }

  acceptLifecycleResponse(connectionId: string, value: unknown): BrowserHostResponseDisposition {
    if (!isRecord(value) || typeof value.requestId !== "string") return "mismatched-response";
    const pending = this.pending.get(value.requestId);
    if (!pending) return this.completedRequestIds.has(value.requestId) ? "duplicate" : "unknown-request";
    if (pending.kind !== "lifecycle" || !isLifecycleResponse(value)) return "mismatched-response";
    const response = value as unknown as BrowserHostLifecycleResponse;
    const authority = this.responseAuthorityDisposition(connectionId, response, pending);
    if (authority) return authority;
    if (!lifecycleResponseMatches(response, pending.request)) return "mismatched-response";
    this.finish(pending, response);
    return "accepted";
  }

  cancelSession(sessionAgentId: string, code: BrowserAutomationErrorCode = "request-cancelled", message = "Browser request was cancelled."): number {
    let cancelled = 0;
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionAgentId !== sessionAgentId) continue;
      this.finishWithError(pending, brokerError(code, message, code === "host-disconnected" || code === "request-cancelled"));
      cancelled += 1;
    }
    return cancelled;
  }

  getPendingCount(): number { return this.pending.size; }

  hasPendingSession(sessionAgentId: string): boolean {
    return [...this.pending.values()].some((pending) => pending.request.sessionAgentId === sessionAgentId);
  }

  private requireHost(expected?: { hostId: string; hostGeneration: number }): CurrentHost {
    const host = this.host;
    if (!host) throw brokerError("unavailable-host", "No local Automatic Browser Host is connected.", true);
    if (expected && (host.registration.hostId !== expected.hostId || host.generation !== expected.hostGeneration)) {
      throw brokerError("stale-host-generation", "The expected browser host authority is no longer current.", true);
    }
    return host;
  }

  private responseAuthorityDisposition(connectionId: string, response: { hostId: string; hostGeneration: number }, pending: PendingRequest): BrowserHostResponseDisposition | undefined {
    const host = this.host;
    if (!host || response.hostId !== host.registration.hostId || response.hostGeneration !== host.generation) return "stale-host";
    if (connectionId !== pending.connectionId || connectionId !== host.connectionId) return "wrong-connection";
    return undefined;
  }

  private finish(pending: PendingRequest, response: BrowserAutomationResponse | BrowserHostLifecycleResponse): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.requestId);
    this.rememberCompleted(pending.request.requestId);
    if (pending.kind === "automation") pending.resolve(response as BrowserAutomationResponse);
    else pending.resolve(response as BrowserHostLifecycleResponse);
  }

  private finishWithError(pending: PendingRequest, error: BrowserAutomationBrokerError): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.requestId);
    this.rememberCompleted(pending.request.requestId);
    pending.reject(error);
  }

  private rejectPendingForGeneration(generation: number, code: BrowserAutomationErrorCode, message: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.hostGeneration === generation) this.finishWithError(pending, brokerError(code, message, true));
    }
  }

  private allocateOrValidateRequestId(requestId?: string): string {
    if (requestId && (this.pending.has(requestId) || this.completedRequestIds.has(requestId))) {
      throw brokerError("invalid-input", "Browser request correlation was already used.", false);
    }
    if (requestId) return requestId;
    let candidate = this.requestId();
    while (this.pending.has(candidate) || this.completedRequestIds.has(candidate)) candidate = this.requestId();
    return candidate;
  }

  private allocateOrValidateLifecycleRequestId(requestId?: string): string {
    if (!requestId) return this.allocateOrValidateRequestId();
    if (this.pending.has(requestId)) throw brokerError("invalid-input", "Browser lifecycle correlation is already pending.", false);
    // Lifecycle receipts are durable and idempotent. A pending receipt may retry
    // the same exact request ID after a timeout without replaying automation.
    this.completedRequestIds.delete(requestId);
    return requestId;
  }

  private timeout(requestId: string, timeoutMs: number, message: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (pending) this.finishWithError(pending, brokerError("timeout", message, true, { timeoutMs }));
    }, timeoutMs);
    timer.unref?.();
    return timer;
  }

  private failSend(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (pending) this.finishWithError(pending, brokerError("host-disconnected", "Failed to send request to the browser host.", true, { cause: error instanceof Error ? error.message : String(error) }));
  }

  private rememberCompleted(requestId: string): void {
    this.completedRequestIds.add(requestId);
    if (this.completedRequestIds.size > 1_000) {
      const oldest = this.completedRequestIds.values().next().value as string | undefined;
      if (oldest) this.completedRequestIds.delete(oldest);
    }
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.round(value), BROWSER_AUTOMATION_MAX_TIMEOUT_MS));
}

function responseMatchesRequest(response: BrowserAutomationResponse, request: BrowserAutomationRequest): boolean {
  return response.requestId === request.requestId
    && response.hostId === request.hostId && response.hostGeneration === request.hostGeneration
    && response.operation === request.operation && response.sessionAgentId === request.sessionAgentId
    && response.profileId === request.profileId && response.tabId === request.tabId
    && Number.isFinite(response.elapsedMs)
    && ((response.ok && "result" in response && !("error" in response)) || (!response.ok && "error" in response && !("result" in response)));
}

function lifecycleResponseMatches(response: BrowserHostLifecycleResponse, request: BrowserHostLifecycleRequest): boolean {
  if (response.requestId !== request.requestId || response.kind !== request.kind || response.sessionAgentId !== request.sessionAgentId
    || response.profileId !== request.profileId || response.hostId !== request.hostId || response.hostGeneration !== request.hostGeneration) return false;
  if (!response.ok) return true;
  return response.kind === "turn-ended"
    ? request.kind === "turn-ended" && response.turnId === request.turnId
    : request.kind === "release-session" && response.reason === request.reason;
}

function isAutomationResponse(value: Record<string, unknown>): boolean {
  return typeof value.hostId === "string" && typeof value.hostGeneration === "number" && typeof value.sessionAgentId === "string"
    && typeof value.profileId === "string" && (typeof value.tabId === "string" || value.tabId === null)
    && typeof value.operation === "string" && typeof value.ok === "boolean" && typeof value.elapsedMs === "number";
}

function isLifecycleResponse(value: Record<string, unknown>): boolean {
  return typeof value.hostId === "string" && typeof value.hostGeneration === "number" && typeof value.sessionAgentId === "string"
    && typeof value.profileId === "string" && (value.kind === "turn-ended" || value.kind === "release-session") && typeof value.ok === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeJson(value: unknown): string { try { return JSON.stringify(value); } catch { return "{}"; } }
function brokerError(code: BrowserAutomationErrorCode, message: string, retryable = false, details?: BrowserAutomationFailure["details"]): BrowserAutomationBrokerError {
  return new BrowserAutomationBrokerError(code, message, retryable, details);
}
