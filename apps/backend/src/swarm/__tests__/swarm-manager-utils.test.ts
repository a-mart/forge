import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ConversationMessageEvent
} from "../types.js";
import {
  analyzeLatestCortexCloseoutNeed,
  areContextUsagesEqual,
  buildModelCapacityBlockKey,
  buildSessionMemoryRuntimeView,
  buildWorkerCompletionReport,
  clampModelCapacityBlockDurationMs,
  cloneDescriptor,
  cloneProjectAgentInfoValue,
  compareRuntimeExtensionSnapshots,
  createDeferred,
  errorToMessage,
  escapeXmlForPreview,
  extractDescriptorAgentId,
  extractRuntimeMessageText,
  extractVersionedToolPath,
  finalizeMergedMemoryContent,
  formatBinaryAttachmentForPrompt,
  formatInboundUserMessageForManager,
  formatTextAttachmentForPrompt,
  formatToolExecutionPayload,
  hashMemoryMergeContent,
  isEnoentError,
  isPostApplyFailureStage,
  isRecord,
  isVersionedWriteToolName,
  normalizeAgentId,
  normalizeContextUsage,
  normalizeConversationAttachments,
  normalizeCortexUserVisiblePaths,
  normalizeMemoryMergeContent,
  normalizeMemoryTemplateLines,
  normalizeMessageSourceContext,
  normalizeMessageTargetContext,
  normalizeOptionalAgentId,
  normalizeOptionalAttachmentPath,
  normalizeOptionalModelId,
  normalizeThinkingLevelForProvider,
  nowIso,
  parseCompactSlashCommand,
  parseSessionNumberFromAgentId,
  parseTimestampToMillis,
  previewForLog,
  readFileHead,
  readPositiveIntegerDetail,
  readStringDetail,
  resolveExactModel,
  resolveModel,
  resolveNextCapacityFallbackModelId,
  safeJson,
  sanitizeAttachmentFileName,
  sanitizePathSegment,
  shouldRetrySpecialistSpawnWithFallback,
  slugifySessionName,
  toConversationAttachmentMetadata,
  toDisplayToolName,
  toRuntimeDispatchAttachments,
  toRuntimeImageAttachments,
  trimToMaxChars,
  trimToMaxCharsFromEnd,
  validateAgentDescriptor,
  withManagerTimeout
} from "../swarm-manager-utils.js";

function baseDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "mgr-1",
    displayName: "Manager",
    role: "manager",
    managerId: "mgr-1",
    status: "idle",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    cwd: "/tmp",
    sessionFile: "/tmp/session.jsonl",
    model: {
      provider: "openai",
      modelId: "gpt-4",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

describe("isRecord / extractDescriptorAgentId", () => {
  it("isRecord distinguishes objects from arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it.each([
    [{ agentId: "  abc  " }, "abc"],
    [{ agentId: "" }, undefined],
    [{}, undefined],
    [null, undefined]
  ])("extractDescriptorAgentId(%j) -> %j", (input, expected) => {
    expect(extractDescriptorAgentId(input)).toBe(expected);
  });
});

describe("isEnoentError", () => {
  it("detects ENOENT code", () => {
    expect(isEnoentError({ code: "ENOENT" })).toBe(true);
    expect(isEnoentError({ code: "ENOTFOUND" })).toBe(false);
    expect(isEnoentError(new Error("fail"))).toBe(false);
  });
});

describe("parseSessionNumberFromAgentId", () => {
  const profile = "my-profile";

  it.each([
    [`${profile}--s2`, 2],
    [`${profile}--s10`, 10],
    [`${profile}--s1`, undefined],
    [`${profile}--s0`, undefined],
    [`${profile}--sx`, undefined],
    ["other--s2", undefined]
  ])("%s -> %j", (agentId, expected) => {
    expect(parseSessionNumberFromAgentId(agentId, profile)).toBe(expected);
  });
});

