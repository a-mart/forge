import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyCursorSdkFailure,
  createCursorSdkBackgroundScope,
  emitCursorSdkBackgroundFailureForTests,
  getCursorSdkErrorContainmentStateForTests,
  resetCursorSdkErrorContainmentForTests,
  type CursorSdkFailureBucket
} from "../runtime/cursor-sdk/cursor-sdk-error-containment.js";

function createConnectError(options: {
  code?: string | number;
  message?: string;
  stackHint?: string;
  cause?: unknown;
} = {}): Error & { code?: string | number; cause?: unknown } {
  class ConnectError extends Error {
    code?: string | number;
    cause?: unknown;
  }

  const error = new ConnectError(options.message ?? "ConnectError: [unauthenticated] ERR_NOT_LOGGED_IN");
  error.name = "ConnectError";
  error.code = options.code ?? "ERR_NOT_LOGGED_IN";
  error.stack = `ConnectError: ${error.message}\n    at parseConnectResponse (${options.stackHint ?? "@connectrpc/connect/dist/index.js"}:1:1)`;
  if (options.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

function createHttp2StreamError(options: {
  message?: string;
  code?: string;
  rstCode?: string;
  stackHint?: string;
  cause?: unknown;
} = {}): Error & { code?: string; rstCode?: string; cause?: unknown } {
  const error = new Error(options.message ?? "stream failed") as Error & { code?: string; rstCode?: string; cause?: unknown };
  error.code = options.code ?? "ERR_HTTP2_STREAM_ERROR";
  error.stack = `Error: ${error.message}\n    at streamRequest (${options.stackHint ?? "@cursor/sdk/dist/index.js"}:1:1)`;
  if (options.rstCode !== undefined) {
    error.rstCode = options.rstCode;
  }
  if (options.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

function createRateLimitError(options: {
  stackHint?: string;
  statusCode?: number;
  code?: string | number;
} = {}): Error & { code?: string | number; statusCode?: number } {
  class RateLimitError extends Error {
    code?: string | number;
    statusCode?: number;
  }

  const error = new RateLimitError("cursor rate limited");
  error.name = "RateLimitError";
  error.code = options.code ?? "429";
  error.statusCode = options.statusCode ?? 429;
  error.stack = `RateLimitError: ${error.message}\n    at run (${options.stackHint ?? "@cursor/sdk/dist/index.js"}:1:1)`;
  return error;
}

function createNetworkError(): Error {
  class NetworkError extends Error {}
  const error = new NetworkError("network unavailable");
  error.name = "NetworkError";
  error.stack = `NetworkError: ${error.message}\n    at run (@cursor/sdk/dist/index.js:1:1)`;
  return error;
}

function createAbortError(): Error & { code?: string } {
  class AbortError extends Error {
    code = "ABORT_ERR";
  }

  const error = new AbortError("stream aborted");
  error.name = "AbortError";
  error.stack = `AbortError: ${error.message}\n    at run (@cursor/sdk/dist/index.js:1:1)`;
  return error;
}

function createAgentBusyError(): Error {
  class AgentBusyError extends Error {}
  const error = new AgentBusyError("agent busy");
  error.name = "AgentBusyError";
  error.stack = `AgentBusyError: ${error.message}\n    at run (@cursor/sdk/dist/index.js:1:1)`;
  return error;
}

function createConfigurationError(): Error {
  class ConfigurationError extends Error {}
  const error = new ConfigurationError("invalid sdk config");
  error.name = "ConfigurationError";
  error.stack = `ConfigurationError: ${error.message}\n    at run (@cursor/sdk/dist/index.js:1:1)`;
  return error;
}

function classifyAwaited(error: unknown, options: {
  attemptIndex?: number;
  visibleOutputEmitted?: boolean;
} = {}) {
  return classifyCursorSdkFailure(error, {
    source: "awaited",
    attemptIndex: options.attemptIndex ?? 0,
    maxRetryAttempts: 1,
    visibleOutputEmitted: options.visibleOutputEmitted ?? false,
    agentId: "worker-1",
    promptToken: 7,
    sdkAgentId: "sdk-agent-1",
    runId: "run-1"
  });
}

function classifyBackground(error: unknown, options: {
  attributionMode?: "als" | "single_active_scope";
  activeScopeCount?: number;
  retainedClosedScopeCount?: number;
  attributionFailureReason?: "als_scope_missing" | "no_active_scope" | "ambiguous_active_scopes" | "retained_closed_scope_without_active" | "retained_closed_scope_ambiguous";
  cancelled?: boolean;
  completed?: boolean;
  closed?: boolean;
} = {}) {
  return classifyCursorSdkFailure(error, {
    source: "background",
    attributionMode: options.attributionMode,
    activeScopeCount: options.activeScopeCount ?? 1,
    retainedClosedScopeCount: options.retainedClosedScopeCount ?? 0,
    attributionFailureReason: options.attributionFailureReason,
    cancelled: options.cancelled,
    completed: options.completed,
    closed: options.closed,
    agentId: "worker-1",
    promptToken: 7,
    sdkAgentId: "sdk-agent-1",
    runId: "run-1"
  });
}

async function expectContainedFailure(options: {
  error: unknown;
  expectedBucket: CursorSdkFailureBucket;
  useAls?: boolean;
}): Promise<void> {
  const scope = createCursorSdkBackgroundScope({
    agentId: "worker-1",
    promptToken: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    sdkAgentId: "sdk-agent-1"
  });
  const containedPromise = scope.waitForContainedFailure();

  if (options.useAls === false) {
    expect(emitCursorSdkBackgroundFailureForTests(options.error)).toBe(true);
  } else {
    await scope.runWithAttribution(async () => {
      expect(emitCursorSdkBackgroundFailureForTests(options.error)).toBe(true);
    });
  }

  const contained = await containedPromise;
  expect(contained.decision.bucket).toBe(options.expectedBucket);
  scope.close();
}

afterEach(() => {
  vi.useRealTimers();
  resetCursorSdkErrorContainmentForTests();
});

describe("Cursor SDK error containment classifier", () => {
  it.each([
    {
      name: "Connect Unavailable before output retries once",
      error: createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }),
      expected: { family: "connectrpc", bucket: "retryable_transport", retryPreOutput: true, fatal: false }
    },
    {
      name: "NetworkError before output retries once",
      error: createNetworkError(),
      expected: { family: "cursor_sdk", bucket: "retryable_transport", retryPreOutput: true, fatal: false }
    },
    {
      name: "HTTP2 ENHANCE_YOUR_CALM wrapper retries once",
      error: createHttp2StreamError({ rstCode: "NGHTTP2_ENHANCE_YOUR_CALM" }),
      expected: { family: "http2", bucket: "retryable_transport", retryPreOutput: true, fatal: false }
    },
    {
      name: "auth/connect contains without retry",
      error: createConnectError(),
      expected: { family: "connectrpc", bucket: "auth_permission", retryPreOutput: false, fatal: false }
    },
    {
      name: "abort/stream destroyed contains without retry",
      error: createAbortError(),
      expected: { family: "cursor_sdk", bucket: "cancel_abort", retryPreOutput: false, fatal: false }
    },
    {
      name: "AgentBusy contains without retry",
      error: createAgentBusyError(),
      expected: { family: "cursor_sdk", bucket: "agent_busy_state", retryPreOutput: false, fatal: false }
    },
    {
      name: "bare HTTP2 wrapper is contain-only and never retryable",
      error: createHttp2StreamError(),
      expected: { family: "http2", bucket: "internal_stream", retryPreOutput: false, fatal: false }
    }
  ])("$name", ({ error, expected }) => {
    const decision = classifyAwaited(error);
    expect(decision.family).toBe(expected.family);
    expect(decision.bucket).toBe(expected.bucket);
    expect(decision.retryPreOutput).toBe(expected.retryPreOutput);
    expect(decision.fatal).toBe(expected.fatal);
  });

  it("does not retry once visible output has already emitted", () => {
    const decision = classifyAwaited(createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }), {
      visibleOutputEmitted: true
    });

    expect(decision.bucket).toBe("retryable_transport");
    expect(decision.retryPreOutput).toBe(false);
  });

  it("handles cause-chain cycles without throwing", () => {
    const error = createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" });
    error.cause = error;

    const decision = classifyAwaited(error);
    expect(decision.bucket).toBe("retryable_transport");
    expect(decision.retryPreOutput).toBe(true);
  });

  it("classifies non-Error causes in the wrapper chain", () => {
    const error = createHttp2StreamError({
      cause: {
        name: "ConnectError",
        message: "ConnectError: [unauthenticated] ERROR_NOT_LOGGED_IN",
        code: 16,
        stack: "at parseConnectResponse (@connectrpc/connect/dist/index.js:1:1)"
      }
    });

    const decision = classifyBackground(error, { attributionMode: "als" });
    expect(decision.bucket).toBe("auth_permission");
    expect(decision.contain).toBe(true);
  });

  it.each([
    { rstCode: "NGHTTP2_REFUSED_STREAM", expectedBucket: "retryable_transport" },
    { rstCode: "GOAWAY_SESSION", expectedBucket: "retryable_transport" },
    { rstCode: "NGHTTP2_ENHANCE_YOUR_CALM", expectedBucket: "retryable_transport" },
    { rstCode: undefined, expectedBucket: "internal_stream" }
  ])("inspects HTTP2 wrapper reset code %s", ({ rstCode, expectedBucket }) => {
    const decision = classifyAwaited(createHttp2StreamError({ rstCode }));
    expect(decision.bucket).toBe(expectedBucket);
    expect(decision.retryPreOutput).toBe(expectedBucket === "retryable_transport");
  });

  it("only retries exact Cursor 429, not generic 429 text", () => {
    const exactDecision = classifyAwaited(createRateLimitError());
    const genericDecision = classifyAwaited(Object.assign(new Error("rate limited"), { code: 429 }));

    expect(exactDecision.bucket).toBe("retryable_transport");
    expect(exactDecision.retryPreOutput).toBe(true);
    expect(genericDecision.bucket).toBe("non_cursor");
    expect(genericDecision.retryPreOutput).toBe(false);
  });

  it("keeps protocol/config and generic text failures fatal in background mode", () => {
    const configurationDecision = classifyBackground(createConfigurationError(), { attributionMode: "als" });
    expect(configurationDecision.bucket).toBe("protocol_config");
    expect(configurationDecision.contain).toBe(false);
    expect(configurationDecision.fatal).toBe(true);

    const generic429Decision = classifyBackground(new Error("rate limit 429 please retry"), { attributionMode: "als" });
    expect(generic429Decision.bucket).toBe("non_cursor");
    expect(generic429Decision.contain).toBe(false);
    expect(generic429Decision.fatal).toBe(true);

    const genericResourceDecision = classifyBackground(new Error("ResourceExhausted without Cursor context"), { attributionMode: "als" });
    expect(genericResourceDecision.bucket).toBe("non_cursor");
    expect(genericResourceDecision.contain).toBe(false);
    expect(genericResourceDecision.fatal).toBe(true);
  });

  it("fails closed for unattributed and ambiguous background matches", () => {
    const error = createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" });

    const noScope = classifyBackground(error, {
      activeScopeCount: 0,
      attributionFailureReason: "no_active_scope"
    });
    expect(noScope.bucket).toBe("unattributed");
    expect(noScope.contain).toBe(false);
    expect(noScope.fatal).toBe(true);

    const ambiguous = classifyBackground(error, {
      activeScopeCount: 2,
      attributionFailureReason: "ambiguous_active_scopes"
    });
    expect(ambiguous.bucket).toBe("ambiguous_attribution");
    expect(ambiguous.contain).toBe(false);
    expect(ambiguous.fatal).toBe(true);
  });

  it("suppresses late attributed failures after cancel/completion/close", () => {
    expect(classifyBackground(createConnectError(), { attributionMode: "als", cancelled: true }).bucket).toBe("late_after_cancel");
    expect(classifyBackground(createConnectError(), { attributionMode: "als", completed: true }).bucket).toBe("late_after_completion");
    expect(classifyBackground(createConnectError(), { attributionMode: "als", closed: true }).bucket).toBe("late_after_close");
  });
});

