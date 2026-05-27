import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type AttributionMode = "als" | "single_active_scope";

type ScopeState = {
  id: string;
  agentId: string;
  promptToken: number;
  sdkAgentId?: string;
  runId?: string;
  startedAt: string;
  cancelled: boolean;
  completed: boolean;
  closed: boolean;
  containedFailure?: CursorSdkContainedBackgroundError;
  resolveContainedFailure: (error: CursorSdkContainedBackgroundError) => void;
  containedFailurePromise: Promise<CursorSdkContainedBackgroundError>;
  logDebug?: (message: string, details?: unknown) => void;
};

const scopeStorage = new AsyncLocalStorage<string>();
const activeScopes = new Map<string, ScopeState>();
let handledReasons = new WeakSet<object>();

let hooksInstalled = false;

export interface CursorSdkBackgroundScope {
  readonly agentId: string;
  readonly promptToken: number;
  runWithAttribution<T>(callback: () => Promise<T>): Promise<T>;
  waitForContainedFailure(): Promise<CursorSdkContainedBackgroundError>;
  update(details: { sdkAgentId?: string; runId?: string }): void;
  markCancelled(): void;
  markCompleted(): void;
  close(): void;
}

export class CursorSdkContainedBackgroundError extends Error {
  readonly source = "cursor_sdk_background" as const;
  readonly errorName?: string;
  readonly errorCode?: string | number;
  readonly attributionMode: AttributionMode;
  readonly agentId: string;
  readonly promptToken: number;
  readonly runId?: string;
  readonly sdkAgentId?: string;

  constructor(options: {
    cause: unknown;
    attributionMode: AttributionMode;
    agentId: string;
    promptToken: number;
    runId?: string;
    sdkAgentId?: string;
  }) {
    const original = normalizeError(options.cause);
    super(original.message, { cause: options.cause });
    this.name = "CursorSdkContainedBackgroundError";
    this.errorName = original.errorName;
    this.errorCode = original.errorCode;
    this.attributionMode = options.attributionMode;
    this.agentId = options.agentId;
    this.promptToken = options.promptToken;
    this.runId = options.runId;
    this.sdkAgentId = options.sdkAgentId;
    this.stack = original.stack ?? this.stack;
  }
}

export function createCursorSdkBackgroundScope(options: {
  agentId: string;
  promptToken: number;
  startedAt: string;
  sdkAgentId?: string;
  logDebug?: (message: string, details?: unknown) => void;
}): CursorSdkBackgroundScope {
  const id = randomUUID();
  let resolveContainedFailure!: (error: CursorSdkContainedBackgroundError) => void;
  const containedFailurePromise = new Promise<CursorSdkContainedBackgroundError>((resolve) => {
    resolveContainedFailure = resolve;
  });
  const state: ScopeState = {
    id,
    agentId: options.agentId,
    promptToken: options.promptToken,
    sdkAgentId: options.sdkAgentId,
    startedAt: options.startedAt,
    cancelled: false,
    completed: false,
    closed: false,
    resolveContainedFailure,
    containedFailurePromise,
    logDebug: options.logDebug
  };

  activeScopes.set(id, state);
  ensureProcessHooks();

  return {
    agentId: options.agentId,
    promptToken: options.promptToken,
    async runWithAttribution<T>(callback: () => Promise<T>): Promise<T> {
      return await scopeStorage.run(id, callback);
    },
    waitForContainedFailure(): Promise<CursorSdkContainedBackgroundError> {
      return state.containedFailurePromise;
    },
    update(details: { sdkAgentId?: string; runId?: string }): void {
      if (typeof details.sdkAgentId === "string" && details.sdkAgentId.trim().length > 0) {
        state.sdkAgentId = details.sdkAgentId;
      }
      if (typeof details.runId === "string" && details.runId.trim().length > 0) {
        state.runId = details.runId;
      }
    },
    markCancelled(): void {
      state.cancelled = true;
    },
    markCompleted(): void {
      state.completed = true;
    },
    close(): void {
      state.closed = true;
      activeScopes.delete(id);
      maybeRemoveProcessHooks();
    }
  };
}

export function isCursorSdkTransientAuthConnectError(error: unknown): boolean {
  const original = normalizeError(error);
  const nameMatches = original.errorName === "ConnectError";
  const messageMatches = /unauthenticated/i.test(original.message);
  const normalizedCode = typeof original.errorCode === "string" ? original.errorCode.trim().toUpperCase() : original.errorCode;
  const codeMatches = normalizedCode === 16 || normalizedCode === "16"
    || normalizedCode === "ERR_NOT_LOGGED_IN"
    || normalizedCode === "ERROR_NOT_LOGGED_IN";
  const stackAndMessage = `${original.message}\n${original.stack ?? ""}`;
  const moduleHintMatches = /@connectrpc|connectrpc|@cursor\/sdk|cursor sdk/i.test(stackAndMessage)
    || normalizedCode === "ERR_NOT_LOGGED_IN"
    || normalizedCode === "ERROR_NOT_LOGGED_IN";

  return nameMatches && messageMatches && codeMatches && moduleHintMatches;
}

export function emitCursorSdkBackgroundFailureForTests(reason: unknown): boolean {
  return tryContain(reason);
}

export function resetCursorSdkErrorContainmentForTests(): void {
  removeProcessHooks();
  activeScopes.clear();
  handledReasons = new WeakSet<object>();
}

