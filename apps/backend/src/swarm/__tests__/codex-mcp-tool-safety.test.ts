import { describe, expect, it } from "vitest";
import {
  assertCodexMcpToolReadOnlyAllowed,
  classifyCodexMcpToolSafety,
} from "../codex-app-server/codex-mcp-tool-safety.js";
import type { CodexCatalogMcpTool } from "../codex-app-server/codex-mcp-catalog.js";

function tool(overrides: Partial<CodexCatalogMcpTool>): CodexCatalogMcpTool {
  return {
    selector: "fireflies/list_recent",
    serverName: "fireflies",
    toolName: "list_recent",
    ...overrides,
  };
}

describe("codex-mcp-tool-safety", () => {
  it("allows read-only annotated tools", () => {
    expect(
      classifyCodexMcpToolSafety(
        tool({
          readOnly: true,
          annotations: { readOnlyHint: true },
        }),
      ).allowed,
    ).toBe(true);
  });

  it("rejects destructive and unannotated tools", () => {
    expect(classifyCodexMcpToolSafety(tool({ destructive: true })).allowed).toBe(false);
    expect(classifyCodexMcpToolSafety(tool({ toolName: "delete_item" })).allowed).toBe(false);
    expect(classifyCodexMcpToolSafety(tool({ description: "Update calendar event" })).allowed).toBe(
      false,
    );
  });

  it("throws on blocked tools", () => {
    expect(() => assertCodexMcpToolReadOnlyAllowed(tool({ toolName: "send_email" }))).toThrow(
      /blocked/i,
    );
  });
});
