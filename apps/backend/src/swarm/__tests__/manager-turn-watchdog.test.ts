import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDescriptor } from "../../test-support/index.js";
import { getSessionTurnLedgerPath } from "../data-paths.js";
import {
  MANAGER_TURN_ESCALATE_MS,
  MANAGER_TURN_NOTICE_MS,
  MANAGER_TURN_RECYCLE_OFFER_MS,
  ManagerTurnWatchdog,
} from "../manager-turn-watchdog.js";
import type { AgentDescriptor, ConversationMessageEvent } from "../types.js";

async function setup(status: AgentDescriptor["status"] = "streaming") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
  const dataDir = await mkdtemp(join(tmpdir(), "manager-turn-watchdog-"));
  const manager = createAgentDescriptor({
    agentId: "m1",
    managerId: "m1",
    profileId: "p1",
    role: "manager",
    status,
  });
  const descriptors = new Map<string, AgentDescriptor>([[manager.agentId, manager]]);
  const emitted: ConversationMessageEvent[] = [];
  const recycleOffers: string[] = [];
  const watchdog = new ManagerTurnWatchdog({
    dataDir,
    descriptors,
    now: () => new Date(Date.now()).toISOString(),
    getSessionTarget: () => ({ dataDir, profileId: "p1", sessionAgentId: "m1" }),
    getActiveTurnId: (_agentId, runtimeToken) => (runtimeToken === 2 ? undefined : "m1:1"),
    isRuntimeRecoveryActive: () => false,
    emitConversationMessage: (event) => emitted.push(event),
    offerRuntimeRecycle: (agentId) => recycleOffers.push(agentId),
    logDebug: vi.fn(),
  });
  return { dataDir, descriptors, watchdog, emitted, recycleOffers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ManagerTurnWatchdog", () => {
  it("fires the ladder past the recycle ceiling even while a manager tool call hangs open", async () => {
    const { watchdog, emitted, recycleOffers } = await setup();
    watchdog.recordStatus("m1", 1, "streaming", 0);
    watchdog.recordEvent("m1", 1, { type: "tool_execution_start", toolCallId: "hung-tool", toolName: "bash", args: {} });

    vi.advanceTimersByTime(MANAGER_TURN_ESCALATE_MS + 1);
    watchdog.check();
    expect(emitted).toHaveLength(0); // paused while the tool runs

    vi.advanceTimersByTime(MANAGER_TURN_RECYCLE_OFFER_MS);
    watchdog.check();
    expect(emitted.length).toBeGreaterThan(0); // hung tool cannot hide forever
    expect(recycleOffers).toContain("m1");
  });

  it("arms on accepted manager streaming status and disarms on terminal", async () => {
    const { watchdog, emitted } = await setup();
    watchdog.recordStatus("m1", 1, "streaming", 0);
    watchdog.recordTerminal("m1", "agent_end");

    vi.advanceTimersByTime(MANAGER_TURN_NOTICE_MS + 1);
    watchdog.check();

    expect(emitted).toHaveLength(0);
  });

  it("ignores stale-token status that cannot resolve the active turn id", async () => {
    const { watchdog, emitted } = await setup();
    watchdog.recordStatus("m1", 2, "streaming", 0);

    vi.advanceTimersByTime(MANAGER_TURN_NOTICE_MS + 1);
    watchdog.check();

    expect(emitted).toHaveLength(0);
  });

  it("emits 30s and 5m notices with ledger receipts", async () => {
    const { dataDir, watchdog, emitted } = await setup();
    watchdog.recordStatus("m1", 1, "streaming", 0);

    vi.advanceTimersByTime(MANAGER_TURN_NOTICE_MS + 1);
    watchdog.check();
    vi.advanceTimersByTime(MANAGER_TURN_ESCALATE_MS - MANAGER_TURN_NOTICE_MS);
    watchdog.check();

    expect(emitted.map((event) => event.text)).toEqual([
      expect.stringContaining("Still working"),
      expect.stringContaining("may be stuck"),
    ]);
    let ledger = "";
    await vi.waitFor(async () => {
      ledger = await readFile(getSessionTurnLedgerPath(dataDir, "p1", "m1"), "utf8");
      expect(ledger).toContain('"tier":2');
    });
    expect(ledger).toContain('"t":"turn_stalled"');
    expect(ledger).toContain('"tier":1');
    expect(ledger).toContain('"tier":2');
  });

  it("pauses tier escalation while a manager tool call is executing", async () => {
    const { watchdog, emitted } = await setup();
    watchdog.recordStatus("m1", 1, "streaming", 0);
    watchdog.recordEvent("m1", 1, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });

    vi.advanceTimersByTime(MANAGER_TURN_ESCALATE_MS + 1);
    watchdog.check();
    expect(emitted).toHaveLength(0);

    watchdog.recordEvent("m1", 1, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: "ok", isError: false });
    vi.advanceTimersByTime(MANAGER_TURN_NOTICE_MS + 1);
    watchdog.check();
    expect(emitted).toHaveLength(1);
  });

  it("offers recycle once at tier 3", async () => {
    const { watchdog, recycleOffers } = await setup();
    watchdog.recordStatus("m1", 1, "streaming", 0);

    vi.advanceTimersByTime(MANAGER_TURN_RECYCLE_OFFER_MS + 1);
    watchdog.check();
    watchdog.check();

    expect(recycleOffers).toEqual(["m1"]);
  });
});
