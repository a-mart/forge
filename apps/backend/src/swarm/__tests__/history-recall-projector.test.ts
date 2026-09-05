import { describe, expect, it } from "vitest";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { createProjectorState, projectCanonicalLine } from "../history-recall/canonical-projector.js";
import { FORGE_CONTEXT_BOUNDARY_TYPE, INITIAL_WINDOW_ID } from "../history-recall/types.js";

function projectAll(lines: string[]) {
  const state = createProjectorState();
  return lines.flatMap((line, index) => {
    const projected = projectCanonicalLine(line, index * 100, state);
    return projected ? [projected] : [];
  });
}

describe("history recall canonical projector", () => {
  it("covers Forge custom rows and native Pi messages/results/checkpoints while hiding thinking, system, secrets, and binaries", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "header", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        id: "user-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        data: { type: "conversation_message", role: "user", text: "please inspect getUserId in src/auth.ts", timestamp: "2026-01-01T00:00:01.000Z" },
      }),
      JSON.stringify({
        type: "message",
        id: "native-user-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "please inspect getUserId in src/auth.ts" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "native-tool",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth.ts" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "native-result",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "export function getUserId() { return 1 }" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "thinking",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "assistant", content: [{ type: "thinking", text: "hidden chain of thought" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "system",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "system", content: [{ type: "text", text: "SYSTEM: secret instructions" }] },
      }),
      JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        id: "secret-tool",
        timestamp: "2026-01-01T00:00:06.000Z",
        data: {
          type: "agent_tool_call",
          kind: "tool_execution_end",
          toolName: "secure_session_status",
          toolCallId: "secret-1",
          text: "token=super-secret-value",
          timestamp: "2026-01-01T00:00:06.000Z",
        },
      }),
      JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        id: "image-1",
        timestamp: "2026-01-01T00:00:07.000Z",
        data: {
          type: "conversation_message",
          role: "user",
          text: "screenshot attached",
          attachments: [{ type: "image", mimeType: "image/png", data: "aaaa", fileName: "shot.png", fileRef: "artifacts/shot.png" }],
          timestamp: "2026-01-01T00:00:07.000Z",
        },
      }),
      JSON.stringify({ type: "custom", customType: FORGE_CONTEXT_BOUNDARY_TYPE, id: "boundary-1", timestamp: "2026-01-01T00:00:08.000Z" }),
      JSON.stringify({
        type: "compaction",
        id: "compact-fresh",
        timestamp: "2026-01-01T00:00:09.000Z",
        summary: "Fresh window checkpoint",
        firstKeptEntryId: "boundary-1",
        tokensBefore: 99,
        details: { forgeContext: { mode: "fresh" } },
      }),
      JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        id: "after-fresh",
        timestamp: "2026-01-01T00:00:10.000Z",
        data: { type: "conversation_message", role: "user", text: "new context starts here", timestamp: "2026-01-01T00:00:10.000Z" },
      }),
      JSON.stringify({
        type: "compaction",
        id: "compact-summary",
        timestamp: "2026-01-01T00:00:11.000Z",
        summary: "Ordinary compacted branch summary",
        firstKeptEntryId: "after-fresh",
        tokensBefore: 12,
      }),
    ];

    const projected = projectAll(lines);
    expect(projected.map((entry) => entry.entryId)).toEqual([
      "user-1",
      "native-tool",
      "native-result",
      "image-1",
      "compact-fresh",
      "after-fresh",
      "compact-summary",
    ]);
    expect(projected.find((entry) => entry.entryId === "user-1")?.origin).toBe("forge_custom");
    expect(projected.find((entry) => entry.entryId === "native-user-1")).toBeUndefined();
    expect(projected.some((entry) => entry.text.includes("hidden chain of thought"))).toBe(false);
    expect(projected.some((entry) => entry.text.includes("SYSTEM: secret"))).toBe(false);
    expect(projected.some((entry) => entry.text.includes("super-secret-value"))).toBe(false);
    expect(projected.find((entry) => entry.entryId === "image-1")?.text).toContain("artifacts/shot.png");
    expect(projected.find((entry) => entry.entryId === "image-1")?.text).not.toContain("aaaa");
    expect(projected.find((entry) => entry.entryId === "user-1")?.windowId).toBe(INITIAL_WINDOW_ID);
    expect(projected.find((entry) => entry.entryId === "after-fresh")?.windowId).toBe("window:fresh:compact-fresh");
    expect(projected.find((entry) => entry.entryId === "compact-summary")?.kind).toBe("checkpoint");
    expect(projected.find((entry) => entry.entryId === "compact-summary")?.windowId).toBe("window:compact:compact-summary");
    expect(projected.find((entry) => entry.entryId === "compact-summary")?.retainsFromEntryId).toBe("after-fresh");
  });

  it("preserves formatting in read projection while index projection still truncates searchable text", () => {
    const long = `line one\n\nline two ${"x".repeat(40_000)}`;
    const line = JSON.stringify({
      type: "message",
      id: "tool-result",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: long }] },
    });
    const index = projectCanonicalLine(line, 0, createProjectorState(), "index");
    const read = projectCanonicalLine(line, 0, createProjectorState(), "read");
    expect(index?.text.includes("\n")).toBe(false);
    expect(index?.text.length).toBeLessThanOrEqual(32_768);
    expect(read?.text).toBe(long);
    expect(read?.text.startsWith("line one\n\nline two ")).toBe(true);
  });
});