describe("slugifySessionName", () => {
  it.each([
    ["  Hello World  ", "hello-world"],
    ["Foo!!! Bar", "foo-bar"],
    ["a--b---c", "a-b-c"],
    ["___", ""]
  ])("%j -> %j", (input, expected) => {
    expect(slugifySessionName(input)).toBe(expected);
  });
});

describe("normalizeAgentId", () => {
  it("lowercases, collapses separators, and caps length", () => {
    expect(normalizeAgentId("  Ab_Cd  ")).toBe("ab-cd");
    const long = "a".repeat(100);
    expect(normalizeAgentId(long).length).toBe(48);
  });

  it("throws on path-like characters", () => {
    expect(() => normalizeAgentId("a/b")).toThrow(/invalid characters/);
    expect(() => normalizeAgentId("a\\b")).toThrow(/invalid characters/);
  });
});

describe("normalizeOptionalAgentId / normalizeOptionalModelId", () => {
  it("returns undefined for empty or non-strings", () => {
    expect(normalizeOptionalAgentId(undefined)).toBeUndefined();
    expect(normalizeOptionalAgentId("   ")).toBeUndefined();
    expect(normalizeOptionalModelId("  x  ")).toBe("x");
  });
});

describe("buildModelCapacityBlockKey / resolveNextCapacityFallbackModelId", () => {
  it("builds provider/model key when both present", () => {
    expect(buildModelCapacityBlockKey(" OpenAI ", " GPT-5 ")).toBe("openai/gpt-5");
    expect(buildModelCapacityBlockKey("", "m")).toBeUndefined();
  });

  it.each([
    ["openai-codex", "gpt-5.3-codex-spark", "gpt-5.3-codex"],
    ["openai-codex", "gpt-5.3-codex", "gpt-5.4"],
    ["openai-codex", "gpt-5.4", "gpt-5.5"],
    ["openai-codex", "gpt-5.5", undefined],
    ["anthropic", "gpt-5.3-codex", undefined],
    ["openai-codex", "unknown-model", undefined]
  ])("resolveNextCapacityFallbackModelId(%s, %s) -> %j", (provider, modelId, expected) => {
    expect(resolveNextCapacityFallbackModelId(provider, modelId)).toBe(expected);
  });
});

describe("shouldRetrySpecialistSpawnWithFallback", () => {
  it("returns true for auth-related messages", () => {
    expect(
      shouldRetrySpecialistSpawnWithFallback(new Error("authentication failed"), {
        provider: "x",
        modelId: "y"
      })
    ).toBe(true);
  });

  it("returns true when error mentions provider, model, and auth", () => {
    expect(
      shouldRetrySpecialistSpawnWithFallback(new Error("openai gpt-4 auth failure"), {
        provider: "openai",
        modelId: "gpt-4"
      })
    ).toBe(true);
  });
});

describe("clampModelCapacityBlockDurationMs", () => {
  it.each([
    [0, undefined],
    [NaN, undefined],
    [4_000, 5_000],
    [6_000, 6_000],
    [8 * 24 * 60 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000]
  ])("clampModelCapacityBlockDurationMs(%s)", (input, expected) => {
    expect(clampModelCapacityBlockDurationMs(input)).toBe(expected);
  });
});

describe("normalizeThinkingLevelForProvider", () => {
  it("maps Anthropic aliases", () => {
    expect(normalizeThinkingLevelForProvider("anthropic", "none")).toBe("low");
    expect(normalizeThinkingLevelForProvider("anthropic", "xhigh")).toBe("high");
    expect(normalizeThinkingLevelForProvider("anthropic", "X-HIGH")).toBe("high");
  });

  it("passes through for non-Anthropic", () => {
    expect(normalizeThinkingLevelForProvider("openai", "none")).toBe("none");
  });
});

