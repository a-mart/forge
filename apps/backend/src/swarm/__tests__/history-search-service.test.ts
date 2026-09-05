import { locateCheckpointEvidence } from "../history-recall/checkpoint-references.js";
import { appendFile, readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { getHistoryRecallIndexPath, getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
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
    db.exec("DELETE FROM meta; DELETE FROM entries WHERE entry_id='later'; DELETE FROM entries_fts WHERE entry_id='later'; ALTER TABLE sources DROP COLUMN oversized_state;");
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
