import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_ENTRY_TYPE,
  ConversationTimeline,
  appendImmediateCustomEntryViaTimeline,
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

  it("tracks persisted entry counts independently from leaf ids", async () => {
    const root = await createTempDir("conversation-timeline-");
    const sessionFile = join(root, "manager.jsonl");
    const timeline = makeTimeline();

    timeline.trackPersistedEntryCount(sessionFile, 1.9);
    timeline.incrementPersistedEntryCount(sessionFile);
    timeline.trackLastSessionEntryId(sessionFile, "leaf-1");

    expect(timeline.getPersistedEntryCount(sessionFile)).toBe(2);
    expect(timeline.getLastSessionEntryId(sessionFile)).toBe("leaf-1");

    timeline.resetSession(sessionFile);
    expect(timeline.getPersistedEntryCount(sessionFile)).toBeUndefined();
    expect(timeline.getLastSessionEntryId(sessionFile)).toBeUndefined();
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
});
