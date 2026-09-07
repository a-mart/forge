import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryItemsRequest, HistorySearchRequest } from "@forge/protocol";
import { HistorySearchService } from "../history-recall/history-search-service.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const fixtures: Array<{ service: HistorySearchService; root: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.service.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});
function row(id: string, text: string, role = "user") {
  return JSON.stringify({ type: "message", id, timestamp: "2026-09-07T00:00:00.000Z", message: { role, content: text } });
}
function compact(id: string) {
  return JSON.stringify({ type: "compaction", id, firstKeptEntryId: "boundary", summary: "Continue the same task", details: { forgeContext: { mode: "fresh" } } });
}
async function fixture(lines: string[], databaseAvailable = false) {
  const root = await mkdtemp(join(tmpdir(), "forge-canonical-recovery-"));
  const session = { agentId: "session", managerId: "session", profileId: "project", role: "manager", displayName: "Task",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" }, sessionFile: "ignored",
    status: "idle", cwd: root, createdAt: "2026-09-07", updatedAt: "2026-09-07" } as AgentDescriptor;
  const agents = [session];
  const profiles = [{ profileId: "project", displayName: "Project", defaultSessionAgentId: "session" }] as ManagerProfile[];
  const loadDatabaseModule = vi.fn(async () => { if (!databaseAvailable) throw new Error("SQLite unavailable"); return Database; });
  const service = new HistorySearchService({ config: { paths: { dataDir: root } } as Pick<SwarmConfig, "paths">,
    getAgent: id => agents.find(agent => agent.agentId === id), listAgents: () => agents, listProfiles: () => profiles, loadDatabaseModule });
  fixtures.push({ service, root });
  const path = getSessionFilePath(root, "project", "session");
  await mkdir(dirname(path), { recursive: true });
  const header = JSON.stringify({ type: "session", id: "header", version: 3 });
  await writeFile(path, [header, ...lines, ""].join("\n"));
  return { root, path, service, agents, profiles, session, loadDatabaseModule, header };
}
async function allItems(service: HistorySearchService, request: HistoryItemsRequest = {}) {
  const hits = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const last = await service.items("session", { ...request, cursor });
    hits.push(...last.results);
    cursor = last.nextCursor;
    if (!cursor) return { hits, last };
  }
  throw new Error("Traversal did not finish");
}
async function allSearch(service: HistorySearchService, request: HistorySearchRequest) {
  const hits = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const last = await service.search("session", { ...request, cursor });
    hits.push(...last.results);
    cursor = last.nextCursor;
    if (!cursor) return { hits, last };
  }
  throw new Error("Search did not finish");
}

