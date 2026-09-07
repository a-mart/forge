import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StatsSourceCache, getStatsSourceCache } from "../stats/stats-source-cache.js";
import { getSharedStatsSourcesDir } from "../swarm/storage/data-paths.js";
import { scanProfilesData } from "../stats/stats-scan.js";
import { scanJsonlFile } from "../stats/stats-shared.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-stats-source-")); roots.push(root);
  const path = join(root, "profiles/p/sessions/s/session.jsonl");
  await mkdir(join(root, "profiles/p/sessions/s"), { recursive: true });
  return { root, path, cache: new StatsSourceCache(root) };
}
const usage = (output = 5) => JSON.stringify({ type: "message", timestamp: "2026-09-07T10:00:00Z", message: {
  model: "test", provider: "openai", content: "PRIVATE-MESSAGE-CANARY", usage: { input: 2, output },
} });

describe("persistent stats source projections", () => {
  it("reads no transcript bytes for unchanged sources, including after a fresh cache instance", async () => {
    const { root, path, cache } = await fixture();
    await writeFile(path, `${usage()}\n`);
    const baseline = await cache.read(path);
    const bytes = cache.diagnostics.bytesRead;
    expect(await cache.read(path)).toEqual(baseline);
    expect(cache.diagnostics.bytesRead).toBe(bytes);
    const restarted = new StatsSourceCache(root);
    expect(await restarted.read(path)).toEqual(baseline);
    expect(restarted.diagnostics).toMatchObject({ bytesRead: 0, cacheHits: 1, rebuilds: 0 });
    const [file] = await readdir(getSharedStatsSourcesDir(root));
    expect(await readFile(join(getSharedStatsSourcesDir(root), file), "utf8")).not.toContain("PRIVATE-MESSAGE-CANARY");
  });

  it("joins simultaneous cold readers and reads only the appended suffix plus fixed boundary checks", async () => {
    const { path, cache } = await fixture();
    await writeFile(path, `${usage()}\n`.repeat(2000));
    const [a, b] = await Promise.all([cache.read(path), cache.read(path)]);
    expect(a).toBe(b);
    expect(cache.diagnostics.rebuilds).toBe(1);
    const before = cache.diagnostics.bytesRead;
    const suffix = `${usage(9)}\n`;
    await appendFile(path, suffix);
    expect(await cache.read(path)).toHaveLength(2001);
    expect(cache.diagnostics.bytesRead - before).toBeLessThanOrEqual(Buffer.byteLength(suffix) + 1024);
  });

  it("rebuilds a truncated, replaced, or same-length edited source without keeping old counts", async () => {
    const { root, path, cache } = await fixture();
    await writeFile(path, `${usage()}\n`.repeat(4));
    await cache.read(path);
    await writeFile(path, `${usage(3)}\n`);
    expect(await cache.read(path)).toHaveLength(1);
    await writeFile(join(root, "replacement"), `${usage(8)}\n`);
    await rename(join(root, "replacement"), path);
    expect((await cache.read(path))[0].entry).toMatchObject({ message: { usage: { output: 8 } } });
    await writeFile(path, `${usage(7)}\n`);
    expect((await cache.read(path))[0].entry).toMatchObject({ message: { usage: { output: 7 } } });
    await rm(path);
    expect(await cache.read(path)).toEqual([]);
  });

  it("rejects an append checkpoint after truncate-and-regrow", async () => {
    const { path, cache } = await fixture();
    await writeFile(path, `${usage(1)}\n`);
    await cache.read(path);
    await writeFile(path, `${usage(9)}\n`.repeat(3));
    const rows = await cache.read(path);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => (r.entry.message as { usage: { output: number } }).usage.output === 9)).toBe(true);
  });

  it("does not checkpoint partial JSON or count a completed final row twice", async () => {
    const { root, path, cache } = await fixture();
    const line = usage();
    await writeFile(path, line.slice(0, 20));
    expect(await cache.read(path)).toEqual([]);
    await appendFile(path, line.slice(20));
    expect(await cache.read(path)).toHaveLength(1);
    const restarted = new StatsSourceCache(root);
    expect(await restarted.read(path)).toHaveLength(1);
    await appendFile(path, `\n${usage(2)}\n`);
    expect(await restarted.read(path)).toHaveLength(2);
  });

  it("recovers a corrupt cache and processes a giant irrelevant row in linear reads", async () => {
    const { root, path, cache } = await fixture();
    const body = `${JSON.stringify({ type: "message", message: { content: "x".repeat(8 * 1024 * 1024) } })}\n${usage()}\n`;
    await writeFile(path, body);
    expect(await cache.read(path)).toHaveLength(1);
    expect(cache.diagnostics.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(body) + 512);
    const [file] = await readdir(getSharedStatsSourcesDir(root));
    await writeFile(join(getSharedStatsSourcesDir(root), file), "broken");
    const restarted = new StatsSourceCache(root);
    expect(await restarted.read(path)).toHaveLength(1);
    expect(restarted.diagnostics.rebuilds).toBe(1);
  });

  it("preserves reasoning context, usage costs, user counts and word totals across cached replay", async () => {
    const { root, path } = await fixture();
    await writeFile(path, [
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }), usage(),
      JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", data: {
        type: "conversation_message", role: "user", source: "user_input", timestamp: "2026-09-07T10:00:00Z",
        text: "PRIVATE-USER-CANARY fuck Fucked", attachments: [{ secret: "PRIVATE-ATTACHMENT" }],
      } }),
    ].join("\n") + "\n");
    const first = await scanProfilesData(root, ["p"], "UTC");
    const before = getStatsSourceCache(root).diagnostics.bytesRead;
    expect(await scanProfilesData(root, ["p"], "UTC")).toEqual(first);
    expect(getStatsSourceCache(root).diagnostics.bytesRead).toBe(before);
    expect(first.userMessages).toHaveLength(1);
    expect(first.fuckMeterDaily.get("2026-09-07")).toBe(2);
    expect(first.usageRecords[0]).toMatchObject({ input: 2, output: 5, reasoningLevel: "high" });
    const contexts: unknown[] = [];
    await scanJsonlFile(path, (_entry, context) => contexts.push(context), { dataDir: root });
    expect(contexts.every((context) => (context as { thinkingLevel: string }).thinkingLevel === "high")).toBe(true);
    const [file] = await readdir(getSharedStatsSourcesDir(root));
    expect(await readFile(join(getSharedStatsSourcesDir(root), file), "utf8")).not.toContain("PRIVATE-");
  });
});
