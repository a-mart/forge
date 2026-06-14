import { describe, expect, it } from "vitest";
import {
  CodexPluginScopeService,
  buildCodexPluginScopedToolDefinitions,
  type CodexPluginScopeCatalogAdapter,
} from "../codex-app-server/codex-plugin-scope-service.js";
import {
  CodexMcpCatalog,
  type CodexCatalogSnapshot,
} from "../codex-app-server/codex-mcp-catalog.js";

function catalog(overrides: Partial<CodexCatalogSnapshot> = {}): CodexCatalogSnapshot {
  return {
    apps: [{ id: "fireflies", name: "Fireflies" }],
    plugins: [
      {
        selector: "fireflies",
        name: "fireflies",
        pluginId: "fireflies@openai-curated",
        displayName: "Fireflies",
        enabled: true,
        availability: "available",
      },
      {
        selector: "repo-prompt",
        name: "repo-prompt",
        pluginId: "repo-prompt",
        displayName: "RepoPrompt",
        enabled: true,
        availability: "available",
        relatedServerNames: ["RepoPrompt"],
      },
    ],
    tools: [
      {
        selector: "fireflies/list_recent",
        serverName: "fireflies",
        toolName: "list_recent",
        description: "List recent meetings",
        readOnly: true,
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
      },
      {
        selector: "fireflies/delete_meeting",
        serverName: "fireflies",
        toolName: "delete_meeting",
        description: "Delete a meeting",
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
      {
        selector: "RepoPrompt/get_code_structure",
        serverName: "RepoPrompt",
        toolName: "get_code_structure",
        description: "Inspect repository structure",
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function adapter(snapshot: CodexCatalogSnapshot): CodexPluginScopeCatalogAdapter {
  const resolver = new CodexMcpCatalog(async () => {
    throw new Error("should not fetch");
  });

  return {
    listCatalog: async () => snapshot,
    resolvePlugin: (selector, current) => resolver.resolvePlugin(selector, current),
    resolveTool: (selector, current) => resolver.resolveTool(selector, current),
    filterToolsForAuthorizedSelectors: (current, selectors) =>
      resolver.filterToolsForAuthorizedSelectors(current, selectors),
  };
}

describe("CodexPluginScopeService", () => {
  it("materializes plugin scopes with only safe tools for that plugin", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      delegationId: "delegation-1",
      selectors: ["fireflies"],
    });

    expect(scope.allowedTools.map((tool) => tool.displaySelector)).toEqual(["fireflies/list_recent"]);
    expect(scope.allowedTools.some((tool) => tool.displaySelector.includes("delete"))).toBe(false);
    expect(scope.allowedTools.some((tool) => tool.serverName === "RepoPrompt")).toBe(false);
  });

  it("materializes exact advanced selectors without widening to plugin scope", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-repo",
      selectors: ["RepoPrompt/get_code_structure"],
    });

    expect(scope.allowedTools).toHaveLength(1);
    expect(scope.allowedTools[0]).toMatchObject({
      displaySelector: "RepoPrompt/get_code_structure",
      serverName: "RepoPrompt",
      toolName: "get_code_structure",
    });
  });

  it("fails closed for disabled plugins and open-world exact tools", async () => {
    const disabledCatalog = catalog({
      plugins: [
        {
          selector: "fireflies",
          displayName: "Fireflies",
          enabled: false,
          availability: "disabled",
        },
      ],
    });
    await expect(
      new CodexPluginScopeService({ catalog: adapter(disabledCatalog) }).materializePendingScope({
        managerAgentId: "manager",
        workerAgentId: "worker",
        selectors: ["fireflies"],
      }),
    ).rejects.toThrow(/unavailable|disabled/i);

    const openWorldCatalog = catalog({
      tools: [
        {
          selector: "fireflies/list_recent",
          serverName: "fireflies",
          toolName: "list_recent",
          readOnly: true,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
      ],
    });
    await expect(
      new CodexPluginScopeService({ catalog: adapter(openWorldCatalog) }).materializePendingScope({
        managerAgentId: "manager",
        workerAgentId: "worker",
        selectors: ["fireflies/list_recent"],
      }),
    ).rejects.toThrow(/open-world/i);
  });

  it("rejects scoped tool calls after the worker scope is closed", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      delegationId: "delegation-1",
      selectors: ["fireflies"],
    });

    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", scope.allowedTools[0]!.scopedToolName)).not.toThrow();
    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", "codex_repoprompt_get_code_structure")).toThrow(/not allowed/i);

    service.activateScopeForWorker("codex-plugin-fireflies", "delegation-1");
    service.closeScopeForWorker("codex-plugin-fireflies");
    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", scope.allowedTools[0]!.scopedToolName)).toThrow(/No active|closed/i);
  });

  it("generates deterministic collision-safe names and args fallback for huge schemas", async () => {
    const hugeDescription = "x".repeat(20_000);
    const collisionCatalog = catalog({
      plugins: [
        {
          selector: "plug",
          displayName: "Plugin",
          enabled: true,
          relatedServerNames: ["a-b", "a_b"],
        },
      ],
      tools: [
        {
          selector: "a-b/c",
          serverName: "a-b",
          toolName: "c",
          readOnly: true,
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", description: hugeDescription, properties: { q: { type: "string" } } },
        },
        {
          selector: "a_b/c",
          serverName: "a_b",
          toolName: "c",
          readOnly: true,
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}`, { type: "string", description: hugeDescription }])) },
        },
      ],
    });
    const service = new CodexPluginScopeService({ catalog: adapter(collisionCatalog) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-plug",
      selectors: ["plug"],
    });

    expect(new Set(scope.allowedTools.map((tool) => tool.scopedToolName)).size).toBe(2);
    expect(scope.allowedTools.every((tool) => tool.scopedToolName.length <= 64)).toBe(true);
    expect(scope.allowedTools.some((tool) => tool.inputMode === "args")).toBe(true);
  });

  it("returns full redacted Fireflies fetch_transcript content to the worker while keeping public details preview-only", async () => {
    const baseCatalog = catalog();
    const service = new CodexPluginScopeService({
      catalog: adapter(
        catalog({
          tools: [
            ...baseCatalog.tools,
            {
              selector: "fireflies/fetch_transcript",
              serverName: "fireflies",
              toolName: "fetch_transcript",
              description: "Fetch full transcript by ID",
              readOnly: true,
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object", properties: { transcriptId: { type: "string" } } },
            },
          ],
        }),
      ),
    });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      selectors: ["fireflies/fetch_transcript"],
    });
    const definitions = buildCodexPluginScopedToolDefinitions({
      scope,
      executeScopedTool: async () => ({
        auditId: "audit-1",
        selector: "fireflies/fetch_transcript",
        serverName: "fireflies",
        toolName: "fetch_transcript",
        ok: true,
        redactedPreview: "{\"content\":\"preview…\"}",
        redactedModelContent: "{\"content\":\"full redacted transcript tail\"}",
        redactedModelContentTruncated: false,
      }),
    });

    const transcriptTool = definitions.find((tool) => tool.name === "codex_fireflies_fetch_transcript")!;
    const result = await transcriptTool.execute("tc-1", { transcriptId: "transcript-1" });
    const contentText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(contentText).toContain("fullRedactedContent");
    expect(contentText).toContain("full redacted transcript tail");
    expect(JSON.stringify(result.details)).toContain("preview");
    expect(JSON.stringify(result.details)).not.toContain("fullRedactedContent");
    expect(JSON.stringify(result.details)).not.toContain("full redacted transcript tail");
  });

  it("list fallback returns scoped cards only", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      selectors: ["fireflies"],
    });
    const definitions = buildCodexPluginScopedToolDefinitions({
      scope,
      executeScopedTool: async () => {
        throw new Error("not needed");
      },
    });

    const listTool = definitions.find((tool) => tool.name === "list_scoped_codex_plugin_tools")!;
    const result = await listTool.execute("tc-1", {});
    expect(JSON.stringify(result.details)).toContain("fireflies/list_recent");
    expect(JSON.stringify(result.details)).not.toContain("RepoPrompt/get_code_structure");
  });
});
