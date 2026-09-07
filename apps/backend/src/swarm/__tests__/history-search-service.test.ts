import { locateCheckpointEvidence } from "../history-recall/checkpoint-references.js";
import { appendFile, readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { getHistoryRecallIndexPath, getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import * as jsonlReader from "../history-recall/jsonl-reader.js";
import { HistoryRecallIndexStore } from "../history-recall/index-store.js";
import { HistorySearchService } from "../history-recall/history-search-service.js";
import { HistoryRecallError } from "../history-recall/source-catalog.js";
import { FORGE_CONTEXT_BOUNDARY_TYPE } from "../history-recall/types.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const created: HistorySearchService[] = [];

afterEach(async () => {
  while (created.length > 0) {
    await created.pop()?.dispose();
  }
});

describe("HistorySearchService", () => {
  it("bounds idle filesystem probes independently of catalog size", async () => {
    const fx = await createFixture();
    for (let i = 0; i < 1000; i += 1) {
      fx.agents.push(descriptor({ agentId: `idle-${i}`, managerId: `idle-${i}`, role: "manager", profileId: "project-a" }));
    }
    await fx.service.startFromRegistry();
    const needsScan = vi.fn(() => false);
    const store = { listIndexedSourceIds: () => catalogSources(fx, fx.agents).map((source) => source.sourceId), readySourceIds: () => [], purgeSource: vi.fn(), needsScan, reconcileSources: vi.fn() };
    Reflect.get(fx.service, "runBackgroundSlice").call(fx.service, store);
    expect(needsScan.mock.calls.length).toBeGreaterThan(0);
    expect(needsScan.mock.calls.length).toBeLessThanOrEqual(32);
    expect(store.reconcileSources).not.toHaveBeenCalled();
  });
  it("revisits runnable backlog without rotating through a thousand idle sources", async () => {
    const fx = await createFixture();
    for (let i = 0; i < 1000; i++) fx.agents.push(descriptor({ agentId: `idle-${i}`, managerId: `idle-${i}`, role: "manager", profileId: "project-a" }));
    await fx.service.startFromRegistry();
    const source = catalogSources(fx, [fx.session])[0]!;
    const ingestSource = vi.fn(() => ({ scannedBytes: 256_000 }));
    const store = {
      listIndexedSourceIds: () => catalogSources(fx, fx.agents).map((entry) => entry.sourceId),
      readySourceIds: () => [source.sourceId], purgeSource: vi.fn(), needsScan: () => false, ingestSource,
    };
    const slice = Reflect.get(fx.service, "runBackgroundSlice").bind(fx.service);
    expect(slice(store)).toBe(true);
    expect(slice(store)).toBe(true);
    expect(ingestSource).toHaveBeenCalledTimes(2);
    Reflect.get(fx.service, "dirtySourceIds").add("removed:removed");
    store.readySourceIds = () => [];
    expect(slice(store)).toBe(false);
  });

  it("persists runnable tail gaps across restart and clears them on complete ingestion", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      ...Array.from({ length: 80 }, (_, i) => nativeMessage(`large-${i}`, { role: "user", content: "x".repeat(32_000) })),
    ]);
    const path = getHistoryRecallIndexPath(fx.dataDir);
    const source = catalogSources(fx, [fx.session])[0]!;
    let store = await HistoryRecallIndexStore.open(path, async () => Database);
    try {
      store.ingestSource(source, 256_000);
      expect(store.readySourceIds(1)).toEqual([source.sourceId]);
      store.close();
      store = await HistoryRecallIndexStore.open(path, async () => Database);
      expect(store.readySourceIds(1)).toEqual([source.sourceId]);
      for (let i = 0; i < 32 && store.readySourceIds(1).length; i++) store.ingestSource(source, 256_000);
      expect(store.readySourceIds(1)).toEqual([]);
      expect(store.coverageCounts([source.sourceId]).pendingSourceCount).toBe(0);
    } finally { store.close(); }
  });

  it("does not keep an oversized unterminated EOF runnable", async () => {
    const fx = await createFixture();
    const source = catalogSources(fx, [fx.session])[0]!;
    await mkdir(dirname(source.path), { recursive: true });
    await writeFile(source.path, header("/tmp/a") + "\n" + '{"type":"message","text":"' + "x".repeat(1_500_000));
    const store = await HistoryRecallIndexStore.open(getHistoryRecallIndexPath(fx.dataDir), async () => Database);
    try {
      for (let i = 0; i < 32; i++) store.ingestSource(source, 256_000);
      expect(store.readySourceIds(1)).toEqual([]);
      expect(store.needsScan(source)).toBe(false);
    } finally { store.close(); }
  });

  it("rolls back interrupted schema creation and can reopen without manual cache deletion", async () => {
    const fx = await createFixture();
    const path = getHistoryRecallIndexPath(fx.dataDir);
    const original = Database.prototype.exec;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementationOnce(function (this: Database.Database) {
      original.call(this, "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      throw new Error("simulated interrupted schema initialization");
    });
    try {
      await expect(HistoryRecallIndexStore.open(path, async () => Database)).rejects.toThrow("simulated interrupted");
    } finally { failure.mockRestore(); }
    const inspect = new Database(path);
    try {
      expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally { inspect.close(); }
    const recovered = await HistoryRecallIndexStore.open(path, async () => Database);
    try { expect(recovered.readySourceIds(1)).toEqual([]); }
    finally { recovered.close(); }
  });

  it("selects in-catalog ready work before LIMIT without changing omitted partial sources", async () => {
    const fx = await createFixture();
    const excluded = Array.from({ length: 8 }, (_, i) => descriptor({ agentId: `excluded-${i}`, managerId: `excluded-${i}`, role: "manager", profileId: "project-a" }));
    fx.agents.push(...excluded);
    const sources = catalogSources(fx, [...excluded, fx.session]);
    const path = getHistoryRecallIndexPath(fx.dataDir);
    const store = await HistoryRecallIndexStore.open(path, async () => Database);
    try {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;
        await mkdir(dirname(source.path), { recursive: true });
        await writeFile(source.path, header("/tmp/a") + "\n");
        store.ingestSource(source, 256_000);
      }
      const seed = new Database(path);
      try { seed.exec("UPDATE sources SET scan_ready=1, updated_at='2000-01-01'"); }
      finally { seed.close(); }
      const included = sources.at(-1)!;
      expect(store.readySourceIds(8)).not.toContain(included.sourceId);
      fx.service.replaceCatalog({ revision: 1, hydration: "partial", sources: [included] });
      const ingest = vi.spyOn(store, "ingestSource");
      Reflect.get(fx.service, "runBackgroundSlice").call(fx.service, store);
      expect(ingest).toHaveBeenCalledWith(included, expect.any(Number));
      expect(store.readySourceIds(8)).toEqual(sources.slice(0, 8).map((source) => source.sourceId));
    } finally { store.close(); }
  });

  it("isolates an open/read permission failure so another ready source progresses", async () => {
    const fx = await createFixture();
    const sources = catalogSources(fx, [fx.session, fx.worker]);
    const store = await HistoryRecallIndexStore.open(getHistoryRecallIndexPath(fx.dataDir), async () => Database);
    let failure: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (const source of sources) {
        await mkdir(dirname(source.path), { recursive: true });
        await writeFile(source.path, header("/tmp/a") + "\n" + nativeMessage("large", { role: "user", content: "x".repeat(600_000) }) + "\n");
        store.ingestSource(source, 128_000);
      }
      const original = jsonlReader.readSourceGeneration;
      failure = vi.spyOn(jsonlReader, "readSourceGeneration").mockImplementation((path, stat) => {
        if (path === sources[0]!.path) throw Object.assign(new Error("simulated EACCES after stat"), { code: "EACCES" });
        return original(path, stat);
      });
      expect(store.needsScan(sources[0]!)).toBe(true);
      fx.service.replaceCatalog({ revision: 1, hydration: "complete", sources });
      const ingest = vi.spyOn(store, "ingestSource");
      Reflect.get(fx.service, "runBackgroundSlice").call(fx.service, store);
      expect(store.getSourceRow(sources[0]!.sourceId)?.unreadable).toBe(1);
      expect(store.readySourceIds(8)).not.toContain(sources[0]!.sourceId);
      expect(ingest).toHaveBeenCalledWith(sources[1], expect.any(Number));
    } finally { failure?.mockRestore(); store.close(); }
  });

  it("reports missing canonical files as degraded, not permanently building", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a")]);
    await fx.service.start({ revision: 1, hydration: "complete", sources: catalogSources(fx, [fx.session, fx.worker]) });
    await vi.waitFor(async () => {
      const result = await fx.service.sessions(fx.session.agentId, { scope: "project" });
      expect(result.coverage).toMatchObject({ state: "degraded", pendingSourceCount: 0, unreadableSourceCount: 1 });
    });
  });

  it("keeps the bounded recent fast path exact and falls back for older matches", async () => {
    const fx = await createFixture();
    const path = getHistoryRecallIndexPath(fx.dataDir);
    const source = catalogSources(fx, [fx.session])[0]!;
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("old-one", { role: "user", content: "oldneedle" }),
      nativeMessage("old-two", { role: "user", content: "oldneedle" }),
    ]);
    const store = await HistoryRecallIndexStore.open(path, async () => Database);
    try {
      store.ingestSource(source, 256_000);
      // Populate only the derived SQL fixture: these rows exercise the query
      // planner/cohort boundary, not canonical reading or projection.
      const seed = new Database(path);
      try {
        seed.transaction(() => {
          seed.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<65536)
            INSERT INTO entries(source_id,entry_id,kind,role,timestamp,window_id,origin,byte_offset,content_key)
            SELECT ?, 'padding-'||i, 'message','user','2099-01-01T00:00:00.000Z','initial','native',i,'padding' FROM n`).run(source.sourceId);
          seed.exec(`INSERT INTO entry_payload(entry_rowid,text) SELECT id,'padding' FROM entries WHERE entry_id LIKE 'padding-%';
            INSERT INTO entries_fts(rowid,text,extra) SELECT id,'padding','' FROM entries WHERE entry_id LIKE 'padding-%';`);
        })();
      } finally { seed.close(); }
      const params = { sourceIds: [source.sourceId], order: "newest" as const, offset: 0, limit: 501 };
      const recent = store.search({ ...params, ftsMatch: '"padding"' });
      const full = store.search({ ...params, ftsMatch: '"padding"', offset: 1, limit: 500 });
      expect(recent).toHaveLength(501);
      expect(recent.slice(1).map((row) => row.entry_id)).toEqual(full.map((row) => row.entry_id));
      expect(store.search({ ...params, ftsMatch: '"oldneedle"', limit: 1 }).map((row) => row.entry_id)).toEqual(["old-two"]);
      expect(store.search({ ...params, ftsMatch: '"padding"', sourceIds: ["not-in-scope"] })).toEqual([]);
    } finally { store.close(); }
  });

  it("keeps persisted mirror state bounded for a large eligible record", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"), nativeMessage("large-mirror", { role: "user", content: "x".repeat(900_000) })]);
    const source = catalogSources(fx, [fx.session])[0]!;
    const store = await HistoryRecallIndexStore.open(getHistoryRecallIndexPath(fx.dataDir), async () => Database);
    try {
      store.ingestSource(source, 2_000_000);
      for (let i = 0; i < 16 && store.readySourceIds(1).length; i++) store.ingestSource(source, 256_000);
      const state = store.getSourceRow(source.sourceId)!.prefix_projector_json;
      expect(state.length).toBeLessThan(2048);
      expect(state).toMatch(/"textHash":"[a-f0-9]{64}"/);
      expect(state).not.toContain('"text":');
    } finally { store.close(); }
  });

  it("skips an unreadable hit without failing other search results", async () => {
    const fx = await createFixture();
    for (const agent of [fx.session, fx.worker]) await writeTranscript(fx.dataDir, agent, [header("/tmp/a"), nativeMessage("match", { role: "user", content: "sharedneedle" })]);
    const initial = await fx.service.search(fx.session.agentId, { query: "sharedneedle" });
    expect(initial.results).toHaveLength(2);
    const blocked = initial.results.find((hit) => hit.ref.actorAgentId === fx.session.agentId)!;
    const original = jsonlReader.readSourceGeneration;
    const failure = vi.spyOn(jsonlReader, "readSourceGeneration").mockImplementation((path, stat) => {
      if (path === getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId)) throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
      return original(path, stat);
    });
    try {
      const result = await fx.service.search(fx.session.agentId, { query: "sharedneedle" });
      expect(result.results.map((hit) => hit.ref.actorAgentId)).toEqual([fx.worker.agentId]);
      expect(result.complete).toBe(false);
      expect(result.warnings.join(" ")).toContain("unavailable or replaced");
      await expect(fx.service.read(fx.session.agentId, { ref: blocked.ref })).rejects.toThrow(/stale/);
    } finally { failure.mockRestore(); }
  });

  it("reads checkpoint evidence from a cold index with a bounded canonical offset", async () => {
    const fx = await createFixture();
    const text = "tool evidence\n" + "x".repeat(70_000) + "\nlast line";
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      ...Array.from({ length: 60 }, (_, i) => nativeMessage(`old-${i}`, { role: "user", content: "z".repeat(40_000) })),
      nativeMessage("unconsumed-result", { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text }] }),
    ]);
    const found = locateCheckpointEvidence({
      sessionFile: getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId),
      sessionAgentId: fx.session.agentId, actorAgentId: fx.session.agentId, entryIds: ["unconsumed-result"],
    });
    expect(found.missingIds).toEqual([]);
    expect(found.refs).toHaveLength(1);
    const cold = new HistorySearchService({ ...fx.host, loadDatabaseModule: async () => { throw new Error("index unavailable"); } });
    created.push(cold);
    const result = await cold.read(fx.session.agentId, { ref: found.refs[0], offset: 65_000, maxChars: 10_000 });
    expect(result.entry.text).toContain("\nlast line");
    expect(result.entry.ref.byteOffset).toBe(found.refs[0].byteOffset);
    await expect(cold.read(fx.session.agentId, { ref: { ...found.refs[0], byteOffset: found.refs[0].byteOffset! + 1 } })).rejects.toThrow();
    await expect(cold.read(fx.session.agentId, { ref: { ...found.refs[0], entryId: "wrong" } })).rejects.toThrow();
  });

  it("makes catch-up progress beyond the per-query source limit", async () => {
    const fx = await createFixture();
    for (const agent of fx.agents) await writeTranscript(fx.dataDir, agent, [header("/tmp/a")]);
    for (let i = 0; i < 60; i++) {
      const agentId = `bulk-${String(i).padStart(3, "0")}`;
      const agent = descriptor({ agentId, managerId: agentId, role: "manager", profileId: "project-a" });
      fx.agents.push(agent);
      await writeTranscript(fx.dataDir, agent, [header("/tmp/a", agentId), nativeMessage(`entry-${i}`, {
        role: "user", content: [{ type: "text", text: `bulkneedle ${i}` }],
      })]);
    }
    const first = await fx.service.search(fx.session.agentId, { scope: "project", query: "bulkneedle", limit: 50 });
    expect(first.complete).toBe(false);
    const second = await fx.service.search(fx.session.agentId, { scope: "project", query: "bulkneedle", limit: 50 });
    expect(second.complete).toBe(true);
    expect(second.results).toHaveLength(50);
    const tail = await fx.service.search(fx.session.agentId, { scope: "project", query: "bulkneedle", limit: 50, cursor: second.nextCursor });
    expect(tail.results).toHaveLength(10);
  });

  it("ranks phrase and code identifier retrieval across session, project, and explicit outside-project scopes without approval", async () => {
    const fx = await createFixture();
    const service = fx.service;

    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd),
      conversation("old-user", {
        type: "conversation_message",
        role: "user",
        text: "the exact old failure happened in billing",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      nativeMessage("native-old-user", {
        role: "user",
        content: [{ type: "text", text: "the exact old failure happened in billing" }],
      }, "2026-01-01T00:00:01.000Z"),
      nativeMessage("tool-call", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth/getUserId.ts" } }],
      }),
      nativeMessage("tool-result", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "export function getUserId() { return session.userId }" }],
      }),
      conversation("secret-tool", {
        type: "agent_tool_call",
        kind: "tool_execution_end",
        toolName: "request_secret_access",
        toolCallId: "secret-1",
        text: "delivered token=should-never-index",
        timestamp: "2026-01-01T00:00:05.000Z",
      }),
      custom(FORGE_CONTEXT_BOUNDARY_TYPE, "boundary-1", { mode: "fresh" }),
      compaction("fresh-1", "boundary-1", "Fresh window checkpoint", { forgeContext: { mode: "fresh" } }),
      conversation("new-user", {
        type: "conversation_message",
        role: "user",
        text: "continue after fresh window",
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
      compaction("summary-1", "new-user", "Ordinary compacted branch still searchable"),
    ]);
    await writeTranscript(fx.dataDir, fx.worker, [
      header(fx.session.cwd),
      conversation("worker-note", {
        type: "conversation_message",
        role: "assistant",
        text: "worker observed the exact old failure in logs",
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
    ]);
    await writeTranscript(fx.dataDir, fx.otherSession, [
      header("/tmp/other"),
      conversation("project-other", {
        type: "conversation_message",
        role: "user",
        text: "project sibling still has exact old failure notes",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
    ]);
    await writeTranscript(fx.dataDir, fx.outsideSession, [
      header("/tmp/outside"),
      conversation("outside", {
        type: "conversation_message",
        role: "user",
        text: "outside project mentions exact old failure too",
        timestamp: "2026-01-01T00:00:04.000Z",
      }),
    ]);
    await writeTranscript(fx.dataDir, fx.cortex, [
      header("/tmp/cortex"),
      conversation("cortex-secret", {
        type: "conversation_message",
        role: "user",
        text: "exact old failure in cortex review",
        timestamp: "2026-01-01T00:00:04.000Z",
      }),
    ]);

    const phrase = await service.search(fx.worker.agentId, { query: '"exact old failure"' });
    expect(phrase.scope).toBe("session");
    expect(phrase.complete).toBe(true);
    expect(phrase.warnings.join(" ")).toMatch(/current session/i);
    expect(phrase.results.map((hit) => hit.ref.entryId).sort()).toEqual(["old-user", "worker-note"]);
    expect(phrase.results.every((hit) => hit.snippet.includes("exact old failure"))).toBe(true);

    const code = await service.search(fx.session.agentId, { query: "getUserId src/auth/getUserId.ts" });
    expect(code.results.some((hit) => hit.ref.entryId === "tool-call" || hit.ref.entryId === "tool-result")).toBe(true);
    expect(code.results[0]?.score).toBeGreaterThanOrEqual(code.results.at(-1)?.score ?? 0);
    const prefix = await service.search(fx.session.agentId, { query: "getUser*" });
    expect(prefix.results.some((hit) => hit.ref.entryId === "tool-call" || hit.ref.entryId === "tool-result")).toBe(true);

    const project = await service.search(fx.worker.agentId, { query: '"exact old failure"', scope: "project" });
    expect(project.scope).toBe("project");
    expect(project.results.map((hit) => hit.ref.entryId).sort()).toEqual(["old-user", "project-other", "worker-note"]);

    await expect(service.search(fx.worker.agentId, { query: '"exact old failure"', scope: "all_local" }))
      .rejects.toBeInstanceOf(HistoryRecallError);

    const allLocal = await service.search(fx.worker.agentId, {
      query: '"exact old failure"',
      scope: "all_local",
      reason: "compare the same billing failure across local projects",
    });
    expect(allLocal.scope).toBe("all_local");
    expect(allLocal.warnings.join(" ")).toMatch(/Outside-project search reason/);
    expect(allLocal.results.map((hit) => hit.ref.entryId).sort()).toEqual(["old-user", "outside", "project-other", "worker-note"]);
    expect(allLocal.results.some((hit) => hit.ref.entryId === "cortex-secret")).toBe(false);
    expect(allLocal.results.some((hit) => hit.snippet.includes("should-never-index"))).toBe(false);

    const previous = await service.search(fx.session.agentId, { query: "billing", window: "previous" });
    expect(previous.results.some((hit) => hit.ref.entryId === "old-user")).toBe(true);
    expect(previous.results.some((hit) => hit.ref.entryId === "new-user")).toBe(false);

    const oldHit = phrase.results.find((hit) => hit.ref.entryId === "old-user");
    expect(oldHit).toBeTruthy();
    const read = await service.read(fx.worker.agentId, { ref: oldHit!.ref, before: 0, after: 1, maxChars: 80 });
    expect(read.entry.text).toContain("exact old failure");
    expect(read.entry.ref.sourceVersion).toBe(oldHit!.ref.sourceVersion);
    expect(read.after.length).toBeGreaterThan(0);

    const checkpoint = await service.search(fx.session.agentId, { query: '"Ordinary compacted branch still searchable"' });
    expect(checkpoint.results.some((hit) => hit.kind === "checkpoint")).toBe(true);
  });

  it("rebuilds after restart, purges truncated/replaced/cleared/deleted sources, and keeps forks from colliding", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "gen-1"),
      conversation("keep-me", {
        type: "conversation_message",
        role: "user",
        text: "recoverable requirement alpha",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const first = await fx.service.search(fx.session.agentId, { query: "alpha" });
    expect(first.results.map((hit) => hit.ref.entryId)).toEqual(["keep-me"]);
    const staleRef = first.results[0]!.ref;
    await fx.service.dispose();

    const restarted = createService(fx);
    const afterRestart = await restarted.search(fx.session.agentId, { query: "alpha" });
    expect(afterRestart.results.map((hit) => hit.ref.entryId)).toEqual(["keep-me"]);

    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "gen-2"),
      conversation("replacement", {
        type: "conversation_message",
        role: "user",
        text: "unrelated replacement row alpha",
        timestamp: "2026-01-01T00:10:00.000Z",
      }),
    ]);
    const replaced = await restarted.search(fx.session.agentId, { query: "alpha" });
    expect(replaced.results.map((hit) => hit.ref.entryId)).toEqual(["replacement"]);
    await expect(restarted.read(fx.session.agentId, { ref: staleRef })).rejects.toBeInstanceOf(HistoryRecallError);

    await writeTranscript(fx.dataDir, fx.session, [header(fx.session.cwd, "gen-2")]);
    const cleared = await restarted.search(fx.session.agentId, { query: "alpha" });
    expect(cleared.results).toEqual([]);

    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "gen-3"),
      conversation("live", {
        type: "conversation_message",
        role: "user",
        text: "fork source alpha",
        timestamp: "2026-01-01T00:20:00.000Z",
      }),
    ]);
    await writeTranscript(fx.dataDir, fx.fork, [
      header(fx.session.cwd, "fork-gen"),
      conversation("live", {
        type: "conversation_message",
        role: "user",
        text: "fork copy should not collide alpha",
        timestamp: "2026-01-01T00:20:00.000Z",
      }),
    ]);
    const forked = await restarted.search(fx.session.agentId, { query: "alpha", scope: "project" });
    expect(forked.results).toHaveLength(2);
    expect(new Set(forked.results.map((hit) => hit.ref.sessionAgentId))).toEqual(new Set([fx.session.agentId, fx.fork.agentId]));

    fx.agents.splice(fx.agents.findIndex((agent) => agent.agentId === fx.otherSession.agentId), 1);
    await restarted.invalidateSession(fx.otherSession.agentId);
    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "gen-3"),
      conversation("live", {
        type: "conversation_message",
        role: "user",
        text: "fork source alpha",
        timestamp: "2026-01-01T00:20:00.000Z",
      }),
    ]);
    const afterDelete = await restarted.search(fx.session.agentId, { query: '"project sibling"', scope: "project" });
    expect(afterDelete.results).toEqual([]);
  });

  it("indexes only complete JSONL lines and reports incomplete coverage for a truncated tail", async () => {
    const fx = await createFixture();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${header(fx.session.cwd)}\n${conversation("complete", {
        type: "conversation_message",
        role: "user",
        text: "complete searchable line",
        timestamp: "2026-01-01T00:00:01.000Z",
      })}\n{"type":"custom","customType":"${CONVERSATION_ENTRY_TYPE}","id":"partial"`,
      "utf8",
    );
    const result = await fx.service.search(fx.session.agentId, { query: "complete searchable" });
    expect(result.results.map((hit) => hit.ref.entryId)).toEqual(["complete"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/incomplete/i);
  });

  it("keeps window filters source-qualified across ordinary compaction retained tails", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "session-header"),
      conversation("old-a", {
        type: "conversation_message",
        role: "user",
        text: "alpha in the first window",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      conversation("kept-a", {
        type: "conversation_message",
        role: "user",
        text: "alpha retained into ordinary compaction",
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
      compaction("compact-a", "kept-a", "Ordinary compaction A still has alpha"),
      conversation("new-a", {
        type: "conversation_message",
        role: "user",
        text: "alpha after ordinary compaction",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
    ]);
    await writeTranscript(fx.dataDir, fx.worker, [
      header(fx.session.cwd, "worker-header"),
      conversation("worker-current", {
        type: "conversation_message",
        role: "assistant",
        text: "alpha still in the worker current window",
        timestamp: "2026-01-01T00:00:04.000Z",
      }),
    ]);

    const previous = await fx.service.search(fx.session.agentId, { query: "alpha", window: "previous" });
    expect(previous.results.map((hit) => hit.ref.entryId).sort()).toEqual(["old-a"]);
    const current = await fx.service.search(fx.session.agentId, { query: "alpha", window: "current" });
    expect(current.results.map((hit) => hit.ref.entryId).sort()).toEqual(["compact-a", "kept-a", "new-a", "worker-current"]);
    expect(current.results.find((hit) => hit.ref.entryId === "worker-current")?.windowId).toBe("window:initial");
    expect(current.results.find((hit) => hit.ref.entryId === "new-a")?.windowId).toBe("window:compact:compact-a");
  });

  it("pages original long tool evidence beyond the index cap and bounds neighbor bytes", async () => {
    const fx = await createFixture();
    const marker = "sentinelEvidence99";
    const long = `${"head\n".repeat(10)}${marker}\n${"x".repeat(40_000)}${"\ntail".repeat(5)}`;
    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd),
      nativeMessage("tool-result", {
        role: "toolResult",
        toolCallId: "call-long",
        toolName: "read",
        content: [{ type: "text", text: long }],
      }),
      conversation("neighbor", {
        type: "conversation_message",
        role: "user",
        text: "neighbor after long result",
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
    ]);
    const hits = await fx.service.search(fx.session.agentId, { query: marker });
    expect(hits.results[0]?.ref.entryId).toBe("tool-result");
    const first = await fx.service.read(fx.session.agentId, {
      ref: hits.results[0]!.ref,
      maxChars: 20_000,
      after: 1,
    });
    expect(first.entry.totalChars).toBe(long.length);
    expect(first.entry.text.startsWith("head\n")).toBe(true);
    expect(first.entry.nextOffset).toBeGreaterThan(0);
    const continued = await fx.service.read(fx.session.agentId, {
      ref: hits.results[0]!.ref,
      offset: first.entry.nextOffset,
      maxChars: 20_000,
    });
    expect(continued.entry.text).toContain("x".repeat(100));
    expect(first.entry.text.length + (first.after[0]?.text.length ?? 0)).toBeLessThanOrEqual(20_000);
  });

  it("rejects same-header replacement before refreshing the index and awaits invalidation", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "same-header"),
      conversation("original", {
        type: "conversation_message",
        role: "user",
        text: "original alpha body",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const first = await fx.service.search(fx.session.agentId, { query: "alpha" });
    const staleRef = first.results[0]!.ref;
    expect(staleRef.entryId).toBe("original");

    await writeTranscript(fx.dataDir, fx.session, [
      header(fx.session.cwd, "same-header"),
      conversation("replacement", {
        type: "conversation_message",
        role: "user",
        text: "replacement alpha body",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    await expect(fx.service.read(fx.session.agentId, { ref: staleRef })).rejects.toBeInstanceOf(HistoryRecallError);
    const replaced = await fx.service.search(fx.session.agentId, { query: "alpha" });
    expect(replaced.results.map((hit) => hit.ref.entryId)).toEqual(["replacement"]);
    expect(replaced.results[0]?.ref.sourceVersion).not.toBe(staleRef.sourceVersion);

    await writeTranscript(fx.dataDir, fx.otherSession, [
      header("/tmp/other", "other-header"),
      conversation("gone", {
        type: "conversation_message",
        role: "user",
        text: "project sibling still has exact old failure notes",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
    ]);
    await fx.service.search(fx.session.agentId, { query: "failure", scope: "project" });
    fx.agents.splice(fx.agents.findIndex((agent) => agent.agentId === fx.otherSession.agentId), 1);
    await fx.service.invalidateSession(fx.otherSession.agentId);
    const afterInvalidate = await fx.service.search(fx.session.agentId, { query: '"project sibling"', scope: "project" });
    expect(afterInvalidate.results).toEqual([]);
  });

  it("indexes a valid 500KiB row that exceeds a 256KiB scan batch and then becomes ready", async () => {
    const fx = await createFixture();
    const marker = "fivehundredkibneedle";
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      nativeMessage("midsize", { role: "user", content: `${marker} ${"m".repeat(500_000)}` }),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    await waitFor(async () => {
      const result = await fx.service.search(fx.session.agentId, { query: marker });
      return result.results.some((hit) => hit.ref.entryId === "midsize") && result.coverage?.state === "ready";
    }, 4_000);
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await appendFile(path, nativeMessage("suffix-midsize", {
      role: "assistant",
      content: `suffix${marker} ${"s".repeat(500_000)}`,
    }) + "\n");
    await waitFor(async () => {
      const result = await fx.service.search(fx.session.agentId, { query: `suffix${marker}` });
      return result.results.some((hit) => hit.ref.entryId === "suffix-midsize") && result.coverage?.state === "ready";
    }, 4_000);
  });

  it("skips oversized JSONL rows without treating coverage as complete", async () => {
    const fx = await createFixture();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await mkdir(dirname(path), { recursive: true });
    const oversized = `{"type":"message","id":"huge","message":{"role":"user","content":[{"type":"text","text":"${"y".repeat(1_200_000)}"}]}}`;
    await writeFile(
      path,
      `${header(fx.session.cwd)}\n${conversation("complete", {
        type: "conversation_message",
        role: "user",
        text: "complete searchable line",
        timestamp: "2026-01-01T00:00:01.000Z",
      })}\n${oversized}\n${conversation("after-huge", {
        type: "conversation_message",
        role: "user",
        text: "after oversized row",
        timestamp: "2026-01-01T00:00:02.000Z",
      })}\n`,
      "utf8",
    );
    const result = await fx.service.search(fx.session.agentId, { query: "complete searchable" });
    expect(result.results.map((hit) => hit.ref.entryId)).toEqual(["complete"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/oversized|incomplete/i);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    await waitFor(async () => {
      const later = await fx.service.search(fx.session.agentId, { query: "after oversized row" });
      return later.results.some((hit) => hit.ref.entryId === "after-huge")
        && later.coverage?.state === "degraded"
        && later.coverage?.omittedEligibleText === true;
    }, 4_000);
  });
  it("resumes oversized skipping after restart, retrieves trailing evidence, and retains coverage warnings", async () => {
    const fx = await createFixture();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("first", { role: "user", content: "stable first row" }),
      nativeMessage("huge", { role: "user", content: "x".repeat(3_200_000) }),
      nativeMessage("target", { role: "user", content: "trailingneedle" }),
    ]);
    let service = fx.service;
    let found = false;
    let previousOffset = 0;
    for (let i = 0; i < 8; i++) {
      await appendFile(path, nativeMessage(`append-${i}`, { role: "user", content: `active ${i}` }) + "\n");
      const response = await service.search(fx.session.agentId, { query: "trailingneedle" });
      const db = new Database(getHistoryRecallIndexPath(fx.dataDir), { readonly: true });
      const state = db.prepare("SELECT indexed_bytes, oversized_state FROM sources").get() as { indexed_bytes: number; oversized_state: number };
      db.close();
      expect(state.indexed_bytes).toBeGreaterThan(previousOffset);
      previousOffset = state.indexed_bytes;
      if (response.results.length) {
        expect((await service.read(fx.session.agentId, { ref: response.results[0].ref })).entry.text).toBe("trailingneedle");
        found = true;
        break;
      }
      await service.dispose();
      service = createService(fx);
    }
    expect(found).toBe(true);
    await service.dispose();
    service = createService(fx);
    const warm = await service.search(fx.session.agentId, { query: "trailingneedle" });
    expect(warm.results).toHaveLength(1);
    expect(warm.complete).toBe(false);
    expect(warm.warnings.join(" ")).toMatch(/skipped oversized/);
    await service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    await waitFor(async () => {
      const settled = await service.search(fx.session.agentId, { query: "trailingneedle" });
      return settled.coverage?.state === "degraded" && settled.coverage?.omittedEligibleText === true;
    }, 4_000);
  });

  it("keeps repeated messages and identical checkpoints searchable across windows and restarts", async () => {
    const fx = await createFixture();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("old", { role: "user", content: "repeatedneedle" }),
      compaction("fresh1", "anchor1", "repeated checkpoint", { forgeContext: { mode: "fresh" } }),
    ]);
    await fx.service.search(fx.session.agentId, { query: "repeatedneedle" });
    await fx.service.dispose();
    const service = createService(fx);
    await appendFile(path, [
      nativeMessage("new", { role: "user", content: "repeatedneedle" }, "2026-01-02T00:00:00.000Z"),
      compaction("fresh2", "anchor2", "repeated checkpoint", { forgeContext: { mode: "fresh" } }),
      nativeMessage("newest", { role: "user", content: "repeatedneedle" }, "2026-01-03T00:00:00.000Z"),
    ].join("\n") + "\n");
    const all = await service.search(fx.session.agentId, { query: "repeatedneedle" });
    expect(all.results.map(hit => hit.ref.entryId).sort()).toEqual(["new", "newest", "old"]);
    const current = await service.search(fx.session.agentId, { query: "repeatedneedle", window: "current" });
    expect(current.results.map(hit => hit.ref.entryId)).toEqual(["newest"]);
    const dated = await service.search(fx.session.agentId, { query: "repeatedneedle", since: "2026-01-02T00:00:00.000Z" });
    expect(dated.results).toHaveLength(2);
    const checkpoints = await service.search(fx.session.agentId, { query: '"repeated checkpoint"', kinds: ["checkpoint"] });
    expect(checkpoints.results.map(hit => hit.ref.entryId).sort()).toEqual(["fresh1", "fresh2"]);
    for (const hit of [...all.results, ...checkpoints.results]) {
      expect((await service.read(fx.session.agentId, { ref: hit.ref })).entry.ref.entryId).toBe(hit.ref.entryId);
    }
  });

  it("yields to pending I/O between queued history operations", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("first", { role: "user", content: "fairnessneedle" }),
    ]);
    await fx.service.search(fx.session.agentId, { query: "fairnessneedle" });
    const order: string[] = [];
    const reconcile = HistoryRecallIndexStore.prototype.reconcileSources;
    const spy = vi.spyOn(HistoryRecallIndexStore.prototype, "reconcileSources").mockImplementation(function (...args) {
      order.push(order.length === 0 ? "first" : "second");
      if (order.length === 1) setImmediate(() => order.push("io"));
      return reconcile.apply(this, args);
    });
    try {
      await Promise.all([
        fx.service.search(fx.session.agentId, { query: "fairnessneedle" }),
        fx.service.search(fx.session.agentId, { query: "fairnessneedle" }),
      ]);
      expect(order).toEqual(["first", "io", "second"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rebuilds legacy FTS rowids and preserves append, restart, and purge behavior", async () => {
    const fx = await createFixture();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("first", { role: "user", content: "rowidneedle original" }),
      nativeMessage("second", { role: "user", content: "rowidneedle second" }),
    ]);
    const first = await fx.service.search(fx.session.agentId, { query: "rowidneedle" });
    await fx.service.dispose();
    const canonical = await readFile(path, "utf8");
    const dbPath = getHistoryRecallIndexPath(fx.dataDir);
    const legacy = new Database(dbPath);
    legacy.exec(`DROP TABLE entries_fts;
      CREATE VIRTUAL TABLE entries_fts USING fts5(text,extra,source_id UNINDEXED,entry_id UNINDEXED);
      INSERT INTO entries_fts(rowid,text,extra,source_id,entry_id)
        SELECT e.id+1000,p.text,'',e.source_id,e.entry_id FROM entries e JOIN entry_payload p ON p.entry_rowid=e.id;
      UPDATE meta SET value='3' WHERE key='projection_version';`);
    legacy.close();

    const service = createService(fx);
    const restored = await service.search(fx.session.agentId, { query: "rowidneedle" });
    expect(restored.results.map(hit => hit.ref)).toEqual(first.results.map(hit => hit.ref));
    expect(await readFile(path, "utf8")).toBe(canonical);
    await appendFile(path, nativeMessage("third", { role: "user", content: "rowidneedle appended" }) + "\n");
    expect((await service.search(fx.session.agentId, { query: "rowidneedle" })).results).toHaveLength(3);
    await service.dispose();

    const db = new Database(dbPath);
    const mismatched = db.prepare(`SELECT count(*) AS n FROM (
      SELECT id FROM entries EXCEPT SELECT rowid FROM entries_fts
    )`).get() as { n: number };
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')");
    expect(db.prepare("SELECT count(*) AS n FROM entries").get()).toEqual(db.prepare("SELECT count(*) AS n FROM entries_fts").get());
    expect(db.prepare("SELECT count(*) AS n FROM entries").get()).toEqual(db.prepare("SELECT count(*) AS n FROM entry_payload").get());
    expect(mismatched.n).toBe(0);
    // A constrained FTS rowid lookup is essential: UNINDEXED metadata predicates
    // otherwise scan every cached document on each insertion.
    const plan = db.prepare(`EXPLAIN QUERY PLAN DELETE FROM entries_fts WHERE rowid = (
      SELECT rowid FROM entries WHERE source_id = ? AND entry_id = ?
    )`).all("source", "entry") as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes("VIRTUAL TABLE INDEX 0:="))).toBe(true);
    db.close();

    const reopened = createService(fx);
    expect((await reopened.search(fx.session.agentId, { query: "rowidneedle" })).results).toHaveLength(3);
    await reopened.invalidateSession(fx.session.agentId);
    const purged = new Database(dbPath);
    expect(purged.prepare("SELECT count(*) AS n FROM entries_fts").get()).toEqual({ n: 0 });
    purged.close();
    expect((await reopened.search(fx.session.agentId, { query: "rowidneedle" })).results).toHaveLength(3);
  });

  it("rebuilds legacy derived projections once without modifying canonical history or invalidating refs", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("old", { role: "user", content: "migrationneedle" }),
      nativeMessage("later", { role: "user", content: "migrationneedle" }),
    ]);
    const first = await fx.service.search(fx.session.agentId, { query: "migrationneedle" });
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    const canonical = await readFile(path, "utf8");
    await fx.service.dispose();
    const db = new Database(getHistoryRecallIndexPath(fx.dataDir));
    // Model the old cache: no version/oversized state and later occurrence omitted.
    db.exec("DELETE FROM meta; DELETE FROM entries_fts WHERE rowid IN (SELECT id FROM entries WHERE entry_id='later'); DELETE FROM entries WHERE entry_id='later'; ALTER TABLE sources DROP COLUMN oversized_state;");
    db.close();
    const service = createService(fx);
    const restored = await service.search(fx.session.agentId, { query: "migrationneedle" });
    expect(restored.results).toHaveLength(2);
    expect((await service.read(fx.session.agentId, { ref: first.results.find(hit => hit.ref.entryId === "old")!.ref })).entry.text).toBe("migrationneedle");
    expect(await readFile(path, "utf8")).toBe(canonical);
    await service.dispose();
    const reopened = createService(fx);
    expect((await reopened.search(fx.session.agentId, { query: "migrationneedle" })).results).toHaveLength(2);
  });

  it("exposes a cold recent suffix before the archival prefix and reports honest coverage", async () => {
    const fx = await createFixture();
    const old = Array.from({ length: 4_000 }, (_, i) => nativeMessage(`old-${i}`, {
      role: "user",
      content: `archive filler ${i} ${"z".repeat(280)}`,
    }));
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      ...old,
      nativeMessage("recent-status", {
        role: "assistant",
        content: [{ type: "text", text: "september mobile launch is live" }],
      }, "2026-09-01T00:00:00.000Z"),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    const cold = await fx.service.search(fx.session.agentId, { query: "september mobile launch", order: "newest" });
    expect(cold.results.some((hit) => hit.ref.entryId === "recent-status")).toBe(true);
    expect(cold.coverage?.state === "building" || cold.complete === false).toBe(true);
    expect(cold.coverage?.eligibleSourceCount).toBe(1);
  });

  it("indexes a dirty append without another search driving catch-up and keeps newest chronological", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      nativeMessage("old-mobile", { role: "user", content: "mobile notes from march" }, "2026-03-01T00:00:00.000Z"),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session, fx.otherSession]),
    });
    await fx.service.search(fx.session.agentId, { query: "mobile" });
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await appendFile(path, nativeMessage("new-mobile", {
      role: "assistant",
      content: [{ type: "text", text: "mobile launch landed in september" }],
    }, "2026-09-01T00:00:00.000Z") + "\n");
    fx.service.markSourceDirty({ sessionAgentId: fx.session.agentId, actorAgentId: fx.session.agentId });
    const newest = await fx.service.search(fx.session.agentId, { query: "mobile", order: "newest" });
    expect(newest.results[0]?.ref.entryId).toBe("new-mobile");
    expect(newest.results.map((hit) => hit.ref.entryId)).toContain("old-mobile");
  });

  it("keeps suffix projection provisional until bounded replay matches a clean forward index", async () => {
    const fx = await createFixture();
    const filler = Array.from({ length: 3_000 }, (_, i) => nativeMessage(`pad-${i}`, {
      role: "user",
      content: `padding ${i} ${"y".repeat(200)}`,
    }));
    const nativeMirror = nativeMessage("seam-native", { role: "user", content: "seam repeated evidence" }, "2026-01-01T00:00:01.000Z");
    const customMirror = conversation("seam-custom", {
      type: "conversation_message",
      role: "user",
      text: "seam repeated evidence",
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"), ...filler, nativeMirror, customMirror]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    let converged = await fx.service.search(fx.session.agentId, { query: '"seam repeated evidence"' });
    expect(converged.results.length).toBeGreaterThan(0);
    for (let i = 0; i < 16 && converged.coverage?.state !== "ready"; i += 1) {
      converged = await fx.service.search(fx.session.agentId, { query: '"seam repeated evidence"' });
    }
    expect(converged.results.map((hit) => hit.ref.entryId).sort()).toEqual(["seam-custom"]);
    expect(converged.results.every((hit) => !hit.provisional)).toBe(true);
    await fx.service.dispose();
    const fresh = createService(fx);
    await writeTranscript(fx.dataDir, fx.otherSession, [header("/tmp/a2"), nativeMirror, customMirror]);
    const forward = await fresh.search(fx.otherSession.agentId, { query: '"seam repeated evidence"' });
    expect(converged.results.map((hit) => hit.ref.entryId).sort()).toEqual(forward.results.map((hit) => hit.ref.entryId).sort());
  });

  it("returns a complete multipart row for a legacy no-part read and validates qualified parts", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("mixed", {
        role: "assistant",
        content: [
          { type: "text", text: "decision: inspect billing" },
          { type: "toolCall", id: "call-a", name: "read", arguments: { path: "src/a.ts" } },
          { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "rg billing" } },
        ],
      }),
    ]);
    const hits = await fx.service.search(fx.session.agentId, { query: "billing" });
    expect(hits.results.some((hit) => hit.ref.entryId === "mixed")).toBe(true);
    const anyHit = hits.results.find((hit) => hit.ref.entryId === "mixed")!;
    const legacy = await fx.service.read(fx.session.agentId, {
      ref: { ...anyHit.ref, partId: undefined, chunkIndex: undefined },
    });
    expect(legacy.entry.text).toContain("decision: inspect billing");
    expect(legacy.entry.text).toContain("src/a.ts");
    expect(legacy.entry.text).toContain("rg billing");
    expect(legacy.entry.totalChars).toBe(legacy.entry.text.length);
    const partHit = hits.results.find((hit) => hit.ref.partId === "toolCall:call-b");
    if (partHit) {
      const part = await fx.service.read(fx.session.agentId, { ref: partHit.ref });
      expect(part.entry.text).toContain("rg billing");
      expect(part.entry.text).not.toContain("decision: inspect billing");
    }
    await expect(fx.service.read(fx.session.agentId, {
      ref: { ...anyHit.ref, partId: "toolCall:missing" },
    })).rejects.toBeInstanceOf(HistoryRecallError);
  });

  it("pages a stable snapshot while appends continue and suppresses history artifacts by default", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      ...Array.from({ length: 12 }, (_, i) => nativeMessage(`hit-${i}`, {
        role: "user",
        content: `stablepaging ${i}`,
      }, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`)),
      nativeMessage("history-echo", {
        role: "toolResult",
        toolCallId: "hist-1",
        toolName: "history",
        content: [{ type: "text", text: "stablepaging copied into a history tool result" }],
      }),
    ]);
    const first = await fx.service.search(fx.session.agentId, { query: "stablepaging", limit: 5, order: "newest" });
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.results.length).toBeLessThanOrEqual(5);
    expect(first.results.some((hit) => hit.toolName === "history")).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await appendFile(path, nativeMessage("late", { role: "user", content: "stablepaging late" }, "2026-02-01T00:00:00.000Z") + "\n");
    const second = await fx.service.search(fx.session.agentId, {
      query: "stablepaging",
      limit: 5,
      order: "newest",
      cursor: first.nextCursor,
    });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.results.some((hit) => hit.ref.entryId === "late")).toBe(false);
    const firstIds = first.results.map((hit) => hit.ref.entryId);
    const secondIds = second.results.map((hit) => hit.ref.entryId);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    const artifacts = await fx.service.search(fx.session.agentId, {
      query: "stablepaging",
      includeHistoryArtifacts: true,
      limit: 50,
    });
    expect(artifacts.results.some((hit) => hit.toolName === "history")).toBe(true);
    await expect(fx.service.search(fx.session.agentId, {
      query: "billing",
      cursor: first.nextCursor,
    })).rejects.toBeInstanceOf(HistoryRecallError);
  });

  it("discovers sessions, omits restricted sources, and does not purge from a partial catalog", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"), nativeMessage("keep", { role: "user", content: "partialcatalog" })]);
    await writeTranscript(fx.dataDir, fx.otherSession, [header("/tmp/a2"), nativeMessage("other", { role: "user", content: "partialcatalog" })]);
    await fx.service.search(fx.session.agentId, { query: "partialcatalog", scope: "project" });
    await fx.service.start({
      revision: 2,
      hydration: "partial",
      sources: catalogSources(fx, [fx.session]),
    });
    const sessions = await fx.service.sessions(fx.session.agentId, { query: "Session", scope: "project" });
    expect(sessions.results.some((hit) => hit.sessionAgentId === fx.session.agentId)).toBe(true);
    expect(sessions.coverage.catalogHydration).toBe("partial");
    expect(sessions.coverage.eligibleSourceCount).toBeUndefined();
    const stillIndexed = await fx.service.search(fx.session.agentId, { query: "partialcatalog", scope: "project" });
    expect(stillIndexed.results.map((hit) => hit.ref.entryId).sort()).toEqual(["keep", "other"]);
    expect(stillIndexed.coverage?.eligibleSourceCount).toBeUndefined();
    await expect(fx.service.search(fx.cortex.agentId, { query: "partialcatalog" })).rejects.toBeInstanceOf(HistoryRecallError);
    await fx.service.start({
      revision: 3,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    const purged = await fx.service.search(fx.session.agentId, { query: "partialcatalog", scope: "project" });
    expect(purged.results.map((hit) => hit.ref.entryId)).toEqual(["keep"]);
  });

  it("does not treat sibling branches as same-branch neighbors", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      JSON.stringify({ type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "branch root" } }),
      JSON.stringify({ type: "message", id: "left", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "left sibling needle" } }),
      JSON.stringify({ type: "message", id: "right", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "right sibling needle" } }),
    ]);
    const hits = await fx.service.search(fx.session.agentId, { query: "left sibling" });
    const read = await fx.service.read(fx.session.agentId, { ref: hits.results[0]!.ref, before: 1, after: 1 });
    expect(read.before.map((entry) => entry.ref.entryId)).toEqual(["root"]);
    expect(read.after.map((entry) => entry.ref.entryId)).toEqual([]);
  });

  it("start returns before cache initialization finishes", async () => {
    const fx = await createFixture();
    let resolveDb: (value: typeof Database) => void = () => undefined;
    const delayed = new Promise<typeof Database>((resolve) => {
      resolveDb = resolve;
    });
    const service = new HistorySearchService({
      ...fx.host,
      loadDatabaseModule: () => delayed,
    });
    created.push(service);
    let finished = false;
    const start = service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    }).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(true);
    resolveDb(Database);
    await start;
  });

  it("discovers a lost append through idle reconciliation without a search driving ingestion", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      nativeMessage("seed", { role: "user", content: "idle seed" }),
    ]);
    const started = Date.now();
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    expect(Date.now() - started).toBeLessThan(250);
    await waitFor(async () => {
      const seed = await fx.service.search(fx.session.agentId, { query: "idle seed" });
      return seed.results.some((hit) => hit.ref.entryId === "seed");
    });
    const path = getSessionFilePath(fx.dataDir, fx.session.profileId!, fx.session.agentId);
    await appendFile(path, nativeMessage("lost-append", {
      role: "assistant",
      content: [{ type: "text", text: "autonomouslostappend landed" }],
    }, "2026-09-01T00:00:00.000Z") + "\n");
    await waitFor(async () => {
      const db = new Database(getHistoryRecallIndexPath(fx.dataDir), { readonly: true });
      const row = db.prepare("SELECT count(*) AS n FROM entries WHERE entry_id = 'lost-append'").get() as { n: number };
      db.close();
      return row.n > 0;
    });
    const found = await fx.service.search(fx.session.agentId, { query: "autonomouslostappend" });
    expect(found.results.some((hit) => hit.ref.entryId === "lost-append")).toBe(true);
  });

  it("does not spin ingest on oversized degraded coverage once catch-up is idle", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [header("/tmp/a"),
      nativeMessage("first", { role: "user", content: "degradedidle" }),
      nativeMessage("huge", { role: "user", content: "x".repeat(1_200_000) }),
      nativeMessage("after", { role: "user", content: "after oversized" }),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    await waitFor(async () => {
      const db = new Database(getHistoryRecallIndexPath(fx.dataDir), { readonly: true });
      const state = db.prepare("SELECT omitted_eligible_text FROM sources").get() as { omitted_eligible_text: number } | undefined;
      const after = db.prepare("SELECT count(*) AS n FROM entries WHERE entry_id = 'after'").get() as { n: number };
      db.close();
      return Boolean(state?.omitted_eligible_text && after.n > 0);
    }, 4_000);
    const ingest = vi.spyOn(HistoryRecallIndexStore.prototype, "ingestSource");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const calls = ingest.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ingest.mock.calls.length - calls).toBeLessThanOrEqual(2);
    ingest.mockRestore();
    const result = await fx.service.search(fx.session.agentId, { query: "degradedidle" });
    expect(result.results.some((hit) => hit.ref.entryId === "first")).toBe(true);
    expect(result.coverage?.omittedEligibleText).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.coverage?.state).toBe("degraded");
  });

  it("rotates later active sources and archives past a busy nonarchived backlog", async () => {
    const fx = await createFixture();
    const busy: AgentDescriptor[] = [];
    for (let i = 0; i < 9; i += 1) {
      const agent = descriptor({
        agentId: `busy-${i}`,
        managerId: `busy-${i}`,
        role: "manager",
        profileId: "project-a",
        displayName: `Busy ${i}`,
      });
      fx.agents.push(agent);
      busy.push(agent);
      await writeTranscript(fx.dataDir, agent, [
        header("/tmp/busy", agent.agentId),
        ...Array.from({ length: 80 }, (_, row) => nativeMessage(`pad-${i}-${row}`, {
          role: "user",
          content: `busy backlog ${i} ${row} ${"z".repeat(12_000)}`,
        })),
      ]);
    }
    const later = descriptor({
      agentId: "later-active",
      managerId: "later-active",
      role: "manager",
      profileId: "project-a",
      displayName: "Later Active",
    });
    fx.agents.push(later);
    await writeTranscript(fx.dataDir, later, [
      header("/tmp/later"),
      nativeMessage("later-hit", { role: "assistant", content: "lateractivesource needle" }),
    ]);
    await writeTranscript(fx.dataDir, fx.otherSession, [
      header("/tmp/a2"),
      nativeMessage("archive-hit", { role: "user", content: "archivefairness needle" }),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [...busy, later, fx.otherSession]),
    });
    await waitFor(async () => {
      const laterHits = await fx.service.search(fx.session.agentId, {
        query: "lateractivesource",
        scope: "project",
      });
      const archiveHits = await fx.service.search(fx.session.agentId, {
        query: "archivefairness",
        scope: "project",
      });
      return laterHits.results.some((hit) => hit.ref.entryId === "later-hit")
        && archiveHits.results.some((hit) => hit.ref.entryId === "archive-hit");
    }, 4_000);
  });

  it("stops scheduled background work on dispose", async () => {
    const fx = await createFixture();
    await writeTranscript(fx.dataDir, fx.session, [
      header("/tmp/a"),
      nativeMessage("seed", { role: "user", content: "dispose stop" }),
    ]);
    await fx.service.start({
      revision: 1,
      hydration: "complete",
      sources: catalogSources(fx, [fx.session]),
    });
    await waitFor(async () => {
      const seed = await fx.service.search(fx.session.agentId, { query: "dispose stop" });
      return seed.results.length > 0;
    });
    await fx.service.dispose();
    const ingest = vi.spyOn(HistoryRecallIndexStore.prototype, "ingestSource");
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(ingest).not.toHaveBeenCalled();
    ingest.mockRestore();
  });

});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-history-recall-"));
  const now = "2026-01-01T00:00:00.000Z";
  const profile: ManagerProfile = {
    profileId: "project-a",
    displayName: "Project A",
    defaultSessionAgentId: "session-a",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    createdAt: now,
    updatedAt: now,
  };
  const outsideProfile: ManagerProfile = {
    ...profile,
    profileId: "project-b",
    displayName: "Project B",
    defaultSessionAgentId: "session-b",
  };
  const cortexProfile: ManagerProfile = {
    ...profile,
    profileId: "cortex",
    displayName: "Cortex",
    defaultSessionAgentId: "cortex",
    profileType: "system",
  };
  const session = descriptor({
    agentId: "session-a",
    managerId: "session-a",
    role: "manager",
    profileId: "project-a",
    displayName: "Session A",
    cwd: "/tmp/a",
  });
  const worker = descriptor({
    agentId: "worker-a",
    managerId: "session-a",
    role: "worker",
    profileId: "project-a",
    displayName: "Worker A",
    cwd: "/tmp/a",
  });
  const otherSession = descriptor({
    agentId: "session-a2",
    managerId: "session-a2",
    role: "manager",
    profileId: "project-a",
    displayName: "Session A2",
    cwd: "/tmp/a2",
    archivedAt: "2026-01-01T00:00:00.000Z",
  });
  const fork = descriptor({
    agentId: "session-fork",
    managerId: "session-fork",
    role: "manager",
    profileId: "project-a",
    displayName: "Fork",
    cwd: "/tmp/a",
  });
  const outsideSession = descriptor({
    agentId: "session-b",
    managerId: "session-b",
    role: "manager",
    profileId: "project-b",
    displayName: "Session B",
    cwd: "/tmp/b",
  });
  const cortex = descriptor({
    agentId: "cortex",
    managerId: "cortex",
    role: "manager",
    profileId: "cortex",
    displayName: "Cortex",
    cwd: "/tmp/cortex",
    sessionPurpose: "cortex_review",
  });
  const agents = [session, worker, otherSession, fork, outsideSession, cortex];
  const profiles = [profile, outsideProfile, cortexProfile];
  const host = {
    config: { paths: { dataDir } } as Pick<SwarmConfig, "paths">,
    getAgent: (agentId: string) => agents.find((agent) => agent.agentId === agentId),
    listAgents: () => agents,
    listProfiles: () => profiles,
    loadDatabaseModule: async () => Database,
  };
  const service = new HistorySearchService(host);
  created.push(service);
  return { dataDir, session, worker, otherSession, fork, outsideSession, cortex, agents, profiles, service, host };
}

function createService(fx: Awaited<ReturnType<typeof createFixture>>): HistorySearchService {
  const service = new HistorySearchService(fx.host);
  created.push(service);
  return service;
}

function catalogSources(
  fx: Awaited<ReturnType<typeof createFixture>>,
  agents: AgentDescriptor[],
) {
  return agents.map((agent) => {
    const session = agent.role === "manager" ? agent : fx.agents.find((entry) => entry.agentId === agent.managerId)!;
    const profileId = agent.profileId ?? session.profileId ?? agent.agentId;
    return {
      sourceId: `${session.agentId}:${agent.agentId}`,
      profileId,
      sessionAgentId: session.agentId,
      actorAgentId: agent.agentId,
      path: agent.role === "manager"
        ? getSessionFilePath(fx.dataDir, profileId, agent.agentId)
        : getWorkerSessionFilePath(fx.dataDir, profileId, session.agentId, agent.agentId),
      archived: Boolean(session.archivedAt),
      sessionLabel: session.displayName ?? session.agentId,
      actorLabel: agent.displayName ?? agent.agentId,
      lastActivityAt: agent.lastUserMessageAt ?? session.lastUserMessageAt,
    };
  });
}


function descriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "managerId" | "role">): AgentDescriptor {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    displayName: overrides.agentId,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: "/ignored.jsonl",
    ...overrides,
  };
}

async function writeTranscript(dataDir: string, agent: AgentDescriptor, lines: string[]): Promise<void> {
  const profileId = agent.profileId ?? agent.agentId;
  const path = agent.role === "manager"
    ? getSessionFilePath(dataDir, profileId, agent.agentId)
    : getWorkerSessionFilePath(dataDir, profileId, agent.managerId, agent.agentId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

function header(cwd: string, id = "session-header"): string {
  return JSON.stringify({ type: "session", id, version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd });
}

function conversation(id: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: typeof data.timestamp === "string" ? data.timestamp : "2026-01-01T00:00:00.000Z",
    data,
  });
}

function nativeMessage(id: string, message: Record<string, unknown>, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp, message });
}

function custom(customType: string, id: string, data: unknown): string {
  return JSON.stringify({ type: "custom", customType, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", data });
}

function compaction(id: string, firstKeptEntryId: string, summary: string, details?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary,
    firstKeptEntryId,
    tokensBefore: 10,
    ...(details ? { details } : {}),
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for history scheduler condition");
}
