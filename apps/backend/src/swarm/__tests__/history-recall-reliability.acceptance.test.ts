import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_PIN,
  BASELINE_PIN_REVISION,
  GOLDENS,
  PASSIVE_READINESS_DEADLINE_MS,
  QUALITY_RUBRIC,
  assertLargeModeConfirmed,
  compactAgentSpecs,
  compactGoldens,
  createMarkedDataRoot,
  evaluateBaseline,
  evaluateStrict,
  fakeScore,
  isHarnessOwnedRoot,
  removeMarkedDataRoot,
  runReliabilitySuite,
  scoreCase,
} from "./fixtures/history-recall-reliability/index.js";
import { COMPACT_ARCHIVE_COUNT, ENTRY, SESSION } from "./fixtures/history-recall-reliability/ids.js";

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
    expect(new Set(GOLDENS.map((entry) => entry.gate))).toEqual(new Set(["quality", "readiness", "integrity", "resources"]));
    expect(compactGoldens().some((entry) => entry.summary.includes("top hit"))).toBe(false);
    expect(compactAgentSpecs(COMPACT_ARCHIVE_COUNT).length).toBeGreaterThan(48);
    expect(GOLDENS.find((entry) => entry.id === "cold-source-last-first-search")?.expectedBaseline).toBe("pass");
    expect(GOLDENS.find((entry) => entry.id === "provisional-seam-unanchored")?.expectedRefs.map((ref) => ref.entryId)).toEqual([
      "hrr-seam-unanchored-custom",
      "hrr-seam-unanchored-native",
    ]);
    expect(GOLDENS.find((entry) => entry.id === "forward-seam-equivalence")?.expectedRefs.map((ref) => ref.entryId)).toEqual([
      "hrr-seam-custom",
    ]);

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
    expect(PASSIVE_READINESS_DEADLINE_MS).toBe(2_000);
  });

  it("fails strict mode on fake red observations and passes it on fake green observations", () => {
    const red = evaluateStrict([fakeScore({ id: "cold-source-last-first-search", meetsGolden: false, observed: "miss" })]);
    expect(red.ok).toBe(false);
    expect(red.missedGoldens).toEqual(["cold-source-last-first-search"]);

    const green = evaluateStrict([fakeScore({
      id: "cold-source-last-first-search",
      meetsGolden: true,
      observed: "pass",
      expectedBaseline: "pass",
      matchesExpectedBaseline: true,
      notes: [],
    })]);
    expect(green.ok).toBe(true);
    expect(green.missedGoldens).toEqual([]);
  });

  it("requires both unanchored mirrors only before isolated convergence, then matches clean forward", () => {
    const golden = GOLDENS.find((entry) => entry.id === "provisional-seam-unanchored");
    expect(golden).toBeTruthy();
    const missingNative = scoreCase(golden!, {
      op: "lifecycle",
      hits: [{ sessionAgentId: SESSION.seam, actorAgentId: SESSION.seam, entryId: ENTRY.seamUnanchoredCustom }],
      durationMs: 12,
      queryCount: 1,
      unanchored: true,
      phase: "provisional",
      convergedEntryIds: [ENTRY.seamUnanchoredCustom],
      forwardEntryIds: [ENTRY.seamUnanchoredCustom],
    });
    expect(missingNative.meetsGolden).toBe(false);
    expect(missingNative.notes.some((note) => note.includes("hrr-seam-unanchored-native"))).toBe(true);

    const unanchoredPass = scoreCase(golden!, {
      op: "lifecycle",
      hits: [
        { sessionAgentId: SESSION.seam, actorAgentId: SESSION.seam, entryId: ENTRY.seamUnanchoredCustom },
        { sessionAgentId: SESSION.seam, actorAgentId: SESSION.seam, entryId: ENTRY.seamUnanchoredNative },
      ],
      durationMs: 12,
      queryCount: 1,
      unanchored: true,
      phase: "provisional",
      convergedEntryIds: [ENTRY.seamUnanchoredCustom],
      forwardEntryIds: [ENTRY.seamUnanchoredCustom],
    });
    expect(unanchoredPass.meetsGolden).toBe(true);

    const alreadyConverged = scoreCase(golden!, {
      op: "lifecycle",
      hits: [{ sessionAgentId: SESSION.seam, actorAgentId: SESSION.seam, entryId: ENTRY.seamUnanchoredCustom }],
      durationMs: 8,
      queryCount: 1,
      unanchored: false,
      phase: "converged",
      convergedEntryIds: [ENTRY.seamUnanchoredCustom],
      forwardEntryIds: [ENTRY.seamUnanchoredCustom],
    });
    expect(alreadyConverged.meetsGolden).toBe(true);
    expect(alreadyConverged.notes.some((note) => note.includes("dual-id assertion skipped"))).toBe(true);
  });

  it("scores compact goldens strictly, starts cold queries after start(snapshot), and reports remaining engine failures separately", async () => {
    const report = await runReliabilitySuite({ mode: "compact" });
    expect(report.sourceCount).toBeGreaterThan(48);
    expect(report.corpusBytes).toBeLessThan(8 * 1024 * 1024);
    expect(report.lifecycle.start).toBe(true);
    expect(report.lifecycle.sessions).toBe(true);

    const scores = [...report.cases, ...report.extras];
    const byId = new Map(scores.map((entry) => [entry.id, entry]));
    const cold = byId.get("cold-source-last-first-search");
    expect(cold, "missing cold-source-last-first-search").toBeTruthy();
    expect(cold?.queryCount).toBe(1);
    expect(cold?.passiveWaitMs ?? 0).toBeGreaterThan(0);
    expect(cold?.passiveWaitMs ?? 0).toBeLessThanOrEqual(PASSIVE_READINESS_DEADLINE_MS + 250);
    expect(cold?.startupToEvidenceMs ?? 0).toBeGreaterThan(0);
    expect(cold?.startupToEvidenceMs ?? 0).toBeGreaterThanOrEqual(cold?.passiveWaitMs ?? 0);
    expect(Math.abs((cold?.startupToEvidenceMs ?? 0) - ((cold?.passiveWaitMs ?? 0) + (cold?.durationMs ?? 0)))).toBeLessThan(50);

    const coldTail = byId.get("cold-tail-without-search-clock");
    expect(coldTail, "missing cold-tail-without-search-clock").toBeTruthy();
    expect(Math.abs((coldTail?.startupToEvidenceMs ?? 0) - (coldTail?.durationMs ?? 0))).toBeLessThan(1);
    expect(coldTail?.startupToEvidenceMs ?? 0).toBeLessThan(((coldTail?.passiveWaitMs ?? 0) * 2) - 100);

    const seam = byId.get("provisional-seam-unanchored");
    expect(seam, "missing provisional-seam-unanchored").toBeTruthy();
    expect(seam?.notes.some((note) => note.includes("unanchored") || note.includes("clean forward"))).toBe(true);
    expect(seam?.startupToEvidenceMs ?? seam?.durationMs ?? 0).toBeLessThan(PASSIVE_READINESS_DEADLINE_MS);

    const extras = new Map(report.extras.map((entry) => [entry.id, entry]));
    expect(extras.get("harness-refuses-unmarked-roots")?.meetsGolden).toBe(true);

    const gates = scores.reduce<Record<string, { gold: number; total: number }>>((acc, entry) => {
      const bucket = acc[entry.gate] ?? { gold: 0, total: 0 };
      bucket.total += 1;
      if (entry.meetsGolden) bucket.gold += 1;
      acc[entry.gate] = bucket;
      return acc;
    }, {});
    expect(gates.quality?.total).toBeGreaterThan(0);
    expect(gates.readiness?.total).toBeGreaterThan(0);
    expect(gates.integrity?.total).toBeGreaterThan(0);

    const strict = evaluateStrict(scores);
    const baseline = evaluateBaseline(scores, BASELINE_PIN, BASELINE_PIN_REVISION);
    expect(baseline.mode).toBe("baseline");
    if (!strict.ok) {
      expect(strict.remainingEngineFailures.length).toBeGreaterThan(0);
      expect(strict.missedGoldens).toEqual(strict.remainingEngineFailures.map((entry) => entry.id));
    }
  }, 90_000);
});
