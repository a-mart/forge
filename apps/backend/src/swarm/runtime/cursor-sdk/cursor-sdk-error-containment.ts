import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type AttributionMode = "als" | "single_active_scope";

type BackgroundAttributionFailureReason =
  | "als_scope_missing"
  | "no_active_scope"
  | "ambiguous_active_scopes"
  | "retained_closed_scope_without_active"
  | "retained_closed_scope_ambiguous";

type ScopeState = {
  id: string;
  agentId: string;
  promptToken: number;
  attemptIndex: number;
  sdkAgentId?: string;
  runId?: string;
  startedAt: string;
  cancelled: boolean;
  completed: boolean;
  closed: boolean;
  closedAt?: number;
  reapTimer?: ReturnType<typeof setTimeout>;
  containedFailure?: CursorSdkContainedBackgroundError;
  resolveContainedFailure: (error: CursorSdkContainedBackgroundError) => void;
  containedFailurePromise: Promise<CursorSdkContainedBackgroundError>;
  logDebug?: (message: string, details?: unknown) => void;
};

const CLOSED_SCOPE_TOMBSTONE_MS = 1_000;
const scopeStorage = new AsyncLocalStorage<string>();
const scopesById = new Map<string, ScopeState>();
const activeScopeIds = new Set<string>();
let handledReasons = new WeakSet<object>();
let hooksInstalled = false;

const RETRYABLE_HTTP2_RESET_CODES = new Set([
  "REFUSED_STREAM",
  "NGHTTP2_REFUSED_STREAM",
  "GOAWAY_SESSION",
  "NGHTTP2_GOAWAY_SESSION",
  "ENHANCE_YOUR_CALM",
  "NGHTTP2_ENHANCE_YOUR_CALM"
]);
const CURSOR_PROVIDER_ERROR_NAMES = new Set([
  "ConnectError",
  "NetworkError",
  "AuthenticationError",
  "RateLimitError",
  "AgentBusyError",
  "IntegrationNotConnectedError",
  "ConfigurationError"
]);
const PROGRAMMER_ERROR_NAMES = new Set([
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "ZodError"
]);
const PROTOCOL_OR_CONFIG_NODE_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_RETURN_VALUE",
  "ERR_INVALID_STATE"
]);
const TRANSIENT_CONNECT_CODE_NAMES = new Set(["UNAVAILABLE", "RESOURCE_EXHAUSTED"]);
const AUTH_CONNECT_CODE_NAMES = new Set(["UNAUTHENTICATED", "PERMISSION_DENIED"]);
const CANCEL_CONNECT_CODE_NAMES = new Set(["CANCELLED", "ABORTED"]);

export type CursorSdkFailureFamily = "connectrpc" | "cursor_sdk" | "http2" | "node_stream" | "generic";

export type CursorSdkFailureBucket =
  | "retryable_transport"
  | "auth_permission"
  | "cancel_abort"
  | "agent_busy_state"
  | "internal_stream"
  | "protocol_config"
  | "late_after_cancel"
  | "late_after_completion"
  | "late_after_close"
  | "unattributed"
  | "ambiguous_attribution"
  | "non_cursor";

export interface CursorSdkFailureEvidence {
  errorName?: string;
  errorCode?: string | number;
  message?: string;
  connectCode?: string | number;
  connectCodeName?: string;
  providerErrorNames?: string[];
  nodeCodes?: string[];
  h2ResetCodes?: string[];
  httpStatusCodes?: number[];
  moduleHintMatched?: boolean;
  cursorModuleHintMatched?: boolean;
  connectModuleHintMatched?: boolean;
  http2HintMatched?: boolean;
  attributionMode?: AttributionMode;
  activeScopeCount?: number;
  retainedClosedScopeCount?: number;
  attributionFailureReason?: BackgroundAttributionFailureReason;
  agentId?: string;
  promptToken?: number;
  runId?: string;
  sdkAgentId?: string;
  cancelled?: boolean;
  completed?: boolean;
  closed?: boolean;
  visibleOutputEmitted?: boolean;
  attemptIndex?: number;
  maxRetryAttempts?: number;
}

export interface CursorSdkFailureDecision {
  family: CursorSdkFailureFamily;
  bucket: CursorSdkFailureBucket;
  contain: boolean;
  retryPreOutput: boolean;
  fatal: boolean;
  reason: string;
  evidence: CursorSdkFailureEvidence;
}

