import { describe, expect, it } from "vitest";
import { buildClaudeRecoveryContext } from "../claude-recovery-context.js";
import type { ConversationEntryEvent } from "../types.js";

const descriptor = {
  agentId: "manager-1",
  role: "manager" as const
};

describe("buildClaudeRecoveryContext", () => {
  it("formats mixed manager history entries and filters unrelated events", () => {
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
        source: "speak_to_user"
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
        text: "I found the root cause."
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
      }
    ];

    const result = buildClaudeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000
    });

    expect(result.blockText).toContain("# Recovered Forge Conversation Context");
    expect(result.blockText).toContain("historical conversation context reconstructed from Forge's durable session history");
    expect(result.transcriptText).toContain("User: What broke?");
    expect(result.transcriptText).toContain("Assistant: The server crashed.");
    expect(result.transcriptText).toContain("Project agent (Documentation): Please update the docs.");
    expect(result.transcriptText).toContain("Worker/Agent message (backend-specialist): I found the root cause.");
    expect(result.transcriptText).not.toContain("Thanks.");
    expect(result.transcriptText).not.toContain("ignore me");
  });

  it("renders attachment placeholders for image-only and named attachments", () => {
    const entries: ConversationEntryEvent[] = [
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "See screenshot",
        timestamp: "2026-04-07T10:00:00.000Z",
        source: "user_input",
        attachments: [
          {
            mimeType: "image/png",
            data: "abc"
          }
        ]
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "I reviewed both files.",
        timestamp: "2026-04-07T10:00:01.000Z",
        source: "speak_to_user",
        attachments: [
          {
            mimeType: "image/png",
            fileName: "screenshot.png"
          },
          {
            type: "text",
            mimeType: "text/plain",
            fileName: "error-log.txt"
          }
        ]
      }
    ];

    const result = buildClaudeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000
    });

    expect(result.transcriptText).toContain("User: See screenshot [image attachment present]");
    expect(result.transcriptText).toContain(
      "Assistant: I reviewed both files. [attachments: screenshot.png, error-log.txt]"
    );
  });

  it("honors the compaction cutoff and excludes only the newest matching pending turn", () => {
    const entries: ConversationEntryEvent[] = [
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "old request",
        timestamp: "2026-04-07T10:00:00.000Z",
        source: "user_input"
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "same request",
        timestamp: "2026-04-07T10:00:10.000Z",
        source: "user_input"
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "working on it",
        timestamp: "2026-04-07T10:00:11.000Z",
        source: "speak_to_user"
      },
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "same request",
        timestamp: "2026-04-07T10:00:12.000Z",
        source: "user_input"
      }
    ];

    const result = buildClaudeRecoveryContext({
      descriptor,
      entries,
      compactedAt: "2026-04-07T10:00:05.000Z",
      pendingTurnExclusion: {
        sourceHint: "user_input",
        text: "same request",
        attachmentCount: 0,
        imageCount: 0
      },
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000
    });

    expect(result.pendingTurnExcluded).toBe(true);
    expect(result.transcriptText).not.toContain("old request");
    expect(result.transcriptText.match(/User: same request/g)).toHaveLength(1);
    expect(result.transcriptText).toContain("Assistant: working on it");
  });

  it("truncates to the newest entries and adds an omission marker when over budget", () => {
    const entries: ConversationEntryEvent[] = Array.from({ length: 12 }, (_, index) => ({
      type: "conversation_message",
      agentId: "manager-1",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index} ${"x".repeat(48)}`,
      timestamp: `2026-04-07T10:00:${String(index).padStart(2, "0")}.000Z`,
      source: index % 2 === 0 ? "user_input" : "speak_to_user"
    } satisfies ConversationEntryEvent));

    const result = buildClaudeRecoveryContext({
      descriptor,
      entries,
      existingPrompt: "y".repeat(2_000),
      modelContextWindow: 1_200
    });

    expect(result.truncated).toBe(true);
    expect(result.omittedEntryCount).toBeGreaterThan(0);
    expect(result.transcriptText).toContain("Older recovered transcript omitted due to context budget");
    expect(result.transcriptText).toContain("Latest recovered entry truncated to fit context budget");
    expect(result.transcriptText).not.toContain("message 0");
  });
});
