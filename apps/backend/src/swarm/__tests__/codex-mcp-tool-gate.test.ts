import { describe, expect, it } from "vitest";
import {
  evaluateCodexMcpToolGate,
  isScheduledTaskUserMessage,
} from "../codex-app-server/codex-mcp-tool-gate.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

describe("codex-mcp-tool-gate", () => {
  it("detects scheduled task messages even when channel is web", () => {
    expect(
      isScheduledTaskUserMessage(
        '[Scheduled Task: Nightly]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nDo work',
      ),
    ).toBe(true);
  });

  it("allows Builder web user-input turns", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
      sessionSurface: "builder",
    });

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "web" },
        messageText: "@Codex -fireflies list meetings",
        inboundSource: "user_input",
      }).allowed,
    ).toBe(true);
  });

  it("rejects scheduled, collab, cli, and project-agent turns", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
      sessionSurface: "builder",
    });

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "web" },
        messageText: '[Scheduled Task: Nightly]\n[scheduleContext] {"scheduleId":"1"}',
        inboundSource: "user_input",
      }).allowed,
    ).toBe(false);

    expect(
      evaluateCodexMcpToolGate({
        manager: { ...manager, sessionSurface: "collab", collab: { channelId: "ch-1" } },
        sourceContext: { channel: "web" },
        inboundSource: "user_input",
      }).allowed,
    ).toBe(false);

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "cli" },
        inboundSource: "user_input",
      }).allowed,
    ).toBe(false);

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "web" },
        inboundSource: "project_agent_input",
      }).allowed,
    ).toBe(false);
  });
});
