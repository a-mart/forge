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

function createMockQueryHandle(
  initEvent: ClaudeSdkMessage = { type: "system:init" },
  overrides?: Partial<ClaudeSdkQueryHandle>
): ClaudeSdkQueryHandle {
  return createPromptAwareMockQueryHandle(undefined, initEvent, overrides);
}

function createPromptAwareMockQueryHandle(
  prompt: AsyncIterable<ClaudeSdkUserMessage> | undefined,
  initEvent: ClaudeSdkMessage = { type: "system:init" },
  overrides?: Partial<ClaudeSdkQueryHandle>,
  hooks?: {
    onPrompt?: (
      message: ClaudeSdkUserMessage,
      pushEvent: (event: ClaudeSdkMessage) => void,
      close: () => void
    ) => Promise<void> | void;
  }
): ClaudeSdkQueryHandle {
  let closed = false;
  const queuedEvents: ClaudeSdkMessage[] = [initEvent];
  const waiters: Array<(value: IteratorResult<ClaudeSdkMessage>) => void> = [];

  const flush = (): void => {
    while (waiters.length > 0 && queuedEvents.length > 0) {
      const resolve = waiters.shift();
      resolve?.({ value: queuedEvents.shift()!, done: false });
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve?.({ value: undefined, done: true });
    }
  };

  const pushEvent = (event: ClaudeSdkMessage): void => {
    if (closed) {
      return;
    }

    queuedEvents.push(event);
    flush();
  };

  if (prompt && hooks?.onPrompt) {
    void (async () => {
      for await (const message of prompt) {
        await hooks.onPrompt?.(message, pushEvent, close);
      }
    })();
  }

  const iterator: ClaudeSdkQueryHandle & AsyncIterator<ClaudeSdkMessage> = {
    async next(): Promise<IteratorResult<ClaudeSdkMessage>> {
      if (queuedEvents.length > 0) {
        return { value: queuedEvents.shift()!, done: false };
      }

      if (closed) {
        return { value: undefined, done: true };
      }

      return await new Promise<IteratorResult<ClaudeSdkMessage>>((resolve) => {
        waiters.push(resolve);
      });
    },
    async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
      close();
      return { value: undefined, done: true };
    },
    async interrupt(): Promise<void> {
      // No-op for tests.
    },
    async initializationResult(): Promise<void> {
      // No-op for tests.
    },
    close,
    [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
      return iterator;
    },
    ...overrides
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

  it("passes auto-compaction settings into query options and proxies SDK control methods", async () => {
    const callbacks = createCallbacks();
    const getContextUsage = vi.fn().mockResolvedValue({
      totalTokens: 1_234,
      maxTokens: 200_000,
      percentage: 0.617
    });
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    const capturedOptions: ClaudeSdkQueryOptions[] = [];
    const sdk: ClaudeSdkModule = {
      query: vi.fn((args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) => {
        capturedOptions.push(args.options);
        return createMockQueryHandle(
          { type: "system:init" },
          {
            getContextUsage,
            applyFlagSettings
          }
        );
      }) as unknown as ClaudeSdkModule["query"]
    };

    const session = new ClaudeQuerySession({
      sdk,
      config: {
        model: "claude-test",
        systemPrompt: "system",
        cwd: process.cwd(),
        autoCompactWindow: 160_000
      },
      callbacks
    });

    await session.start();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.settings).toEqual({
      autoCompactWindow: 160_000
    });
    await expect(session.getSdkContextUsage()).resolves.toEqual({
      totalTokens: 1_234,
      maxTokens: 200_000,
      percentage: 0.617
    });

    await session.applyFlagSettings({ autoCompactWindow: 120_000 });
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(applyFlagSettings).toHaveBeenCalledWith({ autoCompactWindow: 120_000 });

    await session.stop();
  });

  it("clears compaction state when Claude emits status:null without a compact boundary", async () => {
    const callbacks = createCallbacks();
    const sdk: ClaudeSdkModule = {
      query: vi.fn((args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) => {
        return createPromptAwareMockQueryHandle(args.prompt, { type: "system:init" }, undefined, {
          onPrompt: async (_message, pushEvent) => {
            pushEvent({
              type: "system",
              subtype: "status",
              status: "compacting"
            });
            pushEvent({
              type: "system",
              subtype: "status",
              status: null
            });
            pushEvent({ type: "result", subtype: "result" });
          }
        });
      }) as unknown as ClaudeSdkModule["query"]
    };

    const session = new ClaudeQuerySession({
      sdk,
      config: {
        model: "claude-test",
        systemPrompt: "system",
        cwd: process.cwd()
      },
      callbacks
    });

    await session.start();
    await session.sendInput("hello");

    const idleResult = await Promise.race([
      session.waitForIdle().then(() => "idle"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timeout"), 100);
      })
    ]);

    expect(idleResult).toBe("idle");
    expect(session.getStatus()).toBe("idle");
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto_compaction_start"
      })
    );
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto_compaction_end"
      })
    );

    await session.stop();
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
