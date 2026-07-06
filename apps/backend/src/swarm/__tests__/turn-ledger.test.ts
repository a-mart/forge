import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSessionTurnLedgerPath } from "../data-paths.js";
import {
  TURN_LEDGER_MAX_BYTES,
  appendTurnLedgerRecord,
  replayTurnLedger,
} from "../turn-ledger.js";

async function makeTarget() {
  const dataDir = await mkdtemp(join(tmpdir(), "turn-ledger-"));
  return { dataDir, profileId: "p1", sessionAgentId: "s1" };
}

describe("turn ledger", () => {
  it("replays open turns, terminal turns, pending deliveries, and acks", async () => {
    const target = await makeTarget();
    await appendTurnLedgerRecord(target, {
      t: "turn_dispatched",
      turnId: "s1:1",
      agentId: "m1",
      role: "manager",
      kind: "user",
      at: "2026-07-06T00:00:00.000Z",
    });
    await appendTurnLedgerRecord(target, {
      t: "turn_dispatched",
      turnId: "s1:2",
      agentId: "w1",
      role: "worker",
      kind: "agent_message",
      at: "2026-07-06T00:00:01.000Z",
    });
    await appendTurnLedgerRecord(target, {
      t: "turn_terminal",
      turnId: "s1:2",
      outcome: "agent_end",
      at: "2026-07-06T00:00:02.000Z",
    });
    await appendTurnLedgerRecord(target, {
      t: "delivery_pending",
      deliveryId: "d1",
      from: "w1",
      to: "m1",
      message: "done",
      at: "2026-07-06T00:00:03.000Z",
    });
    await appendTurnLedgerRecord(target, {
      t: "delivery_pending",
      deliveryId: "d2",
      from: "w2",
      to: "m1",
      at: "2026-07-06T00:00:04.000Z",
    });
    await appendTurnLedgerRecord(target, {
      t: "delivery_acked",
      deliveryId: "d2",
      at: "2026-07-06T00:00:05.000Z",
    });

    const replay = await replayTurnLedger(target);

    expect([...replay.openTurns.keys()]).toEqual(["s1:1"]);
    expect([...replay.terminalTurns.keys()]).toEqual(["s1:2"]);
    expect([...replay.pendingDeliveries.keys()]).toEqual(["d1"]);
    expect(replay.ackedDeliveries.has("d2")).toBe(true);
  });

  it("rotates at 5MB with a single .1 file", async () => {
    const target = await makeTarget();
    const ledgerPath = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId);
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "x".repeat(TURN_LEDGER_MAX_BYTES + 1), "utf8");

    await appendTurnLedgerRecord(target, {
      t: "recovery_receipt",
      receipt: "rotation_test",
      at: "2026-07-06T00:00:00.000Z",
    });

    expect((await stat(`${ledgerPath}.1`)).size).toBeGreaterThan(TURN_LEDGER_MAX_BYTES);
    const current = await readFile(ledgerPath, "utf8");
    expect(current).toContain("rotation_test");
  });
});
