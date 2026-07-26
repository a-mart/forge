import { describe, expect, it, vi } from "vitest";
import { planClaudeResumeRecoveryStart } from "../runtime/claude/claude-resume-recovery-helper.js";
import type { AgentDescriptor, ConversationEntryEvent } from "../types.js";

function createDescriptor(overrides?: Partial<AgentDescriptor>): AgentDescriptor {
  return {
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "claude-sdk",
      modelId: "claude-sonnet-5",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/project/session.jsonl",
    ...overrides
  } as AgentDescriptor;
}

function conversationEntry(options: {
  text: string;
  source?: "user_input" | "speak_to_user";
  timestamp?: string;
}): ConversationEntryEvent {
  return {
    type: "conversation_message",
    agentId: "manager-1",
    role: options.source === "speak_to_user" ? "assistant" : "user",
    text: options.text,
    timestamp: options.timestamp ?? "2026-05-06T00:00:01.000Z",
    source: options.source ?? "user_input"
  } as ConversationEntryEvent;
}

describe("planClaudeResumeRecoveryStart", () => {
  it("builds recovered transcript prompt for missing-persistence recovery and logs metadata", () => {
    const logDebug = vi.fn();

    const plan = planClaudeResumeRecoveryStart({
      descriptor: createDescriptor(),
      durableConversationEntries: [conversationEntry({ text: "Please keep working." })],
      activeSystemPrompt: "Base system prompt",
      hasPinnedContent: true,
      modelContextWindow: 100_000,
      probeResult: { status: "missing", sessionFilePath: "/claude/session.jsonl" },
      reason: "missing_persistence",
      currentGenerationId: 3,
      logDebug
    });

    expect(plan.nextGenerationId).toBe(4);
    expect(plan.persistedRuntimeState).toEqual({ claudeSessionId: null, generationId: 4 });
    expect(plan.systemPromptOverride).toContain("Base system prompt");
    expect(plan.systemPromptOverride).toContain("# Recovered Forge Conversation Context");
    expect(plan.systemPromptOverride).toContain("User: Please keep working.");
    expect(logDebug).toHaveBeenCalledWith(
      "thread_resume:recovery_context",
      expect.objectContaining({
        reason: "missing_persistence",
        probeStatus: "missing",
        sessionFilePath: "/claude/session.jsonl",
        eligibleEntryCount: 1,
        includedEntryCount: 1,
        pendingTurnExcluded: false
      })
    );
  });

  it("builds the same recovered context for resume-failed fallback planning", () => {
    const logDebug = vi.fn();

    const plan = planClaudeResumeRecoveryStart({
      descriptor: createDescriptor(),
      durableConversationEntries: [conversationEntry({ text: "Recover after failed resume." })],
      activeSystemPrompt: "Base system prompt",
      hasPinnedContent: false,
      modelContextWindow: 100_000,
      probeResult: { status: "verified", sessionFilePath: "/claude/session.jsonl" },
      reason: "resume_failed",
      currentGenerationId: 8,
      logDebug
    });

    expect(plan.nextGenerationId).toBe(9);
    expect(plan.persistedRuntimeState).toEqual({ claudeSessionId: null, generationId: 9 });
    expect(plan.systemPromptOverride).toContain("User: Recover after failed resume.");
    expect(logDebug).toHaveBeenCalledWith(
      "thread_resume:recovery_context",
      expect.objectContaining({ reason: "resume_failed", probeStatus: "verified" })
    );
  });

  it("forwards pending-turn exclusion so in-flight turns are not replayed", () => {
    const logDebug = vi.fn();

    const plan = planClaudeResumeRecoveryStart({
      descriptor: createDescriptor(),
      durableConversationEntries: [
        conversationEntry({ text: "Older durable request.", timestamp: "2026-05-06T00:00:01.000Z" }),
        conversationEntry({ text: "In-flight request.", timestamp: "2026-05-06T00:00:02.000Z" })
      ],
      activeSystemPrompt: "Base system prompt",
      pendingTurnExclusion: {
        sourceHint: "user_input",
        text: "In-flight request.",
        attachmentCount: 0,
        imageCount: 0,
        timestamp: "2026-05-06T00:00:02.000Z"
      },
      hasPinnedContent: false,
      modelContextWindow: 100_000,
      probeResult: { status: "missing" },
      reason: "missing_persistence",
      currentGenerationId: 0,
      logDebug
    });

    expect(plan.systemPromptOverride).toContain("User: Older durable request.");
    expect(plan.systemPromptOverride).not.toContain("In-flight request.");
    expect(plan.recoveryContext).toEqual(expect.objectContaining({
      eligibleEntryCount: 2,
      includedEntryCount: 1,
      pendingTurnExcluded: true
    }));
  });

  it("returns no prompt override for empty durable context while still planning generation increment and null state", () => {
    const logDebug = vi.fn();

    const plan = planClaudeResumeRecoveryStart({
      descriptor: createDescriptor(),
      durableConversationEntries: [],
      activeSystemPrompt: "Base system prompt",
      hasPinnedContent: false,
      modelContextWindow: 100_000,
      probeResult: { status: "unknown" },
      reason: "resume_failed",
      currentGenerationId: 2,
      logDebug
    });

    expect(plan.nextGenerationId).toBe(3);
    expect(plan.persistedRuntimeState).toEqual({ claudeSessionId: null, generationId: 3 });
    expect(plan.systemPromptOverride).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      "thread_resume:recovery_context",
      expect.objectContaining({ eligibleEntryCount: 0, includedEntryCount: 0 })
    );
  });

  it("logs recovery-context builder errors and leaves the base prompt unmutated", () => {
    const logDebug = vi.fn();
    const descriptor = createDescriptor();
    Object.defineProperty(descriptor, "role", {
      get() {
        throw new Error("descriptor role unavailable");
      }
    });
    const basePrompt = "Base system prompt";

    const plan = planClaudeResumeRecoveryStart({
      descriptor,
      durableConversationEntries: [conversationEntry({ text: "Will not render." })],
      activeSystemPrompt: basePrompt,
      hasPinnedContent: false,
      modelContextWindow: 100_000,
      probeResult: { status: "missing", sessionFilePath: "/claude/missing.jsonl" },
      reason: "missing_persistence",
      currentGenerationId: 1,
      logDebug
    });

    expect(basePrompt).toBe("Base system prompt");
    expect(plan).toEqual({
      nextGenerationId: 2,
      persistedRuntimeState: { claudeSessionId: null, generationId: 2 }
    });
    expect(logDebug).toHaveBeenCalledWith(
      "thread_resume:recovery_context_error",
      expect.objectContaining({
        reason: "missing_persistence",
        probeStatus: "missing",
        sessionFilePath: "/claude/missing.jsonl",
        error: "descriptor role unavailable"
      })
    );
  });
});