describe("memory merge helpers", () => {
  it("normalizeMemoryMergeContent trims CRLF and trailing whitespace", () => {
    expect(normalizeMemoryMergeContent("a\r\nb  \n  ")).toBe("a\nb");
  });

  it("finalizeMergedMemoryContent adds trailing newline when non-empty", () => {
    expect(finalizeMergedMemoryContent("x")).toBe("x\n");
    expect(finalizeMergedMemoryContent("")).toBe("");
  });

  it("hashMemoryMergeContent is stable sha256 of normalized content", () => {
    const h = hashMemoryMergeContent("a\r\nb");
    expect(h).toBe(createHash("sha256").update("a\nb").digest("hex"));
  });

  it("normalizeMemoryTemplateLines drops empty lines and normalizes newlines", () => {
    expect(normalizeMemoryTemplateLines("a\r\n\nb\n")).toEqual(["a", "b"]);
  });
});

describe("buildSessionMemoryRuntimeView", () => {
  it("joins profile and session blocks with separators", () => {
    const out = buildSessionMemoryRuntimeView("profile", "session");
    expect(out).toContain("# Manager Memory");
    expect(out).toContain("profile");
    expect(out).toContain("# Session Memory");
    expect(out).toContain("session");
    expect(out).toContain("---");
  });
});

describe("isPostApplyFailureStage", () => {
  it.each([
    ["refresh_session_meta_stats", true],
    ["record_attempt", true],
    ["write_audit", true],
    ["save_store", true],
    ["merge_session", false]
  ] as const)("%s -> %s", (stage, expected) => {
    expect(isPostApplyFailureStage(stage)).toBe(expected);
  });
});

describe("normalizeContextUsage / areContextUsagesEqual", () => {
  it("rejects invalid usage shapes", () => {
    expect(normalizeContextUsage(undefined)).toBeUndefined();
    expect(
      normalizeContextUsage({ tokens: -1, contextWindow: 100, percent: 50 })
    ).toBeUndefined();
    expect(
      normalizeContextUsage({ tokens: 10, contextWindow: 0, percent: 50 })
    ).toBeUndefined();
  });

  it("clamps percent and rounds tokens", () => {
    expect(
      normalizeContextUsage({ tokens: 10.4, contextWindow: 99.2, percent: 150 })
    ).toEqual({
      tokens: 10,
      contextWindow: 99,
      percent: 100
    });
  });

  it("areContextUsagesEqual handles undefined symmetry", () => {
    expect(areContextUsagesEqual(undefined, undefined)).toBe(true);
    expect(
      areContextUsagesEqual({ tokens: 1, contextWindow: 2, percent: 3 }, undefined)
    ).toBe(false);
  });
});

describe("compareRuntimeExtensionSnapshots", () => {
  const snap = (overrides: Partial<AgentRuntimeExtensionSnapshot>): AgentRuntimeExtensionSnapshot => ({
    agentId: "a",
    role: "worker",
    managerId: "m",
    loadedAt: "t",
    extensions: [],
    loadErrors: [],
    ...overrides
  });

  it("orders manager before worker", () => {
    const mgr = snap({ agentId: "z", role: "manager", managerId: "m1" });
    const wrk = snap({ agentId: "a", role: "worker", managerId: "m1" });
    expect(compareRuntimeExtensionSnapshots(mgr, wrk)).toBeLessThan(0);
  });

  it("breaks ties by profileId/managerId/agentId", () => {
    const a = snap({ agentId: "b", profileId: "p1", managerId: "m" });
    const b = snap({ agentId: "a", profileId: "p2", managerId: "m" });
    expect(compareRuntimeExtensionSnapshots(a, b)).not.toBe(0);
  });
});

