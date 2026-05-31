import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConversationHistoryCacheFilePath } from "../session/conversation-history-cache.js";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { HistoryCacheStore } from "../session/history-cache-store.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

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

function makeStore(): HistoryCacheStore {
  return new HistoryCacheStore({ logDebug: () => undefined });
}

function makeMessage(id: string, text = id): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "manager",
    role: "assistant",
    id,
    text,
    timestamp: FIXED_NOW,
    source: "system"
  };
}

function makeLog(text: string): ConversationEntryEvent {
  return {
    type: "conversation_log",
    agentId: "manager",
    timestamp: FIXED_NOW,
    source: "runtime_log",
    kind: "message_start",
    role: "assistant",
    text
  };
}

function makeWorkPlanCreated(id: string): ConversationEntryEvent {
  return {
    type: "work_plan_created",
    agentId: "manager",
    id,
    timestamp: FIXED_NOW,
    planId: "plan-1",
    stateRevision: 1,
    planRevision: 1,
    plan: {
      planId: "plan-1",
      title: "Cached Work Plan",
      status: "active",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      revision: 1,
      items: [],
      itemCount: 0,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false
    }
  };
}

function sessionHeader(cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "session-id",
    timestamp: FIXED_NOW,
    cwd
  });
}

function sessionConversationEntry(entry: ConversationEntryEvent, wrapperId = entry.type === "conversation_message" ? entry.id : "entry"): string {
  return JSON.stringify({
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    id: wrapperId,
    parentId: null,
    timestamp: FIXED_NOW,
    data: entry
  });
}

function writeSession(sessionFile: string, entries: ConversationEntryEvent[], cwd: string): void {
  writeFileSync(sessionFile, [sessionHeader(cwd), ...entries.map((entry) => sessionConversationEntry(entry))].join("\n") + "\n", "utf8");
}

