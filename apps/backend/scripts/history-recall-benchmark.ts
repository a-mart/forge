#!/usr/bin/env npx tsx
/**
 * Opt-in history-recall reliability runner.
 *
 * Default mode is the compact synthetic corpus used by Vitest. 200MB-class and
 * ~9GB-class corpora require --mode giant|scale and --confirm-large.
 *
 * The runner creates a marked disposable tmp root and will only delete that
 * root. It never reads FORGE_DATA_DIR, live transcripts, or secrets.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLargeModeConfirmed,
  runReliabilitySuite,
  type CorpusMode,
} from "../src/swarm/__tests__/fixtures/history-recall-reliability/index.js";

interface Args {
  mode: CorpusMode;
  confirmLarge: boolean;
  keepRoot: boolean;
  report: string;
  giantPadBytes: number;
  scalePadBytes: number;
  scaleSourceCount: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "compact",
    confirmLarge: false,
    keepRoot: false,
    report: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../.internal/history-recall/implementation/benchmarks/last-run.json",
    ),
    giantPadBytes: 200 * 1024 * 1024,
    scalePadBytes: 96 * 1024 * 1024,
    scaleSourceCount: 96,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--mode" && next) {
      args.mode = next as CorpusMode;
      i += 1;
    } else if (token === "--confirm-large") {
      args.confirmLarge = true;
    } else if (token === "--keep-root") {
      args.keepRoot = true;
    } else if (token === "--report" && next) {
      args.report = resolve(next);
      i += 1;
    } else if (token === "--giant-pad-bytes" && next) {
      args.giantPadBytes = Number(next);
      i += 1;
    } else if (token === "--scale-pad-bytes" && next) {
      args.scalePadBytes = Number(next);
      i += 1;
    } else if (token === "--scale-source-count" && next) {
      args.scaleSourceCount = Number(next);
      i += 1;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!["compact", "giant", "scale"].includes(args.mode)) {
    throw new Error(`Unknown mode ${args.mode}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm exec tsx scripts/history-recall-benchmark.ts [options]

Options:
  --mode compact|giant|scale   Corpus lane (default compact)
  --confirm-large              Required for giant/scale; never implied
  --keep-root                  Leave the marked tmp root in place
  --report <path>              JSON report path
  --giant-pad-bytes <n>        Giant source size (default 209715200)
  --scale-pad-bytes <n>        Per-source scale padding (default 100663296)
  --scale-source-count <n>     Scale source count (default 96)

Safety:
  Creates os.tmpdir()/forge-hrr-* with a marker file.
  Cleanup deletes only that marked root.
  Refuses FORGE_DATA_DIR / MIDDLEMAN_DATA_DIR / unmarked paths.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertLargeModeConfirmed(args.mode, args.confirmLarge);
  const started = Date.now();
  const report = await runReliabilitySuite({
    mode: args.mode,
    confirmLarge: args.confirmLarge,
    keepRoot: args.keepRoot,
    giantPadBytes: args.giantPadBytes,
    scalePadBytes: args.scalePadBytes,
    scaleSourceCount: args.scaleSourceCount,
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    mode: report.mode,
    sourceCount: report.sourceCount,
    corpusBytes: report.corpusBytes,
    lifecycle: report.lifecycle,
    quality: report.quality,
    resources: report.resources ? {
      durationMs: report.resources.durationMs,
      eventLoopP99Ms: report.resources.eventLoopP99Ms,
      eventLoopMaxMs: report.resources.eventLoopMaxMs,
      cpuUserMs: report.resources.cpuUserMs,
      cpuSystemMs: report.resources.cpuSystemMs,
      rssPeakBytes: report.resources.rssPeakBytes,
    } : undefined,
    disk: report.disk,
    gates: summarizeGates([...report.cases, ...report.extras]),
    cases: [...report.cases, ...report.extras].map((entry) => ({
      id: entry.id,
      gate: entry.gate,
      category: entry.category,
      meetsGolden: entry.meetsGolden,
      observed: entry.observed,
      expectedBaseline: entry.expectedBaseline,
      matchesExpectedBaseline: entry.matchesExpectedBaseline,
      notes: entry.notes,
      foundEntryIds: entry.foundEntryIds,
      durationMs: entry.durationMs,
    })),
    note: "This runner compares authored goldens to the current engine. Compact baseline reds are expected until the engine/lifecycle work lands. A matching baseline is not a product pass.",
  };
  await mkdir(dirname(args.report), { recursive: true });
  await writeFile(args.report, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    report: args.report,
    mode: report.mode,
    sourceCount: report.sourceCount,
    corpusBytes: report.corpusBytes,
    qualityMeetsRubric: report.quality.meetsRubric,
    baselineMatched: payload.cases.every((entry) => entry.matchesExpectedBaseline),
    eventLoopP99Ms: payload.resources?.eventLoopP99Ms,
    rssPeakBytes: payload.resources?.rssPeakBytes,
    disk: report.disk,
  }, null, 2));
}

function summarizeGates(cases: Array<{ gate: string; meetsGolden: boolean; matchesExpectedBaseline: boolean }>) {
  const gates = ["quality", "readiness", "integrity", "resources"] as const;
  return Object.fromEntries(gates.map((gate) => {
    const rows = cases.filter((entry) => entry.gate === gate);
    return [gate, {
      total: rows.length,
      meetsGolden: rows.filter((entry) => entry.meetsGolden).length,
      matchesExpectedBaseline: rows.filter((entry) => entry.matchesExpectedBaseline).length,
    }];
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
