import { describe, expect, it, vi } from "vitest";
import { buildForgePiToolBridgeExtensionFactory } from "../forge-pi-tool-bridge.js";

describe("buildForgePiToolBridgeExtensionFactory", () => {
  it("skips bridge dispatch for wrapped Forge-owned tools", async () => {
    const host = {
      dispatchToolBefore: vi.fn(async () => undefined),
      dispatchToolAfter: vi.fn(async () => undefined),
    } as any;

    const handlers = new Map<string, (event: any) => Promise<unknown>>();
    const factory = buildForgePiToolBridgeExtensionFactory({
      forgeExtensionHost: host,
      bindingToken: "binding-1",
      skippedToolNames: ["write"],
    });

    factory({
      on: (event: string, handler: (payload: any) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as any);

    const toolCallHandler = handlers.get("tool_call");
    expect(toolCallHandler).toBeTypeOf("function");

    const event = {
      toolName: "write",
      toolCallId: "tool-1",
      input: { nested: { flag: true } },
    };

    await expect(toolCallHandler?.(event)).resolves.toBeUndefined();
    expect(host.dispatchToolBefore).not.toHaveBeenCalled();
    expect(event).toEqual({
      toolName: "write",
      toolCallId: "tool-1",
      input: { nested: { flag: true } },
    });
  });

  it("passes through Pi-native tool calls without leaking host-side input mutation", async () => {
    const host = {
      dispatchToolBefore: vi.fn(async (_bindingToken: string, event: { input: Record<string, unknown> }) => {
        ((event.input.nested as { flag: boolean }).flag) = false;
        return undefined;
      }),
      dispatchToolAfter: vi.fn(async () => undefined),
    } as any;

    const handlers = new Map<string, (event: any) => Promise<unknown>>();
    const factory = buildForgePiToolBridgeExtensionFactory({
      forgeExtensionHost: host,
      bindingToken: "binding-1",
      skippedToolNames: [],
    });

    factory({
      on: (event: string, handler: (payload: any) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as any);

    const toolCallHandler = handlers.get("tool_call");
    const event = {
      toolName: "bash",
      toolCallId: "tool-2",
      input: { nested: { flag: true } },
    };

    await expect(toolCallHandler?.(event)).resolves.toBeUndefined();
    expect(event.input).toEqual({ nested: { flag: true } });
  });

  it("deep-clones tool results before dispatching tool:after", async () => {
    const host = {
      dispatchToolBefore: vi.fn(async () => undefined),
      dispatchToolAfter: vi.fn(async (_bindingToken: string, event: { result: { value?: { content?: Array<{ text: string }> } } }) => {
        event.result.value?.content?.splice(0, 1, { text: "mutated" });
      }),
    } as any;

    const handlers = new Map<string, (event: any) => Promise<unknown>>();
    const factory = buildForgePiToolBridgeExtensionFactory({
      forgeExtensionHost: host,
      bindingToken: "binding-1",
      skippedToolNames: [],
    });

    factory({
      on: (event: string, handler: (payload: any) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as any);

    const toolResultHandler = handlers.get("tool_result");
    const event = {
      toolName: "read",
      toolCallId: "tool-3",
      input: {},
      content: [{ type: "text", text: "original" }],
      details: { nested: { ok: true } },
      isError: false,
    };

    await expect(toolResultHandler?.(event)).resolves.toBeUndefined();
    expect(event.content).toEqual([{ type: "text", text: "original" }]);
    expect(event.details).toEqual({ nested: { ok: true } });
  });
});
