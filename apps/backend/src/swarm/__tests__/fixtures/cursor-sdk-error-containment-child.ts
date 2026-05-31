import { setTimeout as delay } from "node:timers/promises";
import {
  createCursorSdkBackgroundScope,
  resetCursorSdkErrorContainmentForTests
} from "../../runtime/cursor-sdk/cursor-sdk-error-containment.js";

function createConnectError(options: {
  code?: string | number;
  message?: string;
  cause?: unknown;
} = {}): Error & { code?: string | number; cause?: unknown } {
  class ConnectError extends Error {
    code?: string | number;
    cause?: unknown;
  }

  const error = new ConnectError(options.message ?? "ConnectError: [unauthenticated] ERR_NOT_LOGGED_IN");
  error.name = "ConnectError";
  error.code = options.code ?? "ERR_NOT_LOGGED_IN";
  error.stack = `ConnectError: ${error.message}\n    at parseConnectResponse (@connectrpc/connect/dist/index.js:1:1)`;
  if (options.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

function createHttp2StreamError(options: {
  rstCode?: string;
  cause?: unknown;
} = {}): Error & { code?: string; rstCode?: string; cause?: unknown } {
  const error = new Error("stream failed") as Error & { code?: string; rstCode?: string; cause?: unknown };
  error.code = "ERR_HTTP2_STREAM_ERROR";
  error.stack = "Error: stream failed\n    at streamRequest (@cursor/sdk/dist/index.js:1:1)";
  if (options.rstCode !== undefined) {
    error.rstCode = options.rstCode;
  }
  if (options.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

function createConfigurationError(): Error {
  class ConfigurationError extends Error {}
  const error = new ConfigurationError("invalid sdk config");
  error.name = "ConfigurationError";
  error.stack = "ConfigurationError: invalid sdk config\n    at run (@cursor/sdk/dist/index.js:1:1)";
  return error;
}

function createGenericCursorStackError(): Error {
  const error = new Error("cursor sdk bug exploded");
  error.stack = "Error: cursor sdk bug exploded\n    at run (@cursor/sdk/dist/index.js:1:1)";
  return error;
}

async function emitInsideScope(scope: ReturnType<typeof createCursorSdkBackgroundScope>, error: unknown): Promise<void> {
  await scope.runWithAttribution(async () => {
    queueMicrotask(() => {
      Promise.reject(error);
    });
    await delay(0);
  });
}

async function expectContained(scope: ReturnType<typeof createCursorSdkBackgroundScope>): Promise<void> {
  const contained = await Promise.race([
    scope.waitForContainedFailure(),
    delay(200).then(() => {
      throw new Error("timed out waiting for contained failure");
    })
  ]);
  console.log(JSON.stringify({
    marker: "contained",
    bucket: contained.decision.bucket,
    family: contained.decision.family,
    contain: contained.decision.contain,
    fatal: contained.decision.fatal
  }));
  scope.close();
  resetCursorSdkErrorContainmentForTests();
}

async function main(): Promise<void> {
  const scenario = process.argv[2];

  switch (scenario) {
    case "contained-transient": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, createHttp2StreamError({ rstCode: "NGHTTP2_REFUSED_STREAM" }));
      await expectContained(scope);
      return;
    }

    case "contained-auth": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, createConnectError());
      await expectContained(scope);
      return;
    }

    case "fatal-protocol": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, createConfigurationError());
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-no-scope": {
      queueMicrotask(() => {
        Promise.reject(createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }));
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-multi-active": {
      createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      createCursorSdkBackgroundScope({
        agentId: "worker-2",
        promptToken: 2,
        startedAt: "2026-01-01T00:00:01.000Z"
      });
      queueMicrotask(() => {
        Promise.reject(createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }));
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-tombstone-ambiguous": {
      const closedScope = createCursorSdkBackgroundScope({
        agentId: "worker-closed",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      closedScope.close();
      createCursorSdkBackgroundScope({
        agentId: "worker-active",
        promptToken: 2,
        startedAt: "2026-01-01T00:00:01.000Z"
      });
      queueMicrotask(() => {
        Promise.reject(createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }));
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-retry-lineage-tombstone-ambiguous": {
      const closedScope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 7,
        attemptIndex: 0,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      closedScope.close();
      createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 7,
        attemptIndex: 1,
        startedAt: "2026-01-01T00:00:01.000Z"
      });
      queueMicrotask(() => {
        Promise.reject(createConnectError({ code: 14, message: "ConnectError: [unavailable] upstream unavailable" }));
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-generic-stream": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await scope.runWithAttribution(async () => {
        queueMicrotask(() => {
          Promise.reject(new Error("generic stream blew up"));
        });
        await delay(0);
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-generic-cursor-stack": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, createGenericCursorStackError());
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-plain-text-refused-stream": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, new Error("ordinary error mentioning REFUSED_STREAM"));
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-plain-text-unavailable": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, new Error("ordinary error [unavailable]"));
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-plain-text-enhance-your-calm": {
      const scope = createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      await emitInsideScope(scope, new Error("NGHTTP2_ENHANCE_YOUR_CALM"));
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    case "fatal-ordinary-uncaught": {
      createCursorSdkBackgroundScope({
        agentId: "worker-1",
        promptToken: 1,
        startedAt: "2026-01-01T00:00:00.000Z"
      });
      queueMicrotask(() => {
        throw new Error("ordinary uncaught exception");
      });
      await delay(200);
      console.log("unexpected-survival");
      process.exit(99);
      return;
    }

    default:
      throw new Error(`Unknown scenario: ${String(scenario)}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
