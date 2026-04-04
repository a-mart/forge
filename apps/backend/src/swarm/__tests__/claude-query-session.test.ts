import { describe, expect, it, vi } from "vitest";
import { ClaudeQuerySession, type ClaudeQuerySessionCallbacks } from "../claude-query-session.js";
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
  it("passes env overrides to sdk.query without mutating process.env", async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

    process.env.ANTHROPIC_API_KEY = "global-api-key";
    process.env.CLAUDE_CONFIG_DIR = "/global/config";

    const capturedOptions: ClaudeSdkQueryOptions[] = [];
    const query = vi.fn(
      (args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) => {
        capturedOptions.push(args.options);
        return createMockQueryHandle();
      }
    );
    const sdk: ClaudeSdkModule = {
      query: query as unknown as ClaudeSdkModule["query"],
      pathToClaudeCodeExecutable: "/tmp/claude-sdk/cli.js"
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
      expect(capturedOptions[0]?.env).toEqual({
        ANTHROPIC_API_KEY: "session-api-key",
        CLAUDE_CONFIG_DIR: "/session/config"
      });
      expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe("/tmp/claude-sdk/cli.js");
      expect(process.env.ANTHROPIC_API_KEY).toBe("global-api-key");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/global/config");

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
    }
  });
});
