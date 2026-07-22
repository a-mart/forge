import { describe, expect, it, vi } from "vitest";
import { createCursorSdkMcpToolBridge } from "../runtime/cursor-sdk/cursor-sdk-mcp-tool-bridge.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
  it("binds to loopback, rejects unsupported methods, and shuts down idempotently", async () => {
    const bridge = await createCursorSdkMcpToolBridge([]);

    const serverConfig = bridge.mcpServers[bridge.serverName];
    if (!serverConfig || !("url" in serverConfig)) {
      throw new Error("Expected HTTP server config");
    }
    expect(serverConfig.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const response = await fetch(serverConfig.url, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");

    await bridge.shutdown();
    await bridge.shutdown();
  });

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
      const initializedResponse = await fetch(serverConfig.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      });
      expect(initializedResponse.status).toBe(202);
      await expect(postJson(serverConfig.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).resolves.toMatchObject({
        result: { tools: [expect.objectContaining({
          name: "send_message_to_agent",
          inputSchema: expect.objectContaining({ type: "object" })
        })] }
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

  it("preserves Forge text and image content blocks for browser snapshots", async () => {
    const bridge = await createCursorSdkMcpToolBridge([
      {
        name: "browser_snapshot",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ ok: true, screenshot: { mimeType: "image/png" } }) },
            { type: "image", data: "base64data", mimeType: "image/png" },
          ],
          details: { ok: true },
        }),
      } as unknown as ToolDefinition,
    ]);

    try {
      const serverConfig = bridge.mcpServers[bridge.serverName];
      if (!serverConfig || !("url" in serverConfig)) throw new Error("Expected URL");
      await expect(postJson(serverConfig.url, {
        jsonrpc: "2.0",
        id: "snapshot",
        method: "tools/call",
        params: { name: "browser_snapshot", arguments: {} },
      })).resolves.toMatchObject({
        result: {
          content: [
            { type: "text", text: expect.stringContaining("image/png") },
            { type: "image", data: "base64data", mimeType: "image/png" },
          ],
        },
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it("returns default schemas and MCP isError results for unknown tools", async () => {
    const bridge = await createCursorSdkMcpToolBridge([
      { name: "no_schema", execute: async () => "ok" } as unknown as ToolDefinition
    ]);

    try {
      const serverConfig = bridge.mcpServers[bridge.serverName];
      if (!serverConfig || !("url" in serverConfig)) throw new Error("Expected URL");
      await expect(postJson(serverConfig.url, { jsonrpc: "2.0", id: "list", method: "tools/list" })).resolves.toMatchObject({
        result: { tools: [expect.objectContaining({ inputSchema: { type: "object", properties: {} } })] }
      });
      await expect(postJson(serverConfig.url, {
        jsonrpc: "2.0",
        id: "unknown",
        method: "tools/call",
        params: { name: "missing", arguments: {} }
      })).resolves.toMatchObject({
        result: { isError: true, content: [{ type: "text", text: "Unknown tool: missing" }] }
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it("returns JSON-RPC errors for unknown methods", async () => {
    const bridge = await createCursorSdkMcpToolBridge([]);

    try {
      const serverConfig = bridge.mcpServers[bridge.serverName];
      if (!serverConfig || !("url" in serverConfig)) throw new Error("Expected URL");
      const response = await fetch(serverConfig.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "bad", method: "unknown/method" })
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32601, message: "Method not found: unknown/method" }
      });
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