describe("cloneProjectAgentInfoValue / cloneDescriptor", () => {
  it("clones project agent capabilities array", () => {
    const pa = {
      handle: "h",
      whenToUse: "w",
      capabilities: ["create_session" as const]
    };
    const cloned = cloneProjectAgentInfoValue(pa);
    expect(cloned?.capabilities).toEqual(["create_session"]);
    expect(cloned?.capabilities).not.toBe(pa.capabilities);
  });

  it("cloneDescriptor deep-copies model and contextUsage", () => {
    const d = baseDescriptor({
      contextUsage: { tokens: 1, contextWindow: 2, percent: 3 }
    });
    const c = cloneDescriptor(d);
    expect(c.model).not.toBe(d.model);
    expect(c.contextUsage).not.toBe(d.contextUsage);
    expect(c.model).toEqual(d.model);
  });
});

describe("validateAgentDescriptor", () => {
  it("returns error string for invalid payloads", () => {
    expect(validateAgentDescriptor(null)).toMatch(/object/);
    expect(validateAgentDescriptor({})).toMatch(/agentId/);
  });

  it("accepts minimal valid descriptor", () => {
    const d = baseDescriptor();
    const result = validateAgentDescriptor(d);
    expect(result).toEqual(d);
  });

  it("normalizes project agent handle when sanitize changes it", () => {
    const d = baseDescriptor({
      projectAgent: {
        handle: "  MyHandle  ",
        whenToUse: "test"
      }
    });
    const result = validateAgentDescriptor(d);
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") {
      expect(result.projectAgent?.handle).toBe("MyHandle");
    }
  });
});

describe("resolveModel", () => {
  it("returns direct registry hit first", () => {
    const fallback = { id: "fb" };
    const registry = {
      find: vi.fn(() => fallback),
      getAll: vi.fn(() => [])
    } as unknown as ModelRegistry;

    const model = resolveModel(registry, {
      provider: "p",
      modelId: "m",
      thinkingLevel: "low"
    });
    expect(model).toBe(fallback);
  });

  it("synthesizes catalog-backed Pi models that are missing from the bundled Pi registry", () => {
    const fallback = { id: "fb" };
    const registry = {
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => [fallback])
    } as unknown as ModelRegistry;

    const exact = resolveExactModel(registry, {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh"
    });
    expect(exact).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 272_000,
      maxTokens: 128_000
    });

    const model = resolveModel(registry, {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh"
    });
    expect(model).toMatchObject({ id: "gpt-5.5" });
    expect(model).not.toBe(fallback);
  });

  it("falls back to getAll()[0] when find and catalog miss", () => {
    const fallback = { id: "fb" };
    const registry = {
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => [fallback])
    } as unknown as ModelRegistry;

    const model = resolveModel(registry, {
      provider: "__unlikely_provider__",
      modelId: "__unlikely_model__",
      thinkingLevel: "low"
    });
    expect(model).toBe(fallback);
  });
});

describe("buildWorkerCompletionReport", () => {
  const msg = (partial: Partial<ConversationMessageEvent>): ConversationMessageEvent => ({
    type: "conversation_message",
    agentId: "w1",
    role: "assistant",
    text: "hello",
    timestamp: "2020-01-01T00:00:00.000Z",
    source: "system",
    ...partial
  });

  it("uses default system line when history empty", () => {
    const r = buildWorkerCompletionReport("worker-1", []);
    expect(r.message).toBe("SYSTEM: Worker worker-1 completed its turn.");
    expect(r.summaryTimestamp).toBeUndefined();
  });

  it("includes latest assistant summary", () => {
    const history: ConversationEntryEvent[] = [
      msg({ text: "old", timestamp: "2019-01-01T00:00:00.000Z" }),
      msg({ text: "newer", timestamp: "2020-01-02T00:00:00.000Z" })
    ];
    const r = buildWorkerCompletionReport("w", history);
    expect(r.message).toContain("newer");
    expect(r.summaryTimestamp).toBe(parseTimestampToMillis("2020-01-02T00:00:00.000Z"));
  });
});

describe("normalizeCortexUserVisiblePaths", () => {
  it("rewrites absolute paths to profiles/ suffix", () => {
    const t = "See C:\\Users\\x\\profiles\\p1\\sessions\\s1 for details";
    expect(normalizeCortexUserVisiblePaths(t)).toContain("profiles/p1/sessions/s1");
  });
});

