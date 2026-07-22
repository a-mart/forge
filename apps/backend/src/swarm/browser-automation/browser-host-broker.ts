import { randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  type BrowserAutomationErrorCode,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserHostConnectionSnapshot,
  type BrowserHostRegistration,
} from "@forge/protocol";

export interface BrowserHostBrokerRegistration {
  connectionId: string;
  registration: BrowserHostRegistration;
  sendRequest: (request: BrowserAutomationRequest) => void | Promise<void>;
}

export interface BrowserHostBrokerRequest {
  sessionAgentId: string;
  profileId: string;
  tabId: string | null;
  operation: BrowserAutomationOperation;
  input: Record<string, unknown>;
  timeoutMs?: number;
  artifactDirectory?: string | null;
}

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
}

interface PendingRequest {
  request: BrowserAutomationRequest;
  connectionId: string;
  maximumResponseBytes: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: BrowserAutomationResponse) => void;
  reject: (error: BrowserAutomationBrokerError) => void;
}

export interface BrowserHostBrokerOptions {
  now?: () => string;
  requestId?: () => string;
  maxResponseBytes?: number;
  logDebug?: (message: string, details?: unknown) => void;
}

export class BrowserHostBroker {
  private readonly now: () => string;
  private readonly requestId: () => string;
  private readonly maxResponseBytes: number;
  private readonly logDebug: (message: string, details?: unknown) => void;
  private generation = 0;
  private host: CurrentHost | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completedRequestIds = new Set<string>();

  constructor(options: BrowserHostBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestId = options.requestId ?? randomUUID;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1_024 * 1_024;
    this.logDebug = options.logDebug ?? (() => undefined);
  }

  register(options: BrowserHostBrokerRegistration): BrowserHostConnectionSnapshot {
    if (this.host) {
      this.rejectPendingForGeneration(this.host.generation, "stale-host-generation", "Browser host was superseded by a newer registration.");
    }
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
    this.host = null;
    this.rejectPendingForGeneration(host.generation, "host-disconnected", "Browser host disconnected.");
    return true;
  }

  setFocused(connectionId: string, hostId: string, hostGeneration: number, focused: boolean): boolean {
    const host = this.host;
    if (!host || host.connectionId !== connectionId || host.registration.hostId !== hostId || host.generation !== hostGeneration) return false;
    host.focused = focused;
    return true;
  }

  isCurrentConnection(connectionId: string, hostId: string, hostGeneration: number): boolean {
    return !!this.host
      && this.host.connectionId === connectionId
      && this.host.registration.hostId === hostId
      && this.host.generation === hostGeneration;
  }

  getConnectionSnapshot(): BrowserHostConnectionSnapshot {
    const host = this.host;
    return host
      ? {
          connected: true,
          hostId: host.registration.hostId,
          hostGeneration: host.generation,
          focused: host.focused,
          capabilities: host.registration.capabilities,
          connectedAt: host.connectedAt,
        }
      : {
          connected: false,
          hostId: null,
          hostGeneration: null,
          focused: false,
          capabilities: null,
          connectedAt: null,
        };
  }

  async request(options: BrowserHostBrokerRequest): Promise<BrowserAutomationResponse> {
    const host = this.host;
    if (!host) throw brokerError("unavailable-host", "No local Electron browser host is connected.", true);
    if (!host.registration.capabilities.supportedOperations.includes(options.operation)) {
      this.logDebug("browser-host-broker:unsupported-operation", {
        hostId: host.registration.hostId,
        operation: options.operation,
      });
      throw brokerError("unsupported-operation", `The connected browser host does not support ${options.operation}.`, false, {
        operation: options.operation,
      });
    }

    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const request = {
      requestId: this.allocateRequestId(),
      sessionAgentId: options.sessionAgentId,
      profileId: options.profileId,
      tabId: options.tabId,
      operation: options.operation,
      input: options.input,
      hostId: host.registration.hostId,
      hostGeneration: host.generation,
      deadlineAt,
      artifactDirectory: options.artifactDirectory ?? null,
    } as BrowserAutomationRequest;

    const responsePromise = new Promise<BrowserAutomationResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        this.rememberCompleted(request.requestId);
        reject(brokerError("timeout", `Browser ${request.operation} timed out after ${timeoutMs}ms.`, true, { timeoutMs }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, {
        request,
        connectionId: host.connectionId,
        maximumResponseBytes: Math.min(this.maxResponseBytes, host.registration.capabilities.maxResponseBytes),
        timer,
        resolve,
        reject,
      });
    });

