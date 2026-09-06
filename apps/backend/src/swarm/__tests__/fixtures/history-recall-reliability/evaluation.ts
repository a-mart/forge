import { performance } from "node:perf_hooks";
import type { BaselineExpectation } from "./goldens.js";
import type { CaseScore } from "./scoring.js";

export const PASSIVE_READINESS_DEADLINE_MS = 2_000;
export const BASELINE_PIN_REVISION = "bbea380e-compact-diagnostic-2026-09-06";

/**
 * Diagnostic snapshot of this engine revision. Used only by explicit
 * `--eval baseline --baseline-revision <pin>`. Product goldens are unchanged.
 */
export const BASELINE_PIN: {
  revision: string;
  observed: Record<string, BaselineExpectation>;
} = {
  revision: BASELINE_PIN_REVISION,
  observed: {
    "cold-source-last-first-search": "miss",
    "worker-only-project-cold": "miss",
    "oversized-then-later-text": "coverage-lie",
  },
};

export type EvalMode = "strict" | "baseline";

export interface EvaluationResult {
  mode: EvalMode;
  ok: boolean;
  missedGoldens: string[];
  mismatchedBaseline: string[];
  remainingEngineFailures: Array<{
    id: string;
    gate: CaseScore["gate"];
    observed: BaselineExpectation;
    notes: string[];
  }>;
}

export function remainingEngineFailures(scores: readonly CaseScore[]): EvaluationResult["remainingEngineFailures"] {
  return scores
    .filter((score) => !score.meetsGolden)
    .map((score) => ({
      id: score.id,
      gate: score.gate,
      observed: score.observed,
      notes: score.notes,
    }));
}

export function evaluateStrict(scores: readonly CaseScore[]): EvaluationResult {
  const missedGoldens = scores.filter((score) => !score.meetsGolden).map((score) => score.id);
  return {
    mode: "strict",
    ok: missedGoldens.length === 0,
    missedGoldens,
    mismatchedBaseline: [],
    remainingEngineFailures: remainingEngineFailures(scores),
  };
}

export function evaluateBaseline(
  scores: readonly CaseScore[],
  pin = BASELINE_PIN,
  revision?: string,
): EvaluationResult {
  if (revision && revision !== pin.revision) {
    throw new Error(`Baseline revision mismatch: requested ${revision}, pin is ${pin.revision}`);
  }
  const mismatchedBaseline: string[] = [];
  for (const score of scores) {
    const pinned = pin.observed[score.id];
    if (pinned) {
      if (score.observed !== pinned) {
        mismatchedBaseline.push(`${score.id}:${score.observed} pin=${pinned}`);
      }
      continue;
    }
    if (!score.meetsGolden) {
      mismatchedBaseline.push(`${score.id}:unpinned miss`);
    }
  }
  return {
    mode: "baseline",
    ok: mismatchedBaseline.length === 0,
    missedGoldens: [],
    mismatchedBaseline,
    remainingEngineFailures: remainingEngineFailures(scores),
  };
}

export async function waitForPassiveReadiness(
  startedAtMs: number,
  deadlineMs = PASSIVE_READINESS_DEADLINE_MS,
): Promise<{ waitedMs: number; deadlineMs: number }> {
  const remaining = Math.max(0, deadlineMs - (performance.now() - startedAtMs));
  if (remaining > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, remaining);
    });
  }
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { waitedMs: performance.now() - startedAtMs, deadlineMs };
}

export function fakeScore(overrides: Partial<CaseScore> & Pick<CaseScore, "id">): CaseScore {
  return {
    category: "current-status",
    gate: "readiness",
    critical: true,
    meetsGolden: false,
    observed: "miss",
    expectedBaseline: "pass",
    matchesExpectedBaseline: false,
    notes: ["fake observation"],
    foundEntryIds: [],
    durationMs: 0,
    ...overrides,
  };
}
