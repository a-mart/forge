import { describe, expect, it } from "vitest";
import {
  __forcePiCompactionMeasurementFallbackForTests,
  __resetPiCompactionMeasurementModuleForTests,
  boundCompactionPreparation,
  serializeMessagesForCompactionMeasurement,
} from "../compaction/forge-pi-compaction-bounds.js";

function createPreparation() {
  return {
    firstKeptEntryId: "entry-keep",
    messagesToSummarize: [
      {
        role: "user" as const,
        content: `User request start\n${"U".repeat(5_000)}\nUser request end`,
        timestamp: 1,
      },
      {
        role: "assistant" as const,
        api: "openai-codex-responses" as const,
        provider: "openai-codex" as const,
        model: "gpt-5.5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        content: [
          { type: "thinking" as const, thinking: `think-${"T".repeat(4_000)}-end` },
          { type: "text" as const, text: `assistant-${"A".repeat(4_000)}-tail` },
          {
            type: "toolCall" as const,
            id: "tool-1",
            name: "write",
            arguments: {
              path: "src/file.ts",
              content: `${"x".repeat(4_000)}RAW_TOOL_SECRET${"y".repeat(4_000)}`,
              imageData: `data:image/png;base64,${"a".repeat(5_000)}`,
              encodedBlob: `${"Ab9+/".repeat(900)}==`,
              archiveData: `QUJDMTIz+/=${"AbC123".repeat(900)}`,
            },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-1",
        toolName: "write",
        content: [{ type: "text" as const, text: `result-${"R".repeat(8_000)}-tail` }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "custom" as const,
        customType: "custom_type",
        content: [{ type: "text" as const, text: `custom-${"C".repeat(6_000)}-tail` }],
        display: true,
        timestamp: 4,
      },
      {
        role: "user" as const,
        content: [{ type: "image" as const, mimeType: "image/png", data: "b".repeat(6_000) }],
        timestamp: 5,
      },
    ],
    turnPrefixMessages: [
      {
        role: "bashExecution" as const,
        command: "npm test",
        output: `bash-${"B".repeat(4_000)}-tail`,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 6,
      },
    ],
    isSplitTurn: true,
    tokensBefore: 100,
    previousSummary: "Preserve this previous summary verbatim.",
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
  };
}

function buildActualHistoryPromptText(messages: Parameters<typeof boundCompactionPreparation>[0]["messagesToSummarize"], customInstructions?: string): string {
  let basePrompt = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  const conversationText = serializeMessagesForCompactionMeasurement(messages);
  return `<conversation>\n${conversationText}\n</conversation>\n\n${basePrompt}`;
}

describe("forge pi compaction bounds", () => {
  it("bounds role-specific block types and preserves identifiers/settings/summary", () => {
    const preparation = createPreparation();

    const result = boundCompactionPreparation(preparation, {
      customInstructions: "Keep pinned instructions intact.",
      maxPromptChars: 4_000,
    });

    expect(result.preparation.firstKeptEntryId).toBe("entry-keep");
    expect(result.preparation.previousSummary).toBe("Preserve this previous summary verbatim.");
    expect(result.preparation.settings).toEqual(preparation.settings);
    expect(result.preparation.fileOps.read).toBeInstanceOf(Set);

    const serialized = JSON.stringify(result.preparation);
    expect(serialized).not.toContain("RAW_TOOL_SECRET");
    expect(serialized).toContain("forge compaction omitted image payload");
    expect(
      serialized.includes("forge compaction truncated tool_call_args")
        || serialized.includes("forge_compaction_aggregate_omission"),
    ).toBe(true);

    const boundedUser = JSON.stringify(result.preparation.messagesToSummarize[0]);
    expect(boundedUser).toContain("User request start");
    expect(boundedUser).toContain("User request end");

    expect(result.stats.categories.user_message.truncatedItems).toBeGreaterThan(0);
    expect(result.stats.categories.custom_message.truncatedItems).toBeGreaterThan(0);
    expect(result.stats.truncationCounts.total).toBeGreaterThan(0);
    expect(result.stats.truncationCounts.messagesToSummarize).toBeGreaterThan(0);
  });

  it("enforces the aggregate serialized prompt cap and reports split-turn counters", () => {
    const preparation = createPreparation();

    const result = boundCompactionPreparation(preparation, {
      customInstructions: "Focus on the newest user intent first.",
      maxPromptChars: 13_000,
    });

    expect(result.stats.promptChars.maxBounded).toBeLessThanOrEqual(13_000);
    expect(result.stats.promptChars.maxOriginal).toBeGreaterThan(result.stats.promptChars.maxBounded);
    expect(result.stats.estimatedTokens.original).toBeGreaterThan(result.stats.estimatedTokens.bounded);
    expect(result.stats.splitTurn).toEqual({
      enabled: true,
      messagesToSummarize: preparation.messagesToSummarize.length,
      turnPrefixMessages: preparation.turnPrefixMessages.length,
    });
    expect(result.stats.truncationCounts.total).toBeGreaterThan(0);
    expect(result.stats.truncationCounts.tiersApplied).toBeGreaterThan(0);
    expect(result.stats.truncationCounts.overBudgetAfterBounding).toBe(false);
  });

  it("reduces many-message histories to a real aggregate prompt cap", () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: Array.from({ length: 500 }, (_, index) => ({
        role: "user" as const,
        content: `message-${index}-start ${"U".repeat(2_000)} message-${index}-end`,
        timestamp: index + 1,
      })),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      previousSummary: "Keep the original goal in mind.",
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
    };

    const result = boundCompactionPreparation(preparation, {
      customInstructions: "Preserve the latest user intent and the recent tail.",
      maxPromptChars: 180_000,
    });

    expect(result.stats.promptChars.maxBounded).toBeLessThanOrEqual(180_000);
    expect(result.stats.truncationCounts.overBudgetAfterBounding).toBe(false);
    expect(JSON.stringify(result.preparation.messagesToSummarize)).toContain("forge_compaction_aggregate_omission");
    expect(JSON.stringify(result.preparation.messagesToSummarize.at(-1))).toContain("message-499-end");
    expect(JSON.stringify(result.preparation.messagesToSummarize[0])).toContain("message-0-start");
  });

  it("matches Pi serialization for many short bashExecution messages under the cap", () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: Array.from({ length: 6_000 }, (_, index) => ({
        role: "bashExecution" as const,
        command: `echo ${index}`,
        output: "ok",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: index + 1,
      })),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
    };

    const result = boundCompactionPreparation(preparation, {
      maxPromptChars: 180_000,
    });

    const actualPrompt = buildActualHistoryPromptText(result.preparation.messagesToSummarize);
    expect(actualPrompt.length).toBeLessThanOrEqual(180_000);
    expect(result.stats.promptChars.maxBounded).toBe(actualPrompt.length);
    expect(result.stats.truncationCounts.overBudgetAfterBounding).toBe(false);
  }, 10_000);

  it("falls back to JSON serialization when Pi measurement modules are unavailable", () => {
    __forcePiCompactionMeasurementFallbackForTests();

    try {
      const messages = [
        {
          role: "user" as const,
          content: "hello from fallback",
          timestamp: 1,
        },
      ];

      const serialized = serializeMessagesForCompactionMeasurement(messages);
      expect(serialized).toContain('"role":"user"');
      expect(serialized).toContain("hello from fallback");

      const preparation = createPreparation();
      const result = boundCompactionPreparation(preparation, {
        maxPromptChars: 4_000,
      });

      expect(result.stats.promptChars.maxBounded).toBeLessThanOrEqual(4_000);
      expect(result.stats.truncationCounts.overBudgetAfterBounding).toBe(false);
    } finally {
      __resetPiCompactionMeasurementModuleForTests();
    }
  });

  it("keeps instrumentation/details redacted with no raw prompt payloads", () => {
    const secret = "VERY_SECRET_BOUNDING_VALUE";
    const preparation = createPreparation();
    preparation.messagesToSummarize.push({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      content: [{ type: "text", text: `${secret}${"z".repeat(5_000)}` }],
      timestamp: 7,
    });

    const result = boundCompactionPreparation(preparation, {
      customInstructions: `${secret}-INSTRUCTIONS`,
      maxPromptChars: 2_400,
    });

    const serializedStats = JSON.stringify(result.stats);
    expect(serializedStats).not.toContain(secret);
    expect(serializedStats).not.toContain(`${secret}-INSTRUCTIONS`);
    expect(serializedStats).toContain("promptChars");
    expect(serializedStats).toContain("base64_payload");
  });
});
