import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CortexConsolidationRunRecord } from "@forge/protocol";
import { appendCortexConsolidationRun, readCortexConsolidationRuns } from "../cortex-consolidation-runs.js";

describe("cortex-consolidation-runs", () => {
  it("stores newest consolidation runs first and de-duplicates by run id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-consolidation-runs-"));
    await appendCortexConsolidationRun(dataDir, run("run-1", "2026-07-05T12:00:00.000Z"));
    await appendCortexConsolidationRun(dataDir, run("run-2", "2026-07-05T13:00:00.000Z"));
    await appendCortexConsolidationRun(dataDir, { ...run("run-1", "2026-07-05T14:00:00.000Z"), merged: 2 });

    expect(await readCortexConsolidationRuns(dataDir)).toMatchObject([
      { runId: "run-1", merged: 2 },
      { runId: "run-2", merged: 0 },
    ]);
  });
});

function run(runId: string, requestedAt: string): CortexConsolidationRunRecord {
  return {
    runId,
    trigger: "manual",
    status: "completed",
    requestedAt,
    completedAt: requestedAt,
    merged: 0,
    archived: 0,
    superseded: 0,
    reindexedScopes: ["global"],
    changelog: [],
  };
}