describe("analyzeLatestCortexCloseoutNeed", () => {
  const userMsg = (ts: string): ConversationEntryEvent => ({
    type: "conversation_message",
    agentId: "m",
    role: "user",
    text: "hi",
    timestamp: ts,
    source: "user_input"
  });

  const speak = (ts: string): ConversationEntryEvent => ({
    type: "conversation_message",
    agentId: "m",
    role: "assistant",
    text: "spoken",
    timestamp: ts,
    source: "speak_to_user"
  });

  const agentToAgent = (ts: string): ConversationEntryEvent => ({
    type: "agent_message",
    agentId: "m",
    timestamp: ts,
    source: "agent_to_agent",
    toAgentId: "x",
    text: "x"
  });

  it("returns false when no user message", () => {
    expect(analyzeLatestCortexCloseoutNeed([]).needsReminder).toBe(false);
  });

  it("flags missing speak_to_user after latest user", () => {
    const r = analyzeLatestCortexCloseoutNeed([userMsg("2020-01-01T00:00:00.000Z")]);
    expect(r.needsReminder).toBe(true);
    expect(r.reason).toBe("missing_speak_to_user");
  });

  it("does not remind when speak_to_user follows user", () => {
    const r = analyzeLatestCortexCloseoutNeed([
      userMsg("2020-01-01T00:00:00.000Z"),
      speak("2020-01-02T00:00:00.000Z")
    ]);
    expect(r.needsReminder).toBe(false);
  });

  it("flags stale when worker progress after speak_to_user", () => {
    const r = analyzeLatestCortexCloseoutNeed([
      userMsg("2020-01-01T00:00:00.000Z"),
      speak("2020-01-02T00:00:00.000Z"),
      agentToAgent("2020-01-03T00:00:00.000Z")
    ]);
    expect(r.needsReminder).toBe(true);
    expect(r.reason).toBe("stale_after_worker_progress");
  });
});

describe("parseTimestampToMillis / previewForLog / safeJson / formatToolExecutionPayload", () => {
  it("parseTimestampToMillis handles undefined and invalid", () => {
    expect(parseTimestampToMillis(undefined)).toBeUndefined();
    expect(parseTimestampToMillis("not-a-date")).toBeUndefined();
    expect(parseTimestampToMillis("2020-01-01T00:00:00.000Z")).toBe(1577836800000);
  });

  it("previewForLog collapses whitespace", () => {
    expect(previewForLog("  a \n b ", 3)).toBe("a b");
  });

  it("safeJson falls back on circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(safeJson(a)).toBe("[object Object]");
  });

  it("formatToolExecutionPayload passes strings through", () => {
    expect(formatToolExecutionPayload("plain")).toBe("plain");
    expect(formatToolExecutionPayload({ x: 1 })).toContain("x");
  });
});

describe("trim helpers / toDisplayToolName", () => {
  it("trimToMaxChars / trimToMaxCharsFromEnd", () => {
    expect(trimToMaxChars("abcd", 2)).toBe("ab");
    expect(trimToMaxCharsFromEnd("abcd", 2)).toBe("cd");
  });

  it("toDisplayToolName title-cases segments", () => {
    expect(toDisplayToolName("read_file")).toBe("Read File");
    expect(toDisplayToolName("   ")).toBe("Unknown");
  });
});

describe("readPositiveIntegerDetail / readStringDetail", () => {
  it("readPositiveIntegerDetail rejects non-positive integers", () => {
    expect(readPositiveIntegerDetail({ n: 1.5 }, "n")).toBeUndefined();
    expect(readPositiveIntegerDetail({ n: 0 }, "n")).toBeUndefined();
    expect(readPositiveIntegerDetail({ n: 3 }, "n")).toBe(3);
  });

  it("readStringDetail trims non-empty strings", () => {
    expect(readStringDetail({ s: "  x  " }, "s")).toBe("x");
    expect(readStringDetail({ s: "   " }, "s")).toBeUndefined();
  });
});

