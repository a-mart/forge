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
        args: { limit: 1 },
      },
      tool!,
    );

    expect(result.ok).toBe(true);
    expect(result.redactedPreview).toContain("[redacted]");
    expect(result.redactedPreview).not.toContain("abc.def.ghi");
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
    expect(result.error).toMatch(/approval/i);
  });
});
