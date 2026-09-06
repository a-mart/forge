import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getHistoryRecallIndexPath, getSessionFilePath } from "../../../storage/data-paths.js";
import { catalogSnapshot, createBenchmarkService, executeGolden } from "./adapter.js";
import { elapsedSince, waitForPassiveReadiness } from "./evaluation.js";
import {
  compactAgentSpecs,
  compactProfileSpecs,
  giantAgentSpecs,
  scaleAgentSpecs,
  toDescriptors,
  toProfiles,
} from "./catalog.js";
import { materializeCorpus, type CorpusMode } from "./corpus.js";
import { GOLDENS, goldensForLane, type GoldenCase } from "./goldens.js";
import {
  assertNotDefaultDataDir,
  createMarkedDataRoot,
  removeMarkedDataRoot,
} from "./harness.js";
import { COMPACT_ARCHIVE_COUNT, ENTRY, NEEDLE, PROFILE, SESSION, TIME } from "./ids.js";
import { inspectLifecycle } from "./lifecycle-contract.js";
import { nativeUser } from "./jsonl.js";
import { ResourceMonitor, measureDisk } from "./metrics.js";
import { classifyCursor, scoreCase, summarizeQuality, type CaseScore, type ObservedResponse } from "./scoring.js";
import { runIsolatedSeamPhases } from "./seam-phase.js";

export interface SuiteReport {
  mode: CorpusMode;
  dataDir: string;
  sourceCount: number;
  corpusBytes: number;
  cases: CaseScore[];
  observations: ObservedResponse[];
  quality: ReturnType<typeof summarizeQuality>;
  resources?: ReturnType<ResourceMonitor["stop"]>;
  disk?: Awaited<ReturnType<typeof measureDisk>>;
  lifecycle: ReturnType<typeof inspectLifecycle>;
  extras: CaseScore[];
}

export function assertLargeModeConfirmed(mode: CorpusMode, confirmed: boolean): void {
  if ((mode === "giant" || mode === "scale") && !confirmed) {
    throw new Error(`${mode} corpus is opt-in; pass --confirm-large to the benchmark runner. Default Vitest must not generate 200MB/~9GB workloads.`);
  }
}

export async function runReliabilitySuite(options: {
  mode: CorpusMode;
  confirmLarge?: boolean;
  giantPadBytes?: number;
  scalePadBytes?: number;
  scaleSourceCount?: number;
  keepRoot?: boolean;
}): Promise<SuiteReport> {
  assertLargeModeConfirmed(options.mode, Boolean(options.confirmLarge));
  const root = await createMarkedDataRoot(`history-recall-${options.mode}`);
  assertNotDefaultDataDir(root.dataDir);
  const monitor = new ResourceMonitor();
  monitor.start();
  const agentSpecs = options.mode === "giant"
    ? giantAgentSpecs(COMPACT_ARCHIVE_COUNT)
    : options.mode === "scale"
      ? scaleAgentSpecs(options.scaleSourceCount ?? 96)
      : compactAgentSpecs(COMPACT_ARCHIVE_COUNT);
  const agents = toDescriptors(agentSpecs);
  const profiles = toProfiles(compactProfileSpecs());
  let service: ReturnType<typeof createBenchmarkService> | undefined;
  try {
    const corpus = await materializeCorpus({
      dataDir: root.dataDir,
      agents: agentSpecs,
      mode: options.mode,
      giantPadBytes: options.giantPadBytes,
      scalePadBytes: options.scalePadBytes,
      scaleSourceCount: options.scaleSourceCount,
    });
    const goldens = goldensForLane(options.mode === "compact" ? "compact" : options.mode);
    const observations: ObservedResponse[] = [];
    const cases: CaseScore[] = [];
    const coldGoldens = goldens.filter((golden) => golden.gate === "readiness" && golden.op === "search");
    const isolatedSeamGolden = goldens.find((golden) => golden.id === "provisional-seam-unanchored");
    const warmGoldens = goldens.filter((golden) =>
      !(golden.gate === "readiness" && golden.op === "search") && golden.id !== "provisional-seam-unanchored",
    );
    for (const golden of coldGoldens) {
      await resetDerivedIndex(root.dataDir);
      const cold = createBenchmarkService(root.dataDir, agents, profiles);
      try {
        const startedAt = performance.now();
        await cold.start(catalogSnapshot(root.dataDir, agents, "complete", 1));
        const wait = await waitForPassiveReadiness(startedAt);
        const observed = await executeGolden(cold, golden, root.dataDir, agents);
        observed.queryCount = 1;
        observed.passiveWaitMs = wait.waitedMs;
        observed.startupToEvidenceMs = elapsedSince(startedAt);
        observations.push(observed);
        cases.push(scoreCase(golden, observed));
      } finally {
        await cold.dispose().catch(() => undefined);
      }
    }
    await resetDerivedIndex(root.dataDir);
    service = createBenchmarkService(root.dataDir, agents, profiles);
    await service.start(catalogSnapshot(root.dataDir, agents, "complete", 1));
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const golden of warmGoldens) {
      const observed = await executeGolden(service, golden, root.dataDir, agents);
      observations.push(observed);
      cases.push(scoreCase(golden, observed));
    }
    if (isolatedSeamGolden) {
      const phase = await runIsolatedSeamPhases(root.dataDir);
      const observed: ObservedResponse = {
        op: isolatedSeamGolden.op,
        hits: phase.hits,
        durationMs: phase.durationMs,
        queryCount: 1,
        startupToEvidenceMs: phase.durationMs,
        unanchored: phase.unanchored,
        phase: phase.phase,
        convergedEntryIds: phase.convergedEntryIds,
        forwardEntryIds: phase.forwardEntryIds,
        phaseNotes: phase.notes,
      };
      observations.push(observed);
      cases.push(scoreCase(isolatedSeamGolden, observed));
    }
    const extras = await runExtraScenarios(service, root.dataDir, async () => {
      await service?.dispose().catch(() => undefined);
      const next = createBenchmarkService(root.dataDir, agents, profiles);
      await next.start(catalogSnapshot(root.dataDir, agents, "complete", 2));
      service = next;
      return next;
    });
    const resources = monitor.stop();
    const disk = await measureDisk(root.dataDir, corpus.totalBytes, getHistoryRecallIndexPath(root.dataDir));
    return {
      mode: options.mode,
      dataDir: root.dataDir,
      sourceCount: corpus.sources.length,
      corpusBytes: corpus.totalBytes,
      cases,
      observations,
      quality: summarizeQuality(cases),
      resources,
      disk,
      lifecycle: inspectLifecycle(service),
      extras,
    };
  } finally {
    await service?.dispose().catch(() => undefined);
    if (!options.keepRoot) {
      await removeMarkedDataRoot(root.dataDir);
    }
  }
}

