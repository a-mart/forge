import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getSpawnPresetFamilies } from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadClaudeSdkMcpHelpers } = vi.hoisted(() => ({
  loadClaudeSdkMcpHelpers: vi.fn()
}));

vi.mock("../claude-sdk-loader.js", () => ({
  loadClaudeSdkMcpHelpers
}));

import { buildCreateProjectAgentTool } from "../agent-creator-tool.js";
import { createClaudeMcpToolBridge } from "../claude-mcp-tool-bridge.js";
import { ChoiceRequestCancelledError } from "../swarm-manager.js";
import { buildSwarmTools, type SwarmToolHost } from "../swarm-tools.js";
import type { AgentDescriptor, MessageSourceContext } from "../types.js";

interface RegisteredTool {
  name: string;
  description: string;
  shape: {
    parse: (value: unknown) => unknown;
    safeParse: (value: unknown) => { success: boolean };
  };
  handler: (args: unknown) => Promise<unknown>;
}

function createMockDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  const now = new Date("2026-04-04T12:00:00.000Z").toISOString();
  return {
    agentId: "manager-1",
    displayName: "Test Manager",
    role: "manager",
    managerId: "manager-1",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp/test",
    model: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/test/session.jsonl",
    ...overrides
  };
}

function createMockHost(overrides: Partial<SwarmToolHost> = {}): SwarmToolHost {
  const defaultPublishContext: MessageSourceContext = { channel: "web" };

  return {
    listAgents: vi.fn(() => []),
    getWorkerActivity: vi.fn(() => undefined),
    spawnAgent: vi.fn(async (_callerAgentId, input) =>
      createMockDescriptor({
        agentId: input.agentId,
        displayName: input.agentId,
        role: "worker",
        managerId: _callerAgentId
      })
    ),
    killAgent: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_fromAgentId, targetAgentId) => ({
      targetAgentId,
      deliveryId: "del-1",
      acceptedMode: "steer"
    })),
    createSessionFromAgent: vi.fn(async (_creatorAgentId, input) => ({
      sessionAgentId: `${_creatorAgentId}:${input.sessionName}`,
      sessionLabel: input.sessionName,
      profileId: "profile-1"
    })),
    publishToUser: vi.fn(async () => ({
      targetContext: defaultPublishContext
    })),
    requestUserChoice: vi.fn(async () => []),
    createAndPromoteProjectAgent: vi.fn(async () => ({
      agentId: "new-agent-1",
      handle: "new-handle"
    })),
    ...overrides
  };
}

function createSdkHelpersMock() {
  const registeredTools: RegisteredTool[] = [];
  const tool = vi.fn(
    (
      name: string,
      description: string,
      shape: RegisteredTool["shape"],
      handler: RegisteredTool["handler"]
    ) => {
      const registered = { name, description, shape, handler };
      registeredTools.push(registered);
      return registered;
    }
  );
  const createSdkMcpServer = vi.fn((config: { name: string; version: string; tools: unknown[] }) => ({
    name: config.name,
    version: config.version,
    tools: config.tools
  }));

  loadClaudeSdkMcpHelpers.mockResolvedValue({
    tool,
    createSdkMcpServer
  });

  return {
    registeredTools,
    tool,
    createSdkMcpServer
  };
}

async function buildBridge(tools: ToolDefinition[], options?: { serverName?: string }) {
  const sdk = createSdkHelpersMock();
  const bridge = await createClaudeMcpToolBridge(tools, options);
  return {
    bridge,
    ...sdk
  };
}

function getRegisteredTool(registeredTools: RegisteredTool[], name: string): RegisteredTool {
  const tool = registeredTools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool as RegisteredTool;
}

async function invokeTool(
  registeredTools: RegisteredTool[],
  name: string,
  args: unknown
): Promise<any> {
  const tool = getRegisteredTool(registeredTools, name);
  return await tool.handler(tool.shape.parse(args));
}

function createCustomTool(
  name: string,
  parameters: Record<string, unknown>,
  execute: ToolDefinition["execute"]
): ToolDefinition {
  return {
    name,
    label: name,
    description: `Run ${name}`,
    parameters,
    execute
  };
}

