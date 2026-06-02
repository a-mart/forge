import { describe, expect, it } from "vitest";
import { buildSwarmTools } from "../swarm-tools.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

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
    sessionSurface: "builder",
  };
}

describe("codex manager tools", () => {
  it("exposes list/call codex MCP tools only for builder web managers", () => {
    const host: SwarmToolHost = {
      listAgents: () => [],
      spawnAgent: async () => {
        throw new Error("not needed");
      },
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "d1",
        acceptedMode: "followUp",
      }),
      publishToUser: async () => ({ targetContext: { channel: "web" } }),
      requestUserChoice: async () => [],
      runTaskTool: async () => {
        throw new Error("not needed");
      },
      listCodexMcpTools: async () => ({ apps: [], tools: [], fetchedAt: new Date().toISOString() }),
      callCodexMcpTool: async () => ({
        auditId: "audit-1",
        selector: "fireflies/list",
        serverName: "fireflies",
        toolName: "list",
        ok: true,
        redactedPreview: "{}",
      }),
    };

    const managerTools = buildSwarmTools(host, createManager()).map((tool) => tool.name);
    expect(managerTools).toContain("list_codex_mcp_tools");
    expect(managerTools).toContain("call_codex_mcp_tool");

    const collabManager = buildSwarmTools(host, {
      ...createManager(),
      sessionSurface: "collab",
      collab: { channelId: "ch-1" },
    } as AgentDescriptor).map((tool) => tool.name);

    expect(collabManager).not.toContain("list_codex_mcp_tools");
    expect(collabManager).not.toContain("call_codex_mcp_tool");
  });

  it("bounds call_codex_mcp_tool persisted preview details for UI", async () => {
    const longPreview = JSON.stringify({ summary: "x".repeat(8_000), email: "adam@secret.com" });
    const host: SwarmToolHost = {
      listAgents: () => [],
      spawnAgent: async () => {
        throw new Error("not needed");
      },
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "d1",
        acceptedMode: "followUp",
      }),
      publishToUser: async () => ({ targetContext: { channel: "web" } }),
      requestUserChoice: async () => [],
      runTaskTool: async () => {
        throw new Error("not needed");
      },
      listCodexMcpTools: async () => ({ apps: [], tools: [], fetchedAt: new Date().toISOString() }),
      callCodexMcpTool: async () => ({
        auditId: "audit-1",
        selector: "fireflies/list",
        serverName: "fireflies",
        toolName: "list",
        ok: true,
        redactedPreview: longPreview,
      }),
    };

    const tool = buildSwarmTools(host, createManager()).find((entry) => entry.name === "call_codex_mcp_tool");
    expect(tool).toBeDefined();

    const result = await tool!.execute("tc-1", { selector: "fireflies/list" });
    const details = result.details as { preview?: string };
    expect(details.preview).toBeDefined();
    expect(details.preview).not.toContain("adam@secret.com");
    const { MAX_CODEX_MCP_UI_PREVIEW_BYTES } = await import("../codex-app-server/codex-mcp-args.js");
    expect(Buffer.byteLength(details.preview ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_CODEX_MCP_UI_PREVIEW_BYTES,
    );
  });
});
