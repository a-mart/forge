import { describe, expect, it } from "vitest";
import { CodexMcpCatalog, isPluginPickerEligible } from "../codex-app-server/codex-mcp-catalog.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";
import {
  LIVE_APP_LIST_RESPONSE,
  LIVE_MCP_SERVER_STATUS_RESPONSE,
  LIVE_PLUGIN_LIST_RESPONSE,
} from "./codex-mcp-catalog-live-fixtures.js";

class FakeCatalogClient implements CodexAppServerClientPort {
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "plugin/list") {
      return {
        plugins: [
          {
            id: "fireflies",
            name: "fireflies",
            displayName: "Fireflies",
            enabled: true,
            availability: "available",
            description: "Meeting notes",
            category: "productivity",
          },
          {
            pluginId: "repo-prompt",
            displayName: "RepoPrompt",
            enabled: true,
            availability: "available",
            description: "Repository browser tools",
            serverNames: ["RepoPrompt"],
          },
          {
            id: "disabled-only",
            name: "disabled_only",
            displayName: "Disabled Only",
            enabled: false,
            availability: "available",
          },
        ],
      } as T;
    }

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
  it("parses object-map MCP tool entries from mcpServerStatus/list", async () => {
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServerStatus/list") {
        return {
          servers: [
            {
              name: "RepoPrompt",
              tools: {
                get_code_structure: {
                  description: "Inspect repository structure",
                  readOnly: true,
                  annotations: { readOnlyHint: true },
                },
              },
            },
          ],
        } as T;
      }
      return new FakeCatalogClient().request(method, params);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);

    expect(snapshot.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: "RepoPrompt/get_code_structure",
          serverName: "RepoPrompt",
          toolName: "get_code_structure",
        }),
      ]),
    );
  });

  it("lists plugins from plugin/list as the primary catalog source", async () => {
    const client = new FakeCatalogClient();
    const catalog = new CodexMcpCatalog(async () => client);

    const snapshot = await catalog.listCatalog(true);
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: "fireflies",
          displayName: "Fireflies",
          pluginId: "fireflies",
        }),
        expect.objectContaining({
          selector: "repo-prompt",
          displayName: "RepoPrompt",
          relatedServerNames: ["RepoPrompt"],
        }),
      ]),
    );
    expect(client.requests.some((entry) => entry.method === "plugin/list")).toBe(true);
  });

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

  it("parses live-shaped plugin/list marketplaces and maps codex_apps tools to plugins", async () => {
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string): Promise<T> => {
      if (method === "plugin/list") {
        return LIVE_PLUGIN_LIST_RESPONSE as T;
      }
      if (method === "app/list") {
        return LIVE_APP_LIST_RESPONSE as T;
      }
      if (method === "mcpServerStatus/list") {
        return LIVE_MCP_SERVER_STATUS_RESPONSE as T;
      }
      return new FakeCatalogClient().request(method);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);

    const fireflies = snapshot.plugins.find((plugin) => plugin.selector === "fireflies");
    expect(fireflies).toMatchObject({
      selector: "fireflies",
      name: "fireflies",
      pluginId: "fireflies@openai-curated",
      displayName: "Fireflies",
      marketplaceName: "openai-curated",
      codexAppsToolNames: ["fireflies_fireflies_get_summary"],
    });

    expect(
      catalog.isToolSelectorAuthorized(
        "codex_apps/fireflies_fireflies_get_summary",
        ["fireflies"],
        snapshot,
      ),
    ).toBe(true);
    expect(
      catalog.isToolSelectorAuthorized(
        "codex_apps/gmail_gmail_search_messages",
        ["fireflies"],
        snapshot,
      ),
    ).toBe(false);
    expect(
      catalog.isToolSelectorAuthorized(
        "codex_apps/fireflies_fireflies_get_summary",
        ["codex_apps"],
        snapshot,
      ),
    ).toBe(false);
    expect(catalog.resolvePlugin("fireflies", snapshot)?.displayName).toBe("Fireflies");
    expect(
      catalog.filterToolsForAuthorizedSelectors(snapshot, ["fireflies"]).map((tool) => tool.toolName),
    ).toEqual(["fireflies_fireflies_get_summary"]);

    expect(snapshot.plugins.map((plugin) => plugin.selector).sort()).toEqual([
      "fireflies",
      "gmail",
      "google_calendar",
    ]);
    expect(snapshot.plugins.some((plugin) => plugin.selector === "disabled_demo")).toBe(false);
    expect(snapshot.plugins.some((plugin) => plugin.selector === "unavailable_demo")).toBe(false);
  });

  it("filters picker catalog to enabled=true plugins with allowed availability", () => {
    expect(
      isPluginPickerEligible({
        selector: "fireflies",
        displayName: "Fireflies",
        enabled: true,
        availability: "available",
      }),
    ).toBe(true);
    expect(
      isPluginPickerEligible({
        selector: "disabled",
        displayName: "Disabled",
        enabled: false,
        availability: "available",
      }),
    ).toBe(false);
    expect(
      isPluginPickerEligible({
        selector: "missing-enabled",
        displayName: "Missing Enabled",
        availability: "available",
      }),
    ).toBe(false);
    expect(
      isPluginPickerEligible({
        selector: "unavailable",
        displayName: "Unavailable",
        enabled: true,
        availability: "unavailable",
      }),
    ).toBe(false);
  });

  it("authorizes tools within a plugin scope and rejects unrelated servers", async () => {
    const client = new FakeCatalogClient();
    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);

    expect(
      catalog.isToolSelectorAuthorized("fireflies/list_recent", ["fireflies"], snapshot),
    ).toBe(true);
    expect(
      catalog.isToolSelectorAuthorized("fireflies/list_recent", ["repo-prompt"], snapshot),
    ).toBe(false);
    expect(catalog.filterToolsForAuthorizedSelectors(snapshot, ["fireflies"]).map((tool) => tool.selector)).toEqual([
      "fireflies/list_recent",
    ]);
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
    expect(Buffer.byteLength(result.redactedPreview, "utf8")).toBeLessThanOrEqual(2048);
    expect("content" in result).toBe(false);
    expect("structuredContent" in result).toBe(false);

    const callRequest = client.requests.find((entry) => entry.method === "mcpServer/tool/call");
    expect((callRequest?.params as { arguments?: Record<string, unknown> })?.arguments).toEqual({
      limit: 1,
      token: "Bearer raw-token-value",
    });
  });

  it("returns larger redacted model content for narrow Fireflies full-transcript tools while keeping previews bounded", async () => {
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServer/tool/call") {
        return {
          content: [
            {
              type: "text",
              text: `start adam@example.com ${"middle ".repeat(600)}tail-value`,
            },
          ],
          structuredContent: { accessToken: "secret-token", transcriptId: "transcript-1" },
        } as T;
      }
      return new FakeCatalogClient().request(method, params);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: "codex_apps",
        toolName: "fireflies_fireflies_get_transcript",
        args: { transcriptId: "transcript-1" },
      },
      {
        selector: "codex_apps/fireflies_fireflies_get_transcript",
        serverName: "codex_apps",
        toolName: "fireflies_fireflies_get_transcript",
        description: "Fetches detailed meeting transcript by ID.",
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
    );

    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.redactedPreview, "utf8")).toBeLessThanOrEqual(2048);
    expect(result.redactedPreview.endsWith("…")).toBe(true);
    expect(result.redactedModelContent).toContain("tail-value");
    expect(result.redactedModelContent).toContain("[redacted-email]");
    expect(result.redactedModelContent).toContain('"accessToken":"[redacted]"');
    expect(result.redactedModelContentTruncated).toBe(false);
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
