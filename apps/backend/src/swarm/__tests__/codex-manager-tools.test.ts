import { describe, expect, it, vi } from "vitest";
import { buildSwarmTools } from "../swarm-tools.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";
import type { CodexPluginScopeRuntimeView } from "../codex-app-server/codex-plugin-scope-service.js";

function createManager(): AgentDescriptor {
  return {
    agentId: "manager",
    managerId: "manager",
    role: "manager",
    displayName: "Manager",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: "/tmp/project",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" },
    sessionFile: "/tmp/project/manager.jsonl",
    sessionSurface: "builder",
  };
}

function createWorker(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "worker",
    managerId: "manager",
    role: "worker",
    displayName: "Worker",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: "/tmp/project",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" },
    sessionFile: "/tmp/project/worker.jsonl",
    ...overrides,
  };
}

function createHost(overrides: Partial<SwarmToolHost> = {}): SwarmToolHost {
  return {
    listAgents: () => [],
    getWorkerActivity: () => undefined,
    spawnAgent: async () => {
      throw new Error("not needed");
    },
    killAgent: async () => {},
    sendMessage: async () => ({
      targetAgentId: "worker",
      deliveryId: "d1",
      acceptedMode: "followUp",
    }),
    createSessionFromAgent: async () => {
      throw new Error("not needed");
    },
    publishToUser: async () => ({ targetContext: { channel: "web" } }),
    requestUserChoice: async () => [],
    runTaskTool: async () => {
      throw new Error("not needed");
    },
    delegateCodexPlugin: async () => {
      throw new Error("not needed");
    },
    ...overrides,
  };
}

function createScope(): CodexPluginScopeRuntimeView {
  return {
    delegationId: "delegation-1",
    managerAgentId: "manager",
    workerAgentId: "codex-plugin-fireflies",
    state: "active",
    selectors: ["fireflies"],
    expiresAt: Date.now() + 60_000,
    allowedTools: [
      {
        scopedToolName: "codex_fireflies_list_recent",
        displaySelector: "fireflies/list_recent",
        serverName: "fireflies",
        toolName: "list_recent",
        pluginSelector: "fireflies",
        pluginDisplayName: "Fireflies",
        description: "List recent meetings",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer" } },
          required: [],
          additionalProperties: true,
        },
        inputMode: "schema",
        readOnly: true,
      },
    ],
  };
}

describe("codex manager tools", () => {
  it("does not expose raw Codex MCP list/call tools to managers", () => {
    const host = createHost({
      listCodexMcpTools: async () => ({ apps: [], plugins: [], tools: [], fetchedAt: new Date().toISOString() }),
      callCodexMcpTool: async () => ({
        auditId: "audit-1",
        selector: "fireflies/list",
        serverName: "fireflies",
        toolName: "list",
        ok: true,
        redactedPreview: "{}",
      }),
    });

    const managerTools = buildSwarmTools(host, createManager()).map((tool) => tool.name);
    expect(managerTools).toContain("delegate_codex_plugin");
    expect(managerTools).not.toContain("list_codex_mcp_tools");
    expect(managerTools).not.toContain("call_codex_mcp_tool");
  });

  it("delegate_codex_plugin passes only task/context to the server-side scope binder", async () => {
    const delegateCodexPlugin = vi.fn(async () => ({
      workerAgentId: "codex-plugin-fireflies",
      selectors: ["fireflies"],
      deliveryId: "delivery-1",
      acceptedMode: "prompt" as const,
    }));
    const host = createHost({ delegateCodexPlugin });
    const tool = buildSwarmTools(host, createManager()).find((entry) => entry.name === "delegate_codex_plugin");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tc-1", {
      task: "List meetings via @Codex:RepoPrompt/get_code_structure",
      context: "Need a concise summary",
      selectors: ["RepoPrompt/get_code_structure"],
    });

    expect(delegateCodexPlugin).toHaveBeenCalledWith("manager", {
      task: "List meetings via @Codex:RepoPrompt/get_code_structure",
      context: "Need a concise summary",
    });
    expect(JSON.stringify(result.details)).toContain("codex-plugin-fireflies");
  });

  it("exposes scoped Codex plugin tools only to the bound internal worker", async () => {
    const callScoped = vi.fn(async () => ({
      auditId: "audit-1",
      selector: "fireflies/list_recent",
      serverName: "fireflies",
      toolName: "list_recent",
      ok: true,
      redactedPreview: JSON.stringify({ summary: "ok", email: "adam@secret.com" }),
    }));
    const host = createHost({
      getCodexPluginScopeForWorker: (agentId) => (agentId === "codex-plugin-fireflies" ? createScope() : undefined),
      callCodexPluginScopedTool: callScoped,
    });

    const ordinaryWorkerTools = buildSwarmTools(host, createWorker()).map((tool) => tool.name);
    expect(ordinaryWorkerTools).not.toContain("codex_fireflies_list_recent");

    const internalWorker = createWorker({
      agentId: "codex-plugin-fireflies",
      internalWorkerKind: "codex_plugin",
      specialistDisplayName: "Codex Plugin",
    });
    const scopedTools = buildSwarmTools(host, internalWorker);
    expect(scopedTools.map((tool) => tool.name)).toEqual([
      "send_message_to_agent",
      "list_scoped_codex_plugin_tools",
      "codex_fireflies_list_recent",
    ]);
    const tool = scopedTools.find((entry) => entry.name === "codex_fireflies_list_recent");
    expect(tool).toBeDefined();

    const result = await tool!.execute("tc-1", { limit: 1 });
    expect(callScoped).toHaveBeenCalledWith("codex-plugin-fireflies", "codex_fireflies_list_recent", { limit: 1 });
    const details = result.details as { preview?: string };
    expect(details.preview).toContain("[redacted-email]");
    expect(details.preview).not.toContain("adam@secret.com");
  });
});