function ensureProcessHooks(): void {
  if (hooksInstalled) {
    return;
  }
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  hooksInstalled = true;
}

function maybeRemoveProcessHooks(): void {
  if (activeScopes.size > 0) {
    return;
  }
  removeProcessHooks();
}

function removeProcessHooks(): void {
  if (!hooksInstalled) {
    return;
  }
  process.off("unhandledRejection", onUnhandledRejection);
  process.off("uncaughtException", onUncaughtException);
  hooksInstalled = false;
}

function onUnhandledRejection(reason: unknown): void {
  if (tryContain(reason)) {
    return;
  }
  preserveFatalUnhandledFailure(reason);
}

function onUncaughtException(error: Error, origin: NodeJS.UncaughtExceptionOrigin): void {
  if (origin === "unhandledRejection" && tryContain(error)) {
    return;
  }
  preserveFatalUnhandledFailure(error);
}

function tryContain(reason: unknown): boolean {
  const trackedReason = isWeakSetTrackable(reason) ? reason : undefined;
  if (trackedReason && handledReasons.has(trackedReason)) {
    return true;
  }

  if (!isCursorSdkTransientAuthConnectError(reason)) {
    return false;
  }

  const attributed = resolveScope(reason);
  if (!attributed) {
    return false;
  }

  if (trackedReason) {
    handledReasons.add(trackedReason);
  }

  if (attributed.scope.cancelled || attributed.scope.completed || attributed.scope.closed) {
    attributed.scope.logDebug?.("cursor_sdk:background_error_contained", {
      agentId: attributed.scope.agentId,
      promptToken: attributed.scope.promptToken,
      runId: attributed.scope.runId,
      sdkAgentId: attributed.scope.sdkAgentId,
      source: "cursor_sdk_background",
      errorName: normalizeError(reason).errorName,
      errorCode: normalizeError(reason).errorCode,
      errorMessage: normalizeError(reason).message,
      attributionMode: attributed.attributionMode,
      state: attributed.scope.cancelled ? "cancelled" : attributed.scope.completed ? "completed" : "closed"
    });
    return true;
  }

  if (attributed.scope.containedFailure) {
    return true;
  }

  const contained = new CursorSdkContainedBackgroundError({
    cause: reason,
    attributionMode: attributed.attributionMode,
    agentId: attributed.scope.agentId,
    promptToken: attributed.scope.promptToken,
    runId: attributed.scope.runId,
    sdkAgentId: attributed.scope.sdkAgentId
  });
  attributed.scope.containedFailure = contained;
  attributed.scope.resolveContainedFailure(contained);
  attributed.scope.logDebug?.("cursor_sdk:background_error_contained", {
    agentId: attributed.scope.agentId,
    promptToken: attributed.scope.promptToken,
    runId: attributed.scope.runId,
    sdkAgentId: attributed.scope.sdkAgentId,
    source: contained.source,
    errorName: contained.errorName,
    errorCode: contained.errorCode,
    errorMessage: contained.message,
    attributionMode: attributed.attributionMode
  });
  return true;
}

function resolveScope(reason: unknown): { scope: ScopeState; attributionMode: AttributionMode } | undefined {
  const attributedScopeId = scopeStorage.getStore();
  if (attributedScopeId) {
    const attributedScope = activeScopes.get(attributedScopeId);
    if (attributedScope) {
      return { scope: attributedScope, attributionMode: "als" };
    }
    logUnmatched(reason, "als_scope_missing");
    return undefined;
  }

  if (activeScopes.size === 1) {
    const [scope] = activeScopes.values();
    return { scope, attributionMode: "single_active_scope" };
  }

  logUnmatched(reason, activeScopes.size === 0 ? "no_active_scope" : "ambiguous_active_scopes");
  return undefined;
}

function preserveFatalUnhandledFailure(reason: unknown): void {
  removeProcessHooks();
  queueMicrotask(() => {
    throw normalizeThrowable(reason);
  });
}

function logUnmatched(reason: unknown, reasonCode: string): void {
  if (process.env.FORGE_DEBUG !== "true") {
    return;
  }
  const normalized = normalizeError(reason);
  console.debug("cursor_sdk:background_error_unmatched", {
    reason: reasonCode,
    activeScopeCount: activeScopes.size,
    errorName: normalized.errorName,
    errorCode: normalized.errorCode,
    errorMessage: normalized.message
  });
}

function normalizeError(error: unknown): {
  message: string;
  stack?: string;
  errorName?: string;
  errorCode?: string | number;
} {
  if (error instanceof CursorSdkContainedBackgroundError) {
    return {
      message: error.message,
      stack: error.stack,
      errorName: error.errorName,
      errorCode: error.errorCode
    };
  }

  if (error instanceof Error) {
    const errorName = error.name && error.name !== "Error" ? error.name : error.constructor.name;
    const code = (error as { code?: unknown }).code;
    return {
      message: error.message || String(error),
      stack: error.stack,
      errorName: errorName && errorName !== "Error" ? errorName : undefined,
      errorCode: typeof code === "string" || typeof code === "number" ? code : undefined
    };
  }

  return { message: typeof error === "string" ? error : String(error) };
}

function normalizeThrowable(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : String(reason));
}

function isWeakSetTrackable(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
