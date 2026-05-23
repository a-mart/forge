import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE,
  CursorSdkAgentRuntime,
} from "../runtime/cursor-sdk/cursor-sdk-agent-runtime.js";
import { CURSOR_SDK_USAGE_ENTRY_TYPE } from "../../utils/cursor-sdk-usage-records.js";
import type { CursorSdkAgent, CursorSdkModule, CursorSdkRun, CursorSdkSendOptions } from "../runtime/cursor-sdk/cursor-sdk-loader.js";
import type { RuntimeUserMessage, SwarmRuntimeCallbacks } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

function createDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: rootDir,
    model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    sessionFile: join(rootDir, "worker.jsonl"),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createRun(options: {
  id?: string;
  status?: CursorSdkRun["status"] | string;
  streamItems?: unknown[];
  streamGate?: Promise<unknown>;
  streamError?: unknown;
  waitResult?: unknown;
  waitError?: unknown;
  cancel?: () => Promise<void>;
} = {}): CursorSdkRun {
  return {
    id: options.id ?? "run-1",
    agentId: "sdk-agent-1",
    status: (options.status ?? "finished") as CursorSdkRun["status"],
    async *stream() {
      if (options.streamGate) {
        await options.streamGate;
      }
      if (options.streamError) {
        throw options.streamError instanceof Error ? options.streamError : new Error(String(options.streamError));
      }
      for (const item of options.streamItems ?? [assistantText("ok")]) {
        yield item;
      }
    },
    wait: vi.fn(async () => {
      if (options.waitError) {
        throw options.waitError instanceof Error ? options.waitError : new Error(String(options.waitError));
      }
      return options.waitResult ?? { status: "finished" };
    }),
    cancel: vi.fn(options.cancel ?? (async () => undefined)),
  };
}

