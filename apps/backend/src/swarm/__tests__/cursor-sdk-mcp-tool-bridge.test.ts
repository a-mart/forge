import { describe, expect, it, vi } from "vitest";
import { createCursorSdkMcpToolBridge } from "../runtime/cursor-sdk/cursor-sdk-mcp-tool-bridge.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

async function postJson(url: string, payload: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("cursor-sdk-mcp-tool-bridge", () => {
  it("returns Cursor SDK mcpServers record-map shape and serves MCP tools", async () => {
    const execute = vi.fn(async (_callId: string, args: Record<string, unknown>) => ({ ok: true, args }));
    const bridge = await createCursorSdkMcpToolBridge([
      {
        name: "send_message_to_agent",
        description: "Send a message",
        parameters: {
          type: "object",
          properties: { targetAgentId: { type: "string" }, message: { type: "string" } },
          required: ["targetAgentId", "message"]
        },
        execute
      } as unknown as ToolDefinition
    ], { serverName: "forge-swarm-worker-1" });

    try {
      const serverConfig = bridge.mcpServers["forge-swarm-worker-1"];
      expect(serverConfig).toMatchObject({ type: "http" });
      if (!serverConfig || !("url" in serverConfig)) {
        throw new Error("Expected HTTP server config");
      }
      expect(serverConfig.headers).toEqual({});

      await expect(postJson(serverConfig.url, { jsonrpc: "2.0", id: 1, method: "initialize" })).resolves.toMatchObject({
        result: { serverInfo: { name: "forge-swarm-worker-1" } }
      });
      await expect(postJson(serverConfig.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).resolves.toMatchObject({
        result: { tools: [expect.objectContaining({ name: "send_message_to_agent" })] }
      });
      await expect(postJson(serverConfig.url, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send_message_to_agent", arguments: { targetAgentId: "manager-1", message: "hi" } }
      })).resolves.toMatchObject({
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, args: { targetAgentId: "manager-1", message: "hi" } }) }] }
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.shutdown();
    }
  });

  it("returns MCP isError results for thrown tool errors", async () => {
    const bridge = await createCursorSdkMcpToolBridge([
      {
        name: "explode",
        execute: async () => {
          throw new Error("boom");
        }
      } as unknown as ToolDefinition
    ]);

    try {
      const serverConfig = bridge.mcpServers[bridge.serverName];
      if (!serverConfig || !("url" in serverConfig)) throw new Error("Expected URL");
      await expect(postJson(serverConfig.url, {
        jsonrpc: "2.0",
        id: "call",
        method: "tools/call",
        params: { name: "explode", arguments: {} }
      })).resolves.toMatchObject({
        result: { isError: true, content: [{ type: "text", text: "Tool explode failed: boom" }] }
      });
    } finally {
      await bridge.shutdown();
    }
  });
});
