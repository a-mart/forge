import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { wrapForgeToolsWithExtensionHooks } from "../forge-instrumented-tools.js";

describe("wrapForgeToolsWithExtensionHooks", () => {
  it("blocks tool execution when Forge returns a block result", async () => {
    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: ToolDefinition = {
      name: "write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      execute: executeSpy,
    };

    const host = {
      dispatchToolBefore: vi.fn(async () => ({ block: true, reason: "blocked by policy" })),
      dispatchToolAfter: vi.fn(async () => undefined),
    } as any;

    const [wrapped] = wrapForgeToolsWithExtensionHooks({
      tools: [tool],
      forgeExtensionHost: host,
      bindingToken: "binding-1",
    });

    await expect(wrapped.execute("tool-0", { path: "secret.env" })).rejects.toThrow("blocked by policy");
    expect(executeSpy).not.toHaveBeenCalled();
    expect(host.dispatchToolAfter).not.toHaveBeenCalled();
  });

  it("deep-clones tool:before inputs so host-side mutation cannot affect execution", async () => {
    const executeSpy = vi.fn(async (_toolCallId: string, params: Record<string, unknown>) => params);
    const tool: ToolDefinition = {
      name: "write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      execute: executeSpy,
    };

    const host = {
      dispatchToolBefore: vi.fn(async (_bindingToken: string, event: { input: Record<string, unknown> }) => {
        ((event.input.nested as { flag: boolean }).flag) = false;
        return undefined;
      }),
      dispatchToolAfter: vi.fn(async () => undefined),
    } as any;

    const [wrapped] = wrapForgeToolsWithExtensionHooks({
      tools: [tool],
      forgeExtensionHost: host,
      bindingToken: "binding-1",
    });

    const originalParams = { nested: { flag: true } };
    const result = await wrapped.execute("tool-1", originalParams);

    expect(executeSpy).toHaveBeenCalledWith("tool-1", { nested: { flag: true } });
    expect(result).toEqual({ nested: { flag: true } });
    expect(originalParams).toEqual({ nested: { flag: true } });
  });

  it("reports tool failures through the standardized tool:after envelope before rethrowing", async () => {
    const tool: ToolDefinition = {
      name: "bash",
      description: "bash",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        throw new Error("command failed");
      }),
    };

    const host = {
      dispatchToolBefore: vi.fn(async () => undefined),
      dispatchToolAfter: vi.fn(async () => undefined),
    } as any;

    const [wrapped] = wrapForgeToolsWithExtensionHooks({
      tools: [tool],
      forgeExtensionHost: host,
      bindingToken: "binding-1",
    });

    await expect(wrapped.execute("tool-fail", { command: "false" })).rejects.toThrow("command failed");
    expect(host.dispatchToolAfter).toHaveBeenCalledWith(
      "binding-1",
      expect.objectContaining({
        toolName: "bash",
        toolCallId: "tool-fail",
        input: { command: "false" },
        result: expect.objectContaining({
          ok: false,
          error: "command failed",
        }),
      })
    );
  });

  it("deep-clones tool:after payloads so host-side mutation cannot affect returned results", async () => {
    const tool: ToolDefinition = {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ nested: { status: "ok" } })),
    };

    const host = {
      dispatchToolBefore: vi.fn(async () => undefined),
      dispatchToolAfter: vi.fn(async (_bindingToken: string, event: { input: Record<string, unknown>; result: { value?: { nested?: { status: string } } } }) => {
        if (event.result.value?.nested) {
          event.result.value.nested.status = "mutated";
        }
        if ((event.input.nested as { flag?: boolean } | undefined)?.flag !== undefined) {
          (event.input.nested as { flag: boolean }).flag = false;
        }
      }),
    } as any;

    const [wrapped] = wrapForgeToolsWithExtensionHooks({
      tools: [tool],
      forgeExtensionHost: host,
      bindingToken: "binding-1",
    });

    const originalParams = { nested: { flag: true } };
    const result = await wrapped.execute("tool-2", originalParams);

    expect(result).toEqual({ nested: { status: "ok" } });
    expect(originalParams).toEqual({ nested: { flag: true } });
  });
});