describe("canonical history recovery", () => {
  it("lists original user requests and exact windows without SQLite, and reads listed references", async () => {
    const fx = await fixture([row("objective", "Build the original objective"), compact("first"), row("correction", "Use the corrected approach"), compact("second"), row("continue", "Continue")]);
    expect((await fx.service.windows("session", {})).results.map(hit => hit.windowId)).toEqual(["window:initial", "window:fresh:first", "window:fresh:second"]);
    const items = await fx.service.items("session", { windowId: "window:fresh:first", role: "user" });
    expect(items.results.map(hit => hit.ref.entryId)).toEqual(["correction"]);
    const earliest = await fx.service.items("session", { role: "user", limit: 1 });
    expect(earliest.results[0]?.ref.entryId).toBe("objective");
    expect(earliest.complete).toBe(false);
    expect((await fx.service.read("session", { ref: earliest.results[0]!.ref })).entry.text).toContain("original objective");
    expect(fx.loadDatabaseModule).not.toHaveBeenCalled();
    const withNeighbors = await fx.service.read("session", { ref: earliest.results[0]!.ref, after: 1 });
    expect(withNeighbors.entry.text).toContain("original objective");
    expect(withNeighbors.warnings.join(" ")).toContain("neighbors are unavailable");
  });
  it("supports literal punctuation, whitespace, case and long tail/cross-chunk searches", async () => {
    const text = "x ".repeat(16_381) + "CrossBoundaryExact\n  foo-bar MixedCase" + "x ".repeat(150_000) + " TailBeyondEightChunks";
    const fx = await fixture([row("long", text), row("underscore", "foo_bar mixedcase")]);
    for (const query of ["CrossBoundaryExact\n  foo-bar", "TailBeyondEightChunks", "foo-bar", "MixedCase"]) {
      const result = await allSearch(fx.service, { query, mode: "literal" });
      expect(result.hits.map(hit => hit.ref.entryId)).toEqual(["long"]);
      expect(result.last.complete).toBe(true);
    }
    expect((await allSearch(fx.service, { query: "mixedcase", mode: "literal", caseSensitive: false })).hits).toHaveLength(2);
    expect((await allSearch(fx.service, { query: '"foo-bar"', mode: "literal" })).hits).toHaveLength(0);
    expect(fx.loadDatabaseModule).not.toHaveBeenCalled();
  });
  it("indexes tail text beyond the former eighth-chunk limit and boundary-straddling phrases", async () => {
    const prefix = "x ".repeat(16_381);
    const fx = await fixture([row("long", prefix + "boundary phrase found " + "padding ".repeat(40_000) + "terminaltailmarker")], true);
    await expect.poll(async () => (await fx.service.search("session", { query: "terminaltailmarker" })).results.length).toBe(1);
    const tail = await fx.service.search("session", { query: "terminaltailmarker" });
    const boundary = await fx.service.search("session", { query: '"boundary phrase found"' });
    expect(boundary.results.some(hit => hit.ref.entryId === "long")).toBe(true);
    expect(tail.coverage?.omittedEligibleText).toBe(false);
    expect((await fx.service.read("session", { ref: tail.results[0]!.ref, maxChars: 256 })).entry.totalChars).toBeGreaterThan(262_144);
  });
  it("keeps canonical recovery available when ingestion is paused and after service restart", async () => {
    const fx = await fixture([row("old", "original task")], true);
    await fx.service.startFromRegistry();
    await fx.service.search("session", { query: "original" });
    await fx.service.setIndexPaused(true);
    await appendFile(fx.path, row("new", "newneedle after pause") + "\n");
    expect((await fx.service.search("session", { query: "newneedle" })).results).toEqual([]);
    const listed = await fx.service.items("session", {});
    expect(listed.results.map(hit => hit.ref.entryId)).toContain("new");
    expect((await fx.service.search("session", { query: "newneedle", mode: "literal" })).results).toHaveLength(1);
    const ref = listed.results.find(hit => hit.ref.entryId === "new")!.ref;
    await fx.service.dispose();
    const restarted = new HistorySearchService({ config: { paths: { dataDir: fx.root } } as Pick<SwarmConfig, "paths">,
      getAgent: id => fx.agents.find(agent => agent.agentId === id), listAgents: () => fx.agents,
      listProfiles: () => fx.profiles, loadDatabaseModule: async () => { throw new Error("unavailable"); } });
    fixtures.push({ service: restarted, root: fx.root });
    expect((await restarted.read("session", { ref })).entry.text).toContain("newneedle");
    expect((await restarted.items("session", {})).results.map(hit => hit.ref.entryId)).toContain("new");
  });
  it("bounds scan work, continues empty filtered pages, and makes immediate cursor retries idempotent", async () => {
    const fx = await fixture([...Array.from({ length: 90 }, (_, i) => row(`large-${i}`, "padding ".repeat(4000))), row("target", "target after scan budget")]);
    const first = await fx.service.search("session", { mode: "literal", query: "target", limit: 1 });
    expect(first.results).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const request: HistorySearchRequest = { mode: "literal", query: "target", limit: 1, cursor: first.nextCursor };
    const second = await fx.service.search("session", request);
    expect(second.results[0]?.ref.entryId).toBe("target");
    expect(await fx.service.search("session", request)).toEqual(second);
    expect(second.complete).toBe(true);
  });
  it("pins source boundaries against appends and rejects replaced or mismatched cursor sources", async () => {
    const fx = await fixture([row("one", "first"), row("two", "second"), row("three", "third")]);
    const first = await fx.service.items("session", { limit: 1 });
    await appendFile(fx.path, row("late", "later append") + "\n");
    const second = await fx.service.items("session", { limit: 50, cursor: first.nextCursor });
    expect(second.results.map(hit => hit.ref.entryId)).toEqual(["two", "three"]);
    await expect(fx.service.items("session", { role: "user", cursor: first.nextCursor })).rejects.toThrow("does not match");
    const newFirst = await fx.service.items("session", { limit: 1 });
    await writeFile(fx.path, fx.header + "\n" + row("replaced", "replacement") + "\n");
    await expect(fx.service.items("session", { cursor: newFirst.nextCursor })).rejects.toThrow("changed or was reset");
  });
  it("preserves actor and project scope while excluding restricted actors and secret tool content", async () => {
    const fx = await fixture([row("one", "manager text"), JSON.stringify({ type: "message", id: "secret",
      message: { role: "toolResult", toolName: "secure_session_status", toolCallId: "call", content: "forbidden-secret-payload" } })]);
    const worker = { ...fx.session, agentId: "worker", role: "worker", displayName: "Worker" } as AgentDescriptor;
    const restricted = { ...worker, agentId: "restricted", internalWorkerKind: "codex_plugin" } as AgentDescriptor;
    const other = { ...fx.session, agentId: "outside", managerId: "outside", profileId: "other" };
    fx.agents.push(worker, restricted, other);
    const workerPath = getWorkerSessionFilePath(fx.root, "project", "session", "worker");
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(workerPath, fx.header + "\n" + row("worker-row", "worker evidence") + "\n");
    expect((await fx.service.items("worker", { actorAgentId: "worker" })).results.map(hit => hit.ref.entryId)).toEqual(["worker-row"]);
    await expect(fx.service.items("session", { actorAgentId: "restricted" })).rejects.toThrow("not available");
    await expect(fx.service.items("session", { sessionAgentId: "outside" })).rejects.toThrow("requires a specific reason");
    await expect(fx.service.windows("restricted", {})).rejects.toThrow("not available");
    expect((await allSearch(fx.service, { query: "forbidden-secret-payload", mode: "literal", actorAgentId: "session" })).hits).toEqual([]);
  });
  it("reports oversized and unfinished source loss truthfully and recovers following records", async () => {
    const fx = await fixture([row("large", "x".repeat(1_100_000)), row("after", "recover me")]);
    await appendFile(fx.path, '{"type":"message","id":"unfinished"');
    const result = await allItems(fx.service);
    expect(result.hits.map(hit => hit.ref.entryId)).toEqual(["after"]);
    expect(result.last.complete).toBe(false);
    expect(result.last.nextCursor).toBeUndefined();
    expect(result.last.warnings.join(" ")).toMatch(/exceeds.*unfinished/);
  });
  it("maps normalized indexed chunks back to raw whitespace-preserving read offsets", async () => {
    const text = "padding          ".repeat(22_000) + "uniqueTailNeedle";
    const fx = await fixture([row("whitespace", text)], true);
    await expect.poll(async () => (await fx.service.search("session", { query: "uniqueTailNeedle" })).results.length).toBe(1);
    const hit = (await fx.service.search("session", { query: "uniqueTailNeedle" })).results[0]!;
    expect(hit.ref.chunkIndex).toBeGreaterThan(0);
    const read = await fx.service.read("session", { ref: hit.ref, maxChars: 256 });
    expect(text.slice(0, read.entry.offset).replace(/\s+/g, " ").length).toBe(hit.ref.chunkIndex! * 32_768);
    expect(read.entry.offset).toBeGreaterThan(hit.ref.chunkIndex! * 32_768);
    expect(read.entry.text).toBe(text.slice(read.entry.offset, read.entry.offset + 256));
  });
  it("centers case-insensitive literal previews after expanding Unicode lowercase and rejects malformed cursor values", async () => {
    const fx = await fixture([row("unicode", "İ".repeat(1000) + "EXACTTARGET")]);
    const found = await fx.service.search("session", { mode: "literal", query: "exacttarget", caseSensitive: false });
    expect(found.results[0]?.snippet).toContain("EXACTTARGET");
    for (const value of [null, [], 123, "cursor"]) {
      await expect(fx.service.items("session", { cursor: Buffer.from(JSON.stringify(value)).toString("base64url") }))
        .rejects.toMatchObject({ name: "HistoryRecallError", code: "snapshot_expired" });
    }
  });
  it("bounds read text across primary text and auxiliary multipart previews", async () => {
    const fx = await fixture([JSON.stringify({ type: "message", id: "multipart", message: { role: "assistant", content: [
      { type: "text", text: "x".repeat(100_000) }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "y".repeat(100_000) } },
    ] } })]);
    const hit = (await fx.service.items("session", {})).results[0]!;
    const { partId: _, ...ref } = hit.ref;
    const read = await fx.service.read("session", { ref, maxChars: 20_000 });
    const textChars = read.entry.text.length + (read.entry.parts ?? []).reduce((sum, part) => sum + part.text.length, 0);
    expect(textChars).toBeLessThanOrEqual(20_000);
    expect(read.entry.nextOffset).toBeDefined();
  });
});
