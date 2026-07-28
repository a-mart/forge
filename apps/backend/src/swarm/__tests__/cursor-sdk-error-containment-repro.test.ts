import { afterEach, describe, expect, it } from "vitest";
import {
  createCursorSdkBackgroundScope,
  emitCursorSdkBackgroundFailureForTests,
  resetCursorSdkErrorContainmentForTests,
} from "../runtime/cursor-sdk/cursor-sdk-error-containment.js";

afterEach(() => {
  resetCursorSdkErrorContainmentForTests();
});

function connectError(): Error & { code: number } {
  const error = new Error("ConnectError: [unauthenticated] ERROR_NOT_LOGGED_IN") as Error & { code: number };
  error.name = "ConnectError";
  error.code = 16;
  error.stack = `${error.name}: ${error.message}\n    at request (@connectrpc/connect/index.js:1:1)`;
  return error;
}

describe("Cursor SDK error containment regression", () => {
  it("contains a detached auth rejection attributed to the real Forge scope", async () => {
    const scope = createCursorSdkBackgroundScope({
      agentId: "worker-1",
      promptToken: 7,
      startedAt: "2026-07-25T16:00:00.000Z",
      sdkAgentId: "sdk-agent-1",
    });
    const failurePromise = scope.waitForContainedFailure();

    await scope.runWithAttribution(async () => {
      expect(emitCursorSdkBackgroundFailureForTests(connectError())).toBe(true);
    });

    const failure = await failurePromise;
    expect(failure.decision.bucket).toBe("auth_permission");
    expect(failure.decision.family).toBe("connectrpc");
    expect(failure.agentId).toBe("worker-1");
    expect(failure.promptToken).toBe(7);
    scope.close();
  });

  it("fails closed for an unattributed Cursor-looking rejection", () => {
    expect(emitCursorSdkBackgroundFailureForTests(connectError())).toBe(false);
  });
});
