import { describe, expect, it, vi } from "vitest";
import { ClaudeQuerySession, type ClaudeQuerySessionCallbacks } from "../claude-query-session.js";
import {
  CLAUDE_SDK_AUTH_USER_MESSAGE,
  buildClaudeSdkStartupTimeoutUserMessage
} from "../claude-startup-errors.js";
import type {
  ClaudeSdkMessage,
  ClaudeSdkModule,
  ClaudeSdkQueryHandle,
  ClaudeSdkQueryOptions,
  ClaudeSdkUserMessage
} from "../claude-sdk-loader.js";

function createMockQueryHandle(initEvent: ClaudeSdkMessage = { type: "system:init" }): ClaudeSdkQueryHandle {
  let sentInit = false;
  let closed = false;
  let pendingResolve: ((value: IteratorResult<ClaudeSdkMessage>) => void) | undefined;

  const resolveDone = (): void => {
    closed = true;
    pendingResolve?.({ value: undefined, done: true });
    pendingResolve = undefined;
  };

  const iterator: ClaudeSdkQueryHandle & AsyncIterator<ClaudeSdkMessage> = {
    async next(): Promise<IteratorResult<ClaudeSdkMessage>> {
      if (!sentInit) {
        sentInit = true;
        return { value: initEvent, done: false };
      }

      if (closed) {
        return { value: undefined, done: true };
      }

      return await new Promise<IteratorResult<ClaudeSdkMessage>>((resolve) => {
        pendingResolve = resolve;
      });
    },
    async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
      resolveDone();
      return { value: undefined, done: true };
    },
    async interrupt(): Promise<void> {
      // No-op for tests.
    },
    async initializationResult(): Promise<void> {
      // No-op for tests.
    },
    close(): void {
      resolveDone();
    },
    [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
      return iterator;
    }
  };

  return iterator;
}

function createCallbacks(): ClaudeQuerySessionCallbacks {
  return {
    agentId: "agent-1",
    onStatusChange: vi.fn(),
    onSessionEvent: vi.fn(),
    onAgentEnd: vi.fn(),
    onRuntimeError: vi.fn()
  };
}

describe("ClaudeQuerySession", () => {
  it("strips inherited Anthropic API keys while preserving the user's Claude config dir", async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousInheritedMarker = process.env.FORGE_TEST_INHERITED_ENV;

    process.env.ANTHROPIC_API_KEY = "global-api-key";
    process.env.CLAUDE_CONFIG_DIR = "/global/config";
    process.env.FORGE_TEST_INHERITED_ENV = "keep-me";

    const capturedOptions: ClaudeSdkQueryOptions[] = [];
    const query = vi.fn(
      (args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) => {
        capturedOptions.push(args.options);
        return createMockQueryHandle();
      }
    );
    const sdk: ClaudeSdkModule = {
      query: query as unknown as ClaudeSdkModule["query"],
      pathToClaudeCodeExecutable: "/tmp/claude-sdk/cli.js",
      jsRuntimeExecutable: "/tmp/runtime/node"
    };

    const session = new ClaudeQuerySession({
      sdk,
      config: {
        model: "claude-test",
        systemPrompt: "system",
        cwd: process.cwd(),
        env: {
          ANTHROPIC_API_KEY: "session-api-key",
          CLAUDE_CONFIG_DIR: "/session/config"
        }
      },
      callbacks: createCallbacks()
    });

    try {
      await session.start();

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0]?.env).toMatchObject({
        FORGE_TEST_INHERITED_ENV: "keep-me",
        CLAUDE_CONFIG_DIR: "/global/config"
      });
      expect(capturedOptions[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe("/tmp/claude-sdk/cli.js");
      expect(capturedOptions[0]?.executable).toBe("/tmp/runtime/node");
      expect(process.env.ANTHROPIC_API_KEY).toBe("global-api-key");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/global/config");
      expect(process.env.FORGE_TEST_INHERITED_ENV).toBe("keep-me");

      await session.stop();
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }

      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }

      if (previousInheritedMarker === undefined) {
        delete process.env.FORGE_TEST_INHERITED_ENV;
      } else {
        process.env.FORGE_TEST_INHERITED_ENV = previousInheritedMarker;
      }
    }
  });

  it("surfaces Claude login guidance when startup fails with an auth error", async () => {
    const callbacks = createCallbacks();
    const startupError = new Error("Authentication required. Please login with Claude Code.");
    const sdk: ClaudeSdkModule = {
      query: vi.fn(() => ({
        async interrupt(): Promise<void> {},
        async initializationResult(): Promise<void> {
          throw startupError;
        },
        close(): void {},
        async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          return {
            next: async () => await new Promise<IteratorResult<ClaudeSdkMessage>>(() => {})
          };
        }
      })) as unknown as ClaudeSdkModule["query"]
    };

    const session = new ClaudeQuerySession({
      sdk,
      config: {
        model: "claude-test",
        systemPrompt: "system",
        cwd: process.cwd()
      },
      callbacks,
      startupTimeoutMs: 50
    });

    await expect(session.start()).rejects.toThrow(CLAUDE_SDK_AUTH_USER_MESSAGE);
    expect(callbacks.onRuntimeError).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        phase: "startup",
        message: CLAUDE_SDK_AUTH_USER_MESSAGE,
        details: expect.objectContaining({
          userFacingMessage: CLAUDE_SDK_AUTH_USER_MESSAGE,
          claudeSdkAuthRequired: true,
          technicalMessage: startupError.message
        })
      })
    );
  });

  it("fails Claude startup after the timeout and surfaces actionable guidance", async () => {
    const callbacks = createCallbacks();
    const sdk: ClaudeSdkModule = {
      query: vi.fn(() => ({
        async interrupt(): Promise<void> {},
        async initializationResult(): Promise<void> {
          await new Promise(() => {});
        },
        close(): void {},
        async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          return {
            next: async () => await new Promise<IteratorResult<ClaudeSdkMessage>>(() => {})
          };
        }
      })) as unknown as ClaudeSdkModule["query"]
    };

    const session = new ClaudeQuerySession({
      sdk,
      config: {
        model: "claude-test",
        systemPrompt: "system",
        cwd: process.cwd()
      },
      callbacks,
      startupTimeoutMs: 25
    });

    const expectedMessage = buildClaudeSdkStartupTimeoutUserMessage(25);
    await expect(session.start()).rejects.toThrow(expectedMessage);
    expect(callbacks.onRuntimeError).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        phase: "startup",
        message: expectedMessage,
        details: expect.objectContaining({
          userFacingMessage: expectedMessage,
          claudeSdkStartupTimeoutMs: 25,
          technicalMessage: "claude_startup timed out after 25ms"
        })
      })
    );
  });
});
