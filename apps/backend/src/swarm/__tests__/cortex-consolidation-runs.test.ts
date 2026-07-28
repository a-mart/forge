import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CortexConsolidationRunRecord } from "@forge/protocol";
import { appendCortexConsolidationRun, readCortexConsolidationRuns } from "../cortex-consolidation-runs.js";
import { getCortexConsolidationRunsPath } from "../data-paths.js";

describe("cortex-consolidation-runs", () => {
  it("caps retained runs and filters malformed records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-consolidation-runs-cap-"));
    for (let index = 0; index < 35; index += 1) {
      await appendCortexConsolidationRun(dataDir, run(`run-${index}`, `2026-07-05T${String(index).padStart(2, "0")}:00:00.000Z`));
    }
    const retained = await readCortexConsolidationRuns(dataDir);
    expect(retained).toHaveLength(30);
    expect(retained[0]?.runId).toBe("run-34");
    expect(retained.at(-1)?.runId).toBe("run-5");

    await writeFile(getCortexConsolidationRunsPath(dataDir), JSON.stringify({ version: 99, runs: [run("valid", "2026-07-06T00:00:00.000Z"), { runId: "broken" }, null] }), "utf8");
    expect(await readCortexConsolidationRuns(dataDir)).toEqual([run("valid", "2026-07-06T00:00:00.000Z")]);
    await appendCortexConsolidationRun(dataDir, run("new", "2026-07-06T01:00:00.000Z"));
    expect(await readCortexConsolidationRuns(dataDir)).toMatchObject([{ runId: "new" }, { runId: "valid" }]);
  });

  it("falls back to an empty run list for corrupt storage", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-consolidation-runs-corrupt-"));
    const path = getCortexConsolidationRunsPath(dataDir);
    await mkdir(join(dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(path, "not-json", "utf8");
    expect(await readCortexConsolidationRuns(dataDir)).toEqual([]);
  });

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
