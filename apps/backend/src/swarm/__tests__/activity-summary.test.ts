import { describe, expect, it } from "vitest";
import { buildActivitySummary } from "../session/activity-summary.js";

function toolEnd(toolName: string, isError = false) {
  return {
    type: "conversation_log" as const,
    kind: "tool_execution_end" as const,
    agentId: "manager-a",
    timestamp: "2026-01-01T00:00:00.000Z",
    toolCallId: `call-${toolName}`,
    toolName,
    isError,
  };
}

describe("buildActivitySummary", () => {
  it("distinguishes host and secure Bash activity", () => {
    expect(buildActivitySummary(toolEnd("bash"))?.displaySummary).toBe(
      "Ran host command",
    );
    expect(buildActivitySummary(toolEnd("secure_bash"))?.displaySummary).toBe(
      "Ran secure command",
    );
    expect(buildActivitySummary(toolEnd("secure_bash", true))?.displaySummary).toBe(
      "Secure command failed",
    );
  });
});
