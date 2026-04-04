import { SessionManager } from "@mariozechner/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAgentRuntime,
  mapReasoningToClaudeEffort,
  mapReasoningToClaudeThinking
} from "../claude-agent-runtime.js";
import {
  resetClaudeSdkLoaderForTests,
  setClaudeSdkImporterForTests,
  type ClaudeSdkMessage,
  type ClaudeSdkModule,
  type ClaudeSdkQueryOptions,
  type ClaudeSdkUserMessage
} from "../claude-sdk-loader.js";
import type { AgentDescriptor } from "../types.js";

interface QueryCallRecord {
  options: ClaudeSdkQueryOptions;
}

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: "claude-manager",
    displayName: "Claude Manager",
    role: "manager",
    managerId: "claude-manager",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: baseDir,
    model: {
      provider: "claude-sdk",
      modelId: "claude-sonnet-4.5",
      thinkingLevel: "medium"
    },
    sessionFile: join(baseDir, "profiles", "profile-1", "sessions", "claude-manager", "session.jsonl")
  };
}

function createMockClaudeSdk(queryCalls: QueryCallRecord[]): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options);
    }
  };
}

function createTurnCompletingMockClaudeSdk(queryCalls: QueryCallRecord[]): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (_message, pushEvent) => {
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createDeferredTurnMockClaudeSdk(
  queryCalls: QueryCallRecord[],
  releaseTurn: Promise<void>
): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (_message, pushEvent) => {
          await releaseTurn;
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createUsageReportingMockClaudeSdk(
  queryCalls: QueryCallRecord[],
  usage: Record<string, unknown>
): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (_message, pushEvent) => {
          pushEvent({ type: "message_delta", usage });
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createControlAwareMockClaudeSdk(
  queryCalls: QueryCallRecord[],
  controls: {
    getContextUsage: ReturnType<typeof vi.fn>;
    applyFlagSettings: ReturnType<typeof vi.fn>;
  }
): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(
        args.prompt,
        args.options,
        undefined,
        {
          getContextUsage: controls.getContextUsage,
          applyFlagSettings: controls.applyFlagSettings
        }
      );
    }
  };
}

function createCompactionMockClaudeSdk(
  queryCalls: QueryCallRecord[],
  hiddenPrompts: string[]
): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (message, pushEvent) => {
          const promptText = extractPromptText(message);
          if (promptText.includes("INTERNAL COMPACTION TASK")) {
            hiddenPrompts.push(promptText);
            pushEvent({
              type: "assistant",
              message: {
                id: "summary-1",
                content: [{ type: "text", text: "## Current Objective\nContinue the task safely." }]
              }
            });
            pushEvent({ type: "result", subtype: "result" });
            return;
          }

          pushEvent({
            type: "assistant",
            message: {
              id: `reply-${queryCalls.length}`,
              content: [{ type: "text", text: "Normal reply" }]
            }
          });
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createAutoCompactingMockClaudeSdk(queryCalls: QueryCallRecord[]): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (_message, pushEvent) => {
          pushEvent({
            type: "system",
            subtype: "status",
            status: "compacting",
            session_id: args.options.sessionId ?? "mock-session",
            uuid: "status-1"
          });
          pushEvent({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 4321
            },
            session_id: args.options.sessionId ?? "mock-session",
            uuid: "boundary-1"
          });
          pushEvent({
            type: "assistant",
            message: {
              id: `reply-${queryCalls.length}`,
              content: [{ type: "text", text: "Normal reply" }]
            }
          });
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createAutoCompactingContextRefreshMockClaudeSdk(
  queryCalls: QueryCallRecord[],
  getContextUsage: () => Promise<unknown>
): ClaudeSdkModule {
  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      return createMockQueryHandle(
        args.prompt,
        args.options,
        {
          onPrompt: async (_message, pushEvent) => {
            pushEvent({
              type: "system",
              subtype: "status",
              status: "compacting",
              session_id: args.options.sessionId ?? "mock-session",
              uuid: "status-1"
            });
            pushEvent({
              type: "system",
              subtype: "compact_boundary",
              compact_metadata: {
                trigger: "auto",
                pre_tokens: 4321
              },
              session_id: args.options.sessionId ?? "mock-session",
              uuid: "boundary-1"
            });
            pushEvent({
              type: "assistant",
              message: {
                id: `reply-${queryCalls.length}`,
                content: [{ type: "text", text: "Normal reply" }]
              }
            });
            pushEvent({ type: "result", subtype: "result" });
          }
        },
        {
          getContextUsage
        }
      );
    }
  };
}