function assistantText(text: string): unknown {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function statusMessage(status: string): unknown {
  return { type: "status", status };
}

async function setupRuntime(options: {
  rootDir?: string;
  descriptor?: AgentDescriptor;
  sdkAgent?: CursorSdkAgent;
  sdk?: CursorSdkModule;
  systemPrompt?: string;
  promptHash?: string;
  callbacks?: Partial<SwarmRuntimeCallbacks>;
} = {}) {
  const rootDir = options.rootDir ?? await mkdtemp(join(tmpdir(), "forge-cursor-sdk-runtime-"));
  await mkdir(rootDir, { recursive: true });
  const descriptor = options.descriptor ?? createDescriptor(rootDir);
  await access(descriptor.sessionFile).catch(async () => {
    await writeFile(descriptor.sessionFile, "", "utf8");
  });

  const send = vi.fn(async () => createRun());
  const close = vi.fn();
  const create = vi.fn(async () => options.sdkAgent ?? ({ agentId: "sdk-agent-1", send, close }));
  const resume = vi.fn(async () => options.sdkAgent ?? ({ agentId: "sdk-agent-1", send, close }));
  const callbacks = {
    onStatusChange: vi.fn(options.callbacks?.onStatusChange ?? (async () => undefined)),
    onSessionEvent: vi.fn(options.callbacks?.onSessionEvent ?? (async () => undefined)),
    onAgentEnd: vi.fn(options.callbacks?.onAgentEnd ?? (async () => undefined)),
    onRuntimeError: vi.fn(options.callbacks?.onRuntimeError ?? (async () => undefined)),
  };
  const sdk = options.sdk ?? { Agent: { create, resume }, Cursor: { models: { list: vi.fn() } } };
  const runtime = await CursorSdkAgentRuntime.create({
    descriptor,
    callbacks,
    now: () => "2026-01-01T00:00:00.000Z",
    sdk,
    apiKey: "cursor-key",
    model: { id: "composer-2.5", params: [{ id: "thinking", value: "medium" }] },
    systemPrompt: options.systemPrompt ?? "Forge worker instructions",
    mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    stateRoot: join(rootDir, "cursor-sdk-state", descriptor.agentId),
    promptHash: options.promptHash ?? "hash-1",
  });
  return { rootDir, descriptor, runtime, callbacks, send, close, create, resume };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 50; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("CursorSdkAgentRuntime", () => {
  it("injects Forge prompt context, uses stream as the sole text source, and persists SDK state", async () => {
    let sendText: string | { text: string } = "";
    let sendOptions: CursorSdkSendOptions | undefined;
    const send = vi.fn(async (text: string | { text: string }, options?: CursorSdkSendOptions) => {
      sendText = text;
      sendOptions = options;
      return createRun();
    });
    const { rootDir, runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");
    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());

    expect(sendText).toContain("<forge_system_context>");
    expect(sendText).toContain("Forge worker instructions");
    expect(sendText).toContain("<forge_user_message>\nhello");
    expect(sendOptions).toMatchObject({
      model: { id: "composer-2.5", params: [{ id: "thinking", value: "medium" }] },
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    expect(typeof sendOptions?.onDelta).toBe("function");
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "message_update" }));
    expect(runtime.getCustomEntries(CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE)).toEqual([
      expect.objectContaining({ sdkAgentId: "sdk-agent-1", stateRoot: join(rootDir, "cursor-sdk-state", "worker-1") }),
    ]);
  });

  it("captures turn-ended usage from onDelta and persists one custom record", async () => {
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({
        update: {
          type: "turn-ended",
          usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 }
        }
      });
      return createRun({ id: "run-usage-1", streamItems: [statusMessage("FINISHED"), assistantText("ok")] });
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toEqual([
      expect.objectContaining({
        version: 1,
        source: "cursor_sdk_on_delta_turn_ended",
        provider: "cursor-sdk",
        modelId: "composer-2.5",
        reasoningLevel: "medium",
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 },
        sdkRunId: "run-usage-1",
        sdkAgentId: "sdk-agent-1",
        providerStatus: "FINISHED",
        runStatus: "finished",
        waitStatus: "finished",
        terminalStatus: "FINISHED",
        outcome: "completed",
        capturedAt: "2026-01-01T00:00:00.000Z"
      })
    ]);
  });

  it("does not use onDelta text as a content source during an active turn", async () => {
    const gate = deferred();
    let sendOptions: CursorSdkSendOptions | undefined;
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      sendOptions = options;
      return createRun({ streamGate: gate.promise, streamItems: [assistantText("ok")] });
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");
    await waitFor(() => expect(sendOptions?.onDelta).toBeTypeOf("function"));
    await sendOptions?.onDelta?.({ update: { type: "text-delta", text: "duplicate" } });
    gate.resolve();

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
    const messageUpdates = callbacks.onSessionEvent.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.type === "message_update");
    expect(messageUpdates).toEqual([
      expect.objectContaining({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
    ]);
  });

  it("maps stream tool rows normally while usage persists once", async () => {
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({ update: { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 4 } } });
      return createRun({
        streamItems: [
          { type: "tool_call", call_id: "call-1", name: "shell", status: "running", args: { command: "pwd" } },
          { type: "tool_call", call_id: "call-1", name: "shell", status: "completed", result: { stdout: "/tmp" } },
          assistantText("ok")
        ]
      });
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", expect.objectContaining({
      type: "tool_execution_start",
      toolName: "execute",
      toolCallId: "call-1",
      args: { command: "pwd" }
    }));
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", expect.objectContaining({
      type: "tool_execution_end",
      toolName: "execute",
      toolCallId: "call-1",
      result: { stdout: "/tmp" },
      isError: false
    }));
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toHaveLength(1);
  });

  it("dedupes duplicate turn-ended usage deltas", async () => {
    const usageDelta = { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 4 } };
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({ update: usageDelta });
      await options?.onDelta?.({ update: usageDelta });
      return createRun();
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toHaveLength(1);
  });

  it("records reported usage for cancelled runs when Cursor emits it before finalization", async () => {
    const gate = deferred();
    const cancel = vi.fn(async () => gate.resolve());
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({ update: { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 4 } } });
      return createRun({ streamGate: gate.promise, cancel });
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");
    await waitFor(() => expect(send).toHaveBeenCalled());
    await runtime.stopInFlight();

    await waitFor(() => expect(runtime.getStatus()).toBe("idle"));
    expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toEqual([
      expect.objectContaining({ outcome: "cancelled", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14 } })
    ]);
  });

  it("retains reported usage when wait later errors", async () => {
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({ update: { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 4 } } });
      return createRun({ waitError: new Error("wait exploded") });
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onRuntimeError).toHaveBeenCalled());
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toEqual([
      expect.objectContaining({ outcome: "error", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14 } })
    ]);
  });

  it("ignores malformed or zero usage deltas", async () => {
    const send = vi.fn(async (_payload: string | { text: string }, options?: CursorSdkSendOptions) => {
      await options?.onDelta?.({ update: { type: "turn-ended", usage: { inputTokens: -1, outputTokens: "4" } } });
      await options?.onDelta?.({ update: { type: "turn-ended", usage: { inputTokens: 0, outputTokens: 0 } } });
      return createRun();
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
    expect(runtime.getCustomEntries(CURSOR_SDK_USAGE_ENTRY_TYPE)).toEqual([]);
  });

  it("returns an accepted receipt before stream completion", async () => {
    const gate = deferred();
    const send = vi.fn(async () => createRun({ streamGate: gate.promise }));
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    const receipt = await runtime.sendMessage("hello");

    expect(receipt.acceptedMode).toBe("prompt");
    expect(callbacks.onAgentEnd).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());
  });

  it.each([
    ["stream throw", createRun({ streamError: new Error("stream exploded") })],
    ["wait throw", createRun({ waitError: new Error("wait exploded") })],
    ["wait error status", createRun({ waitResult: { status: "error" } })],
    ["SDK ERROR status", createRun({ streamItems: [statusMessage("ERROR")], waitResult: { status: "finished" } })],
    ["SDK EXPIRED status", createRun({ streamItems: [statusMessage("EXPIRED")], waitResult: { status: "finished" } })],
  ])("emits runtime error and suppresses success completion on %s", async (_label, run) => {
    const send = vi.fn(async () => run);
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");

    await waitFor(() => expect(callbacks.onRuntimeError).toHaveBeenCalled());
    expect(callbacks.onAgentEnd).not.toHaveBeenCalled();
    expect(callbacks.onSessionEvent).not.toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "message_end" }));
  });

  it("resumes persisted SDK agent with explicit model, MCP, stateRoot and refreshes prompt wrapper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-cursor-sdk-runtime-"));
    await mkdir(rootDir, { recursive: true });
    const descriptor = createDescriptor(rootDir);
    await writeFile(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "now", cwd: rootDir })}\n${JSON.stringify({
      type: "custom",
      customType: CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE,
      id: "state-1",
      parentId: "session-1",
      timestamp: "now",
      data: { version: 1, sdkAgentId: "persisted-agent", model: descriptor.model, cwd: rootDir, stateRoot: "old", promptHash: "old", savedAt: "old" },
    })}\n`, "utf8");

    let sentText = "";
    const send = vi.fn(async (payload: string | { text: string }) => {
      sentText = typeof payload === "string" ? payload : payload.text;
      return createRun();
    });
    const resume = vi.fn(async () => ({ agentId: "persisted-agent", send, close: vi.fn() }));
    const create = vi.fn();
    const { runtime } = await setupRuntime({
      rootDir,
      descriptor,
      sdk: { Agent: { create, resume }, Cursor: { models: { list: vi.fn() } } },
      systemPrompt: "new prompt",
      promptHash: "new-hash",
    });

    expect(resume).toHaveBeenCalledWith("persisted-agent", expect.objectContaining({
      model: { id: "composer-2.5", params: [{ id: "thinking", value: "medium" }] },
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      platform: { stateRoot: join(rootDir, "cursor-sdk-state", "worker-1"), workspaceRef: rootDir },
    }));
    expect(create).not.toHaveBeenCalled();

    await runtime.sendMessage("hello");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sentText).toContain("new prompt");
    expect(sentText).toContain("<forge_system_context>");
  });

  it("dispatches queued follow-ups FIFO", async () => {
    const firstGate = deferred();
    const sent: string[] = [];
    const send = vi.fn(async (payload: string | { text: string }) => {
      sent.push(typeof payload === "string" ? payload : payload.text);
      return createRun(sent.length === 1 ? { streamGate: firstGate.promise } : {});
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("first");
    await runtime.sendMessage("second");
    await runtime.sendMessage("third");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    firstGate.resolve();

    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(3));
    expect(sent[0]).toContain("first");
    expect(sent[1]).toBe("second");
    expect(sent[2]).toBe("third");
  });

  it("stop cancels active run without runtime error and clears queued prompts", async () => {
    const gate = deferred();
    const cancel = vi.fn(async () => {
      gate.resolve();
    });
    const send = vi.fn(async () => createRun({ streamGate: gate.promise, cancel }));
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("first");
    await runtime.sendMessage("queued");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await runtime.stopInFlight();

    expect(cancel).toHaveBeenCalled();
    expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stop while sdkAgent.send is pending cancels resolved run and skips stream/completion/tool execution", async () => {
    const sendGate = deferred<CursorSdkRun>();
    const cancel = vi.fn(async () => undefined);
    const send = vi.fn(async () => sendGate.promise);
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("first");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await runtime.stopInFlight();
    sendGate.resolve(createRun({
      streamItems: [
        assistantText("should not emit"),
        { type: "tool_call", call_id: "call-1", name: "shell", status: "running", args: { command: "pwd" } }
      ],
      cancel
    }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
    expect(callbacks.onAgentEnd).not.toHaveBeenCalled();
    expect(callbacks.onSessionEvent).not.toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "message_update" }));
    expect(callbacks.onSessionEvent).not.toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "message_end" }));
    expect(callbacks.onSessionEvent).not.toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "tool_execution_start" }));
  });

  it("stop while pre-send status update is pending bails before sdkAgent.send", async () => {
    const statusGate = deferred();
    const send = vi.fn(async () => createRun());
    let heldStreamingStatus = false;
    const { runtime, callbacks } = await setupRuntime({
      sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() },
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          if (status === "streaming" && !heldStreamingStatus) {
            heldStreamingStatus = true;
            await statusGate.promise;
          }
        }
      }
    });

    await runtime.sendMessage("first");
    await waitFor(() => expect(callbacks.onStatusChange).toHaveBeenCalledWith("worker-1", "streaming", 0, undefined));
    await runtime.stopInFlight();
    statusGate.resolve();

    await waitFor(() => expect(runtime.getStatus()).toBe("idle"));
    expect(send).not.toHaveBeenCalled();
    expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
    expect(callbacks.onAgentEnd).not.toHaveBeenCalled();
  });

  it("terminate while pre-send beginPrompt events are pending bails before sdkAgent.send and stays terminated", async () => {
    const eventGate = deferred();
    const send = vi.fn(async () => createRun());
    let heldAgentStart = false;
    const close = vi.fn();
    const { descriptor, runtime, callbacks } = await setupRuntime({
      sdkAgent: { agentId: "sdk-agent-1", send, close },
      callbacks: {
        onSessionEvent: async (_agentId, event) => {
          if (event.type === "agent_start" && !heldAgentStart) {
            heldAgentStart = true;
            await eventGate.promise;
          }
        }
      }
    });

    await runtime.sendMessage("first");
    await waitFor(() => expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", { type: "agent_start" }));
    await runtime.terminate();
    eventGate.resolve();

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toBe("terminated");
    expect(descriptor.status).toBe("terminated");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("worker-1", "terminated", 0, undefined);
  });

  it("terminate while sdkAgent.send is pending does not overwrite terminated status", async () => {
    const sendGate = deferred<CursorSdkRun>();
    const cancel = vi.fn(async () => undefined);
    const close = vi.fn();
    const send = vi.fn(async () => sendGate.promise);
    const { descriptor, runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close } });

    await runtime.sendMessage("first");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await runtime.terminate();
    expect(runtime.getStatus()).toBe("terminated");
    sendGate.resolve(createRun({ cancel }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(close).toHaveBeenCalled();
    expect(runtime.getStatus()).toBe("terminated");
    expect(descriptor.status).toBe("terminated");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("worker-1", "terminated", 0, undefined);
  });

  it("includes Cursor SDK error name and code in runtime error details", async () => {
    class RateLimitError extends Error {
      code = "429";
    }
    const error = new RateLimitError("request failed");
    const send = vi.fn(async () => {
      throw error;
    });
    const { runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("first");

    await waitFor(() => expect(callbacks.onRuntimeError).toHaveBeenCalled());
    expect(callbacks.onRuntimeError).toHaveBeenCalledWith("worker-1", expect.objectContaining({
      details: { errorName: "RateLimitError", errorCode: "429" }
    }));
  });

  it("fallback snapshot preserves original text and images without Forge wrapper", async () => {
    const gate = deferred();
    const send = vi.fn(async () => createRun({ streamGate: gate.promise }));
    const { runtime } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });
    const message: RuntimeUserMessage = { text: "original", images: [{ data: "abc", mimeType: "image/png" }] };

    await runtime.sendMessage(message);
    const snapshot = await runtime.prepareForSpecialistFallbackReplay();

    expect(snapshot?.messages).toEqual([message]);
    expect(snapshot?.messages[0]?.text).not.toContain("forge_system_context");
    gate.resolve();
  });
});