describe("normalizeConversationAttachments", () => {
  it("filters invalid entries and keeps typed attachments", () => {
    const out = normalizeConversationAttachments([
      { type: "text" as const, mimeType: "text/plain", text: " hi ", fileName: " f.txt " },
      { type: "text" as const, mimeType: "", text: "x" },
      { type: "binary" as const, mimeType: "application/octet-stream", data: " YWJj ", fileName: "b" },
      { mimeType: "image/png", data: "abc" } as any
    ]);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ type: "text", text: " hi " });
    expect(out[1]).toMatchObject({ type: "binary", data: "YWJj" });
    expect(out[2]).toMatchObject({ mimeType: "image/png" });
  });
});

describe("toConversationAttachmentMetadata", () => {
  it("resolves fileRef for uploads-dir paths only", () => {
    const uploads = join(tmpdir(), "uploads-test");
    const safePath = join(uploads, "doc.txt");
    const meta = toConversationAttachmentMetadata(
      [
        {
          type: "text",
          mimeType: "text/plain",
          text: "hello",
          filePath: safePath
        }
      ],
      uploads
    );
    expect(meta[0]?.fileRef).toBe("doc.txt");
  });
});

describe("toRuntimeDispatchAttachments / toRuntimeImageAttachments", () => {
  it("merges persisted paths by index", () => {
    const a = normalizeConversationAttachments([
      { mimeType: "image/png", data: "qq==" } as any
    ])!;
    const out = toRuntimeDispatchAttachments(a, [
      { ...a[0], filePath: "/tmp/x.png" }
    ]);
    expect(out[0]?.filePath).toBe("/tmp/x.png");
  });

  it("toRuntimeImageAttachments filters images only", () => {
    const norm = normalizeConversationAttachments([
      { mimeType: "image/png", data: "ab" },
      { type: "text" as const, mimeType: "text/plain", text: "t" }
    ]);
    expect(toRuntimeImageAttachments(norm)).toEqual([{ mimeType: "image/png", data: "ab" }]);
  });
});

describe("formatTextAttachmentForPrompt / formatBinaryAttachmentForPrompt", () => {
  it("formats blocks with file names", () => {
    const text = formatTextAttachmentForPrompt(
      { type: "text", mimeType: "text/plain", text: "body" },
      1
    );
    expect(text).toContain("BEGIN FILE");
    expect(text).toContain("body");

    const bin = formatBinaryAttachmentForPrompt(
      { type: "binary", mimeType: "application/octet-stream", data: "x" },
      "/data/f.bin",
      2
    );
    expect(bin).toContain("/data/f.bin");
  });
});

describe("sanitizeAttachmentFileName / sanitizePathSegment (utils)", () => {
  it("sanitizeAttachmentFileName strips unsafe characters", () => {
    expect(sanitizeAttachmentFileName("a/b\\c.txt", "f.bin")).toBe("a-b-c.txt");
    expect(sanitizeAttachmentFileName(undefined, "  x  ")).toBe("x");
  });

  it("sanitizePathSegment lowercases and truncates", () => {
    expect(sanitizePathSegment("  Hello World  ", "fb")).toBe("hello-world");
    expect(sanitizePathSegment("!!!", "fb")).toBe("fb");
  });
});

describe("normalizeOptionalAttachmentPath", () => {
  it("trims or undefined", () => {
    expect(normalizeOptionalAttachmentPath("  /p  ")).toBe("/p");
    expect(normalizeOptionalAttachmentPath("   ")).toBeUndefined();
  });
});