beforeEach(() => {
  loadClaudeSdkMcpHelpers.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("claude-mcp-tool-bridge", () => {
  it("creates a bridge from an empty tool list", async () => {
    const { bridge, createSdkMcpServer, tool } = await buildBridge([]);

    expect(bridge.serverName).toBe("forge-swarm");
    expect(bridge.allowedTools).toEqual([]);
    expect(tool).not.toHaveBeenCalled();
    expect(createSdkMcpServer).toHaveBeenCalledWith({
      name: "forge-swarm",
      version: "1.0.0",
      tools: []
    });
  });

  it("registers manager swarm tools with namespaced allowedTools", async () => {
    const manager = createMockDescriptor();
    const tools = buildSwarmTools(createMockHost(), manager);
    const { bridge, registeredTools } = await buildBridge(tools);

    expect(registeredTools.map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_message_to_agent",
      "spawn_agent",
      "kill_agent",
      "speak_to_user",
      "present_choices"
    ]);
    expect(bridge.allowedTools).toEqual([
      "mcp__forge-swarm__list_agents",
      "mcp__forge-swarm__send_message_to_agent",
      "mcp__forge-swarm__spawn_agent",
      "mcp__forge-swarm__kill_agent",
      "mcp__forge-swarm__speak_to_user",
      "mcp__forge-swarm__present_choices"
    ]);
  });

  it("registers worker swarm tools only", async () => {
    const worker = createMockDescriptor({
      agentId: "worker-1",
      displayName: "Worker",
      role: "worker",
      managerId: "manager-1"
    });
    const tools = buildSwarmTools(createMockHost(), worker);
    const { bridge, registeredTools } = await buildBridge(tools, { serverName: "custom-swarm" });

    expect(registeredTools.map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_message_to_agent"
    ]);
    expect(bridge.serverName).toBe("custom-swarm");
    expect(bridge.allowedTools).toEqual([
      "mcp__custom-swarm__list_agents",
      "mcp__custom-swarm__send_message_to_agent"
    ]);
  });

  it("registers create_project_agent when provided", async () => {
    const manager = createMockDescriptor({ sessionPurpose: "agent_creator" });
    const host = createMockHost();
    const tools = [...buildSwarmTools(host, manager), buildCreateProjectAgentTool(host, manager)];
    const { registeredTools } = await buildBridge(tools);

    expect(registeredTools.map((tool) => tool.name)).toContain("create_project_agent");
  });

  it("converts string, enum, and optional schemas for send_message_to_agent", async () => {
    const tools = buildSwarmTools(createMockHost(), createMockDescriptor());
    const { registeredTools } = await buildBridge(tools);
    const sendMessageTool = getRegisteredTool(registeredTools, "send_message_to_agent");

    expect(
      sendMessageTool.shape.safeParse({
        targetAgentId: "worker-1",
        message: "hello",
        delivery: "steer"
      }).success
    ).toBe(true);
    expect(sendMessageTool.shape.safeParse({ targetAgentId: "worker-1" }).success).toBe(false);
  });

  it("converts boolean and integer constraints for list_agents", async () => {
    const tools = buildSwarmTools(createMockHost(), createMockDescriptor());
    const { registeredTools } = await buildBridge(tools);
    const listAgentsTool = getRegisteredTool(registeredTools, "list_agents");

    expect(listAgentsTool.shape.safeParse({ verbose: true, limit: 20, offset: 0 }).success).toBe(true);
    expect(listAgentsTool.shape.safeParse({ limit: 0 }).success).toBe(false);
    expect(listAgentsTool.shape.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("converts nested object schema for speak_to_user", async () => {
    const tools = buildSwarmTools(createMockHost(), createMockDescriptor());
    const { registeredTools } = await buildBridge(tools);
    const speakToUserTool = getRegisteredTool(registeredTools, "speak_to_user");

    expect(
      speakToUserTool.shape.safeParse({
        text: "hello",
        target: {
          channel: "telegram",
          channelId: "C123",
          threadTs: "123.456"
        }
      }).success
    ).toBe(true);
    expect(
      speakToUserTool.shape.safeParse({
        text: "hello",
        target: { channel: "email" }
      }).success
    ).toBe(false);
  });

  it("converts array schemas for present_choices", async () => {
    const tools = buildSwarmTools(createMockHost(), createMockDescriptor());
    const { registeredTools } = await buildBridge(tools);
    const presentChoicesTool = getRegisteredTool(registeredTools, "present_choices");

    expect(
      presentChoicesTool.shape.safeParse({
        questions: [
          {
            id: "q1",
            header: "Choose one",
            question: "Which option?",
            options: [
              {
                id: "opt-a",
                label: "Option A",
                description: "The first option",
                recommended: true
              }
            ],
            placeholder: "Tell me more"
          }
        ]
      }).success
    ).toBe(true);
    expect(presentChoicesTool.shape.safeParse({ questions: [] }).success).toBe(false);
  });

  it("handles unknown schema constructs by falling back to z.any", async () => {
    const weirdTool = createCustomTool(
      "weird_tool",
      {
        type: "object",
        properties: {
          mystery: {
            weird: true
          }
        }
      },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    const { registeredTools } = await buildBridge([weirdTool]);
    const registered = getRegisteredTool(registeredTools, "weird_tool");

    expect(registered.shape.safeParse({ mystery: Symbol("x") }).success).toBe(true);
  });

  it("round-trips actual tool schemas through Zod validation", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost();
    const tools = [...buildSwarmTools(host, manager), buildCreateProjectAgentTool(host, manager)];
    const { registeredTools } = await buildBridge(tools);
    const spawnPreset = getSpawnPresetFamilies()[0]?.familyId ?? "pi-codex";

    expect(getRegisteredTool(registeredTools, "list_agents").shape.safeParse({ verbose: true }).success).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "send_message_to_agent").shape.safeParse({
        targetAgentId: "worker-1",
        message: "hello"
      }).success
    ).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "spawn_agent").shape.safeParse({
        agentId: "worker-1",
        model: spawnPreset,
        reasoningLevel: "high"
      }).success
    ).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "kill_agent").shape.safeParse({ targetAgentId: "worker-1" }).success
    ).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "speak_to_user").shape.safeParse({ text: "hello" }).success
    ).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "present_choices").shape.safeParse({
        questions: [{ id: "q1", question: "Continue?" }]
      }).success
    ).toBe(true);
    expect(
      getRegisteredTool(registeredTools, "create_project_agent").shape.safeParse({
        sessionName: "Releases",
        whenToUse: "Use for release notes",
        systemPrompt: "You write release notes."
      }).success
    ).toBe(true);
  });

  it("dispatches list_agents and returns JSON content", async () => {
    const manager = createMockDescriptor();
    const worker = createMockDescriptor({
      agentId: "worker-1",
      displayName: "Worker 1",
      role: "worker",
      managerId: manager.agentId,
      status: "streaming"
    });
    const host = createMockHost({
      listAgents: vi.fn(() => [manager, worker])
    });
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "list_agents", { limit: 10, offset: 0 });
    const payload = JSON.parse(result.content[0].text);

    expect(host.listAgents).toHaveBeenCalledTimes(1);
    expect(payload.summary.totalVisible).toBe(2);
    expect(payload.agents).toHaveLength(2);
  });

  it("returns an error result when list_agents throws", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost({
      listAgents: vi.fn(() => {
        throw new Error("list failed");
      })
    });
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "list_agents", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tool list_agents failed: list failed");
  });

  it("dispatches send_message_to_agent and appends receipt details", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost();
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "send_message_to_agent", {
      targetAgentId: "worker-1",
      message: "please investigate",
      delivery: "steer"
    });

    expect(host.sendMessage).toHaveBeenCalledWith(manager.agentId, "worker-1", "please investigate", "steer");
    expect(result.content[0].text).toContain("Queued message for worker-1");
    expect(result.content[1].text).toContain("[details]");
  });

  it("dispatches spawn_agent with specialist, model, and reasoning level", async () => {
    const manager = createMockDescriptor();
    const spawnPreset = getSpawnPresetFamilies()[0]?.familyId ?? "pi-codex";
    const host = createMockHost();
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    await invokeTool(registeredTools, "spawn_agent", {
      agentId: "backend-worker",
      specialist: "backend",
      model: spawnPreset,
      reasoningLevel: "high"
    });

    expect(host.spawnAgent).toHaveBeenCalledWith(
      manager.agentId,
      expect.objectContaining({
        agentId: "backend-worker",
        specialist: "backend",
        model: spawnPreset,
        reasoningLevel: "high"
      })
    );
  });

  it("returns an error when spawn_agent rejects", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost({
      spawnAgent: vi.fn(async () => {
        throw new Error("specialist and model cannot be combined");
      })
    });
    const spawnPreset = getSpawnPresetFamilies()[0]?.familyId ?? "pi-codex";
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "spawn_agent", {
      agentId: "backend-worker",
      specialist: "backend",
      model: spawnPreset
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("specialist and model cannot be combined");
  });

  it("dispatches kill_agent", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost();
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "kill_agent", { targetAgentId: "worker-1" });

    expect(host.killAgent).toHaveBeenCalledWith(manager.agentId, "worker-1");
    expect(result.content[0].text).toContain("Terminated agent worker-1");
  });

  it("dispatches speak_to_user with default web target", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost();
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "speak_to_user", { text: "Hello from Claude" });

    expect(host.publishToUser).toHaveBeenCalledWith(manager.agentId, "Hello from Claude", "speak_to_user", undefined);
    expect(result.content[0].text).toContain("Published message to user (web).");
  });

  it("dispatches present_choices and returns answered JSON", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost({
      requestUserChoice: vi.fn(async () => [
        {
          questionId: "q1",
          selectedOptionIds: ["opt-a"],
          text: "extra context"
        }
      ])
    });
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "present_choices", {
      questions: [
        {
          id: "q1",
          question: "Choose one",
          options: [{ id: "opt-a", label: "A" }]
        }
      ]
    });
    const payload = JSON.parse(result.content[0].text);

    expect(host.requestUserChoice).toHaveBeenCalledWith(
      manager.agentId,
      expect.arrayContaining([expect.objectContaining({ id: "q1", question: "Choose one" })])
    );
    expect(payload).toEqual({
      status: "answered",
      answers: [{ questionId: "q1", selectedOptions: ["opt-a"], text: "extra context" }]
    });
    expect(result.isError).toBeUndefined();
  });

  it("returns cancelled present_choices results without marking them as errors", async () => {
    const manager = createMockDescriptor();
    const host = createMockHost({
      requestUserChoice: vi.fn(async () => {
        throw new ChoiceRequestCancelledError("cancelled");
      })
    });
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    const result = await invokeTool(registeredTools, "present_choices", {
      questions: [{ id: "q1", question: "Choose one" }]
    });

    expect(JSON.parse(result.content[0].text)).toEqual({ status: "cancelled", reason: "cancelled" });
    expect(result.isError).toBeUndefined();
  });

  it("keeps present_choices pending until the host resolves", async () => {
    const manager = createMockDescriptor();
    let resolveChoice: ((value: unknown) => void) | undefined;
    const host = createMockHost({
      requestUserChoice: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveChoice = resolve;
          }) as Promise<any>
      )
    });
    const { registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    let settled = false;
    const pending = invokeTool(registeredTools, "present_choices", {
      questions: [{ id: "q1", question: "Choose one" }]
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveChoice?.([{ questionId: "q1", selectedOptionIds: ["opt-a"], text: undefined }]);
    await pending;
    expect(settled).toBe(true);
  });

  it("dispatches create_project_agent", async () => {
    const manager = createMockDescriptor({ sessionPurpose: "agent_creator" });
    const host = createMockHost();
    const { registeredTools } = await buildBridge([buildCreateProjectAgentTool(host, manager)]);

    const result = await invokeTool(registeredTools, "create_project_agent", {
      sessionName: "Releases",
      handle: "releases",
      whenToUse: "Use for release notes",
      systemPrompt: "You maintain release notes."
    });

    expect(host.createAndPromoteProjectAgent).toHaveBeenCalledWith(manager.agentId, {
      sessionName: "Releases",
      handle: "releases",
      whenToUse: "Use for release notes",
      systemPrompt: "You maintain release notes."
    });
    expect(result.content[0].text).toContain("Project agent @new-handle created successfully");
  });


  it("returns an error when create_project_agent is unavailable", async () => {
    const manager = createMockDescriptor({ sessionPurpose: "agent_creator" });
    const host = createMockHost({
      createAndPromoteProjectAgent: undefined
    });
    const { registeredTools } = await buildBridge([buildCreateProjectAgentTool(host, manager)]);

    const result = await invokeTool(registeredTools, "create_project_agent", {
      sessionName: "Releases",
      whenToUse: "Use for release notes",
      systemPrompt: "You maintain release notes."
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Project-agent creation is not available in this runtime");
  });

  it("passes through text content unchanged", async () => {
    const tool = createCustomTool(
      "text_tool",
      { type: "object", properties: {} },
      async () => ({
        content: [{ type: "text", text: "hello" }]
      })
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "text_tool", {});

    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("passes through image content unchanged", async () => {
    const tool = createCustomTool(
      "image_tool",
      { type: "object", properties: {} },
      async () => ({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }]
      })
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "image_tool", {});

    expect(result).toEqual({
      content: [{ type: "image", data: "base64data", mimeType: "image/png" }]
    });
  });

  it("appends details when content is a short summary", async () => {
    const tool = createCustomTool(
      "details_tool",
      { type: "object", properties: {} },
      async () => ({
        content: [{ type: "text", text: "Summary" }],
        details: { ok: true, count: 2 }
      })
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "details_tool", {});

    expect(result.content[0].text).toBe("Summary");
    expect(result.content[1].text).toContain("[details]");
    expect(result.content[1].text).toContain('"count": 2');
  });

  it("does not duplicate details when content already contains the same JSON", async () => {
    const details = { agents: [{ agentId: "worker-1" }] };
    const tool = createCustomTool(
      "json_tool",
      { type: "object", properties: {} },
      async () => ({
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details
      })
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "json_tool", {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('"agentId": "worker-1"');
  });

  it("falls back to a completion message when the tool returns undefined", async () => {
    const tool = createCustomTool("undefined_tool", { type: "object", properties: {} }, async () => undefined as any);
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "undefined_tool", {});

    expect(result).toEqual({
      content: [{ type: "text", text: "Tool undefined_tool completed." }]
    });
  });

  it("falls back to JSON serialization for non-content results", async () => {
    const tool = createCustomTool(
      "plain_result_tool",
      { type: "object", properties: {} },
      async () => ({ ok: true, value: 42 })
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "plain_result_tool", {});

    expect(result.content[0].text).toContain('"value": 42');
  });

  it("normalizes synchronous and non-Error failures into MCP errors", async () => {
    const tool = createCustomTool(
      "failing_tool",
      { type: "object", properties: {} },
      async () => {
        throw new Error("plain failure");
      }
    );
    const { registeredTools } = await buildBridge([tool]);

    const result = await invokeTool(registeredTools, "failing_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tool failing_tool failed: plain failure");
  });

  it("creates a full bridge and executes a real tool end-to-end", async () => {
    const manager = createMockDescriptor();
    const worker = createMockDescriptor({
      agentId: "worker-1",
      displayName: "Worker 1",
      role: "worker",
      managerId: manager.agentId
    });
    const host = createMockHost({
      listAgents: vi.fn(() => [manager, worker])
    });
    const { bridge, registeredTools } = await buildBridge(buildSwarmTools(host, manager));

    expect(bridge.allowedTools).toContain("mcp__forge-swarm__list_agents");

    const result = await invokeTool(registeredTools, "list_agents", { verbose: true });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.agents[0].agentId).toBe("manager-1");
    expect(payload.agents[1].agentId).toBe("worker-1");
  });
});
