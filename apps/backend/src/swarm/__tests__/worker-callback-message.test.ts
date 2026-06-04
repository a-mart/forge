import { describe, expect, it } from "vitest";
import {
  formatActionableWorkerCallbackRuntimeMessage,
  getActionableWorkerCallbackIntent,
  isActionableWorkerCallbackMessage,
} from "../worker-callback-message.js";

describe("worker callback runtime message formatting", () => {
  it("detects compact first-line completion statuses as actionable callback intents", () => {
    expect(getActionableWorkerCallbackIntent("status: done\nsummary: shipped")).toBe("done");
    expect(getActionableWorkerCallbackIntent("\n\nSTATUS: PARTIAL\nsummary: still validating")).toBe("partial");
    expect(getActionableWorkerCallbackIntent("status: blocked\nsummary: missing auth")).toBe("blocked");
    expect(isActionableWorkerCallbackMessage("routine progress update")).toBe(false);
    expect(isActionableWorkerCallbackMessage("deployment status: done\nsummary: incidental prose")).toBe(false);
    expect(isActionableWorkerCallbackMessage("summary: shipped\nstatus: done")).toBe(false);
  });

  it("adds a compact workerCallback header without changing routine progress", () => {
    expect(
      formatActionableWorkerCallbackRuntimeMessage({
        fromAgentId: "backend-worker",
        message: "status: blocked\nsummary: provider auth failed",
      }),
    ).toBe(
      'SYSTEM: [workerCallback] {"fromAgentId":"backend-worker","intent":"blocked"}\nstatus: blocked\nsummary: provider auth failed',
    );

    expect(
      formatActionableWorkerCallbackRuntimeMessage({
        fromAgentId: "backend-worker",
        message: "still scanning routes",
      }),
    ).toBe("still scanning routes");
  });
});