export interface CursorSdkFailureClassificationContext {
  source: "awaited" | "background";
  attributionMode?: AttributionMode;
  activeScopeCount?: number;
  retainedClosedScopeCount?: number;
  attributionFailureReason?: BackgroundAttributionFailureReason;
  agentId?: string;
  promptToken?: number;
  runId?: string;
  sdkAgentId?: string;
  cancelled?: boolean;
  completed?: boolean;
  closed?: boolean;
  visibleOutputEmitted?: boolean;
  attemptIndex?: number;
  maxRetryAttempts?: number;
}

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
  readonly decision: CursorSdkFailureDecision;
  readonly errorName?: string;
  readonly errorCode?: string | number;
  readonly attributionMode?: AttributionMode;
  readonly agentId?: string;
  readonly promptToken?: number;
  readonly runId?: string;
  readonly sdkAgentId?: string;

  constructor(options: {
    cause: unknown;
    decision: CursorSdkFailureDecision;
  }) {
    const original = normalizeError(options.cause);
    super(original.message, { cause: options.cause });
    this.name = "CursorSdkContainedBackgroundError";
    this.decision = options.decision;
    this.errorName = options.decision.evidence.errorName ?? original.errorName;
    this.errorCode = options.decision.evidence.errorCode ?? original.errorCode;
    this.attributionMode = options.decision.evidence.attributionMode;
    this.agentId = options.decision.evidence.agentId;
    this.promptToken = options.decision.evidence.promptToken;
    this.runId = options.decision.evidence.runId;
    this.sdkAgentId = options.decision.evidence.sdkAgentId;
    this.stack = original.stack ?? this.stack;
  }
}

export function createCursorSdkBackgroundScope(options: {
  agentId: string;
  promptToken: number;
  attemptIndex?: number;
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
    attemptIndex: options.attemptIndex ?? 0,
    sdkAgentId: options.sdkAgentId,
    startedAt: options.startedAt,
    cancelled: false,
    completed: false,
    closed: false,
    resolveContainedFailure,
    containedFailurePromise,
    logDebug: options.logDebug
  };

  scopesById.set(id, state);
  activeScopeIds.add(id);
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
      if (state.closed) {
        return;
      }
      state.closed = true;
      state.closedAt = Date.now();
      activeScopeIds.delete(id);
      state.reapTimer = setTimeout(() => {
        if (scopesById.get(id) !== state) {
          return;
        }
        scopesById.delete(id);
        activeScopeIds.delete(id);
        maybeRemoveProcessHooks();
      }, CLOSED_SCOPE_TOMBSTONE_MS);
      state.reapTimer.unref?.();
      maybeRemoveProcessHooks();
    }
  };
}

