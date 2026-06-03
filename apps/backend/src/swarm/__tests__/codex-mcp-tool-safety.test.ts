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

  it("rejects destructive, open-world, and unannotated tools", () => {
    expect(classifyCodexMcpToolSafety(tool({ destructive: true })).allowed).toBe(false);
    expect(classifyCodexMcpToolSafety(tool({ toolName: "delete_item" })).allowed).toBe(false);
    expect(classifyCodexMcpToolSafety(tool({ description: "Update calendar event" })).allowed).toBe(
      false,
    );
    expect(
      classifyCodexMcpToolSafety(
        tool({ readOnly: true, annotations: { readOnlyHint: true, openWorldHint: true } }),
      ).allowed,
    ).toBe(false);
  });

  it("rejects separator and camel-case denied tool names even when read-only annotated", () => {
    for (const toolName of ["send_email", "delete-item", "browser_open", "computer_use", "fileRead"]) {
      expect(
        classifyCodexMcpToolSafety(
          tool({ toolName, readOnly: true, annotations: { readOnlyHint: true } }),
        ).allowed,
      ).toBe(false);
    }
  });

  it("allows narrow read-only Fireflies transcript download tools without allowing destructive downloads", () => {
    expect(
      classifyCodexMcpToolSafety(
        tool({
          selector: "codex_apps/fireflies_fireflies_download_transcript",
          serverName: "codex_apps",
          toolName: "fireflies_fireflies_download_transcript",
          description: "Download transcript text for a Fireflies meeting",
          readOnly: true,
          annotations: { readOnlyHint: true },
        }),
      ).allowed,
    ).toBe(true);

    expect(
      classifyCodexMcpToolSafety(
        tool({
          selector: "codex_apps/fireflies_fireflies_download_transcript",
          serverName: "codex_apps",
          toolName: "fireflies_fireflies_download_transcript",
          description: "Download transcript text for a Fireflies meeting",
          readOnly: true,
          annotations: { readOnlyHint: true, openWorldHint: true },
        }),
      ).allowed,
    ).toBe(false);

    expect(
      classifyCodexMcpToolSafety(
        tool({
          selector: "files/download_transcript",
          serverName: "files",
          toolName: "download_transcript",
          description: "Download transcript file",
          readOnly: true,
          annotations: { readOnlyHint: true },
        }),
      ).allowed,
    ).toBe(false);
  });

  it("throws on blocked tools", () => {
    expect(() => assertCodexMcpToolReadOnlyAllowed(tool({ toolName: "send_email" }))).toThrow(
      /blocked/i,
    );
  });
});
