import type { BaselineExpectation, GoldenCase } from "./goldens.js";
import { QUALITY_RUBRIC } from "./goldens.js";

export interface ObservedHit {
  sessionAgentId?: string;
  actorAgentId?: string;
  entryId?: string;
  partId?: string;
  kind?: string;
  timestamp?: string;
  snippet?: string;
  text?: string;
  score?: number;
  toolName?: string;
  provisional?: boolean;
}

export interface ObservedResponse {
  op: GoldenCase["op"];
  hits: ObservedHit[];
  complete?: boolean;
  coverageState?: string;
  warnings?: string[];
  nextCursor?: string;
  cursorKind?: "offset" | "snapshot" | "unknown" | "none";
  error?: string;
  errorStatus?: number;
  lifecycle?: Record<string, boolean>;
  durationMs: number;
  queryCount?: number;
  startupToEvidenceMs?: number;
  passiveWaitMs?: number;
  unanchored?: boolean;
  phase?: "provisional" | "converged";
  convergedEntryIds?: string[];
  forwardEntryIds?: string[];
  phaseNotes?: string[];
}

export interface CaseScore {
  id: string;
  category: string;
  gate: GoldenCase["gate"];
  critical: boolean;
  meetsGolden: boolean;
  observed: BaselineExpectation;
  expectedBaseline: BaselineExpectation;
  matchesExpectedBaseline: boolean;
  notes: string[];
  foundEntryIds: string[];
  durationMs: number;
  queryCount?: number;
  startupToEvidenceMs?: number;
  passiveWaitMs?: number;
  unanchored?: boolean;
  phase?: "provisional" | "converged";
}

export function classifyCursor(cursor: string | undefined): ObservedResponse["cursorKind"] {
  if (!cursor) {
    return "none";
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown; snapshotId?: unknown };
    if (typeof parsed.snapshotId === "string" && parsed.snapshotId.length > 0) {
      return "snapshot";
    }
    if (typeof parsed.offset === "number") {
      return "offset";
    }
    if (parsed && typeof parsed === "object") {
      return "snapshot";
    }
  } catch {
    /* opaque non-JSON cursors are acceptable snapshot identifiers */
  }
  return cursor.length > 0 ? "unknown" : "none";
}