async function resetDerivedIndex(dataDir: string): Promise<void> {
  const db = getHistoryRecallIndexPath(dataDir);
  await Promise.all([
    rm(db, { force: true }),
    rm(`${db}-wal`, { force: true }),
    rm(`${db}-shm`, { force: true }),
  ]);
}

async function runExtraScenarios(
  service: ReturnType<typeof createBenchmarkService>,
  dataDir: string,
  reopen: () => Promise<ReturnType<typeof createBenchmarkService>>,
): Promise<CaseScore[]> {
  const paging = await pagingAppendScenario(service, dataDir);
  const rewrite = await rewriteIdentityScenario(service, dataDir);
  const restarted = await reopen();
  const restart = await restartScenario(restarted);
  const reset = await resetReplacementScenario(restarted, dataDir);
  const harness = await harnessSafetyScenario(dataDir);
  return [paging, rewrite, restart, reset, harness];
}

async function pagingAppendScenario(
  service: ReturnType<typeof createBenchmarkService>,
  dataDir: string,
): Promise<CaseScore> {
  const first = await service.search(SESSION.paging, {
    query: NEEDLE.paging,
    scope: "session",
    sessionAgentId: SESSION.paging,
    limit: 10,
  });
  const firstIds = first.results.map((hit) => hit.ref.entryId);
  const path = getSessionFilePath(dataDir, PROFILE.alpha, SESSION.paging);
  await appendFile(path, `${nativeUser("hrr-page-row-appended", `${NEEDLE.paging} appended`, TIME.september)}\n`);
  const second = first.nextCursor
    ? await service.search(SESSION.paging, {
      query: NEEDLE.paging,
      scope: "session",
      sessionAgentId: SESSION.paging,
      limit: 10,
      cursor: first.nextCursor,
    })
    : { results: [] as typeof first.results, nextCursor: undefined };
  const overlap = second.results.filter((hit) => firstIds.includes(hit.ref.entryId)).map((hit) => hit.ref.entryId);
  const cursorKind = classifyCursor(first.nextCursor);
  const stable = cursorKind !== "offset" && overlap.length === 0;
  return extraScore(
    "paging-append-shift",
    "integrity",
    stable,
    stable ? "pass" : "unstable-page",
    [
      `cursorKind=${cursorKind}`,
      overlap.length ? `second page reused ${overlap.join(",")}` : "no first-page overlap",
    ],
    "pass",
  );
}

