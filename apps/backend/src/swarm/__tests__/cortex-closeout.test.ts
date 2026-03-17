import { describe, expect, it } from "vitest";
import { analyzeLatestCortexCloseoutNeed, normalizeCortexUserVisiblePaths } from "../swarm-manager.js";
import type { AgentMessageEvent, ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

function userEntry(timestamp: string, text = "review this"): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "cortex",
    role: "user",
    text,
    timestamp,
    source: "user_input",
    sourceContext: { channel: "web" }
  };
}

function speakEntry(timestamp: string, text = "done"): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "cortex",
    role: "assistant",
    text,
    timestamp,
    source: "speak_to_user",
    sourceContext: { channel: "web" }
  };
}

function workerEntry(timestamp: string, text = "STATUS: DONE"): AgentMessageEvent {
  return {
    type: "agent_message",
    agentId: "cortex",
    timestamp,
    source: "agent_to_agent",
    fromAgentId: "cortex-worker-1",
    toAgentId: "cortex",
    text
  };
}

describe("normalizeCortexUserVisiblePaths", () => {
  it("converts absolute Unix data paths to relative profile paths", () => {
    expect(
      normalizeCortexUserVisiblePaths(
        "FILES: /Users/testuser/.forge-cortex-memory-v2-migrate/profiles/feature-manager/reference/gotchas.md, /Users/testuser/.forge-cortex-memory-v2-migrate/profiles/feature-manager/sessions/playwright-test/meta.json",
      ),
    ).toBe(
      "FILES: profiles/feature-manager/reference/gotchas.md, profiles/feature-manager/sessions/playwright-test/meta.json",
    )
  })

  it("normalizes Windows-style absolute paths too", () => {
    expect(
      normalizeCortexUserVisiblePaths(
        "FILES: C:\\Users\\testuser\\AppData\\Local\\forge\\profiles\\demo\\reference\\index.md",
      ),
    ).toBe("FILES: profiles/demo/reference/index.md")
  })
})

describe("analyzeLatestCortexCloseoutNeed", () => {
  it("does nothing when no direct user turn exists", () => {
    const history: ConversationEntryEvent[] = [workerEntry("2026-03-16T02:00:05.000Z")];

    expect(analyzeLatestCortexCloseoutNeed(history)).toEqual({ needsReminder: false });
  });

  it("nudges when Cortex finishes a turn without any speak_to_user closeout", () => {
    const history: ConversationEntryEvent[] = [
      userEntry("2026-03-16T02:00:00.000Z"),
      workerEntry("2026-03-16T02:00:10.000Z")
    ];

    expect(analyzeLatestCortexCloseoutNeed(history)).toEqual({
      needsReminder: true,
      userTimestamp: Date.parse("2026-03-16T02:00:00.000Z"),
      reason: "missing_speak_to_user"
    });
  });

  it("nudges when worker progress arrives after the last user-visible update", () => {
    const history: ConversationEntryEvent[] = [
      userEntry("2026-03-16T02:00:00.000Z"),
      speakEntry("2026-03-16T02:00:05.000Z", "starting review"),
      workerEntry("2026-03-16T02:00:20.000Z")
    ];

    expect(analyzeLatestCortexCloseoutNeed(history)).toEqual({
      needsReminder: true,
      userTimestamp: Date.parse("2026-03-16T02:00:00.000Z"),
      reason: "stale_after_worker_progress"
    });
  });

  it("stays quiet after a final speak_to_user closeout", () => {
    const history: ConversationEntryEvent[] = [
      userEntry("2026-03-16T02:00:00.000Z"),
      workerEntry("2026-03-16T02:00:10.000Z"),
      speakEntry("2026-03-16T02:00:30.000Z", "reviewed, no durable updates")
    ];

    expect(analyzeLatestCortexCloseoutNeed(history)).toEqual({
      needsReminder: false,
      userTimestamp: Date.parse("2026-03-16T02:00:00.000Z")
    });
  });

  it("only considers the latest user turn", () => {
    const history: ConversationEntryEvent[] = [
      userEntry("2026-03-16T01:59:00.000Z", "older review"),
      workerEntry("2026-03-16T01:59:10.000Z"),
      speakEntry("2026-03-16T01:59:20.000Z", "older closeout"),
      userEntry("2026-03-16T02:00:00.000Z", "new review"),
      workerEntry("2026-03-16T02:00:10.000Z")
    ];

    expect(analyzeLatestCortexCloseoutNeed(history)).toEqual({
      needsReminder: true,
      userTimestamp: Date.parse("2026-03-16T02:00:00.000Z"),
      reason: "missing_speak_to_user"
    });
  });
});
