import { describe, expect, it } from "vitest";
import {
  buildCodexMcpToolTurnAuthorization,
  evaluateCodexMcpCatalogBrowseGate,
  evaluateCodexMcpToolGate,
  isCodexMcpToolSelectorAuthorized,
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

  it("allows Builder web user-input surface checks", () => {
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

  it("authorizes tool calls only for manager_tool turns with selectors", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
      sessionSurface: "builder",
    });
    const surfaceGate = evaluateCodexMcpToolGate({
      manager,
      sourceContext: { channel: "web" },
      inboundSource: "user_input",
    });

    expect(
      buildCodexMcpToolTurnAuthorization({
        surfaceGate,
        codexClassification: { kind: "none" },
      }).allowed,
    ).toBe(false);

    expect(
      buildCodexMcpToolTurnAuthorization({
        surfaceGate,
        codexClassification: { kind: "manager_tool", selectors: ["fireflies/list_recent"] },
      }),
    ).toEqual({ allowed: true, authorizedSelectors: ["fireflies/list_recent"] });
  });

  it("allows catalog browsing for Builder managers without an active turn", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
      sessionSurface: "builder",
    });

    expect(evaluateCodexMcpCatalogBrowseGate({ manager }).allowed).toBe(true);
    expect(
      evaluateCodexMcpCatalogBrowseGate({
        manager: { ...manager, sessionSurface: "collab", collab: { channelId: "ch-1" } },
      }).allowed,
    ).toBe(false);
  });

  it("matches authorized selectors and derived server/tool resolutions", () => {
    const catalog = {
      selector: "fireflies/list_recent",
      serverName: "fireflies",
    };
    const resolveTool = (selector: string) => {
      if (selector === "fireflies/list_recent") {
        return catalog;
      }
      if (selector === "fireflies") {
        return catalog;
      }
      return undefined;
    };

    expect(
      isCodexMcpToolSelectorAuthorized("fireflies/list_recent", ["fireflies"], resolveTool),
    ).toBe(true);
    expect(
      isCodexMcpToolSelectorAuthorized("other/list", ["fireflies"], resolveTool),
    ).toBe(false);
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