async function rewriteIdentityScenario(
  service: ReturnType<typeof createBenchmarkService>,
  dataDir: string,
): Promise<CaseScore> {
  const path = getSessionFilePath(dataDir, PROFILE.alpha, SESSION.reset);
  const original = await readFile(path, "utf8");
  const mutated = original.replace(NEEDLE.rewriteA, NEEDLE.rewriteB).replace(ENTRY.rewriteA, ENTRY.rewriteB);
  if (Buffer.byteLength(mutated) !== Buffer.byteLength(original)) {
    return extraScore("stale-interior-rewrite-rejected", "integrity", false, "wrong-identity", ["rewrite lines were not the same size"], "pass");
  }
  const before = await service.search(SESSION.reset, { query: NEEDLE.rewriteA, scope: "session", sessionAgentId: SESSION.reset });
  const ref = before.results[0]?.ref;
  await writeFile(path, mutated);
  if (!ref) {
    return extraScore("stale-interior-rewrite-rejected", "integrity", false, "wrong-identity", ["rewrite target was not indexed"], "pass");
  }
  try {
    const read = await service.read(SESSION.reset, { ref });
    const leaked = read.entry.text.includes(NEEDLE.rewriteB) && !read.entry.text.includes(NEEDLE.rewriteA);
    return extraScore(
      "stale-interior-rewrite-rejected",
      "integrity",
      !leaked,
      leaked ? "wrong-identity" : "pass",
      leaked ? ["read returned a different canonical row for the same locator"] : [],
      "pass",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejected = /stale|mismatch|replaced|does not identify|not found/i.test(message);
    return extraScore("stale-interior-rewrite-rejected", "integrity", rejected, rejected ? "pass" : "wrong-identity", [message], "pass");
  }
}

async function restartScenario(service: ReturnType<typeof createBenchmarkService>): Promise<CaseScore> {
  const result = await service.search(SESSION.errors, {
    query: `"${NEEDLE.exactError}"`,
    scope: "session",
    sessionAgentId: SESSION.errors,
  });
  const found = result.results.some((hit) => hit.ref.entryId === ENTRY.exactError);
  return extraScore("restart-reopens-derived-cache", "readiness", found, found ? "pass" : "miss", found ? [] : ["restarted service missed exact error"], "pass");
}

async function resetReplacementScenario(
  service: ReturnType<typeof createBenchmarkService>,
  dataDir: string,
): Promise<CaseScore> {
  const path = getSessionFilePath(dataDir, PROFILE.alpha, SESSION.reset);
  await writeFile(path, [
    JSON.stringify({ type: "session", id: "reset-generation-2", version: 3, timestamp: TIME.current, cwd: "/tmp/hrr/hrr-reset" }),
    nativeUser(ENTRY.resetAfter, NEEDLE.resetAfter, TIME.september),
  ].join("\n") + "\n");
  const after = await service.search(SESSION.reset, { query: NEEDLE.resetAfter, scope: "session", sessionAgentId: SESSION.reset });
  const before = await service.search(SESSION.reset, { query: NEEDLE.resetBefore, scope: "session", sessionAgentId: SESSION.reset });
  const ok = after.results.some((hit) => hit.ref.entryId === ENTRY.resetAfter)
    && !before.results.some((hit) => hit.ref.entryId === ENTRY.resetBefore);
  return extraScore("reset-replacement-generation", "integrity", ok, ok ? "pass" : "miss", ok ? [] : ["reset did not isolate replacement generation"], "pass");
}

async function harnessSafetyScenario(dataDir: string): Promise<CaseScore> {
  const refusedDefault = await removeMarkedDataRoot("/tmp");
  const notes = [refusedDefault.reason];
  const safe = !refusedDefault.removed && dataDir.includes("forge-hrr-");
  return extraScore("harness-refuses-unmarked-roots", "integrity", safe, safe ? "pass" : "miss", notes, "pass");
}

function extraScore(
  id: string,
  gate: GoldenCase["gate"],
  meetsGolden: boolean,
  observed: CaseScore["observed"],
  notes: string[],
  expectedBaseline: CaseScore["expectedBaseline"],
): CaseScore {
  return {
    id,
    category: "integrity",
    gate,
    critical: true,
    meetsGolden,
    observed,
    expectedBaseline,
    matchesExpectedBaseline: observed === expectedBaseline || (meetsGolden && expectedBaseline === "pass"),
    notes,
    foundEntryIds: [],
    durationMs: 0,
  };
}

export function authoredGoldenIds(): string[] {
  return GOLDENS.map((entry) => entry.id);
}

export function compactGoldens(): GoldenCase[] {
  return goldensForLane("compact");
}
