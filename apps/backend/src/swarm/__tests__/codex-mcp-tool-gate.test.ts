import { describe, expect, it } from "vitest";
import {
  buildCodexMcpToolTurnAuthorization,
  evaluateCodexMcpCatalogBrowseGate,
  evaluateCodexMcpToolGate,
  isCodexMcpToolSelectorAuthorized,
  isScheduledTaskUserMessage,
} from "../codex-app-server/codex-mcp-tool-gate.js";
import { CodexMcpCatalog, type CodexCatalogSnapshot } from "../codex-app-server/codex-mcp-catalog.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

function buildCatalogSnapshot(): CodexCatalogSnapshot {
  return {
    apps: [{ id: "fireflies", name: "Fireflies" }],
    plugins: [
      {
        selector: "fireflies",
        pluginId: "fireflies",
        displayName: "Fireflies",
        relatedServerNames: ["fireflies"],
      },
      {
        selector: "repo-prompt",
        pluginId: "repo-prompt",
        displayName: "RepoPrompt",
        relatedServerNames: ["RepoPrompt"],
      },
    ],
    tools: [
      {
        selector: "fireflies/list_recent",
        serverName: "fireflies",
        toolName: "list_recent",
        readOnly: true,
      },
      {
        selector: "RepoPrompt/get_code_structure",
        serverName: "RepoPrompt",
        toolName: "get_code_structure",
        readOnly: true,
      },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("codex-mcp-tool-gate", () => {
  const catalogSnapshot = buildCatalogSnapshot();
  const catalogResolver = new CodexMcpCatalog(async () => {
    throw new Error("catalog resolver should not fetch in gate tests");
  });

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

  it("authorizes RepoPrompt/get_code_structure when tagged inline", () => {
    expect(
      isCodexMcpToolSelectorAuthorized(
        "RepoPrompt/get_code_structure",
        ["RepoPrompt/get_code_structure"],
        catalogSnapshot,
        catalogResolver,
      ),
    ).toBe(true);
  });

  it("authorizes plugin-scoped selectors for tools within that plugin", () => {
    expect(
      isCodexMcpToolSelectorAuthorized(
        "fireflies/list_recent",
        ["fireflies"],
        catalogSnapshot,
        catalogResolver,
      ),
    ).toBe(true);
    expect(
      isCodexMcpToolSelectorAuthorized(
        "RepoPrompt/get_code_structure",
        ["fireflies"],
        catalogSnapshot,
        catalogResolver,
      ),
    ).toBe(false);
  });

  it("matches explicit tool selectors and rejects unrelated servers", () => {
    expect(
      isCodexMcpToolSelectorAuthorized(
        "fireflies/list_recent",
        ["fireflies/list_recent"],
        catalogSnapshot,
        catalogResolver,
      ),
    ).toBe(true);
    expect(
      isCodexMcpToolSelectorAuthorized(
        "other/list",
        ["fireflies"],
        catalogSnapshot,
        catalogResolver,
      ),
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
