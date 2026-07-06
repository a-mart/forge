import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCortexReviewLogEntry, readCortexReviewLogEntries } from "../swarm/scripts/cortex-review-state.js";

describe("cortex consolidation changelog", () => {
  it("appends compact changelog entries and ignores malformed lines", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-consolidation-log-"));
    await appendCortexReviewLogEntry({
      dataDir,
      entry: {
        runId: "run-1",
        action: "merged",
        entryId: "preference-alpha",
        sourceEntryIds: ["preference-alpha", "preference-beta", "preference-alpha"],
        why: "duplicate title",
        recordedAt: "2026-07-05T12:00:00.000Z",
      },
    });

    expect(await readCortexReviewLogEntries(dataDir)).toEqual([
      {
        runId: "run-1",
        action: "merged",
        entryId: "preference-alpha",
        sourceEntryIds: ["preference-alpha", "preference-beta"],
        why: "duplicate title",
        recordedAt: "2026-07-05T12:00:00.000Z",
      },
    ]);
  });
});