    try {
      await host.sendRequest(request);
    } catch (error) {
      const pending = this.pending.get(request.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        this.rememberCompleted(request.requestId);
        pending.reject(brokerError("host-disconnected", "Failed to send request to the browser host.", true, {
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return responsePromise;
  }

  acceptResponse(connectionId: string, value: unknown, encodedBytes?: number): BrowserHostResponseDisposition {
    if (!isResponseEnvelope(value)) return "mismatched-response";
    const response = value as BrowserAutomationResponse;
    const pending = this.pending.get(response.requestId);
    if (!pending) return this.completedRequestIds.has(response.requestId) ? "duplicate" : "unknown-request";
    if (!hasResponseRouting(value)) return "mismatched-response";
    const host = this.host;
    if (!host || response.hostId !== host.registration.hostId || response.hostGeneration !== host.generation) return "stale-host";
    if (connectionId !== pending.connectionId || connectionId !== host.connectionId) return "wrong-connection";
    if (!responseMatchesRequest(response, pending.request)) return "mismatched-response";

    const responseBytes = encodedBytes ?? Buffer.byteLength(safeJson(value), "utf8");
    if (responseBytes > pending.maximumResponseBytes) {
      this.finishWithError(pending, brokerError("response-too-large", "Browser host response exceeded the negotiated size limit.", false, {
        responseBytes,
        maximumResponseBytes: pending.maximumResponseBytes,
      }));
      return "accepted";
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    this.rememberCompleted(response.requestId);
    pending.resolve(response);
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

  getPendingCount(): number {
    return this.pending.size;
  }

  private finishWithError(pending: PendingRequest, error: BrowserAutomationBrokerError): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.requestId);
    this.rememberCompleted(pending.request.requestId);
    pending.reject(error);
  }

  private rejectPendingForGeneration(generation: number, code: BrowserAutomationErrorCode, message: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.hostGeneration !== generation) continue;
      this.finishWithError(pending, brokerError(code, message, true));
    }
  }

  private allocateRequestId(): string {
    let candidate = this.requestId();
    while (this.pending.has(candidate) || this.completedRequestIds.has(candidate)) candidate = this.requestId();
    return candidate;
  }

  private rememberCompleted(requestId: string): void {
    this.completedRequestIds.add(requestId);
    if (this.completedRequestIds.size <= 1_000) return;
    const oldest = this.completedRequestIds.values().next().value as string | undefined;
    if (oldest) this.completedRequestIds.delete(oldest);
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value)) return BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.round(value), BROWSER_AUTOMATION_MAX_TIMEOUT_MS));
}

function responseMatchesRequest(response: BrowserAutomationResponse, request: BrowserAutomationRequest): boolean {
  return response.requestId === request.requestId
    && response.hostId === request.hostId
    && response.hostGeneration === request.hostGeneration
    && response.operation === request.operation
    && response.sessionAgentId === request.sessionAgentId
    && response.profileId === request.profileId
    && response.tabId === request.tabId
    && typeof response.elapsedMs === "number"
    && Number.isFinite(response.elapsedMs)
    && ((response.ok === true && "result" in response && !("error" in response))
      || (response.ok === false && "error" in response && !("result" in response)));
}

function isResponseEnvelope(value: unknown): value is { requestId: string } {
  return !!value && typeof value === "object" && typeof (value as { requestId?: unknown }).requestId === "string";
}

function hasResponseRouting(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return typeof response.hostId === "string"
    && typeof response.hostGeneration === "number"
    && typeof response.sessionAgentId === "string"
    && typeof response.profileId === "string"
    && (typeof response.tabId === "string" || response.tabId === null)
    && typeof response.operation === "string";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
  }
}

function brokerError(
  code: BrowserAutomationErrorCode,
  message: string,
  retryable = false,
  details?: BrowserAutomationFailure["details"],
): BrowserAutomationBrokerError {
  return new BrowserAutomationBrokerError(code, message, retryable, details);
}
