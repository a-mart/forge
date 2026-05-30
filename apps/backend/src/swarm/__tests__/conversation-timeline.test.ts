import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_ENTRY_TYPE,
  ConversationTimeline,
  appendImmediateCustomEntryViaTimeline,
  collectConversationMessageIdsFromSessionFile,
  copySessionHistoryForFork,
  hasValidSessionHeader
} from "../session/conversation-timeline.js";
import type { ConversationMessageEvent } from "../types.js";

const createdDirs: string[] = [];
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function makeTimeline(): ConversationTimeline {
  return new ConversationTimeline({ now: () => FIXED_NOW });
}

function makeMessage(agentId: string, text: string): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId,
    role: "assistant",
    text,
    timestamp: FIXED_NOW,
    source: "system"
  };
}

function buildSessionHeader(cwd: string, id = "session-header"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: FIXED_NOW,
    cwd
  });
}

function buildConversationEntry(id: string, text = id): string {
  return buildConversationMessageEntry({ wrapperId: id, dataId: id, text });
}

function buildConversationMessageEntry(options: { wrapperId?: string; dataId?: string; text?: string }): string {
  const data: Record<string, unknown> = {
    type: "conversation_message",
    agentId: "manager",
    role: "assistant",
    text: options.text ?? options.dataId ?? options.wrapperId,
    timestamp: FIXED_NOW,
    source: "system"
  };

  if (options.dataId !== undefined) {
    data.id = options.dataId;
  }

  return JSON.stringify({
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    ...(options.wrapperId !== undefined ? { id: options.wrapperId } : {}),
    parentId: null,
    timestamp: FIXED_NOW,
    data
  });
}

