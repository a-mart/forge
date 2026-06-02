import { describe, expect, it } from "vitest";
import { CodexMcpCatalog } from "../codex-app-server/codex-mcp-catalog.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";

class FakeCatalogClient implements CodexAppServerClientPort {
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "app/list") {
      return {
        apps: [{ id: "fireflies", name: "Fireflies" }],
      } as T;
    }

    if (method === "mcpServerStatus/list") {
      return {
        servers: [
          {
            name: "fireflies",
            tools: [
              {
                name: "list_recent",
                description: "List recent meetings",
                readOnly: true,
                annotations: { readOnlyHint: true },
                inputSchema: {
                  type: "object",
                  properties: { limit: { type: "integer" } },
                  required: ["limit"],
                },
              },
            ],
          },
        ],
      } as T;
    }

    if (method === "mcpServer/tool/call") {
      return {
        content: [{ type: "text", text: "secret Bearer abc.def.ghi" }],
      } as T;
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  notify(): void {}
  dispose(): void {}
  isDisposed(): boolean {
    return false;
  }
}

describe("CodexMcpCatalog", () => {
  it("lists apps and tools with tolerant parsing", async () => {
    const client = new FakeCatalogClient();
    const catalog = new CodexMcpCatalog(async () => client);

    const snapshot = await catalog.listCatalog(true);
    expect(snapshot.apps).toEqual([{ id: "fireflies", name: "Fireflies" }]);
    expect(snapshot.tools[0]).toMatchObject({
      selector: "fireflies/list_recent",
      serverName: "fireflies",
      toolName: "list_recent",
    });
  });

  it("validates required args and redacts tool output", async () => {
    const client = new FakeCatalogClient();
    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot);
    expect(tool).toBeDefined();

    await expect(
      catalog.callTool(
        {
          managerAgentId: "manager",
          cwd: "/tmp",
          threadId: "thread-1",
          serverName: tool!.serverName,
          toolName: tool!.toolName,
        },
        tool!,
      ),
    ).rejects.toThrow(/Missing required Codex tool argument: limit/);

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool!.serverName,
        toolName: tool!.toolName,
        args: { limit: 1, token: "Bearer raw-token-value" },
      },
      tool!,
    );

    expect(result.ok).toBe(true);
    expect(result.redactedPreview).toContain("[redacted]");
    expect(result.redactedPreview).not.toContain("abc.def.ghi");
    expect("content" in result).toBe(false);
    expect("structuredContent" in result).toBe(false);

    const callRequest = client.requests.find((entry) => entry.method === "mcpServer/tool/call");
    expect((callRequest?.params as { arguments?: Record<string, unknown> })?.arguments).toEqual({
      limit: 1,
      token: "Bearer raw-token-value",
    });
  });

  it("paginates catalog list endpoints when nextCursor is provided", async () => {
    let page = 0;
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "app/list") {
        page += 1;
        if (page === 1) {
          return { apps: [{ id: "a1", name: "A1" }], nextCursor: "page-2" } as T;
        }
        return { apps: [{ id: "a2", name: "A2" }] } as T;
      }
      return new FakeCatalogClient().request(method, params);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);
    expect(snapshot.apps.map((app) => app.id)).toEqual(["a1", "a2"]);
  });

  it("rejects non-read-only tools at call time", async () => {
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServerStatus/list") {
        return {
          servers: [
            {
              name: "fireflies",
              tools: [{ name: "delete_item", description: "Delete a record" }],
            },
          ],
        } as T;
      }
      return new FakeCatalogClient().request(method, params);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/delete_item", snapshot)!;

    await expect(
      catalog.callTool(
        {
          managerAgentId: "manager",
          cwd: "/tmp",
          threadId: "thread-1",
          serverName: tool.serverName,
          toolName: tool.toolName,
        },
        tool,
      ),
    ).rejects.toThrow(/blocked/i);
  });

  it("fails closed on elicitation-style responses", async () => {
    const decliningClient: CodexAppServerClientPort = {
      ...new FakeCatalogClient(),
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServer/tool/call") {
          return { action: "decline" } as T;
        }
        return new FakeCatalogClient().request(method, params);
      },
    };

    const catalog = new CodexMcpCatalog(async () => decliningClient);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot)!;

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool.serverName,
        toolName: tool.toolName,
        args: { limit: 1 },
      },
      tool,
    );

    expect(result.ok).toBe(false);
    expect(result.errorPreview).toMatch(/approval/i);
    expect("error" in result).toBe(false);
  });

  it("redacts MCP tool isError payloads without leaking secrets", async () => {
    const errorClient: CodexAppServerClientPort = {
      ...new FakeCatalogClient(),
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServer/tool/call") {
          return {
            isError: true,
            error: "Meeting transcript for adam@secret.com Bearer sk-live-abcdef1234567890",
          } as T;
        }
        return new FakeCatalogClient().request(method, params);
      },
    };

    const catalog = new CodexMcpCatalog(async () => errorClient);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot)!;

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool.serverName,
        toolName: tool.toolName,
        args: { limit: 1 },
      },
      tool,
    );

    expect(result.ok).toBe(false);
    expect(result.errorPreview).toContain("[redacted]");
    expect(result.errorPreview).not.toContain("sk-live-abcdef1234567890");
    expect(result.errorPreview).not.toContain("adam@secret.com");
    expect(result.redactedPreview).toBe(result.errorPreview);
    expect("error" in result).toBe(false);
  });

  it("redacts JSON-RPC style MCP error payloads without leaking secrets", async () => {
    const rpcErrorClient: CodexAppServerClientPort = {
      ...new FakeCatalogClient(),
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServer/tool/call") {
          return {
            error: {
              code: -32000,
              message: "upstream failed Bearer sk-live-abcdef1234567890 for adam@secret.com",
            },
          } as T;
        }
        return new FakeCatalogClient().request(method, params);
      },
    };

    const catalog = new CodexMcpCatalog(async () => rpcErrorClient);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot)!;

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool.serverName,
        toolName: tool.toolName,
        args: { limit: 1 },
      },
      tool,
    );

    expect(result.ok).toBe(false);
    expect(result.errorPreview).toContain("[redacted]");
    expect(result.errorPreview).not.toContain("sk-live-abcdef1234567890");
    expect(result.errorPreview).not.toContain("adam@secret.com");
    expect(JSON.stringify(result)).not.toContain("sk-live-abcdef1234567890");
  });

  it("redacts and bounds MCP error text returned to callers", async () => {
    const leakingClient: CodexAppServerClientPort = {
      ...new FakeCatalogClient(),
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServer/tool/call") {
          throw new Error("Meeting notes for adam@secret.com Bearer sk-live-abcdef1234567890");
        }
        return new FakeCatalogClient().request(method, params);
      },
    };

    const catalog = new CodexMcpCatalog(async () => leakingClient);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot)!;

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool.serverName,
        toolName: tool.toolName,
        args: { limit: 1 },
      },
      tool,
    );

    expect(result.ok).toBe(false);
    expect(result.errorPreview).toContain("[redacted]");
    expect(result.errorPreview).not.toContain("sk-live-abcdef1234567890");
    expect(result.errorPreview).not.toContain("adam@secret.com");
    expect(result.redactedPreview).toBe(result.errorPreview);
    expect(Buffer.byteLength(result.errorPreview ?? "", "utf8")).toBeLessThanOrEqual(1024);
  });
});