function createAutoCompactionFailureThenRecoveryMockClaudeSdk(queryCalls: QueryCallRecord[]): ClaudeSdkModule {
  let queryCount = 0;

  return {
    query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
      queryCalls.push({ options: { ...args.options } });
      queryCount += 1;

      if (queryCount === 1) {
        return createMockQueryHandle(args.prompt, args.options, {
          onPrompt: async (_message, pushEvent, close) => {
            pushEvent({
              type: "system",
              subtype: "status",
              status: "compacting",
              session_id: args.options.sessionId ?? "mock-session",
              uuid: "status-1"
            });
            close();
          }
        });
      }

      return createMockQueryHandle(args.prompt, args.options, {
        onPrompt: async (_message, pushEvent) => {
          pushEvent({
            type: "assistant",
            message: {
              id: `reply-${queryCalls.length}`,
              content: [{ type: "text", text: "Recovered reply" }]
            }
          });
          pushEvent({ type: "result", subtype: "result" });
        }
      });
    }
  };
}

function createMockQueryHandle(
  prompt: AsyncIterable<ClaudeSdkUserMessage>,
  options: ClaudeSdkQueryOptions,
  hooks?: {
    onPrompt?: (
      message: ClaudeSdkUserMessage,
      pushEvent: (event: ClaudeSdkMessage) => void,
      close: () => void
    ) => Promise<void> | void;
  },
  overrides?: {
    getContextUsage?: () => Promise<unknown>;
    applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  }
) {
  const initialSessionId = options.resume ?? options.sessionId ?? "mock-session";
  let closed = false;
  const queuedEvents: ClaudeSdkMessage[] = [{ type: "system:init", session_id: initialSessionId }];
  const waiters: Array<(result: IteratorResult<ClaudeSdkMessage>) => void> = [];

  const pushEvent = (event: ClaudeSdkMessage) => {
    queuedEvents.push(event);
    const resolve = waiters.shift();
    if (resolve) {
      resolve({
        value: queuedEvents.shift()!,
        done: false
      });
    }
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve?.({ value: undefined, done: true });
    }
  };

  void (async () => {
    for await (const message of prompt) {
      await hooks?.onPrompt?.(message, pushEvent, close);
    }
  })();

  return {
    async interrupt(): Promise<void> {},
    async initializationResult(): Promise<void> {},
    async getContextUsage(): Promise<unknown> {
      return await overrides?.getContextUsage?.();
    },
    async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
      await overrides?.applyFlagSettings?.(settings);
    },
    close,
    async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
      close();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<ClaudeSdkMessage>> => {
          if (queuedEvents.length > 0) {
            return {
              value: queuedEvents.shift()!,
              done: false
            };
          }

          if (closed) {
            return { value: undefined, done: true };
          }

          return await new Promise<IteratorResult<ClaudeSdkMessage>>((resolve) => {
            waiters.push(resolve);
          });
        }
      };
    }
  };
}

function extractPromptText(message: ClaudeSdkUserMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => (item && typeof item === "object" && item.type === "text" ? item.text : ""))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "waitFor failed"));
}

afterEach(() => {
  resetClaudeSdkLoaderForTests();
});

