import { describe, expect, it } from "vitest";
import { buildModelChangeRecoveryContext } from "../runtime/model-change-recovery-context.js";
import type { ConversationEntryEvent } from "../types.js";

const descriptor = {
  agentId: "manager-1",
  role: "manager" as const
};

describe("buildModelChangeRecoveryContext", () => {
  it("shapes only approved durable transcript/event classes and preserves attachment placeholders", () => {
    const entries: ConversationEntryEvent[] = [
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "What broke?",
        timestamp: "2026-04-07T10:00:00.000Z",
        source: "user_input"
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "The server crashed.",
        timestamp: "2026-04-07T10:00:05.000Z",
        source: "speak_to_user",
        attachments: [
          {
            type: "image",
            mimeType: "image/png"
          }
        ]
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "I am checking the logs.",
        timestamp: "2026-04-07T10:00:06.000Z",
        source: "assistant_progress"
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "Please update the docs.",
        timestamp: "2026-04-07T10:00:10.000Z",
        source: "project_agent_input",
        projectAgentContext: {
          fromAgentId: "documentation",
          fromDisplayName: "Documentation"
        }
      },
      {
        type: "agent_message",
        agentId: "manager-1",
        timestamp: "2026-04-07T10:00:15.000Z",
        source: "agent_to_agent",
        fromAgentId: "backend-specialist",
        toAgentId: "manager-1",
        text: "I found the root cause.",
        attachmentCount: 2
      },
      {
        type: "agent_message",
        agentId: "manager-1",
        timestamp: "2026-04-07T10:00:16.000Z",
        source: "agent_to_agent",
        fromAgentId: "manager-1",
        toAgentId: "backend-specialist",
        text: "Thanks."
      },
      {
        type: "conversation_log",
        agentId: "manager-1",
        timestamp: "2026-04-07T10:00:17.000Z",
        source: "runtime_log",
        kind: "message_end",
        role: "assistant",
        text: "ignore me"
      },
      {
        type: "agent_tool_call",
        agentId: "manager-1",
        actorAgentId: "backend-specialist",
        timestamp: "2026-04-07T10:00:18.000Z",
        kind: "tool_execution_update",
        text: "still running"
      }
    ];

    const result = buildModelChangeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000
    });

    expect(result.blockText).toContain("# Recovered Forge Conversation Context");
    expect(result.bodyText).toContain("User: What broke?");
    expect(result.bodyText).toContain("Assistant: The server crashed. [image attachment present]");
    expect(result.bodyText).toContain("Assistant progress: I am checking the logs.");
    expect(result.bodyText).toContain("Project agent (Documentation): Please update the docs.");
    expect(result.bodyText).toContain(
      "Worker/Agent message (backend-specialist): I found the root cause. [2 attachments omitted]"
    );
    expect(result.bodyText).not.toContain("Thanks.");
    expect(result.bodyText).not.toContain("ignore me");
    expect(result.bodyText).not.toContain("still running");
  });

  it("excludes Codex sidecar detail rows and parent external-thread cards from recovery context", () => {
    const entries: ConversationEntryEvent[] = [
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "Ask Codex",
        timestamp: "2026-04-07T10:00:00.000Z",
        source: "user_input",
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "system",
        text: "Codex completed",
        timestamp: "2026-04-07T10:00:01.000Z",
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: "manager-1--codex",
          requestId: "req-1",
          turnCorrelationId: "corr-1",
          status: "completed",
          excludeFromModelContext: true,
        },
      },
      {
        type: "conversation_log",
        agentId: "manager-1--codex",
        timestamp: "2026-04-07T10:00:02.000Z",
        source: "runtime_log",
        kind: "tool_execution_end",
        toolName: "codex_command",
        toolCallId: "cmd-1",
        text: '{"command":"pnpm test","outputPreview":"secret output"}',
      },
      {
        type: "agent_tool_call",
        agentId: "manager-1",
        actorAgentId: "manager-1--codex",
        timestamp: "2026-04-07T10:00:03.000Z",
        kind: "tool_execution_end",
        toolName: "codex_command",
        toolCallId: "cmd-1",
        text: '{"command":"pnpm test"}',
      },
    ];

    const result = buildModelChangeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000,
    });

    expect(result.bodyText).toContain("User: Ask Codex");
    expect(result.bodyText).not.toContain("Codex completed");
    expect(result.bodyText).not.toContain("pnpm test");
    expect(result.bodyText).not.toContain("secret output");
  });

  it("bounds output while keeping the newest canonical transcript content", () => {
    const entries: ConversationEntryEvent[] = Array.from({ length: 18 }, (_, index) => ({
      type: "conversation_message",
      agentId: "manager-1",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index} ${"x".repeat(80)}`,
      timestamp: `2026-04-07T10:00:${String(index).padStart(2, "0")}.000Z`,
      source: index % 2 === 0 ? "user_input" : "speak_to_user"
    } satisfies ConversationEntryEvent));

    const result = buildModelChangeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "y".repeat(1_200),
      modelContextWindow: 6_000,
      hasPinnedContent: true
    });

    expect(result.blockText).toBeDefined();
    expect(result.truncated).toBe(true);
    expect(result.bodyText).toContain("Older recovered transcript omitted due to context budget");
    expect(result.bodyText).toContain("message 17");
    expect(result.bodyText).not.toContain("message 0");
    expect(result.approxTokenCount).toBeLessThanOrEqual(Math.ceil(result.blockText!.length / 4));
  });
});