export function classifyCursorSdkFailure(
  error: unknown,
  context: CursorSdkFailureClassificationContext
): CursorSdkFailureDecision {
  const facts = collectCursorSdkFailureFacts(error);
  const evidence: CursorSdkFailureEvidence = {
    errorName: facts.errorName,
    errorCode: facts.errorCode,
    message: facts.message,
    connectCode: facts.connectCode,
    connectCodeName: facts.connectCodeName,
    providerErrorNames: facts.providerErrorNames,
    nodeCodes: facts.nodeCodes,
    h2ResetCodes: facts.h2ResetCodes,
    httpStatusCodes: facts.httpStatusCodes,
    moduleHintMatched: facts.moduleHintMatched,
    cursorModuleHintMatched: facts.cursorModuleHintMatched,
    connectModuleHintMatched: facts.connectModuleHintMatched,
    http2HintMatched: facts.http2HintMatched,
    attributionMode: context.attributionMode,
    activeScopeCount: context.activeScopeCount,
    retainedClosedScopeCount: context.retainedClosedScopeCount,
    attributionFailureReason: context.attributionFailureReason,
    agentId: context.agentId,
    promptToken: context.promptToken,
    runId: context.runId,
    sdkAgentId: context.sdkAgentId,
    cancelled: context.cancelled,
    completed: context.completed,
    closed: context.closed,
    visibleOutputEmitted: context.visibleOutputEmitted,
    attemptIndex: context.attemptIndex,
    maxRetryAttempts: context.maxRetryAttempts
  };

  const baseDecision = classifyCursorSdkFailureBase(facts, evidence);
  if (context.source === "awaited") {
    return {
      ...baseDecision,
      contain: false,
      fatal: false,
      retryPreOutput: isRetryablePreOutputDecision(baseDecision.bucket, context),
      reason: baseDecision.reason
    };
  }

  if (baseDecision.bucket === "non_cursor" || baseDecision.bucket === "protocol_config") {
    return { ...baseDecision, contain: false, retryPreOutput: false, fatal: true };
  }

  if (context.attributionFailureReason) {
    const bucket = isAmbiguousAttributionReason(context.attributionFailureReason)
      ? "ambiguous_attribution"
      : "unattributed";
    return {
      family: baseDecision.family,
      bucket,
      contain: false,
      retryPreOutput: false,
      fatal: true,
      reason: bucket === "ambiguous_attribution"
        ? "Cursor-looking background failure matched provider taxonomy but attribution was ambiguous across active or retained scopes"
        : "Cursor-looking background failure matched provider taxonomy but no active Cursor prompt scope could be attributed",
      evidence
    };
  }

  if (context.cancelled) {
    return {
      family: baseDecision.family,
      bucket: "late_after_cancel",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Attributed Cursor background failure arrived after the prompt was cancelled",
      evidence
    };
  }

  if (context.completed) {
    return {
      family: baseDecision.family,
      bucket: "late_after_completion",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Attributed Cursor background failure arrived after the prompt completed successfully",
      evidence
    };
  }

  if (context.closed) {
    return {
      family: baseDecision.family,
      bucket: "late_after_close",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Attributed Cursor background failure arrived after the prompt scope closed",
      evidence
    };
  }

  return {
    ...baseDecision,
    contain: true,
    retryPreOutput: isRetryablePreOutputDecision(baseDecision.bucket, context),
    fatal: false
  };
}

export function emitCursorSdkBackgroundFailureForTests(reason: unknown): boolean {
  return tryContain(reason);
}

export function getCursorSdkErrorContainmentStateForTests(): {
  hooksInstalled: boolean;
  activeScopeCount: number;
  retainedClosedScopeCount: number;
  scopeCount: number;
} {
  return {
    hooksInstalled,
    activeScopeCount: activeScopeIds.size,
    retainedClosedScopeCount: scopesById.size - activeScopeIds.size,
    scopeCount: scopesById.size
  };
}

