import { describe, expect, it } from "vitest";
import { ManagerToolActivityState } from "../manager-tool-activity.js";

describe("ManagerToolActivityState", () => {
  it("counts distinct starts only for the authoritative manager turn and emits no tool detail", () => {
    const state = new ManagerToolActivityState();

    expect(state.recordToolStart({
      sessionAgentId: "manager-1",
      turnId: "turn-1",
      toolCallId: "tool-id-that-must-not-leak",
      toolName: "bash",
    })).toBeNull();

    const activation = state.activate("manager-1", "turn-1");
    const first = state.recordToolStart({
      sessionAgentId: "manager-1",
      turnId: "turn-1",
      toolCallId: "tool-id-that-must-not-leak",
      toolName: " Bash   Command ",
    });
    const duplicate = state.recordToolStart({
      sessionAgentId: "manager-1",
      turnId: "turn-1",
      toolCallId: "tool-id-that-must-not-leak",
      toolName: "bash command",
    });
    const second = state.recordToolStart({
      sessionAgentId: "manager-1",
      turnId: "turn-1",
      toolCallId: "tool-id-2",
      toolName: "Read_File",
    });

    expect(activation).toEqual({
      type: "manager_tool_activity",
      sessionAgentId: "manager-1",
      revision: 1,
      toolCount: 0,
    });
    expect(first).toEqual({
      type: "manager_tool_activity",
      sessionAgentId: "manager-1",
      revision: 2,
      toolCount: 1,
      currentToolName: "bash-command",
    });
    expect(duplicate).toBeNull();
    expect(second).toEqual({
      type: "manager_tool_activity",
      sessionAgentId: "manager-1",
      revision: 3,
      toolCount: 2,
      currentToolName: "read_file",
    });
    expect(JSON.stringify(second)).not.toContain("tool-id");
    expect(Object.keys(second ?? {})).toEqual([
      "type",
      "sessionAgentId",
      "revision",
      "toolCount",
      "currentToolName",
    ]);
  });

  it("resets for a newly activated inbound turn, survives provider turn boundaries, and clears terminal state monotonically", () => {
    const state = new ManagerToolActivityState();
    state.activate("manager-1", "turn-1");
    state.recordToolStart({
      sessionAgentId: "manager-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
    });

    // Provider turn_end is deliberately not a state transition for this indicator.
    expect(state.buildSnapshotEvent("manager-1")).toMatchObject({ revision: 2, toolCount: 1 });

    const secondTurn = state.activate("manager-1", "turn-2");
    const terminal = state.clear("manager-1");

    expect(secondTurn).toEqual({
      type: "manager_tool_activity",
      sessionAgentId: "manager-1",
      revision: 3,
      toolCount: 0,
    });
    expect(terminal).toEqual({
      type: "manager_tool_activity",
      sessionAgentId: "manager-1",
      revision: 4,
      toolCount: 0,
    });
    expect(state.buildSnapshotEvent("manager-1")).toMatchObject({ revision: 4, toolCount: 0 });
  });
});