describe("ConversationTimeline", () => {
  it("creates a missing canonical session file with a header and first conversation entry", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "manager.jsonl");
    const timeline = makeTimeline();
    const event = makeMessage("manager", "hello");

    const result = timeline.appendConversationEntry({ sessionFile, cwd: root }, event);

    expect(result.headerCreated).toBe(true);
    expect(result.parentId).toBeNull();
    expect(event.id).toBe(result.entryId);
    expect(timeline.getLastSessionEntryId(sessionFile)).toBe(result.entryId);

    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "session", version: 3, cwd: root });

    const entry = JSON.parse(lines[1] ?? "{}");
    expect(entry).toMatchObject({
      type: "custom",
      customType: CONVERSATION_ENTRY_TYPE,
      id: result.entryId,
      parentId: null,
      data: { type: "conversation_message", id: result.entryId, text: "hello" }
    });
  });

  it("hydrates the current leaf and chains fallback appends to the last persisted session entry", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(
      sessionFile,
      [
        buildSessionHeader(root),
        JSON.stringify({
          type: "message",
          id: "prior-runtime-entry",
          parentId: null,
          timestamp: FIXED_NOW
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const timeline = makeTimeline();
    timeline.hydrateLeafEntryId({ agentId: "manager", sessionFile });
    const result = timeline.appendConversationEntry({ sessionFile, cwd: root }, makeMessage("manager", "after restart"));

    expect(result.headerCreated).toBe(false);
    expect(result.parentId).toBe("prior-runtime-entry");
    expect(timeline.getLastSessionEntryId(sessionFile)).toBe(result.entryId);

    const appended = JSON.parse(readFileSync(sessionFile, "utf8").trimEnd().split("\n").at(-1) ?? "{}");
    expect(appended.parentId).toBe("prior-runtime-entry");
  });

  it("replaces a non-empty invalid canonical file with a recoverable header before append", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(sessionFile, '{"type":"not-session","id":"bad"}\n', "utf8");

    const result = makeTimeline().appendConversationEntry({ sessionFile, cwd: root }, makeMessage("manager", "recovered"));

    expect(result.headerCreated).toBe(true);
    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "session", cwd: root });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ parentId: null, id: result.entryId });
  });

  it("uses the same append inspection path for immediate custom entries", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(sessionFile, `${buildSessionHeader(root)}\r\n${JSON.stringify({ type: "custom", id: "entry-1" })}`, "utf8");

    const result = await appendImmediateCustomEntryViaTimeline({
      sessionFile,
      cwd: root,
      customType: "swarm_model_change_continuity_request",
      data: { requestId: "req-1" },
      now: () => "2026-01-02T00:00:00.000Z"
    });

    expect(result.headerCreated).toBe(false);
    expect(result.parentId).toBe("entry-1");
    const text = readFileSync(sessionFile, "utf8");
    expect(text).toContain("}\n{");
    const appended = JSON.parse(text.trimEnd().split(/\r?\n/u).at(-1) ?? "{}");
    expect(appended).toMatchObject({
      type: "custom",
      customType: "swarm_model_change_continuity_request",
      parentId: "entry-1",
      data: { requestId: "req-1" }
    });
  });

  it("preserves immediate custom entry directory creation while canonical header validation remains explicit", async () => {
    const root = await createTempDir("conversation-timeline-");
    const nestedSessionFile = join(root, "sessions", "manager.jsonl");

    const result = await appendImmediateCustomEntryViaTimeline({
      sessionFile: nestedSessionFile,
      cwd: root,
      customType: "custom_type",
      now: () => FIXED_NOW
    });

    expect(result.headerCreated).toBe(true);
    expect(hasValidSessionHeader(nestedSessionFile)).toBe(true);

    const directoryPath = join(root, "not-a-file.jsonl");
    mkdirSync(directoryPath, { recursive: true });
    expect(() => makeTimeline().appendConversationEntry({ sessionFile: directoryPath, cwd: root }, makeMessage("manager", "nope"))).toThrow();
  });

  it("copies full session history for forks while preserving malformed, blank, and non-JSON lines", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "nested", "target.jsonl");
    const lines = [
      buildSessionHeader(root),
      buildConversationEntry("message-1"),
      "not-json",
      "",
      JSON.stringify({ type: "message", id: "runtime-entry" }),
      buildConversationEntry("message-2")
    ];
    writeFileSync(sourceSessionFile, `${lines.join("\n")}\n`, "utf8");

    await copySessionHistoryForFork({ sourceSessionFile, targetSessionFile });

    expect(readFileSync(targetSessionFile, "utf8")).toBe(readFileSync(sourceSessionFile, "utf8"));
  });

  it("omits only configured custom entry types when copying fork history", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "target.jsonl");
    writeFileSync(
      sourceSessionFile,
      [
        buildSessionHeader(root),
        JSON.stringify({ type: "custom", customType: "omit_me", id: "runtime-state" }),
        JSON.stringify({ type: "custom", customType: "keep_me", id: "other-custom" }),
        buildConversationEntry("message-1")
      ].join("\n") + "\n",
      "utf8"
    );

    await copySessionHistoryForFork({
      sourceSessionFile,
      targetSessionFile,
      omittedCustomTypes: ["omit_me"]
    });

    const copied = readFileSync(targetSessionFile, "utf8");
    expect(copied).not.toContain("omit_me");
    expect(copied).toContain("keep_me");
    expect(copied).toContain("message-1");
  });

  it("strips externalThreadContext from parent Codex cards when copying fork history", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "target.jsonl");
    const codexCard = {
      type: "custom",
      customType: "swarm_conversation_entry",
      id: "card-1",
      parentId: null,
      timestamp: "2026-05-30T00:00:00.000Z",
      data: {
        type: "conversation_message",
        agentId: "mgr-1",
        role: "system",
        text: "Sent to Codex",
        timestamp: "2026-05-30T00:00:00.000Z",
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: "mgr-1--codex",
          requestId: "req-1",
          turnCorrelationId: "turn-1",
          status: "sent",
          promptPreview: "hello",
          excludeFromModelContext: true,
        },
      },
    };

    writeFileSync(
      sourceSessionFile,
      [buildSessionHeader(root), JSON.stringify(codexCard), buildConversationEntry("message-1")].join("\n") + "\n",
      "utf8"
    );

    await copySessionHistoryForFork({ sourceSessionFile, targetSessionFile });

    const copied = readFileSync(targetSessionFile, "utf8");
    expect(copied).toContain("Sent to Codex");
    expect(copied).not.toContain("externalThreadContext");
    expect(copied).not.toContain("mgr-1--codex");
  });

  it("copies partial fork history through the matching top-level conversation entry id when data.id is absent", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "target.jsonl");
    writeFileSync(
      sourceSessionFile,
      [
        buildSessionHeader(root),
        buildConversationMessageEntry({ wrapperId: "wrapper-1", text: "message-1" }),
        buildConversationMessageEntry({ wrapperId: "wrapper-2", text: "message-2" }),
        buildConversationMessageEntry({ wrapperId: "wrapper-3", text: "message-3" })
      ].join("\n") + "\n",
      "utf8"
    );

    await copySessionHistoryForFork({ sourceSessionFile, targetSessionFile, fromMessageId: "wrapper-2" });

    const copied = readFileSync(targetSessionFile, "utf8").trimEnd().split("\n");
    expect(copied).toHaveLength(3);
    expect(copied.join("\n")).toContain("wrapper-1");
    expect(copied.join("\n")).toContain("wrapper-2");
    expect(copied.join("\n")).not.toContain("wrapper-3");
  });

  it("copies partial fork history through conversation data.id when wrapper id differs", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "target.jsonl");
    writeFileSync(
      sourceSessionFile,
      [
        buildSessionHeader(root),
        buildConversationMessageEntry({ wrapperId: "entry-1", dataId: "message-1" }),
        buildConversationMessageEntry({ wrapperId: "entry-2", dataId: "message-2" }),
        buildConversationMessageEntry({ wrapperId: "entry-3", dataId: "message-3" })
      ].join("\n") + "\n",
      "utf8"
    );

    await copySessionHistoryForFork({ sourceSessionFile, targetSessionFile, fromMessageId: "message-2" });

    const copied = readFileSync(targetSessionFile, "utf8");
    expect(copied).toContain("message-1");
    expect(copied).toContain("message-2");
    expect(copied).not.toContain("message-3");
    expect(copied).toContain("entry-2");
    expect(copied).not.toContain("entry-3");
  });

  it("throws the existing fork error when the requested fork target is absent", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sourceSessionFile = join(root, "source.jsonl");
    const targetSessionFile = join(root, "target.jsonl");
    writeFileSync(sourceSessionFile, `${buildSessionHeader(root)}\n${buildConversationEntry("message-1")}\n`, "utf8");

    await expect(
      copySessionHistoryForFork({ sourceSessionFile, targetSessionFile, fromMessageId: "missing-message" })
    ).rejects.toThrow("Message not found in session history");
  });

  it("writes an empty target for missing source full forks and preserves the missing-target error for partial forks", async () => {
    const root = await createTempDir("conversation-timeline-");
    const missingSourceSessionFile = join(root, "missing-source.jsonl");
    const emptyTargetSessionFile = join(root, "nested", "empty-target.jsonl");

    await copySessionHistoryForFork({ sourceSessionFile: missingSourceSessionFile, targetSessionFile: emptyTargetSessionFile });

    expect(readFileSync(emptyTargetSessionFile, "utf8")).toBe("");

    await expect(
      copySessionHistoryForFork({
        sourceSessionFile: missingSourceSessionFile,
        targetSessionFile: join(root, "partial-target.jsonl"),
        fromMessageId: "missing-message"
      })
    ).rejects.toThrow("Message not found in session history");
  });

  it("collects conversation message ids preferring data.id over distinct wrapper ids", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        buildSessionHeader(root),
        buildConversationMessageEntry({ wrapperId: "entry-1", dataId: "message-1" }),
        buildConversationMessageEntry({ wrapperId: "entry-2", dataId: "message-2" }),
        buildConversationMessageEntry({ wrapperId: "wrapper-only", text: "fallback" }),
        JSON.stringify({ type: "custom", customType: "other", id: "not-a-conversation-message" }),
        "not-json"
      ].join("\n") + "\n",
      "utf8"
    );

    await expect(collectConversationMessageIdsFromSessionFile(join(root, "missing.jsonl"))).resolves.toEqual(new Set());
    await expect(collectConversationMessageIdsFromSessionFile(sessionFile)).resolves.toEqual(new Set(["message-1", "message-2", "wrapper-only"]));
  });
});
