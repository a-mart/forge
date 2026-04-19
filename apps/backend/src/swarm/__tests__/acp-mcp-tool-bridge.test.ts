import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAcpMcpToolBridge,
  type AcpMcpBridgeResult
} from "../runtime/acp/acp-mcp-tool-bridge.js";

const activeBridges: AcpMcpBridgeResult[] = [];

afterEach(async () => {
  await Promise.all(activeBridges.splice(0).map(async (bridge) => await bridge.shutdown()));
  vi.restoreAllMocks();
});

describe("acp-mcp-tool-bridge", () => {
  it("starts on loopback and returns the required ACP MCP descriptor", async () => {
    const bridge = await trackBridge(createAcpMcpToolBridge([]));

    expect(bridge.mcpDescriptor).toMatchObject({
      type: "http",
      name: "forge-tools",
      headers: []
    });
    expect(bridge.mcpDescriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const getResponse = await fetch(bridge.mcpDescriptor.url);
    expect(getResponse.status).toBe(405);

    await bridge.shutdown();
    await expect(fetch(bridge.mcpDescriptor.url)).rejects.toThrow();
  });

  it("returns MCP initialize metadata and lists tools with MCP schemas", async () => {
    const bridge = await trackBridge(
      createAcpMcpToolBridge([
        createTool({
          name: "list_agents",
          description: "List active agents",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 100 }
            },
            required: ["limit"]
          },
          execute: async () => "unused"
        })
      ])
    );

    const initialize = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25"
      }
    });

    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toMatch(/^forge-mcp-/);
    expect(initialize.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "forge-tools",
          version: "1.0.0"
        }
      }
    });

    const toolsList = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });

    expect(toolsList.status).toBe(200);
    expect(toolsList.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "list_agents",
            description: "List active agents",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "integer", minimum: 1, maximum: 100 }
              },
              required: ["limit"]
            }
          }
        ]
      }
    });
  });

  it("routes tools/call to the matching tool and normalizes arguments", async () => {
    const execute = vi.fn(async (_callId: string, args: Record<string, unknown>) => ({
      ok: true,
      echoed: args
    }));

    const bridge = await trackBridge(
      createAcpMcpToolBridge([
        createTool({
          name: "echo",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string" }
            }
          },
          execute
        })
      ])
    );

    const response = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          message: "hello"
        }
      }
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ message: "hello" });
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, echoed: { message: "hello" } })
          }
        ]
      }
    });
  });

  it("returns MCP tool errors for unknown tools and execution failures", async () => {
    const bridge = await trackBridge(
      createAcpMcpToolBridge([
        createTool({
          name: "explode",
          execute: async () => {
            throw new Error("boom");
          }
        })
      ])
    );

    const unknown = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "missing",
        arguments: {}
      }
    });

    expect(unknown.body).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        content: [{ type: "text", text: "Unknown tool: missing" }],
        isError: true
      }
    });

    const failure = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "explode",
        arguments: {}
      }
    });

    expect(failure.body).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: {
        content: [{ type: "text", text: "Tool explode failed: boom" }],
        isError: true
      }
    });
  });

  it("handles the expected Cursor MCP HTTP exchange", async () => {
    const bridge = await trackBridge(
      createAcpMcpToolBridge([
        createTool({
          name: "ping",
          execute: async () => "pong"
        })
      ])
    );

    const initialize = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25"
      }
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^forge-mcp-/);

    const initialized = await fetch(bridge.mcpDescriptor.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      })
    });
    expect(initialized.status).toBe(202);
    expect(initialized.headers.get("mcp-session-id")).toBe(sessionId);

    const toolsList = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list"
    });
    expect(toolsList.body.result.tools).toEqual([
      {
        name: "ping",
        description: "Run ping",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]);

    const toolCall = await postJsonRpc(bridge.mcpDescriptor.url, {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "ping",
        arguments: {}
      }
    });
    expect(toolCall.body).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        content: [{ type: "text", text: "pong" }]
      }
    });
  });
});

async function trackBridge(bridgePromise: Promise<AcpMcpBridgeResult>): Promise<AcpMcpBridgeResult> {
  const bridge = await bridgePromise;
  activeBridges.push(bridge);
  return bridge;
}

function createTool(options: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: ToolDefinition["execute"];
}): ToolDefinition {
  return {
    name: options.name,
    label: options.name,
    description: options.description ?? `Run ${options.name}`,
    parameters: options.parameters,
    execute: options.execute
  };
}

async function postJsonRpc(
  url: string,
  payload: unknown
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers
  };
}