export function scoreCase(golden: GoldenCase, observed: ObservedResponse): CaseScore {
  const notes: string[] = [];
  const foundEntryIds = observed.hits.map((hit) => hit.entryId).filter((id): id is string => Boolean(id));
  const topN = golden.requireAllExpectedInTop ?? 10;
  const topHits = observed.hits.slice(0, topN);
  let meetsGolden = true;

  if (golden.op === "lifecycle" || golden.op === "sessions") {
    const missing = Object.entries(observed.lifecycle ?? {}).filter(([, present]) => !present).map(([name]) => name);
    if (missing.length > 0 && !observed.hits.length) {
      meetsGolden = false;
      notes.push(`missing lifecycle methods: ${missing.join(", ")}`);
      return finish(golden, observed, foundEntryIds, meetsGolden, "missing-api", notes);
    }
    if (observed.error && golden.expectedRefs.length > 0 && observed.hits.length === 0) {
      meetsGolden = false;
      notes.push(observed.error);
      return finish(golden, observed, foundEntryIds, meetsGolden, "missing-api", notes);
    }
  }

  if (golden.expectErrorIncludes) {
    if (!observed.error?.includes(golden.expectErrorIncludes)) {
      meetsGolden = false;
      notes.push(`expected error containing "${golden.expectErrorIncludes}", got ${observed.error ?? "no error"}`);
    }
    return finish(golden, observed, foundEntryIds, meetsGolden, meetsGolden ? "pass" : "miss", notes);
  }

  if (observed.error && golden.expectedRefs.length > 0) {
    meetsGolden = false;
    notes.push(observed.error);
    return finish(golden, observed, foundEntryIds, meetsGolden, "miss", notes);
  }

  if (golden.id === "provisional-seam-unanchored") {
    scoreProvisionalSeam(golden, observed, foundEntryIds, notes, (ok) => {
      meetsGolden = ok;
    });
  } else {
    for (const expected of golden.expectedRefs) {
      const match = topHits.find((hit) => hitMatches(hit, expected));
      if (!match) {
        meetsGolden = false;
        notes.push(`missing ${expected.entryId}${expected.partId ? `#${expected.partId}` : ""}`);
      }
    }
  }

  if (golden.newestFirst && golden.newestFirst.length > 1) {
    const positions = golden.newestFirst.map((id) => foundEntryIds.indexOf(id));
    if (positions.some((position) => position < 0) || positions[0]! > positions[1]!) {
      meetsGolden = false;
      notes.push(`newest order expected ${golden.newestFirst.join(" then ")}`);
    }
  }

  for (const forbidden of golden.forbiddenEntryIds ?? []) {
    if (foundEntryIds.includes(forbidden)) {
      meetsGolden = false;
      notes.push(`forbidden entry ${forbidden} appeared`);
    }
  }
  for (const text of golden.forbiddenText ?? []) {
    if (observed.hits.some((hit) => `${hit.snippet ?? ""}${hit.text ?? ""}`.includes(text))) {
      meetsGolden = false;
      notes.push(`forbidden text ${text} appeared`);
    }
  }

  if (golden.expectedComplete !== undefined && observed.complete !== golden.expectedComplete) {
    meetsGolden = false;
    notes.push(`complete=${String(observed.complete)} expected ${String(golden.expectedComplete)}`);
  }
  if (golden.coverage && observed.coverageState !== golden.coverage) {
    meetsGolden = false;
    notes.push(`coverage=${observed.coverageState ?? "absent"} expected ${golden.coverage}`);
  }
  if (golden.id === "paging-stable-under-append" && observed.cursorKind === "offset") {
    meetsGolden = false;
    notes.push("cursor is a raw BM25 offset, not a frozen snapshot");
  }
  if ((observed.queryCount ?? 1) > 1) {
    meetsGolden = false;
    notes.push(`search-driven warmup used ${observed.queryCount} queries; cold evidence must use one query after start(snapshot)`);
  }

  const observedKind = inferObserved(golden, observed, meetsGolden, notes);
  return finish(golden, observed, foundEntryIds, meetsGolden, observedKind, notes);
}

export function summarizeQuality(scores: CaseScore[]): {
  successAt10: number;
  byCategory: Record<string, number>;
  criticalFailures: string[];
  meetsRubric: boolean;
} {
  const quality = scores.filter((score) => score.gate === "quality");
  const successAt10 = ratio(quality.filter((score) => score.meetsGolden).length, quality.length);
  const byCategory: Record<string, number> = {};
  for (const category of new Set(quality.map((score) => score.category))) {
    const rows = quality.filter((score) => score.category === category);
    byCategory[category] = ratio(rows.filter((score) => score.meetsGolden).length, rows.length);
  }
  const criticalFailures = scores.filter((score) => score.critical && !score.meetsGolden).map((score) => score.id);
  const categoryFloor = Object.values(byCategory).every((value) => value >= QUALITY_RUBRIC.perCategorySuccessAt10);
  return {
    successAt10,
    byCategory,
    criticalFailures,
    meetsRubric: successAt10 >= QUALITY_RUBRIC.successAt10 && categoryFloor && criticalFailures.length === 0,
  };
}

function hitMatches(hit: ObservedHit, expected: GoldenCase["expectedRefs"][number]): boolean {
  if (expected.sessionAgentId && hit.sessionAgentId !== expected.sessionAgentId) return false;
  if (expected.actorAgentId && hit.actorAgentId !== expected.actorAgentId) return false;
  if (expected.entryId && hit.entryId !== expected.entryId) return false;
  if (expected.partId && hit.partId !== expected.partId) return false;
  if (expected.kind && hit.kind !== expected.kind) return false;
  const haystack = `${hit.snippet ?? ""} ${hit.text ?? ""}`;
  return (expected.textIncludes ?? []).every((needle) => haystack.includes(needle));
}

function inferObserved(
  golden: GoldenCase,
  observed: ObservedResponse,
  meetsGolden: boolean,
  notes: string[],
): BaselineExpectation {
  if (meetsGolden) {
    return "pass";
  }
  if ((golden.op === "lifecycle" || golden.op === "sessions") && notes.some((note) => note.includes("missing lifecycle"))) {
    return "missing-api";
  }
  if (golden.id === "paging-stable-under-append" || observed.cursorKind === "offset") {
    return "unstable-page";
  }
  if (notes.some((note) => note.includes("coverage=") || note.includes("complete="))) {
    return "coverage-lie";
  }
  if (golden.newestFirst || notes.some((note) => note.includes("newest order") || note.includes("forbidden entry"))) {
    return "wrong-rank";
  }
  if (golden.id.includes("multipart") || notes.some((note) => note.includes("partId") || note.includes("toolCall"))) {
    return "incomplete-projection";
  }
  if (golden.id.includes("longtext") || notes.some((note) => note.includes("chunk"))) {
    return "clipped";
  }
  if (observed.errorStatus === 409 || golden.id.includes("rewrite")) {
    return "wrong-identity";
  }
  if (golden.expectedRefs.length > 0 && observed.hits.length === 0) {
    return "miss";
  }
  return golden.expectedBaseline === "pass" ? "miss" : golden.expectedBaseline;
}

function finish(
  golden: GoldenCase,
  observed: ObservedResponse,
  foundEntryIds: string[],
  meetsGolden: boolean,
  observedKind: BaselineExpectation,
  notes: string[],
): CaseScore {
  return {
    id: golden.id,
    category: golden.category,
    gate: golden.gate,
    critical: golden.critical,
    meetsGolden,
    observed: observedKind,
    expectedBaseline: golden.expectedBaseline,
    matchesExpectedBaseline: observedKind === golden.expectedBaseline || (meetsGolden && golden.expectedBaseline === "pass"),
    notes,
    foundEntryIds,
    durationMs: observed.durationMs,
    queryCount: observed.queryCount,
    startupToEvidenceMs: observed.startupToEvidenceMs,
    passiveWaitMs: observed.passiveWaitMs,
    unanchored: observed.unanchored,
    phase: observed.phase,
  };
}

function scoreProvisionalSeam(
  golden: GoldenCase,
  observed: ObservedResponse,
  foundEntryIds: string[],
  notes: string[],
  setMeetsGolden: (ok: boolean) => void,
): void {
  notes.push(...(observed.phaseNotes ?? []));
  let ok = true;
  if (observed.unanchored) {
    for (const expected of golden.expectedRefs) {
      if (!foundEntryIds.includes(expected.entryId)) {
        ok = false;
        notes.push(`missing ${expected.entryId} while suffix is unanchored`);
      }
    }
    if (ok) {
      notes.push("unanchored suffix kept both native and custom mirrors");
    }
  } else {
    notes.push("bounded tail-prep already converged; dual-id assertion skipped");
    if (foundEntryIds.length === 0) {
      ok = false;
      notes.push("converged isolated seam returned no evidence");
    }
  }
  const converged = [...(observed.convergedEntryIds ?? [])].sort();
  const forward = [...(observed.forwardEntryIds ?? [])].sort();
  if (converged.length === 0 || forward.length === 0) {
    ok = false;
    notes.push("missing converged or clean-forward evidence after isolated advance");
  } else if (converged.join(",") !== forward.join(",")) {
    ok = false;
    notes.push(`converged ${converged.join(",")} did not match clean forward ${forward.join(",")}`);
  } else {
    notes.push("converged isolated seam matched clean forward projection");
  }
  setMeetsGolden(ok);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return numerator / denominator;
}