describe("HistoryCacheStore", () => {
  it("reports an absent cache header without reading from disk", async () => {
    const root = await createTempDir("history-cache-store-");
    const result = makeStore().loadConversationHistoryCacheHeader(join(root, "session.jsonl"));

    expect(result).toMatchObject({
      cacheState: "absent",
      metadata: null,
      fsReadOps: 0,
      fsReadBytes: 0
    });
  });

  it("classifies legacy and invalid cache headers without accepting metadata", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    const store = makeStore();

    writeFileSync(cacheFile, `${JSON.stringify(makeMessage("legacy"))}\n`, "utf8");
    expect(store.loadConversationHistoryCacheHeader(sessionFile)).toMatchObject({
      cacheState: "legacy_rebuild",
      metadata: null,
      detail: "missing_cache_metadata"
    });

    writeFileSync(cacheFile, "{not-json}\n", "utf8");
    expect(store.loadConversationHistoryCacheHeader(sessionFile)).toMatchObject({
      cacheState: "cache_read_error",
      metadata: null,
      detail: "invalid_cache_payload"
    });
  });

  it("validates a matching cache on the fast path", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const store = makeStore();
    const history = [makeMessage("m1"), makeLog("transient")];
    writeSession(sessionFile, [history[0]], root);

    store.queueCacheSnapshotWrite(sessionFile, history, store.buildMetadata(history, 1, store.readSessionFileCanonicalStat(sessionFile)));
    await store.flushPendingWrites();

    const header = store.loadConversationHistoryCacheHeader(sessionFile);
    expect(header.cacheState).toBe("loaded");
    expect(header.metadata).not.toBeNull();

    const validation = store.validateCachedConversationHistory(sessionFile, header.metadata!);
    expect(validation.ok).toBe(true);
    expect(validation.fastPathUsed).toBe(true);
    expect(validation.persistedEntryCount).toBe(1);
    expect(validation.cachedEntryCount).toBe(1);
    expect(validation.entries?.map((entry) => entry.type)).toEqual(["conversation_message", "conversation_log"]);
  });

  it("uses compact stable cache identity for work_plan_created receipts", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const store = makeStore();
    const history = [makeWorkPlanCreated("work-plan-created-1")];
    writeSession(sessionFile, history, root);

    const metadata = store.buildMetadata(history, 1, store.readSessionFileCanonicalStat(sessionFile));
    expect(metadata.firstPersistedEntryKey).toBe("work_plan_created:work-plan-created-1");
    expect(metadata.lastPersistedEntryKey).toBe("work_plan_created:work-plan-created-1");
    expect(metadata.firstPersistedEntryKey).not.toContain("Cached Work Plan");

    store.queueCacheSnapshotWrite(sessionFile, history, metadata);
    await store.flushPendingWrites();

    const header = store.loadConversationHistoryCacheHeader(sessionFile);
    expect(header.metadata?.firstPersistedEntryKey).toBe("work_plan_created:work-plan-created-1");
    const validation = store.validateCachedConversationHistory(sessionFile, header.metadata!);
    expect(validation.ok).toBe(true);
    expect(validation.entries?.[0]?.type).toBe("work_plan_created");
  });

  it("refreshes canonical proof from a summary scan when the session stat changes", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const store = makeStore();
    const cachedHistory = [makeMessage("m1")];
    writeSession(sessionFile, cachedHistory, root);
    store.queueCacheSnapshotWrite(
      sessionFile,
      cachedHistory,
      store.buildMetadata(cachedHistory, 1, store.readSessionFileCanonicalStat(sessionFile))
    );
    await store.flushPendingWrites();

    const staleHeader = store.loadConversationHistoryCacheHeader(sessionFile);
    writeSession(sessionFile, [makeMessage("m1"), makeMessage("m2")], root);

    const validation = store.validateCachedConversationHistory(sessionFile, staleHeader.metadata!);
    expect(validation.ok).toBe(false);
    expect(validation.fastPathUsed).toBe(false);
    expect(validation.persistedEntryCount).toBe(2);
    expect(validation.sessionSummaryBytesScanned).toBeGreaterThan(0);
    expect(validation.cacheState).toBe("cache_missing_persisted_prefix");
  });

  it("rejects cache metadata that does not match cached entries", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    const store = makeStore();
    const canonicalHistory = [makeMessage("m1")];
    const mismatchedHistory = [makeMessage("m2")];
    writeSession(sessionFile, canonicalHistory, root);
    const metadata = store.buildMetadata(canonicalHistory, 1, store.readSessionFileCanonicalStat(sessionFile));
    writeFileSync(cacheFile, `${JSON.stringify(metadata)}\n${JSON.stringify(mismatchedHistory[0])}\n`, "utf8");

    const validation = store.validateCachedConversationHistory(sessionFile, metadata);
    expect(validation.ok).toBe(false);
    expect(validation.cacheState).toBe("metadata_entries_mismatch");
    expect(validation.fastPathUsed).toBe(false);
  });

  it("serializes queued writes, coalesces to the latest snapshot, and deletes on null snapshots", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    const store = makeStore();
    writeSession(sessionFile, [makeMessage("m1")], root);

    store.queueCacheSnapshotWrite(sessionFile, [makeMessage("m1")], store.buildMetadata([makeMessage("m1")], 1, store.readSessionFileCanonicalStat(sessionFile)));
    store.queueCacheSnapshotWrite(sessionFile, [makeMessage("latest")], store.buildMetadata([makeMessage("latest")], 1, store.readSessionFileCanonicalStat(sessionFile)));
    await store.flushPendingWrites();

    const cacheText = readFileSync(cacheFile, "utf8");
    expect(cacheText).toContain('"id":"latest"');
    expect(cacheText).not.toContain('"id":"m1"');

    store.queueCacheSnapshotWrite(sessionFile, null);
    await store.flushPendingWrites();
    expect(existsSync(cacheFile)).toBe(false);
  });

  it("treats cache metadata version 2 as stale after bumping to version 3", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    const store = makeStore();
    const history = [makeMessage("m1")];
    writeSession(sessionFile, history, root);

    const metadata = store.buildMetadata(history, 1, store.readSessionFileCanonicalStat(sessionFile));
    writeFileSync(
      cacheFile,
      `${JSON.stringify({ ...metadata, version: 2 })}\n${JSON.stringify(history[0])}\n`,
      "utf8"
    );

    expect(store.loadConversationHistoryCacheHeader(sessionFile)).toMatchObject({
      cacheState: "legacy_rebuild",
      metadata: null
    });
  });

  it("tracks the persisted-entry cursor separately from cache files", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const store = makeStore();

    store.trackPersistedEntryCount(sessionFile, 1.9);
    store.incrementPersistedEntryCount(sessionFile);
    expect(store.getPersistedEntryCount(sessionFile)).toBe(2);

    store.resetSession(sessionFile);
    expect(store.getPersistedEntryCount(sessionFile)).toBeUndefined();

    store.trackPersistedEntryCount(sessionFile, 3);
    store.clear();
    expect(store.getPersistedEntryCount(sessionFile)).toBeUndefined();
  });

  it("excludes Codex stream detail agent_tool_call rows from disk cache writes and loads", async () => {
    const root = await createTempDir("history-cache-store-");
    const sessionFile = join(root, "session.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    const store = makeStore();
    const persistedMessage = makeMessage("m1");
    const codexToolStart: ConversationEntryEvent = {
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "manager--codex",
      timestamp: FIXED_NOW,
      kind: "tool_execution_start",
      toolName: "codex_command",
      toolCallId: "cmd-1",
      text: '{"command":"echo hi"}',
    };

    writeSession(sessionFile, [persistedMessage], root);
    const history = [persistedMessage, makeLog("runtime"), codexToolStart];
    store.queueCacheSnapshotWrite(
      sessionFile,
      history,
      store.buildMetadata(history, 1, store.readSessionFileCanonicalStat(sessionFile))
    );
    await store.flushPendingWrites();

    const cacheText = readFileSync(cacheFile, "utf8");
    expect(cacheText).toContain('"type":"conversation_log"');
    expect(cacheText).not.toContain('"toolName":"codex_command"');

    const cacheLoad = store.loadConversationHistoryFromCache(sessionFile);
    expect(cacheLoad.cachedHistory?.entries.map((entry) => entry.type)).toEqual([
      "conversation_message",
      "conversation_log"
    ]);
  });
});
