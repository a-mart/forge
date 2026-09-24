import { describe, expect, it } from "vitest";
import {
  handleCodexAppServerServerRequest,
} from "../codex-app-server/codex-app-server-request-handlers.js";

describe("codex app-server server request handlers", () => {
  it("declines command execution approvals fail-closed", () => {
    expect(
      handleCodexAppServerServerRequest({
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf /" },
      }),
    ).toEqual({ decision: "decline" });
  });

  it("declines file change approvals fail-closed", () => {
    expect(
      handleCodexAppServerServerRequest({
        method: "item/fileChange/requestApproval",
        params: { path: "/etc/passwd" },
      }),
    ).toEqual({ decision: "decline" });
  });

  it("declines MCP elicitation requests with action decline", () => {
    expect(
      handleCodexAppServerServerRequest({
        method: "mcpServer/elicitation/request",
        params: { prompt: "Allow Codex to use Google Chrome?" },
      }),
    ).toEqual({ action: "decline" });
  });

  it("throws for unsupported server requests", () => {
    expect(() =>
      handleCodexAppServerServerRequest({
        method: "item/tool/call",
        params: {},
      }),
    ).toThrow(/Unsupported Codex app-server server request/);
  });
});