describe("ClaudeAgentRuntime", () => {
  it("maps all Forge reasoning levels to Claude effort and thinking", () => {
    expect(mapReasoningToClaudeEffort("none")).toBe("low");
    expect(mapReasoningToClaudeEffort("low")).toBe("low");
    expect(mapReasoningToClaudeEffort("medium")).toBe("medium");
    expect(mapReasoningToClaudeEffort("high")).toBe("high");
    expect(mapReasoningToClaudeEffort("xhigh")).toBe("max");

    expect(mapReasoningToClaudeThinking("none")).toEqual({ type: "disabled" });
    expect(mapReasoningToClaudeThinking("low")).toEqual({ type: "disabled" });
    expect(mapReasoningToClaudeThinking("medium")).toEqual({ type: "adaptive" });
    expect(mapReasoningToClaudeThinking("high")).toEqual({
      type: "enabled",
      budgetTokens: 4_096
    });
    expect(mapReasoningToClaudeThinking("xhigh")).toEqual({
      type: "enabled",
      budgetTokens: 16_384
    });
  });

  it("configures SDK auto-compaction from the model context window and exposes SDK control methods", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const getContextUsage = vi.fn().mockResolvedValue({
      totalTokens: 4_321,
      maxTokens: 200_000,
      percentage: 2.1605,
      autoCompactThreshold: 160_000,
      isAutoCompactEnabled: true
    });
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    setClaudeSdkImporterForTests(
      vi.fn().mockResolvedValue(
        createControlAwareMockClaudeSdk(queryCalls, {
          getContextUsage,
          applyFlagSettings
        })
      )
    );

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any,
      modelContextWindow: 200_000
    });

    await expect(runtime.getSdkContextUsage()).resolves.toEqual({
      totalTokens: 4_321,
      maxTokens: 200_000,
      percentage: 2.1605,
      autoCompactThreshold: 160_000,
      isAutoCompactEnabled: true
    });
    await expect(runtime.applyFlagSettings({ autoCompactWindow: 120_000 })).resolves.toBeUndefined();

    expect(queryCalls[0]?.options.settings).toEqual({
      autoCompactWindow: 160_000
    });
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(applyFlagSettings).toHaveBeenCalledWith({ autoCompactWindow: 120_000 });

    await runtime.terminate({ abort: false });
  });

  it("returns undefined when the SDK query handle does not expose getContextUsage", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const sdk: ClaudeSdkModule = {
      query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
        queryCalls.push({ options: { ...args.options } });
        const handle = createMockQueryHandle(args.prompt, args.options);
        delete (handle as { getContextUsage?: unknown }).getContextUsage;
        return handle;
      }
    };
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(sdk));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any,
      modelContextWindow: 200_000
    });

    await expect(runtime.getSdkContextUsage()).resolves.toBeUndefined();
    expect(queryCalls[0]?.options.settings).toEqual({
      autoCompactWindow: 160_000
    });

    await runtime.terminate({ abort: false });
  });

  it("omits auto-compaction settings when the resolved model context window is undefined", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    descriptor.model = {
      ...descriptor.model,
      modelId: "claude-sdk-test-model-without-context-window"
    };
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createMockClaudeSdk(queryCalls)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await expect(runtime.getSdkContextUsage()).resolves.toBeUndefined();
    expect(queryCalls[0]?.options.settings).toBeUndefined();

    await runtime.terminate({ abort: false });
  });

  it("omits auto-compaction settings when the model context window is zero", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createMockClaudeSdk(queryCalls)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any,
      modelContextWindow: 0
    });

    await expect(runtime.getSdkContextUsage()).resolves.toBeUndefined();
    expect(queryCalls[0]?.options.settings).toBeUndefined();

    await runtime.terminate({ abort: false });
  });

  it("forwards mapped reasoning config and catalog context windows to the Claude SDK session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    descriptor.model = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
      thinkingLevel: "xhigh"
    };
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const importer = vi.fn().mockResolvedValue(
      createUsageReportingMockClaudeSdk(queryCalls, {
        input_tokens: 100,
        output_tokens: 50
      })
    );
    setClaudeSdkImporterForTests(importer);

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");

    expect(queryCalls[0]?.options.effort).toBe("max");
    expect(queryCalls[0]?.options.thinking).toEqual({
      type: "enabled",
      budgetTokens: 16_384
    });
    expect(queryCalls[0]?.options.pathToClaudeCodeExecutable).toMatch(/[/\\]cli\.js$/);

    await waitFor(() => {
      expect(runtime.getContextUsage()).toMatchObject({
        tokens: 150,
        contextWindow: 200_000
      });
    });
    expect(runtime.getContextUsage()?.percent).toBeCloseTo(0.075, 6);

    await runtime.terminate({ abort: false });
  });

  it("re-resolves runtime env on recycle without overriding Claude auth discovery", async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.ANTHROPIC_API_KEY = "global-api-key";
    process.env.CLAUDE_CONFIG_DIR = "/global/config";

    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const importer = vi.fn().mockResolvedValue(createTurnCompletingMockClaudeSdk(queryCalls));
    setClaudeSdkImporterForTests(importer);

    const buildEnv = vi.fn()
      .mockResolvedValueOnce({
        ANTHROPIC_API_KEY: "session-api-key-1",
        CLAUDE_CONFIG_DIR: "/session/config/1"
      })
      .mockResolvedValueOnce({
        ANTHROPIC_API_KEY: "session-api-key-2",
        CLAUDE_CONFIG_DIR: "/session/config/2"
      });

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv
      } as any
    });

    try {
      expect(buildEnv).not.toHaveBeenCalled();

      await runtime.sendMessage("hello");
      expect(buildEnv).toHaveBeenCalledTimes(1);
      expect(queryCalls[0]?.options.env).toMatchObject({
        CLAUDE_CONFIG_DIR: "/global/config"
      });
      expect(queryCalls[0]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(queryCalls[0]?.options.executable).toBe(process.execPath);
      expect(process.env.ANTHROPIC_API_KEY).toBe("global-api-key");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/global/config");

      await runtime.recycle();
      expect(buildEnv).toHaveBeenCalledTimes(2);
      expect(queryCalls[1]?.options.env).toMatchObject({
        CLAUDE_CONFIG_DIR: "/global/config"
      });
      expect(queryCalls[1]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(queryCalls[1]?.options.executable).toBe(process.execPath);
      expect(process.env.ANTHROPIC_API_KEY).toBe("global-api-key");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/global/config");

      await runtime.terminate({ abort: false });
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

  it("rebuilds fallback replay snapshots from persisted conversation entries plus live replay state", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = {
      ...makeDescriptor(tempDir),
      agentId: "claude-worker",
      role: "worker" as const,
      managerId: "claude-manager",
      sessionFile: join(tempDir, "profiles", "profile-1", "sessions", "claude-manager", "workers", "claude-worker.jsonl")
    };
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createTurnCompletingMockClaudeSdk([])));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: "claude-manager",
      workerId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    runtime.appendCustomEntry("swarm_conversation_entry", {
      type: "agent_message",
      agentId: "claude-manager",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "agent_to_agent",
      fromAgentId: "claude-manager",
      toAgentId: "claude-worker",
      text: "existing worker task"
    });

    await runtime.sendMessage("latest live steer");

    await expect(runtime.prepareForSpecialistFallbackReplay()).resolves.toEqual({
      messages: [
        {
          text: "existing worker task",
          images: []
        },
        {
          text: "latest live steer",
          images: []
        }
      ]
    });

    await runtime.terminate({ abort: false });
  });

  it("recycles an idle Claude session when pinned content changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createTurnCompletingMockClaudeSdk(queryCalls)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    expect(queryCalls[0]?.options.systemPrompt).toBe("You are a Claude test runtime.");

    runtime.setPinnedContent("Keep this exact wording.");

    expect(runtime.getSystemPrompt()).toContain("# Pinned Messages (preserve across compaction)");
    expect(runtime.getSystemPrompt()).toContain("Keep this exact wording.");

    await waitFor(() => {
      expect(queryCalls).toHaveLength(2);
    });
    expect(queryCalls[1]?.options.systemPrompt).toContain("# Pinned Messages (preserve across compaction)");
    expect(queryCalls[1]?.options.systemPrompt).toContain("Keep this exact wording.");

    runtime.setPinnedContent(undefined);
    await waitFor(() => {
      expect(queryCalls).toHaveLength(3);
    });
    expect(runtime.getSystemPrompt()).not.toContain("# Pinned Messages (preserve across compaction)");
    expect(queryCalls[2]?.options.systemPrompt).not.toContain("# Pinned Messages (preserve across compaction)");

    await runtime.terminate({ abort: false });
  });

  it("queues a Claude recycle for pinned content changes until the active turn completes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    let resolveTurn!: () => void;
    const releaseTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createDeferredTurnMockClaudeSdk(queryCalls, releaseTurn)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    expect(queryCalls).toHaveLength(1);

    runtime.setPinnedContent("Protect this mid-turn pin.");

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queryCalls).toHaveLength(1);

    resolveTurn();

    await waitFor(() => {
      expect(queryCalls).toHaveLength(2);
    });
    expect(queryCalls[1]?.options.systemPrompt).toContain("Protect this mid-turn pin.");

    await runtime.terminate({ abort: false });
  });

  it("retains pinned content when rebuilding the Claude system prompt after compaction rollover", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const hiddenPrompts: string[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createCompactionMockClaudeSdk(queryCalls, hiddenPrompts)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    runtime.setPinnedContent("Keep this exact wording.");
    await runtime.sendMessage("hello");
    await runtime.compact();

    expect(hiddenPrompts).toHaveLength(1);
    expect(runtime.getSystemPrompt()).toContain("# Compacted Conversation Summary");
    expect(runtime.getSystemPrompt()).toContain("# Pinned Messages (preserve across compaction)");
    expect(runtime.getSystemPrompt()).toContain("Keep this exact wording.");
    expect(queryCalls[1]?.options.systemPrompt).toContain("# Compacted Conversation Summary");
    expect(queryCalls[1]?.options.systemPrompt).toContain("# Pinned Messages (preserve across compaction)");
    expect(queryCalls[1]?.options.systemPrompt).toContain("Keep this exact wording.");

    await runtime.terminate({ abort: false });
  });

  it("toggles context recovery while SDK auto-compaction events are in flight", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const observedRecoveryStates: Array<{ eventType: string; recovery: boolean }> = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createAutoCompactingMockClaudeSdk(queryCalls)));

    let runtime!: ClaudeAgentRuntime;
    runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async (agentId, event) => {
          if (
            agentId === descriptor.agentId
            && (event.type === "auto_compaction_start" || event.type === "auto_compaction_end")
          ) {
            observedRecoveryStates.push({
              eventType: event.type,
              recovery: runtime.isContextRecoveryInProgress()
            });
          }
        }
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");

    await waitFor(() => {
      expect(observedRecoveryStates).toEqual([
        {
          eventType: "auto_compaction_start",
          recovery: true
        },
        {
          eventType: "auto_compaction_end",
          recovery: false
        }
      ]);
    });
    expect(runtime.isContextRecoveryInProgress()).toBe(false);
    expect(queryCalls).toHaveLength(1);

    await runtime.terminate({ abort: false });
  });

  it("refreshes authoritative context usage after SDK auto-compaction completes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const statusUpdates: Array<{ status: string; contextUsage?: { tokens: number; contextWindow: number; percent: number } }> = [];
    const getContextUsage = vi.fn().mockResolvedValue({
      totalTokens: 4_321,
      maxTokens: 200_000,
      percentage: 2.1605
    });
    setClaudeSdkImporterForTests(
      vi.fn().mockResolvedValue(createAutoCompactingContextRefreshMockClaudeSdk(queryCalls, getContextUsage))
    );

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async (_agentId, status, _pendingCount, contextUsage) => {
          statusUpdates.push({
            status,
            contextUsage: contextUsage
              ? {
                  tokens: contextUsage.tokens,
                  contextWindow: contextUsage.contextWindow,
                  percent: contextUsage.percent
                }
              : undefined
          });
        }
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");

    await waitFor(() => {
      expect(runtime.getContextUsage()).toEqual({
        tokens: 4_321,
        contextWindow: 200_000,
        percent: 2.1605
      });
    });
    expect(getContextUsage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(statusUpdates).toContainEqual({
      status: "streaming",
      contextUsage: {
        tokens: 4_321,
        contextWindow: 200_000,
        percent: 2.1605
      }
    });
    expect(queryCalls).toHaveLength(1);

    await runtime.terminate({ abort: false });
  });

  it("clears SDK auto-compaction state after a compaction-start session error and replacement", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const runtimeErrors: Array<{ phase?: string; message?: string }> = [];
    setClaudeSdkImporterForTests(
      vi.fn().mockResolvedValue(createAutoCompactionFailureThenRecoveryMockClaudeSdk(queryCalls))
    );

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push(error);
        }
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");

    await waitFor(() => {
      expect(runtimeErrors).toContainEqual(
        expect.objectContaining({
          phase: "runtime_exit",
          message: "Claude query stream ended unexpectedly."
        })
      );
      expect(runtime.isContextRecoveryInProgress()).toBe(false);
    });

    await runtime.sendMessage("retry after replacement");

    await waitFor(() => {
      expect(queryCalls).toHaveLength(2);
    });
    expect(runtime.isContextRecoveryInProgress()).toBe(false);

    await runtime.terminate({ abort: false });
  });

  it("captures a hidden compaction summary, rolls to a fresh generation, and persists the summary context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const hiddenPrompts: string[] = [];
    const forwardedAssistantTexts: string[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createCompactionMockClaudeSdk(queryCalls, hiddenPrompts)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async (agentId, event) => {
          if (agentId !== descriptor.agentId || event.type !== "message_end") {
            return;
          }
          const text = typeof event.message.content === "string"
            ? event.message.content
            : Array.isArray(event.message.content)
              ? event.message.content
                .map((item) => (item && typeof item === "object" && item.type === "text" ? item.text : ""))
                .filter((value): value is string => typeof value === "string" && value.length > 0)
                .join("\n")
              : "";
          if (text) {
            forwardedAssistantTexts.push(text);
          }
        }
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    const firstSessionId = queryCalls[0]?.options.sessionId;

    const result = await runtime.compact("Keep the pinned note verbatim.");

    expect(result).toMatchObject({
      generationId: 1,
      mode: "summary_rollover",
      summary: expect.stringContaining("## Current Objective")
    });
    expect(hiddenPrompts).toHaveLength(1);
    expect(hiddenPrompts[0]).toContain("Keep the pinned note verbatim.");
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[1]?.options.resume).toBeUndefined();
    expect(queryCalls[1]?.options.sessionId).not.toBe(firstSessionId);
    expect(runtime.getSystemPrompt()).toContain("# Compacted Conversation Summary");
    expect(runtime.getSystemPrompt()).toContain("## Current Objective");
    expect(forwardedAssistantTexts).not.toContain("## Current Objective\nContinue the task safely.");

    const restarted = new ClaudeAgentRuntime({
      descriptor: {
        ...descriptor,
        status: "idle",
        updatedAt: "2026-01-01T00:00:01.000Z"
      },
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    expect(restarted.getSystemPrompt()).toContain("# Compacted Conversation Summary");
    expect(restarted.getSystemPrompt()).toContain("## Current Objective");

    await expect(runtime.smartCompact("trim older turns")).resolves.toEqual({
      compactionSucceeded: false,
      compactionFailureReason: "claude_runtime_context_usage_unknown"
    });

    await runtime.terminate({ abort: false });
    await restarted.terminate({ abort: false });
  });

  it("persists custom entries to the session JSONL so they survive runtime recreation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    const entryId = runtime.appendCustomEntry("swarm_conversation_entry", { hello: "world" });
    expect(entryId).toHaveLength(8);

    const reopened = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await waitFor(() => {
      expect(reopened.getCustomEntries("swarm_conversation_entry")).toEqual([{ hello: "world" }]);
    });

    await runtime.terminate({ abort: false });
    await reopened.terminate({ abort: false });
  });

  it("persists the Claude session id and reuses it as resumeSessionId on the next startup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    const importer = vi.fn().mockResolvedValue(createMockClaudeSdk(queryCalls));
    setClaudeSdkImporterForTests(importer);

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    const firstSessionId = queryCalls[0]?.options.sessionId;

    expect(typeof firstSessionId).toBe("string");
    expect(firstSessionId).toBeTruthy();

    await waitFor(() => {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const runtimeStateEntries = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "swarm_claude_session_state")
        .map((entry) => (entry.type === "custom" ? entry.data : undefined));

      expect(runtimeStateEntries).toHaveLength(1);
      expect(runtimeStateEntries[0]).toMatchObject({
        claudeSessionId: firstSessionId,
        generationId: 0
      });
    });

    await runtime.terminate({ abort: false });

    const restartedDescriptor: AgentDescriptor = {
      ...descriptor,
      status: "idle",
      updatedAt: "2026-01-01T00:00:01.000Z"
    };

    const restarted = new ClaudeAgentRuntime({
      descriptor: restartedDescriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await restarted.sendMessage("hello again");

    expect(queryCalls[1]?.options.resume).toBe(firstSessionId);

    await restarted.terminate({ abort: false });
  });

  it("clears the persisted Claude session id before recycle starts a fresh session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const queryCalls: QueryCallRecord[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createTurnCompletingMockClaudeSdk(queryCalls)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    const firstSessionId = queryCalls[0]?.options.sessionId;

    await runtime.recycle();

    const recycledSessionId = queryCalls[1]?.options.sessionId;
    expect(queryCalls[1]?.options.resume).toBeUndefined();
    expect(typeof recycledSessionId).toBe("string");
    expect(recycledSessionId).not.toBe(firstSessionId);

    await waitFor(() => {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const runtimeStateEntries = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "swarm_claude_session_state")
        .map((entry) => (entry.type === "custom" ? entry.data : undefined));

      expect(runtimeStateEntries.at(-1)).toMatchObject({
        claudeSessionId: recycledSessionId,
        generationId: 1
      });
    });

    await runtime.terminate({ abort: false });
  });

  it("falls back to a fresh Claude session when resume fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
    const descriptor = makeDescriptor(tempDir);
    await mkdir(dirname(descriptor.sessionFile), { recursive: true });

    const initialQueryCalls: QueryCallRecord[] = [];
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(createTurnCompletingMockClaudeSdk(initialQueryCalls)));

    const runtime = new ClaudeAgentRuntime({
      descriptor,
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {}
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await runtime.sendMessage("hello");
    const firstSessionId = initialQueryCalls[0]?.options.sessionId;
    await runtime.terminate({ abort: false });

    const resumedQueryCalls: QueryCallRecord[] = [];
    const runtimeErrors: Array<{ phase?: string; message?: string }> = [];
    const failingResumeSdk: ClaudeSdkModule = {
      query(args: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkQueryOptions }) {
        resumedQueryCalls.push({ options: { ...args.options } });
        if (args.options.resume) {
          throw new Error("resume failed");
        }
        return createMockQueryHandle(args.prompt, args.options, {
          onPrompt: async (_message, pushEvent) => {
            pushEvent({ type: "result", subtype: "result" });
          }
        });
      }
    };
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue(failingResumeSdk));

    const restarted = new ClaudeAgentRuntime({
      descriptor: {
        ...descriptor,
        status: "idle",
        updatedAt: "2026-01-01T00:00:01.000Z"
      },
      systemPrompt: "You are a Claude test runtime.",
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push(error);
        }
      },
      dataDir: tempDir,
      profileId: "profile-1",
      sessionId: descriptor.agentId,
      authResolver: {
        buildEnv: async () => ({})
      } as any
    });

    await restarted.sendMessage("hello again");

    expect(resumedQueryCalls).toHaveLength(2);
    expect(resumedQueryCalls[0]?.options.resume).toBe(firstSessionId);
    expect(resumedQueryCalls[1]?.options.resume).toBeUndefined();
    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: "thread_resume",
        message: "resume failed"
      })
    );

    await waitFor(() => {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const runtimeStateEntries = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "swarm_claude_session_state")
        .map((entry) => (entry.type === "custom" ? entry.data : undefined));

      expect(runtimeStateEntries.at(-1)).toMatchObject({
        claudeSessionId: resumedQueryCalls[1]?.options.sessionId,
        generationId: 1
      });
    });

    await restarted.terminate({ abort: false });
  });
});
