import { describe, expect, it } from "vitest";
import {
  isBuilderWebCodexRoutingSurface,
  parseLeadingCodexMention,
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
