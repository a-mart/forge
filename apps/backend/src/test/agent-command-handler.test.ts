import { describe, expect, it, vi } from "vitest";
import { handleAgentCommand } from "../ws/commands/agent-command-handler.js";

describe("agent command handler conversation paging", () => {
  it("returns a request-correlated page event", async () => {
    const send = vi.fn();
    const getConversationHistoryPage = vi.fn(() => ({
      messages: [{
        type: "conversation_message" as const,
        id: "older",
        agentId: "worker",
        role: "assistant" as const,
        text: "older",
        timestamp: "2026-07-14T00:00:00.000Z",
        source: "system" as const,
      }],
      page: {
        hasOlder: false,
        completeness: "complete" as const,
        source: "canonical" as const,
        sourceRevision: "fixture",
        pageBytes: 100,
        scanBytes: 200,
      },
    }));
    const swarmManager = {
      getAgent: vi.fn(() => ({ agentId: "worker", role: "worker" })),
      getConversationHistoryPage,
    };

    await expect(handleAgentCommand({
      command: {
        type: "get_conversation_page",
        agentId: "worker",
        cursor: "cursor-1",
        limit: 25,
        view: "web",
        requestId: "request-1",
      },
      socket: {} as never,
      subscribedAgentId: "worker",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(),
      send,
    })).resolves.toBe(true);

    expect(getConversationHistoryPage).toHaveBeenCalledWith("worker", {
      cursor: "cursor-1",
      limit: 25,
      view: "web",
    });
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      type: "conversation_page",
      agentId: "worker",
      requestId: "request-1",
      messages: expect.any(Array),
      page: {
        source: "canonical",
        completeness: "complete",
        hasOlder: false,
      },
    });
  });

  it("contains synchronous page-read failures in a request-correlated error", async () => {
    const send = vi.fn();
    await expect(handleAgentCommand({
      command: {
        type: "get_conversation_page",
        agentId: "worker",
        cursor: "cursor-1",
        requestId: "request-failure",
      },
      socket: {} as never,
      subscribedAgentId: "worker",
      swarmManager: {
        getAgent: vi.fn(() => ({ agentId: "worker", role: "worker" })),
        getConversationHistoryPage: vi.fn(() => {
          throw new Error("session file disappeared");
        }),
      } as never,
      resolveManagerContextAgentId: vi.fn(),
      send,
    })).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(expect.anything(), {
      type: "error",
      code: "GET_CONVERSATION_PAGE_FAILED",
      message: "session file disappeared",
      requestId: "request-failure",
    });
  });

  it("returns an explicit error for a missing agent", async () => {
    const send = vi.fn();
    await handleAgentCommand({
      command: {
        type: "get_conversation_page",
        agentId: "missing",
        cursor: "cursor-1",
        requestId: "request-2",
      },
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: { getAgent: vi.fn(() => undefined) } as never,
      resolveManagerContextAgentId: vi.fn(),
      send,
    });

    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "error",
      code: "UNKNOWN_AGENT",
      requestId: "request-2",
    }));
  });
});