describe("extractRuntimeMessageText / formatInboundUserMessageForManager", () => {
  it("extractRuntimeMessageText handles string or object", () => {
    expect(extractRuntimeMessageText("x")).toBe("x");
    expect(extractRuntimeMessageText({ text: "y" } as any)).toBe("y");
  });

  it("formatInboundUserMessageForManager includes JSON context", () => {
    const out = formatInboundUserMessageForManager(" hi ", {
      channel: "web"
    });
    expect(out).toContain("[sourceContext]");
    expect(out).toContain("hi");
  });
});

describe("parseCompactSlashCommand", () => {
  it.each([
    ["/compact", {}],
    ["/COMPACT  focus on tests ", { customInstructions: "focus on tests" }],
    ["/not-compact", undefined]
  ])("%j", (text, expected) => {
    expect(parseCompactSlashCommand(text)).toEqual(expected);
  });
});

describe("normalizeMessageTargetContext / normalizeMessageSourceContext", () => {
  it("defaults non-telegram channels to web", () => {
    expect(
      normalizeMessageTargetContext({
        channel: "web",
        channelId: "  c ",
        userId: " u ",
        threadTs: " ",
        integrationProfileId: " p "
      })
    ).toEqual({
      channel: "web",
      channelId: "c",
      userId: "u",
      threadTs: undefined,
      integrationProfileId: "p"
    });
  });

  it("preserves telegram and channelType when valid", () => {
    expect(
      normalizeMessageSourceContext({
        channel: "telegram",
        channelId: "c",
        channelType: "dm",
        teamId: "t"
      }).channel
    ).toBe("telegram");
  });
});

describe("escapeXmlForPreview / errorToMessage / nowIso", () => {
  it("escapeXmlForPreview escapes XML specials", () => {
    expect(escapeXmlForPreview(`a&b<c>'"`)).toBe("a&amp;b&lt;c&gt;&apos;&quot;");
  });

  it("errorToMessage unwraps Error", () => {
    expect(errorToMessage(new Error("e"))).toBe("e");
    expect(errorToMessage(42)).toBe("42");
  });

  it("nowIso returns ISO string", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("isVersionedWriteToolName / extractVersionedToolPath", () => {
  it("isVersionedWriteToolName", () => {
    expect(isVersionedWriteToolName("write")).toBe(true);
    expect(isVersionedWriteToolName("edit")).toBe(true);
    expect(isVersionedWriteToolName("read")).toBe(false);
  });

  it.each([
    [{ path: " /tmp/a.ts " }, "/tmp/a.ts"],
    [{ filePath: "src/b.ts" }, "src/b.ts"],
    [{ args: { path: "nested.ts" } }, "nested.ts"],
    ['{"path":"p.json"}', "p.json"]
  ])("extractVersionedToolPath(%j)", (input, expected) => {
    expect(extractVersionedToolPath(input)).toBe(expected);
  });

  it("returns undefined past depth limit", () => {
    const deep: Record<string, unknown> = {};
    let cur: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i += 1) {
      const next: Record<string, unknown> = {};
      cur.args = next;
      cur = next;
    }
    cur.path = "x";
    expect(extractVersionedToolPath(deep)).toBeUndefined();
  });
});

describe("readFileHead", () => {
  it("reads first bytes of a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfh-"));
    const fp = join(dir, "t.txt");
    await writeFile(fp, "hello world", "utf8");
    await expect(readFileHead(fp, 5)).resolves.toBe("hello");
  });
});

describe("withManagerTimeout", () => {
  it("resolves when promise finishes in time", async () => {
    await expect(withManagerTimeout(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
  });

  it("rejects when promise exceeds timeout", async () => {
    await expect(
      withManagerTimeout(new Promise(() => {}), 15, "op")
    ).rejects.toThrow(/op timed out after 15ms/);
  });
});

describe("createDeferred", () => {
  it("resolves and rejects", async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    await expect(d.promise).resolves.toBe(42);

    const d2 = createDeferred<void>();
    d2.reject(new Error("nope"));
    await expect(d2.promise).rejects.toThrow("nope");
  });
});