describe("Cursor SDK error containment attribution", () => {
  it("installs hooks only while scopes exist and removes them after tombstone cleanup", async () => {
    vi.useFakeTimers();
    expect(getCursorSdkErrorContainmentStateForTests()).toEqual({
      hooksInstalled: false,
      activeScopeCount: 0,
      retainedClosedScopeCount: 0,
      scopeCount: 0
    });

    const scope = createCursorSdkBackgroundScope({
      agentId: "worker-1",
      promptToken: 1,
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(getCursorSdkErrorContainmentStateForTests()).toMatchObject({
      hooksInstalled: true,
      activeScopeCount: 1,
      retainedClosedScopeCount: 0,
      scopeCount: 1
    });

    scope.close();
    expect(getCursorSdkErrorContainmentStateForTests()).toMatchObject({
      hooksInstalled: true,
      activeScopeCount: 0,
      retainedClosedScopeCount: 1,
      scopeCount: 1
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(getCursorSdkErrorContainmentStateForTests()).toEqual({
      hooksInstalled: false,
      activeScopeCount: 0,
      retainedClosedScopeCount: 0,
      scopeCount: 0
    });
  });

  it.each([
    { name: "auth/connect", error: createConnectError(), expectedBucket: "auth_permission" },
    { name: "retryable http2", error: createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" }), expectedBucket: "retryable_transport" },
    { name: "AgentBusy", error: createAgentBusyError(), expectedBucket: "agent_busy_state" }
  ])("contains ALS-attributed %s failures", async ({ error, expectedBucket }) => {
    await expectContainedFailure({ error, expectedBucket });
  });

  it.each([
    { name: "auth/connect", error: createConnectError(), expectedBucket: "auth_permission" },
    { name: "retryable http2", error: createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" }), expectedBucket: "retryable_transport" }
  ])("uses single-active fallback for %s when no tombstone exists", async ({ error, expectedBucket }) => {
    await expectContainedFailure({ error, expectedBucket, useAls: false });
  });

  it.each([
    createConnectError(),
    createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" }),
    createAgentBusyError()
  ])("fails closed for no-ALS multi-active attribution with %p", async (error) => {
    const scopeOne = createCursorSdkBackgroundScope({
      agentId: "worker-1",
      promptToken: 1,
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    const scopeTwo = createCursorSdkBackgroundScope({
      agentId: "worker-2",
      promptToken: 2,
      startedAt: "2026-01-01T00:00:01.000Z"
    });

    expect(emitCursorSdkBackgroundFailureForTests(error)).toBe(false);
    scopeOne.close();
    scopeTwo.close();
  });

  it.each([
    createConnectError(),
    createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" })
  ])("fails closed for no-ALS tombstone ambiguity with %p", async (error) => {
    const closedScope = createCursorSdkBackgroundScope({
      agentId: "worker-closed",
      promptToken: 1,
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    closedScope.close();

    const activeScope = createCursorSdkBackgroundScope({
      agentId: "worker-active",
      promptToken: 2,
      startedAt: "2026-01-01T00:00:01.000Z"
    });

    expect(emitCursorSdkBackgroundFailureForTests(error)).toBe(false);
    activeScope.close();
  });

  it("fails closed when ALS references a scope that has already been reset away", async () => {
    const scope = createCursorSdkBackgroundScope({
      agentId: "worker-1",
      promptToken: 1,
      startedAt: "2026-01-01T00:00:00.000Z"
    });

    await scope.runWithAttribution(async () => {
      resetCursorSdkErrorContainmentForTests();
      expect(emitCursorSdkBackgroundFailureForTests(createConnectError())).toBe(false);
    });
  });
});
