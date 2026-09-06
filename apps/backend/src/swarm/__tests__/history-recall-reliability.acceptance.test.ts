import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOLDENS,
  QUALITY_RUBRIC,
  assertLargeModeConfirmed,
  compactAgentSpecs,
  compactGoldens,
  createMarkedDataRoot,
  isHarnessOwnedRoot,
  removeMarkedDataRoot,
  runReliabilitySuite,
} from "./fixtures/history-recall-reliability/index.js";
import { COMPACT_ARCHIVE_COUNT } from "./fixtures/history-recall-reliability/ids.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const dataDir = roots.pop();
    if (dataDir) {
      await removeMarkedDataRoot(dataDir);
    }
  }
});

describe("history-recall reliability acceptance preparation", () => {
  it("authors independent goldens, refuses unmarked data roots, and keeps large corpora opt-in", async () => {
    const ids = GOLDENS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDENS.some((entry) => entry.expectedRefs.length > 0)).toBe(true);
    expect(GOLDENS.every((entry) => entry.baselineNote.length > 0)).toBe(true);
    expect(GOLDENS.some((entry) => entry.expectedBaseline !== "pass")).toBe(true);
    expect(new Set(GOLDENS.map((entry) => entry.gate))).toEqual(new Set(["quality", "readiness", "integrity", "resources"]));
    expect(compactGoldens().some((entry) => entry.summary.includes("top hit"))).toBe(false);
    expect(compactAgentSpecs(COMPACT_ARCHIVE_COUNT).length).toBeGreaterThan(48);

    const unmarked = await mkdtemp(join(tmpdir(), "not-hrr-"));
    expect(await isHarnessOwnedRoot(unmarked)).toBe(false);
    expect(await removeMarkedDataRoot(unmarked)).toMatchObject({ removed: false });
    expect(await removeMarkedDataRoot(resolve(process.env.FORGE_DATA_DIR ?? "/tmp"))).toMatchObject({ removed: false });
    await rm(unmarked, { recursive: true, force: true });

    const marked = await createMarkedDataRoot("acceptance-self-check");
    roots.push(marked.dataDir);
    expect(await isHarnessOwnedRoot(marked.dataDir)).toBe(true);

    expect(() => assertLargeModeConfirmed("giant", false)).toThrow(/opt-in/i);
    expect(() => assertLargeModeConfirmed("scale", false)).toThrow(/opt-in/i);
    expect(QUALITY_RUBRIC.paraphraseBucket).toBe("diagnostic-only");
  });

  it("records compact baseline reds without hiding them and distinguishes quality, readiness, integrity, and resources", async () => {
    const report = await runReliabilitySuite({ mode: "compact" });
    expect(report.sourceCount).toBeGreaterThan(48);
    expect(report.corpusBytes).toBeLessThan(8 * 1024 * 1024);
    expect(report.lifecycle.start).toBe(true);
    expect(report.lifecycle.sessions).toBe(true);

    const byId = new Map(report.cases.map((entry) => [entry.id, entry]));
    const extras = new Map(report.extras.map((entry) => [entry.id, entry]));
    const expectedReds = [
      byId.get("cold-source-last-first-search"),
      byId.get("worker-only-project-cold"),
    ];
    for (const entry of expectedReds) {
      expect(entry, "missing expected baseline case").toBeTruthy();
      if (!entry?.meetsGolden) {
        expect(entry?.observed).toBe(entry?.expectedBaseline);
        expect(entry?.observed).not.toBe("pass");
      }
    }
    expect(byId.get("cold-source-last-first-search")?.meetsGolden).toBe(false);
    expect(extras.get("harness-refuses-unmarked-roots")?.meetsGolden).toBe(true);
    expect(extras.get("paging-append-shift")?.meetsGolden).toBe(true);
    expect(byId.get("sessions-discovery-by-label")?.meetsGolden).toBe(true);

    const mismatchedReds = [...report.cases, ...report.extras].filter((entry) =>
      !entry.meetsGolden && entry.expectedBaseline !== "pass" && entry.observed !== entry.expectedBaseline);
    expect(mismatchedReds, mismatchedReds.map((entry) => `${entry.id}:${entry.observed} expected ${entry.expectedBaseline}:${entry.notes.join("|")}`).join("\n")).toEqual([]);
    const unexpectedPasses = [...report.cases, ...report.extras].filter((entry) =>
      !entry.meetsGolden && entry.expectedBaseline === "pass");
    expect(unexpectedPasses, unexpectedPasses.map((entry) => `${entry.id}:${entry.observed}:${entry.notes.join("|")}`).join("\n")).toEqual([]);


    const gates = [...report.cases, ...report.extras].reduce<Record<string, { gold: number; baseline: number }>>((acc, entry) => {
      const bucket = acc[entry.gate] ?? { gold: 0, baseline: 0 };
      if (entry.meetsGolden) bucket.gold += 1;
      if (entry.matchesExpectedBaseline) bucket.baseline += 1;
      acc[entry.gate] = bucket;
      return acc;
    }, {});
    expect(gates.quality?.baseline).toBeGreaterThan(0);
    expect(gates.readiness?.baseline).toBeGreaterThan(0);
    expect(gates.integrity?.baseline).toBeGreaterThan(0);
    expect(gates.readiness?.gold).toBeLessThan(gates.readiness.baseline);
    expect(report.quality.criticalFailures).toEqual(expect.arrayContaining([
      "cold-source-last-first-search",
      "worker-only-project-cold",
    ]));
  }, 60_000);
});