export function resetCursorSdkErrorContainmentForTests(): void {
  removeProcessHooks();
  for (const scope of scopesById.values()) {
    if (scope.reapTimer) {
      clearTimeout(scope.reapTimer);
    }
  }
  scopesById.clear();
  activeScopeIds.clear();
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
  if (scopesById.size > 0) {
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

  const attribution = resolveScopeAttribution();
  const decision = classifyCursorSdkFailure(reason, {
    source: "background",
    attributionMode: attribution.attributionMode,
    activeScopeCount: attribution.activeScopeCount,
    retainedClosedScopeCount: attribution.retainedClosedScopeCount,
    attributionFailureReason: attribution.reason,
    agentId: attribution.scope?.agentId,
    promptToken: attribution.scope?.promptToken,
    runId: attribution.scope?.runId,
    sdkAgentId: attribution.scope?.sdkAgentId,
    cancelled: attribution.scope?.cancelled,
    completed: attribution.scope?.completed,
    closed: attribution.scope?.closed,
    maxRetryAttempts: 1
  });

  if (!decision.contain) {
    logFatalPathIfCursorLooking(decision);
    return false;
  }

  if (trackedReason) {
    handledReasons.add(trackedReason);
  }

  const scope = attribution.scope;
  if (!scope) {
    logFatalPathIfCursorLooking(decision);
    return false;
  }

  if (isLateDecision(decision.bucket)) {
    scope.logDebug?.("cursor_sdk:background_error_contained", buildContainedDebugDetails(decision));
    return true;
  }

  if (scope.containedFailure) {
    return true;
  }

  const contained = new CursorSdkContainedBackgroundError({ cause: reason, decision });
  scope.containedFailure = contained;
  scope.resolveContainedFailure(contained);
  scope.logDebug?.("cursor_sdk:background_error_contained", buildContainedDebugDetails(decision));
  return true;
}

function resolveScopeAttribution(): {
  scope?: ScopeState;
  attributionMode?: AttributionMode;
  activeScopeCount: number;
  retainedClosedScopeCount: number;
  reason?: BackgroundAttributionFailureReason;
} {
  const activeScopeCount = activeScopeIds.size;
  const retainedClosedScopeCount = scopesById.size - activeScopeIds.size;
  const attributedScopeId = scopeStorage.getStore();
  if (attributedScopeId) {
    const attributedScope = scopesById.get(attributedScopeId);
    if (attributedScope) {
      return {
        scope: attributedScope,
        attributionMode: "als",
        activeScopeCount,
        retainedClosedScopeCount
      };
    }
    return {
      activeScopeCount,
      retainedClosedScopeCount,
      reason: "als_scope_missing"
    };
  }

  const activeScopes = [...activeScopeIds]
    .map((scopeId) => scopesById.get(scopeId))
    .filter((scope): scope is ScopeState => scope !== undefined);

  if (retainedClosedScopeCount > 0) {
    return {
      activeScopeCount,
      retainedClosedScopeCount,
      reason: activeScopeCount === 0 ? "retained_closed_scope_without_active" : "retained_closed_scope_ambiguous"
    };
  }

  if (activeScopes.length === 1) {
    return {
      scope: activeScopes[0],
      attributionMode: "single_active_scope",
      activeScopeCount,
      retainedClosedScopeCount
    };
  }

  return {
    activeScopeCount,
    retainedClosedScopeCount,
    reason: activeScopeCount === 0 ? "no_active_scope" : "ambiguous_active_scopes"
  };
}

function classifyCursorSdkFailureBase(
  facts: CursorSdkFailureFacts,
  evidence: CursorSdkFailureEvidence
): CursorSdkFailureDecision {
  if (facts.protocolOrConfig) {
    return {
      family: facts.family,
      bucket: "protocol_config",
      contain: false,
      retryPreOutput: false,
      fatal: true,
      reason: "Cursor-looking failure appears to be a protocol/config/shape bug and must remain fatal",
      evidence
    };
  }

  if (facts.retryableTransport) {
    return {
      family: facts.family,
      bucket: "retryable_transport",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Cursor background failure matched an exact transient transport/throttle signature",
      evidence
    };
  }

  if (facts.authOrPermission) {
    return {
      family: facts.family,
      bucket: "auth_permission",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Cursor background failure matched an auth/permission signature",
      evidence
    };
  }

  if (facts.cancelAbortOrDestroyed) {
    return {
      family: facts.family,
      bucket: "cancel_abort",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Cursor background failure matched a cancel/abort/stream-destroyed signature",
      evidence
    };
  }

  if (facts.agentBusyOrUserStateConflict) {
    return {
      family: facts.family,
      bucket: "agent_busy_state",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Cursor background failure matched an AgentBusy or user-state conflict signature",
      evidence
    };
  }

  if (facts.explicitInternalStream) {
    return {
      family: facts.family,
      bucket: "internal_stream",
      contain: true,
      retryPreOutput: false,
      fatal: false,
      reason: "Cursor background failure had concrete ConnectRPC/HTTP2 evidence but did not match a narrower retryable class",
      evidence
    };
  }

  return {
    family: facts.family,
    bucket: "non_cursor",
    contain: false,
    retryPreOutput: false,
    fatal: true,
    reason: "Process-level failure did not match the strict Cursor/connectrpc/http2 taxonomy",
    evidence
  };
}

function isRetryablePreOutputDecision(
  bucket: CursorSdkFailureBucket,
  context: CursorSdkFailureClassificationContext
): boolean {
  return bucket === "retryable_transport"
    && !context.cancelled
    && !context.completed
    && !context.closed
    && !context.visibleOutputEmitted
    && typeof context.attemptIndex === "number"
    && typeof context.maxRetryAttempts === "number"
    && context.attemptIndex < context.maxRetryAttempts;
}

function collectCursorSdkFailureFacts(error: unknown): CursorSdkFailureFacts {
  const chain = collectErrorChain(error);
  const primary = chain[0] ?? { message: typeof error === "string" ? error : String(error) };
  const combinedText = chain
    .flatMap((entry) => [entry.name ?? "", entry.message, entry.stack ?? "", stringifyCode(entry.code), stringifyCode(entry.rstCode)])
    .filter((value) => value.length > 0)
    .join("\n");
  const stackAndStructuredText = chain
    .flatMap((entry) => [entry.stack ?? "", stringifyCode(entry.code), stringifyCode(entry.rstCode)])
    .filter((value) => value.length > 0)
    .join("\n");

  const providerErrorNames = uniqueStrings(chain.map((entry) => entry.name).filter((value): value is string => typeof value === "string" && value.length > 0));
  const nodeCodes = uniqueStrings(chain.flatMap((entry) => {
    const values: string[] = [];
    if (typeof entry.code === "string" && entry.code.length > 0) {
      values.push(entry.code.toUpperCase());
    }
    return values.filter((value) => value.startsWith("ERR_") || value === "ABORT_ERR");
  }));
  const httpStatusCodes = uniqueNumbers(chain.flatMap((entry) => typeof entry.statusCode === "number" ? [entry.statusCode] : []));
  const cursorModuleHintMatched = /@cursor\/sdk|cursor sdk/i.test(combinedText);
  const connectModuleHintMatched = /@connectrpc|connectrpc/i.test(combinedText);
  const hasStructuredHttp2Evidence = chain.some((entry) => entry.rstCode !== undefined)
    || chain.some((entry) => typeof entry.code === "string" && (/^ERR_HTTP2_/i.test(entry.code) || /^NGHTTP2_/i.test(entry.code)))
    || /node:internal\/http2|internal\/http2/i.test(stackAndStructuredText);
  const hasStructuredConnectEvidence = chain.some((entry) => entry.name === "ConnectError")
    || connectModuleHintMatched
    || chain.some((entry) => isStructuredConnectCode(entry.code));
  const hasStructuredCursorEvidence = providerErrorNames.some((name) => CURSOR_PROVIDER_ERROR_NAMES.has(name)) || cursorModuleHintMatched;
  const hasRetryableProviderSignal = chain.some((entry) => entry.isRetryable === true);
  const hasTransportProvenance = cursorModuleHintMatched || connectModuleHintMatched || hasStructuredHttp2Evidence || hasStructuredConnectEvidence;
  const http2HintMatched = hasStructuredHttp2Evidence;
  const moduleHintMatched = cursorModuleHintMatched || connectModuleHintMatched || http2HintMatched;
  const allowTextFallback = hasStructuredConnectEvidence || hasStructuredCursorEvidence || hasStructuredHttp2Evidence;
  const h2ResetCodes = collectHttp2ResetCodes(chain, combinedText, allowTextFallback);
  const connectCode = pickConnectCode(chain, combinedText, allowTextFallback);
  const connectCodeName = normalizeConnectCodeName(connectCode);
  const family = resolveFailureFamily({ providerErrorNames, connectCodeName, nodeCodes, h2ResetCodes, cursorModuleHintMatched, connectModuleHintMatched, http2HintMatched });
  const exactCursor429 = providerErrorNames.includes("RateLimitError")
    && (httpStatusCodes.includes(429) || chain.some((entry) => entry.code === 429 || entry.code === "429"))
    && hasRetryableProviderSignal
    && hasTransportProvenance;
  const retryableTransport = connectCodeName !== undefined && TRANSIENT_CONNECT_CODE_NAMES.has(connectCodeName)
    || (providerErrorNames.includes("NetworkError") && (hasTransportProvenance || hasRetryableProviderSignal))
    || h2ResetCodes.some((code) => RETRYABLE_HTTP2_RESET_CODES.has(code))
    || exactCursor429;
  const authOrPermission = connectCodeName !== undefined && AUTH_CONNECT_CODE_NAMES.has(connectCodeName)
    || providerErrorNames.includes("AuthenticationError");
  const cancelAbortOrDestroyed = connectCodeName !== undefined && CANCEL_CONNECT_CODE_NAMES.has(connectCodeName)
    || ((providerErrorNames.includes("AbortError")
      || nodeCodes.includes("ABORT_ERR")
      || nodeCodes.includes("ERR_STREAM_DESTROYED")
      || /stream destroyed|stream is destroyed|abort(ed)?|cancel(l)?ed/i.test(combinedText))
      && hasTransportProvenance);
  const agentBusyOrUserStateConflict = providerErrorNames.includes("AgentBusyError")
    || providerErrorNames.includes("IntegrationNotConnectedError")
    || (moduleHintMatched && /agent busy|already.*active run|integration not connected/i.test(combinedText));
  const protocolOrConfig = providerErrorNames.includes("ConfigurationError")
    || providerErrorNames.some((name) => PROGRAMMER_ERROR_NAMES.has(name))
    || nodeCodes.some((code) => PROTOCOL_OR_CONFIG_NODE_CODES.has(code))
    || (moduleHintMatched && /unexpected token|failed to parse|invalid response|schema|shape mismatch|serialization/i.test(combinedText));
  const explicitInternalStream = (family === "connectrpc" || family === "http2")
    && !retryableTransport
    && !authOrPermission
    && !cancelAbortOrDestroyed
    && !agentBusyOrUserStateConflict
    && !protocolOrConfig;

  return {
    family,
    errorName: primary.name,
    errorCode: normalizeScalarCode(primary.code),
    message: primary.message,
    connectCode,
    connectCodeName,
    providerErrorNames,
    nodeCodes,
    h2ResetCodes,
    httpStatusCodes,
    moduleHintMatched,
    cursorModuleHintMatched,
    connectModuleHintMatched,
    http2HintMatched,
    retryableTransport,
    authOrPermission,
    cancelAbortOrDestroyed,
    agentBusyOrUserStateConflict,
    protocolOrConfig,
    explicitInternalStream
  };
}

function collectErrorChain(error: unknown): NormalizedErrorEntry[] {
  const entries: NormalizedErrorEntry[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  for (let index = 0; index < 8; index += 1) {
    entries.push(normalizeErrorEntry(current));
    if (!current || typeof current !== "object") {
      break;
    }
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined) {
      break;
    }
    current = next;
  }

  return entries;
}

function collectHttp2ResetCodes(chain: NormalizedErrorEntry[], combinedText: string, allowTextFallback: boolean): string[] {
  const codes = chain.flatMap((entry) => {
    const values: string[] = [];
    if (typeof entry.rstCode === "string" && entry.rstCode.trim().length > 0) {
      values.push(normalizeSymbolLikeToken(entry.rstCode));
    }
    if (typeof entry.code === "string" && /^NGHTTP2_/i.test(entry.code)) {
      values.push(normalizeSymbolLikeToken(entry.code));
    }
    return values;
  });
  if (allowTextFallback) {
    for (const match of combinedText.matchAll(/NGHTTP2_[A-Z_]+|REFUSED_STREAM|GOAWAY_SESSION|ENHANCE_YOUR_CALM/gi)) {
      codes.push(normalizeSymbolLikeToken(match[0]));
    }
  }
  return uniqueStrings(codes);
}

function pickConnectCode(chain: NormalizedErrorEntry[], combinedText: string, allowTextFallback: boolean): string | number | undefined {
  for (const entry of chain) {
    if (entry.name === "ConnectError" || /connecterror/i.test(entry.message) || /@connectrpc|connectrpc/i.test(`${entry.message}\n${entry.stack ?? ""}`)) {
      const normalized = normalizeScalarCode(entry.code);
      if (normalized !== undefined) {
        return normalized;
      }
    }
  }

  if (!allowTextFallback) {
    return undefined;
  }

  if (/ERROR_NOT_LOGGED_IN|ERR_NOT_LOGGED_IN/i.test(combinedText)) {
    return "ERR_NOT_LOGGED_IN";
  }
  if (/\[unauthenticated\]/i.test(combinedText)) {
    return "Unauthenticated";
  }
  if (/\[permission_denied\]|permission denied/i.test(combinedText)) {
    return "PermissionDenied";
  }
  if (/\[unavailable\]/i.test(combinedText)) {
    return "Unavailable";
  }
  if (/\[resource_exhausted\]/i.test(combinedText)) {
    return "ResourceExhausted";
  }
  return undefined;
}

function normalizeConnectCodeName(code: string | number | undefined): string | undefined {
  if (typeof code === "number") {
    switch (code) {
      case 1:
        return "CANCELLED";
      case 7:
        return "PERMISSION_DENIED";
      case 8:
        return "RESOURCE_EXHAUSTED";
      case 14:
        return "UNAVAILABLE";
      case 16:
        return "UNAUTHENTICATED";
      default:
        return undefined;
    }
  }

  if (typeof code !== "string") {
    return undefined;
  }

  const normalized = normalizeSymbolLikeToken(code);
  if (normalized === "ERR_NOT_LOGGED_IN" || normalized === "ERROR_NOT_LOGGED_IN") {
    return "UNAUTHENTICATED";
  }
  if (normalized === "UNAUTHENTICATED") {
    return "UNAUTHENTICATED";
  }
  if (normalized === "PERMISSION_DENIED") {
    return "PERMISSION_DENIED";
  }
  if (normalized === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  if (normalized === "RESOURCE_EXHAUSTED") {
    return "RESOURCE_EXHAUSTED";
  }
  if (normalized === "CANCELLED" || normalized === "CANCELED") {
    return "CANCELLED";
  }
  if (normalized === "ABORT_ERR" || normalized === "ABORTED") {
    return "ABORTED";
  }

  return undefined;
}

function resolveFailureFamily(options: {
  providerErrorNames: string[];
  connectCodeName?: string;
  nodeCodes: string[];
  h2ResetCodes: string[];
  cursorModuleHintMatched: boolean;
  connectModuleHintMatched: boolean;
  http2HintMatched: boolean;
}): CursorSdkFailureFamily {
  if (options.connectCodeName !== undefined || options.providerErrorNames.includes("ConnectError") || options.connectModuleHintMatched) {
    return "connectrpc";
  }
  if (options.nodeCodes.includes("ERR_HTTP2_STREAM_ERROR") || options.h2ResetCodes.length > 0 || options.http2HintMatched) {
    return "http2";
  }
  if (options.providerErrorNames.some((name) => CURSOR_PROVIDER_ERROR_NAMES.has(name)) || options.cursorModuleHintMatched) {
    return "cursor_sdk";
  }
  if (options.nodeCodes.includes("ABORT_ERR") || options.nodeCodes.includes("ERR_STREAM_DESTROYED")) {
    return "node_stream";
  }
  return "generic";
}

function isAmbiguousAttributionReason(reason: BackgroundAttributionFailureReason): boolean {
  return reason === "ambiguous_active_scopes" || reason === "retained_closed_scope_ambiguous";
}

function isLateDecision(bucket: CursorSdkFailureBucket): boolean {
  return bucket === "late_after_cancel" || bucket === "late_after_completion" || bucket === "late_after_close";
}

function logFatalPathIfCursorLooking(decision: CursorSdkFailureDecision): void {
  if (process.env.FORGE_DEBUG !== "true") {
    return;
  }
  if (decision.bucket === "non_cursor" && !decision.evidence.moduleHintMatched && decision.evidence.providerErrorNames?.length === 0) {
    return;
  }
  console.debug("cursor_sdk:background_error_unmatched", {
    reason: decision.evidence.attributionFailureReason ?? decision.bucket,
    family: decision.family,
    bucket: decision.bucket,
    activeScopeCount: decision.evidence.activeScopeCount,
    retainedClosedScopeCount: decision.evidence.retainedClosedScopeCount,
    errorName: decision.evidence.errorName,
    errorCode: decision.evidence.errorCode,
    errorMessage: decision.evidence.message,
    connectCode: decision.evidence.connectCode,
    connectCodeName: decision.evidence.connectCodeName,
    nodeCodes: decision.evidence.nodeCodes,
    h2ResetCodes: decision.evidence.h2ResetCodes,
    providerErrorNames: decision.evidence.providerErrorNames
  });
}

function buildContainedDebugDetails(decision: CursorSdkFailureDecision): Record<string, unknown> {
  const state = decision.bucket === "late_after_cancel"
    ? "cancelled"
    : decision.bucket === "late_after_completion"
      ? "completed"
      : decision.bucket === "late_after_close"
        ? "closed"
        : undefined;
  return {
    family: decision.family,
    bucket: decision.bucket,
    reason: decision.reason,
    agentId: decision.evidence.agentId,
    promptToken: decision.evidence.promptToken,
    runId: decision.evidence.runId,
    sdkAgentId: decision.evidence.sdkAgentId,
    source: "cursor_sdk_background",
    errorName: decision.evidence.errorName,
    errorCode: decision.evidence.errorCode,
    errorMessage: decision.evidence.message,
    attributionMode: decision.evidence.attributionMode,
    connectCode: decision.evidence.connectCode,
    connectCodeName: decision.evidence.connectCodeName,
    nodeCodes: decision.evidence.nodeCodes,
    h2ResetCodes: decision.evidence.h2ResetCodes,
    providerErrorNames: decision.evidence.providerErrorNames,
    ...(state ? { state } : {})
  };
}

function preserveFatalUnhandledFailure(reason: unknown): void {
  removeProcessHooks();
  queueMicrotask(() => {
    throw normalizeThrowable(reason);
  });
}

function normalizeError(error: unknown): {
  message: string;
  stack?: string;
  errorName?: string;
  errorCode?: string | number;
} {
  const entry = normalizeErrorEntry(error);
  return {
    message: entry.message,
    stack: entry.stack,
    errorName: entry.name,
    errorCode: normalizeScalarCode(entry.code)
  };
}

function normalizeErrorEntry(error: unknown): NormalizedErrorEntry {
  if (error instanceof CursorSdkContainedBackgroundError) {
    return {
      name: error.errorName,
      message: error.message,
      stack: error.stack,
      code: error.errorCode
    };
  }

  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? error.name : error.constructor.name;
    return {
      name: name && name !== "Error" ? name : undefined,
      message: error.message || String(error),
      stack: error.stack,
      code: readCode(error),
      rstCode: readRstCode(error),
      statusCode: readStatusCode(error),
      isRetryable: readIsRetryable(error)
    };
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      code?: unknown;
      rstCode?: unknown;
      statusCode?: unknown;
      isRetryable?: unknown;
    };
    const name = typeof candidate.name === "string" && candidate.name.trim().length > 0 ? candidate.name.trim() : undefined;
    const message = typeof candidate.message === "string"
      ? candidate.message
      : name ?? String(error);
    return {
      name,
      message,
      stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
      code: normalizeScalarCode(candidate.code),
      rstCode: normalizeScalarCode(candidate.rstCode),
      statusCode: typeof candidate.statusCode === "number" && Number.isFinite(candidate.statusCode) ? candidate.statusCode : undefined,
      isRetryable: typeof candidate.isRetryable === "boolean" ? candidate.isRetryable : undefined
    };
  }

  return {
    message: typeof error === "string" ? error : String(error)
  };
}

