import { describe, expect, it } from "vitest";
import {
  buildCodexToolMentionManagerGuidance,
  classifyCodexUserMessage,
  extractInlineCodexToolSelectors,
  isBuilderWebCodexRoutingSurface,
  parseLeadingCodexMention,
  stripInlineCodexToolTokens,
} from "../codex-app-server/codex-mention-router.js";

describe("parseLeadingCodexMention", () => {
  it("routes leading @Codex and [@Codex] tokens case-insensitively", () => {
    expect(parseLeadingCodexMention("@Codex summarize my calendar")).toEqual({
      routed: true,
      strippedText: "summarize my calendar",
    });
    expect(parseLeadingCodexMention("[@codex] summarize my calendar")).toEqual({
      routed: true,
      strippedText: "summarize my calendar",
    });
    expect(parseLeadingCodexMention("  @CODEX   hello  ")).toEqual({
      routed: true,
      strippedText: "hello",
    });
  });

  it("rejects non-leading mentions and token suffix collisions", () => {
    expect(parseLeadingCodexMention("please ask @Codex later")).toEqual({ routed: false });
    expect(parseLeadingCodexMention("@Codextra hello")).toEqual({ routed: false });
    expect(parseLeadingCodexMention("@Codex")).toEqual({ routed: true, strippedText: "" });
  });

  it("does not treat leading @Codex -selector as a sidecar turn", () => {
    expect(parseLeadingCodexMention("@Codex -fireflies summarize")).toEqual({ routed: false });
  });
});

describe("classifyCodexUserMessage", () => {
  it("classifies leading tool mentions for the manager path", () => {
    expect(classifyCodexUserMessage("@Codex -fireflies summarize meetings")).toEqual({
      kind: "manager_tool",
      selectors: ["fireflies"],
      strippedText: "summarize meetings",
    });
  });

  it("classifies inline @Codex:selector mentions for the manager path", () => {
    expect(classifyCodexUserMessage("please run @Codex:fireflies/list_recent now")).toEqual({
      kind: "manager_tool",
      selectors: ["fireflies/list_recent"],
      strippedText: "please run now",
    });
    expect(classifyCodexUserMessage("use [@Codex:fireflies] here")).toEqual({
      kind: "manager_tool",
      selectors: ["fireflies"],
      strippedText: "use here",
    });
  });

  it("keeps plain leading @Codex on the sidecar path", () => {
    expect(classifyCodexUserMessage("@Codex summarize my calendar")).toEqual({
      kind: "sidecar",
      strippedText: "summarize my calendar",
    });
  });
});

describe("extractInlineCodexToolSelectors", () => {
  it("collects unique inline selectors", () => {
    expect(extractInlineCodexToolSelectors("@Codex:one and [@Codex:two]")).toEqual(["one", "two"]);
  });
});

describe("stripInlineCodexToolTokens", () => {
  it("removes inline codex tool tokens from visible text", () => {
    expect(stripInlineCodexToolTokens("run @Codex:fireflies now")).toBe("run now");
  });
});

describe("buildCodexToolMentionManagerGuidance", () => {
  it("mentions tagged selectors for the manager runtime", () => {
    expect(buildCodexToolMentionManagerGuidance(["fireflies"])).toContain("fireflies");
    expect(buildCodexToolMentionManagerGuidance(["fireflies"])).toContain("list_codex_mcp_tools");
  });
});

describe("isBuilderWebCodexRoutingSurface", () => {
  it("allows Builder web manager sessions and excludes collab", () => {
    expect(
      isBuilderWebCodexRoutingSurface(
        { channel: "web" },
        { sessionSurface: "builder" },
      ),
    ).toBe(true);
    expect(
      isBuilderWebCodexRoutingSurface(
        { channel: "web" },
        { sessionSurface: "collab", collab: { channelId: "ch-1" } },
      ),
    ).toBe(false);
    expect(
      isBuilderWebCodexRoutingSurface(
        { channel: "cli" },
        { sessionSurface: "builder" },
      ),
    ).toBe(false);
  });
});
