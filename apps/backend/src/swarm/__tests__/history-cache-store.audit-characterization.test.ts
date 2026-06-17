import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConversationHistoryCacheFilePath } from "../session/conversation-history-cache.js";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { HistoryCacheStore } from "../session/history-cache-store.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

/**
 * Phase 0 characterization tests for cache atomicity and safe fallback.
 * Skipped until QF-5 lands. Unskip in Phase 1.
 */
describe.skip("audit replay history cache characterization (Phase 0 → Phase 1)", () => {
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
      source: "user_input"
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

  describe("E. truncated/partial cache rejection and safe fallback", () => {
    it("rejects truncated cache payload with valid metadata header", async () => {
      const root = await createTempDir("history-cache-audit-");
      const sessionFile = join(root, "session.jsonl");
      const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
      const store = makeStore();
      const canonicalHistory = [makeMessage("m1"), makeMessage("m2")];
      writeSession(sessionFile, canonicalHistory, root);

      const metadata = store.buildMetadata(canonicalHistory, 2, store.readSessionFileCanonicalStat(sessionFile));
      writeFileSync(
        cacheFile,
        `${JSON.stringify(metadata)}\n${JSON.stringify(makeMessage("m1"))}\n{"type":"conversation_message","agentId":"manager","role":"assistant","id":"m2","text":"partial`,
        "utf8"
      );

      const header = store.loadConversationHistoryCacheHeader(sessionFile);
      expect(header.cacheState).not.toBe("loaded");

      const validation = store.validateCachedConversationHistory(sessionFile, metadata);
      expect(validation.ok).toBe(false);
      expect(validation.entries?.length ?? 0).not.toBe(2);
    });

    it("does not treat zero-byte cache as authoritative empty history when session has persisted entries", async () => {
      const root = await createTempDir("history-cache-audit-");
      const sessionFile = join(root, "session.jsonl");
      const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
      const store = makeStore();
      const canonicalHistory = [makeMessage("m1")];
      writeSession(sessionFile, canonicalHistory, root);
      writeFileSync(cacheFile, "", "utf8");

      const header = store.loadConversationHistoryCacheHeader(sessionFile);
      expect(header.cacheState).toBe("legacy_rebuild");

      const cacheLoad = store.loadConversationHistoryFromCache(sessionFile);
      expect(cacheLoad.cacheState).not.toBe("loaded");
      expect(cacheLoad.cachedHistory?.entries.length ?? -1).not.toBe(0);
    });

    it("ignores in-progress temp cache files and keeps the previous valid cache", async () => {
      const root = await createTempDir("history-cache-audit-");
      const sessionFile = join(root, "session.jsonl");
      const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
      const tempCacheFile = `${cacheFile}.tmp.${process.pid}`;
      const store = makeStore();
      const history = [makeMessage("stable")];
      writeSession(sessionFile, history, root);

      store.queueCacheSnapshotWrite(
        sessionFile,
        history,
        store.buildMetadata(history, 1, store.readSessionFileCanonicalStat(sessionFile))
      );
      await store.flushPendingWrites();

      writeFileSync(tempCacheFile, '{"type":"conversation_message","incomplete":', "utf8");

      const validation = store.validateCachedConversationHistory(
        sessionFile,
        store.loadConversationHistoryCacheHeader(sessionFile).metadata!
      );
      expect(validation.ok).toBe(true);
      expect(validation.entries?.[0]?.type).toBe("conversation_message");
      expect(existsSync(tempCacheFile)).toBe(true);
      expect(readFileSync(cacheFile, "utf8")).toContain('"id":"stable"');
    });
  });
});
