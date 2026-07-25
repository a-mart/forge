import { randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  DEFAULT_BROWSER_HOST_KIND,
  resolveBrowserHostKind,
  type BrowserAutomationErrorCode,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserHostConnectionSnapshot,
  type BrowserHostKind,
  type BrowserHostRegistration,
} from "@forge/protocol";

export interface BrowserHostBrokerRegistration {
  connectionId: string;
  registration: BrowserHostRegistration;
  sendRequest: (request: BrowserAutomationRequest) => void | Promise<void>;
}

export interface BrowserHostBrokerRequest {
  hostKind?: BrowserHostKind;
  sessionAgentId: string;
  profileId: string;
  tabId: string | null;
  operation: BrowserAutomationOperation;
  input: Record<string, unknown>;
  timeoutMs?: number;
  artifactDirectory?: string | null;
  /** Reserved for backend-owned, privacy-bounded correlation such as lifecycle release. */
  requestId?: string;
  /** Fail closed rather than routing an authority-sensitive request to a replacement host. */
  expectedHost?: { hostId: string; hostGeneration: number };
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
  hostKind: BrowserHostKind;
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
  private readonly generations = new Map<BrowserHostKind, number>();
  private readonly hosts = new Map<BrowserHostKind, CurrentHost>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completedRequestIds = new Set<string>();

  constructor(options: BrowserHostBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestId = options.requestId ?? randomUUID;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1_024 * 1_024;
    this.logDebug = options.logDebug ?? (() => undefined);
  }

  register(options: BrowserHostBrokerRegistration): BrowserHostConnectionSnapshot {
    const hostKind = resolveBrowserHostKind(options.registration.capabilities.hostKind);
    const previous = this.hosts.get(hostKind);
    if (previous) {
      this.rejectPendingForGeneration(hostKind, previous.generation, "stale-host-generation", "Browser host was superseded by a newer registration.");
    }
    const generation = (this.generations.get(hostKind) ?? 0) + 1;
    this.generations.set(hostKind, generation);
    this.hosts.set(hostKind, {
      ...options,
      registration: {
        ...options.registration,
        capabilities: { ...options.registration.capabilities, hostKind },
      },
      hostKind,
      generation,
      connectedAt: this.now(),
      focused: false,
    });
    return this.getConnectionSnapshot(hostKind);
  }

  unregister(connectionId: string, hostId?: string, hostGeneration?: number, hostKind?: BrowserHostKind): boolean {
    const kinds = hostKind ? [hostKind] : [...this.hosts.keys()];
    let removed = false;
    for (const kind of kinds) {
      const host = this.hosts.get(kind);
      if (!host || host.connectionId !== connectionId) continue;
      if (hostId !== undefined && host.registration.hostId !== hostId) continue;
      if (hostGeneration !== undefined && host.generation !== hostGeneration) continue;
      this.hosts.delete(kind);
      this.rejectPendingForGeneration(kind, host.generation, "host-disconnected", "Browser host disconnected.");
      removed = true;
    }
    return removed;
  }

  setFocused(connectionId: string, hostId: string, hostGeneration: number, focused: boolean, hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): boolean {
    const host = this.hosts.get(hostKind);
    if (!host || host.connectionId !== connectionId || host.registration.hostId !== hostId || host.generation !== hostGeneration) return false;
    host.focused = focused;
    return true;
  }

  isCurrentConnection(connectionId: string, hostId: string, hostGeneration: number, hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): boolean {
    const host = this.hosts.get(hostKind);
    return !!host
      && host.connectionId === connectionId
      && host.registration.hostId === hostId
      && host.generation === hostGeneration;
  }

  getConnectionSnapshot(hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): BrowserHostConnectionSnapshot {
    const host = this.hosts.get(hostKind);
    return host
      ? {
          hostKind,
          connected: true,
          hostId: host.registration.hostId,
          hostGeneration: host.generation,
          focused: host.focused,
          capabilities: host.registration.capabilities,
          connectedAt: host.connectedAt,
        }
      : {
          hostKind,
          connected: false,
          hostId: null,
          hostGeneration: null,
          focused: false,
          capabilities: null,
          connectedAt: null,
        };
  }

  getConnectionSnapshots(): BrowserHostConnectionSnapshot[] {
    return (["managed-electron", "external-chrome"] as const).map((kind) => this.getConnectionSnapshot(kind));
  }

  async request(options: BrowserHostBrokerRequest): Promise<BrowserAutomationResponse> {
    const hostKind = resolveBrowserHostKind(options.hostKind);
    const host = this.hosts.get(hostKind);
    if (!host) throw brokerError("unavailable-host", `No local ${hostKind} browser host is connected.`, true, { hostKind });
    if (options.expectedHost && (
      host.registration.hostId !== options.expectedHost.hostId
      || host.generation !== options.expectedHost.hostGeneration
    )) {
      throw brokerError("stale-host-generation", "The expected browser host authority is no longer current.", true);
    }
    if (!host.registration.capabilities.supportedOperations.includes(options.operation)) {
      this.logDebug("browser-host-broker:unsupported-operation", {
        hostKind,
        hostId: host.registration.hostId,
        operation: options.operation,
      });
      throw brokerError("unsupported-operation", `The ${hostKind} browser host does not support ${options.operation}.`, false, {
        hostKind,
        operation: options.operation,
      });
    }

    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const requestId = options.requestId ?? this.allocateRequestId();
    if (options.requestId && (this.pending.has(requestId) || this.completedRequestIds.has(requestId))) {
      throw brokerError("invalid-input", "Browser request correlation was already used.", false);
    }
    const request = {
      requestId,
      hostKind,
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
    const pending = this.pending.get(value.requestId);
    if (!pending) return this.completedRequestIds.has(value.requestId) ? "duplicate" : "unknown-request";
    if (!hasResponseRouting(value)) return "mismatched-response";
    const response = value as BrowserAutomationResponse;
    const host = this.hosts.get(response.hostKind);
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

  hasPendingSession(sessionAgentId: string, hostKind?: BrowserHostKind): boolean {
    for (const pending of this.pending.values()) {
      if (pending.request.sessionAgentId !== sessionAgentId) continue;
      if (hostKind !== undefined && pending.request.hostKind !== hostKind) continue;
      return true;
    }
    return false;
  }

  private finishWithError(pending: PendingRequest, error: BrowserAutomationBrokerError): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.requestId);
    this.rememberCompleted(pending.request.requestId);
    pending.reject(error);
  }

  private rejectPendingForGeneration(hostKind: BrowserHostKind, generation: number, code: BrowserAutomationErrorCode, message: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.hostKind !== hostKind || pending.request.hostGeneration !== generation) continue;
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
    && response.hostKind === request.hostKind
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
  return (response.hostKind === "managed-electron" || response.hostKind === "external-chrome")
    && typeof response.hostId === "string"
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
