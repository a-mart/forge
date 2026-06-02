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
  it("exposes list/call codex tools only for builder web managers", () => {
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
      listCodexAppTools: async () => ({ apps: [], tools: [], fetchedAt: new Date().toISOString() }),
      callCodexAppTool: async () => ({
        auditId: "audit-1",
        selector: "fireflies/list",
        serverName: "fireflies",
        toolName: "list",
        ok: true,
        redactedPreview: "{}",
      }),
    };

    const managerTools = buildSwarmTools(host, createManager()).map((tool) => tool.name);
    expect(managerTools).toContain("list_codex_app_tools");
    expect(managerTools).toContain("call_codex_app_tool");

    const collabManager = buildSwarmTools(host, {
      ...createManager(),
      sessionSurface: "collab",
      collab: { channelId: "ch-1" },
    } as AgentDescriptor).map((tool) => tool.name);

    expect(collabManager).not.toContain("list_codex_app_tools");
    expect(collabManager).not.toContain("call_codex_app_tool");
  });
});