function readCode(error: Error): string | number | undefined {
  return normalizeScalarCode((error as { code?: unknown }).code);
}

function readRstCode(error: Error): string | number | undefined {
  return normalizeScalarCode((error as { rstCode?: unknown }).rstCode);
}

function readStatusCode(error: Error): number | undefined {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && Number.isFinite(statusCode) ? statusCode : undefined;
}

function readIsRetryable(error: Error): boolean | undefined {
  const isRetryable = (error as { isRetryable?: unknown }).isRetryable;
  return typeof isRetryable === "boolean" ? isRetryable : undefined;
}

function normalizeScalarCode(code: unknown): string | number | undefined {
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string" && code.trim().length > 0) {
    return code.trim();
  }
  return undefined;
}

function normalizeThrowable(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : String(reason));
}

function normalizeSymbolLikeToken(value: string): string {
  return value.trim().replace(/[\s-]+/g, "_").toUpperCase();
}

function isStructuredConnectCode(code: string | number | undefined): boolean {
  if (typeof code === "number") {
    return code === 1 || code === 7 || code === 8 || code === 14 || code === 16;
  }
  if (typeof code !== "string") {
    return false;
  }

  const normalized = normalizeSymbolLikeToken(code);
  return normalized === "ERR_NOT_LOGGED_IN"
    || normalized === "ERROR_NOT_LOGGED_IN"
    || normalized === "UNAUTHENTICATED"
    || normalized === "PERMISSION_DENIED"
    || normalized === "UNAVAILABLE"
    || normalized === "RESOURCE_EXHAUSTED";
}

function stringifyCode(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)))];
}

function isWeakSetTrackable(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

type NormalizedErrorEntry = {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  rstCode?: string | number;
  statusCode?: number;
  isRetryable?: boolean;
};

type CursorSdkFailureFacts = {
  family: CursorSdkFailureFamily;
  errorName?: string;
  errorCode?: string | number;
  message?: string;
  connectCode?: string | number;
  connectCodeName?: string;
  providerErrorNames: string[];
  nodeCodes: string[];
  h2ResetCodes: string[];
  httpStatusCodes: number[];
  moduleHintMatched: boolean;
  cursorModuleHintMatched: boolean;
  connectModuleHintMatched: boolean;
  http2HintMatched: boolean;
  retryableTransport: boolean;
  authOrPermission: boolean;
  cancelAbortOrDestroyed: boolean;
  agentBusyOrUserStateConflict: boolean;
  protocolOrConfig: boolean;
  explicitInternalStream: boolean;
};
