import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConversationHistorySeamCursor,
  MAX_CONVERSATION_PAGE_BYTES,
  MAX_CONVERSATION_PAGE_SCAN_BYTES,
  readConversationHistoryPage,
} from "../session/conversation-page-reader.js";
import { getConversationHistoryCacheFilePath } from "../session/conversation-history-cache.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-conversation-page-"));
  roots.push(root);
  return { root, sessionFile: join(root, "session.jsonl") };
}

function conversationRow(index: number): string {
  return JSON.stringify({
    type: "custom",
    customType: "swarm_conversation_entry",
    id: `row-${index}`,
    parentId: index > 0 ? `row-${index - 1}` : null,
    timestamp: new Date(index * 1000).toISOString(),
    data: {
      type: "conversation_message",
      id: `message-${index}`,
      agentId: "worker",
      role: "assistant",
      text: `message ${index}`,
      timestamp: new Date(index * 1000).toISOString(),
      source: "system",
    },
  });
}

describe("readConversationHistoryPage", () => {
  it("pages canonical custom entries newest-first without gaps or duplicates", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 11 }, (_, index) => conversationRow(index)).join("\n")}\n`);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = readConversationHistoryPage({ sessionFile, cursor, limit: 3, preferCanonical: true });
      expect(page.page.source).toBe("canonical");
      expect(page.page.pageBytes).toBeLessThanOrEqual(MAX_CONVERSATION_PAGE_BYTES);
      expect(page.page.scanBytes).toBeLessThanOrEqual(MAX_CONVERSATION_PAGE_SCAN_BYTES);
      expect(page.messages.every((entry) => entry.timelineEntryId && Number.isSafeInteger(entry.timelineSequence))).toBe(true);
      seen.unshift(...page.messages.map((entry) => entry.type === "conversation_message" ? entry.id! : "unexpected"));
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(Array.from({ length: 11 }, (_, index) => `message-${index}`));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("does not skip the first row rejected by the page byte budget", () => {
    const { sessionFile } = createFixture();
    const rows = Array.from({ length: 12 }, (_, index) => {
      const row = JSON.parse(conversationRow(index)) as { data: Record<string, unknown> };
      row.data.text = `message ${index} ${"x".repeat(30 * 1024)}`;
      return JSON.stringify(row);
    });
    writeFileSync(sessionFile, `${rows.join("\n")}\n`);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = readConversationHistoryPage({ sessionFile, cursor, limit: 100 });
      seen.unshift(...page.messages.map((entry) =>
        entry.type === "conversation_message" ? entry.id ?? "missing" : "unexpected"));
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => `message-${index}`));
    expect(new Set(seen).size).toBe(12);
  });

  it("preserves persisted timeline ordering tokens and backfills only legacy rows", () => {
    const { sessionFile } = createFixture();
    const persisted = JSON.parse(conversationRow(0)) as { data: Record<string, unknown> };
    persisted.data.timelineEntryId = "stable-live-id";
    persisted.data.timelineSequence = 42;
    writeFileSync(sessionFile, `${JSON.stringify(persisted)}\n${conversationRow(1)}\n`);

    const page = readConversationHistoryPage({ sessionFile, limit: 10 });

    expect(page.messages[0]).toMatchObject({
      timelineEntryId: "stable-live-id",
      timelineSequence: 42,
    });
    expect(page.messages[1].timelineEntryId).toBe("row-1");
    expect(page.messages[1].timelineSequence).toBeGreaterThan(0);
  });

  it("never treats a current but incomplete legacy sidecar as terminal history", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${[0, 1, 2].map(conversationRow).join("\n")}\n`);
    const canonicalStat = statSync(sessionFile);
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    writeFileSync(cacheFile, [
      JSON.stringify({
        type: "swarm_conversation_cache_meta",
        version: 4,
        canonicalStat: { size: canonicalStat.size, mtimeMs: canonicalStat.mtimeMs },
      }),
      JSON.stringify({
        type: "conversation_log",
        agentId: "worker",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "runtime_log",
        kind: "tool_execution_end",
        toolName: "bash",
        toolCallId: "legacy-tool",
        text: "done",
      }),
    ].join("\n") + "\n");

    const page = readConversationHistoryPage({ sessionFile, limit: 10 });
    expect(page.page.source).toBe("canonical");
    expect(page.page.hasOlder).toBe(false);
    expect(page.messages).toMatchObject([
      { type: "conversation_message", id: "message-0" },
      { type: "conversation_message", id: "message-1" },
      { type: "conversation_message", id: "message-2" },
    ]);
  });

  it("falls back to canonical history when a legacy sidecar is stale", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${conversationRow(0)}\n`);
    const canonicalStat = statSync(sessionFile);
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    writeFileSync(cacheFile, [
      JSON.stringify({
        type: "swarm_conversation_cache_meta",
        version: 4,
        canonicalStat: { size: canonicalStat.size, mtimeMs: canonicalStat.mtimeMs },
      }),
      JSON.stringify({
        type: "conversation_log",
        agentId: "worker",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "runtime_log",
        kind: "tool_execution_end",
        toolName: "bash",
        toolCallId: "stale-tool",
        text: "stale",
      }),
    ].join("\n") + "\n");

    appendFileSync(sessionFile, `${conversationRow(1)}\n`);
    const page = readConversationHistoryPage({ sessionFile, limit: 10 });

    expect(page.page.source).toBe("canonical");
    expect(page.messages).toMatchObject([
      { type: "conversation_message", id: "message-0" },
      { type: "conversation_message", id: "message-1" },
    ]);
  });

  it("continues the original snapshot when live events append between pages", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 4 }, (_, index) => conversationRow(index)).join("\n")}\n`);
    const first = readConversationHistoryPage({ sessionFile, limit: 2, preferCanonical: true });
    expect(first.page.nextCursor).toBeDefined();

    appendFileSync(sessionFile, `${conversationRow(4)}\n`);
    const second = readConversationHistoryPage({
      sessionFile,
      cursor: first.page.nextCursor,
      limit: 2,
      preferCanonical: true,
    });

    expect(second.page.completeness).toBe("complete");
    expect(second.messages.map((entry) => entry.type === "conversation_message" ? entry.id : "unexpected"))
      .toEqual(["message-0", "message-1"]);
  });

  it("crosses from an active-memory head into older canonical rows without replaying the head", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 6 }, (_, index) => conversationRow(index)).join("\n")}\n`);
    const seam = createConversationHistorySeamCursor(sessionFile, "row-4");

    const page = readConversationHistoryPage({ sessionFile, cursor: seam, limit: 10 });

    expect(page.page.completeness).toBe("complete");
    expect(page.page.hasOlder).toBe(false);
    expect(page.messages.map((entry) => entry.type === "conversation_message" ? entry.id : "unexpected"))
      .toEqual(["message-0", "message-1", "message-2", "message-3"]);
  });

  it("rejects an active-memory seam whose canonical boundary cannot be found", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 3 }, (_, index) => conversationRow(index)).join("\n")}\n`);
    const seam = createConversationHistorySeamCursor(sessionFile, "missing-row");

    const page = readConversationHistoryPage({ sessionFile, cursor: seam, limit: 10 });

    expect(page.messages).toEqual([]);
    expect(page.page.completeness).toBe("source_changed");
  });

  it("reports source_changed instead of silently restarting a replaced source", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 4 }, (_, index) => conversationRow(index)).join("\n")}\n`);
    const first = readConversationHistoryPage({ sessionFile, limit: 2, preferCanonical: true });
    expect(first.page.nextCursor).toBeDefined();

    writeFileSync(sessionFile, `${conversationRow(99)}\n`);
    const stale = readConversationHistoryPage({
      sessionFile,
      cursor: first.page.nextCursor,
      limit: 2,
      preferCanonical: true,
    });

    expect(stale.messages).toEqual([]);
    expect(stale.page.completeness).toBe("source_changed");
  });

  it("reports source_changed for a same-size prefix rewrite that preserves the old tail", () => {
    const { sessionFile } = createFixture();
    const original = `${Array.from({ length: 20 }, (_, index) => conversationRow(index)).join("\n")}\n`;
    writeFileSync(sessionFile, original);
    const originalStat = statSync(sessionFile);
    const first = readConversationHistoryPage({ sessionFile, limit: 2, preferCanonical: true });
    expect(first.page.nextCursor).toBeDefined();

    const rewritten = original.replace("message 0", "changed 0");
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    writeFileSync(sessionFile, rewritten);
    utimesSync(sessionFile, new Date(originalStat.atimeMs), new Date(originalStat.mtimeMs));

    const stale = readConversationHistoryPage({
      sessionFile,
      cursor: first.page.nextCursor,
      limit: 2,
      preferCanonical: true,
    });

    expect(stale.messages).toEqual([]);
    expect(stale.page.completeness).toBe("source_changed");
  });

  it("projects oversized message text and inline attachments instead of dropping the row", () => {
    const { sessionFile } = createFixture();
    const row = JSON.parse(conversationRow(0)) as { data: Record<string, unknown> };
    row.data.text = "x".repeat(300 * 1024);
    row.data.attachments = [{
      type: "binary",
      mimeType: "application/octet-stream",
      fileName: "large.bin",
      data: Buffer.alloc(300 * 1024, 7).toString("base64"),
    }];
    writeFileSync(sessionFile, `${JSON.stringify(row)}\n`);

    const page = readConversationHistoryPage({ sessionFile, limit: 10 });

    expect(page.page.completeness).toBe("complete");
    expect(page.page.hasOlder).toBe(false);
    expect(page.page.pageBytes).toBeLessThanOrEqual(MAX_CONVERSATION_PAGE_BYTES);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      type: "conversation_message",
      id: "message-0",
      attachments: [{
        type: "binary",
        mimeType: "application/octet-stream",
        fileName: "large.bin",
        sizeBytes: 300 * 1024,
      }],
    });
    const message = page.messages[0];
    expect(message.type === "conversation_message" ? message.text : "").toContain("Content truncated in timeline");
    expect(JSON.stringify(page.messages)).not.toContain(Buffer.alloc(64, 7).toString("base64"));
  });

  it("repairs a missing activity summary at read time without exposing raw tool output", () => {
    const { sessionFile } = createFixture();
    const row = JSON.parse(conversationRow(0)) as { data: Record<string, unknown> };
    row.data = {
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "manager",
      timestamp: "2026-01-01T00:00:00.000Z",
      kind: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tool-1",
      text: "SECRET RAW OUTPUT",
    };
    writeFileSync(sessionFile, `${JSON.stringify(row)}\n`);

    const page = readConversationHistoryPage({ sessionFile, limit: 10 });

    expect(page.messages).toMatchObject([{
      type: "activity_summary",
      itemId: "tool:manager:tool-1",
      displaySummary: "Ran command",
    }]);
    expect(JSON.stringify(page.messages)).not.toContain("SECRET RAW OUTPUT");
  });

  it("uses failure-specific copy for a repaired failed activity", () => {
    const { sessionFile } = createFixture();
    const row = JSON.parse(conversationRow(0)) as { data: Record<string, unknown> };
    row.data = {
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "manager",
      timestamp: "2026-01-01T00:00:00.000Z",
      kind: "tool_execution_end",
      toolName: "bash",
      toolCallId: "failed-tool",
      text: "SECRET RAW OUTPUT",
      isError: true,
    };
    writeFileSync(sessionFile, `${JSON.stringify(row)}\n`);

    const page = readConversationHistoryPage({ sessionFile, limit: 10 });

    expect(page.messages).toMatchObject([{
      type: "activity_summary",
      status: "failed",
      displaySummary: "Command failed",
      isError: true,
    }]);
  });

  it("scans past All-only activity to fill a Web-view page with visible transcript", () => {
    const { sessionFile } = createFixture();
    const activityRows = Array.from({ length: 250 }, (_, index) => {
      const row = JSON.parse(conversationRow(index + 1)) as { data: Record<string, unknown> };
      row.data = {
        type: "agent_tool_call",
        agentId: "manager",
        actorAgentId: "manager",
        timestamp: new Date(index + 1).toISOString(),
        kind: "tool_execution_end",
        toolName: "bash",
        toolCallId: `tool-${index}`,
        text: "raw output",
      };
      return JSON.stringify(row);
    });
    writeFileSync(sessionFile, `${conversationRow(0)}\n${activityRows.join("\n")}\n`);

    const page = readConversationHistoryPage({
      sessionFile,
      limit: 1,
      projectionKey: "web",
      isVisible: (entry) => entry.type !== "activity_summary",
    });

    expect(page.messages).toMatchObject([{ type: "conversation_message", id: "message-0" }]);
    expect(page.page.hasOlder).toBe(false);
  });

  it("rejects a cursor when the requested Builder view changes", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${Array.from({ length: 4 }, (_, index) => conversationRow(index)).join("\n")}\n`);
    const first = readConversationHistoryPage({ sessionFile, limit: 2, projectionKey: "web" });

    const changed = readConversationHistoryPage({
      sessionFile,
      cursor: first.page.nextCursor,
      limit: 2,
      projectionKey: "all",
    });

    expect(changed.messages).toEqual([]);
    expect(changed.page.completeness).toBe("source_changed");
  });

  it("crosses a row larger than one scan budget and emits one bounded placeholder", () => {
    const { sessionFile } = createFixture();
    const row = JSON.parse(conversationRow(0)) as { data: Record<string, unknown> };
    row.data.text = "x".repeat(MAX_CONVERSATION_PAGE_SCAN_BYTES + 512 * 1024);
    writeFileSync(sessionFile, `${JSON.stringify(row)}\n`);

    const first = readConversationHistoryPage({ sessionFile, agentId: "worker", limit: 10 });
    expect(first.messages).toEqual([]);
    expect(first.page.completeness).toBe("partial_scan");
    expect(first.page.nextCursor).toBeDefined();
    expect(first.page.scanBytes).toBeLessThanOrEqual(MAX_CONVERSATION_PAGE_SCAN_BYTES);

    const second = readConversationHistoryPage({
      sessionFile,
      agentId: "worker",
      cursor: first.page.nextCursor,
      limit: 10,
    });
    expect(second.page.completeness).toBe("complete");
    expect(second.page.hasOlder).toBe(false);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      type: "conversation_message",
      agentId: "worker",
      role: "system",
      source: "system",
    });
    const placeholder = second.messages[0];
    expect(placeholder.type === "conversation_message" ? placeholder.text : "").toContain("too large to display inline");
  });

  it("does not turn an ordinary row crossing a scan boundary into an oversized placeholder", () => {
    const { sessionFile } = createFixture();
    const fillerLine = `${JSON.stringify({
      type: "message",
      id: "non-conversation-filler",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(900) }],
      },
    })}\n`;
    const fillerCopies = Math.ceil(
      (MAX_CONVERSATION_PAGE_SCAN_BYTES + 512 * 1024) / Buffer.byteLength(fillerLine, "utf8")
    );
    writeFileSync(
      sessionFile,
      `${conversationRow(0)}\n${fillerLine.repeat(fillerCopies)}${conversationRow(1)}\n`
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = readConversationHistoryPage({ sessionFile, cursor, agentId: "worker", limit: 10 });
      for (const entry of page.messages) {
        expect(entry.type === "conversation_message" ? entry.text : "").not.toContain("too large to display inline");
        if (entry.type === "conversation_message" && entry.id) seen.push(entry.id);
      }
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(["message-1", "message-0"]);
  });

  it("reports source_changed instead of restarting at the newest page for an invalid cursor", () => {
    const { sessionFile } = createFixture();
    writeFileSync(sessionFile, `${conversationRow(0)}\n`);

    const stale = readConversationHistoryPage({
      sessionFile,
      cursor: "not-a-valid-cursor",
      limit: 2,
      preferCanonical: true,
    });

    expect(stale.messages).toEqual([]);
    expect(stale.page.completeness).toBe("source_changed");
    expect(stale.page.hasOlder).toBe(true);
  });
});
