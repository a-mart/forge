import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { buildProjectSafePiProjectSettingsStorage } from "../project-executable-trust.js";
import {
  DEFAULT_TOOL_OUTPUT_TOKENS,
  MAX_TOOL_OUTPUT_TOKENS,
  MIN_TOOL_OUTPUT_TOKENS,
  boundToolResultContent,
  createModelVisibleToolResultBudget,
  estimateToolResultContentTokens,
} from "../model-visible-tool-result-budget.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

afterEach(async () => {
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTool(
  name: string,
  parameters: ToolDefinition["parameters"] = Type.Object({ value: Type.Optional(Type.String()) }),
): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters,
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
}

function captureHandlers(factory: ExtensionFactory): Map<string, (...args: any[]) => unknown> {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  factory({
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    },
  } as any);
  return handlers;
}

function readSchemaProperties(tool: ToolDefinition): Record<string, any> {
  return (tool.parameters as any).properties ?? {};
}

async function applyMessageEndBudget(
  handlers: Map<string, (...args: any[]) => unknown>,
  message: Record<string, unknown>,
): Promise<Record<string, any> | undefined> {
  const result = await handlers.get("message_end")?.({ type: "message_end", message }) as
    | { message: Record<string, any> }
    | undefined;
  return result?.message;
}

describe("model-visible tool result budget", () => {
  it("adds one stable optional override to object and nested combinator schemas", () => {
    const budget = createModelVisibleToolResultBudget();
    const objectTool = createTool("object_tool");
    const extensionTool = createTool("extension_tool");
    const unionTool = createTool("union_tool", Type.Union([
      Type.Object({ action: Type.Literal("one") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("two") }, { additionalProperties: false }),
    ]));
    const intersectTool = createTool("intersect_tool", Type.Intersect([
      Type.Object({ left: Type.Optional(Type.String()) }, { additionalProperties: false }),
      Type.Object({ right: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ]));
    const objectWithClosedUnion = createTool("object_union_tool", {
      type: "object",
      properties: {},
      oneOf: [
        { type: "object", properties: { kind: { const: "one" } }, additionalProperties: false },
        { type: "object", properties: { kind: { const: "two" } }, additionalProperties: false },
      ],
    } as ToolDefinition["parameters"]);

    budget.augmentToolDefinitions([objectTool, unionTool, intersectTool, objectWithClosedUnion]);
    budget.augmentToolDefinitions([objectTool, unionTool, intersectTool, objectWithClosedUnion]);
    budget.augmentExtensions({
      extensions: [{
        tools: new Map([[extensionTool.name, { definition: extensionTool, sourceInfo: {} }]]),
      } as any],
      errors: [],
      runtime: {} as any,
    });

    expect(readSchemaProperties(objectTool).max_output_tokens).toMatchObject({
      type: "integer",
      minimum: MIN_TOOL_OUTPUT_TOKENS,
    });
    expect(readSchemaProperties(objectTool).max_output_tokens).not.toHaveProperty("maximum");
    expect((objectTool.parameters as any).required ?? []).not.toContain("max_output_tokens");
    for (const branch of (unionTool.parameters as any).anyOf) {
      expect(branch.properties.max_output_tokens).not.toHaveProperty("maximum");
      expect(branch.required ?? []).not.toContain("max_output_tokens");
    }
    for (const branch of (intersectTool.parameters as any).allOf) {
      expect(branch.properties.max_output_tokens).toMatchObject({ type: "integer" });
    }
    expect(readSchemaProperties(objectWithClosedUnion).max_output_tokens).toMatchObject({ type: "integer" });
    for (const branch of (objectWithClosedUnion.parameters as any).oneOf) {
      expect(branch.properties.max_output_tokens).toMatchObject({ type: "integer" });
    }
    expect(readSchemaProperties(extensionTool).max_output_tokens).toMatchObject({ type: "integer" });
  });

  it("preserves a tool-native parameter without injecting it into sibling union branches", () => {
    const nativeField = Type.Optional(Type.Integer({ minimum: 1 }));
    const mixedTool = createTool("mixed_native_tool", Type.Union([
      Type.Object({ kind: Type.Literal("native"), max_output_tokens: nativeField }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("plain") }, { additionalProperties: false }),
    ]));

    createModelVisibleToolResultBudget().augmentToolDefinitions([mixedTool]);

    const branches = (mixedTool.parameters as any).anyOf;
    expect(branches[0].properties.max_output_tokens).toBe(nativeField);
    expect(branches[1].properties).not.toHaveProperty("max_output_tokens");
  });

  it("keeps Forge-injected schema provenance across runtime controllers", async () => {
    const sharedTool = createTool("shared_tool");
    const first = createModelVisibleToolResultBudget();
    first.augmentToolDefinitions([sharedTool]);

    const second = createModelVisibleToolResultBudget();
    second.augmentToolDefinitions([sharedTool]);
    const handlers = captureHandlers(second.extensionFactory);
    const input = { value: "x", max_output_tokens: 2_000 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: sharedTool.name,
      toolCallId: "shared-call",
      input,
    });

    expect(input).toEqual({ value: "x" });
  });

  it("strips injected runtime metadata but preserves a tool's native output parameter", async () => {
    const injectedBudget = createModelVisibleToolResultBudget();
    const injectedPrepare = vi.fn((input: unknown) => input as Record<string, unknown>);
    const injectedTool = createTool("injected_tool");
    injectedTool.prepareArguments = injectedPrepare as ToolDefinition["prepareArguments"];
    injectedBudget.augmentToolDefinitions([injectedTool]);
    const injectedHandlers = captureHandlers(injectedBudget.extensionFactory);

    const prepared = injectedTool.prepareArguments?.({ value: "x", max_output_tokens: 2_000 }) as Record<string, unknown>;
    expect(injectedPrepare).toHaveBeenCalledWith({ value: "x" });
    expect(prepared.max_output_tokens).toBe(2_000);
    await injectedHandlers.get("tool_call")?.({
      type: "tool_call",
      toolName: injectedTool.name,
      toolCallId: "injected-call",
      input: prepared,
    });
    expect(prepared).toEqual({ value: "x" });

    const nativeBudget = createModelVisibleToolResultBudget();
    const nativeTool = createTool("native_tool", Type.Object({
      max_output_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }));
    nativeBudget.augmentToolDefinitions([nativeTool]);
    const nativeHandlers = captureHandlers(nativeBudget.extensionFactory);
    const nativeInput = { max_output_tokens: 2_000 };
    await nativeHandlers.get("tool_call")?.({
      type: "tool_call",
      toolName: nativeTool.name,
      toolCallId: "native-call",
      input: nativeInput,
    });
    expect(nativeInput).toEqual({ max_output_tokens: 2_000 });
    const nativeResult = await applyMessageEndBudget(nativeHandlers, {
      role: "toolResult",
      toolCallId: "native-call",
      toolName: nativeTool.name,
      content: [{ type: "text", text: "n".repeat(16_000) }],
      details: undefined,
      isError: false,
      timestamp: Date.now(),
    });
    expect(estimateToolResultContentTokens(nativeResult!.content)).toBeLessThanOrEqual(2_000);
  });

  it("normalizes a legal content-less extension result without turning it into an error", async () => {
    const budget = createModelVisibleToolResultBudget();
    const handlers = captureHandlers(budget.extensionFactory);
    const message = {
      role: "toolResult",
      toolCallId: "missing-content",
      toolName: "extension_tool",
      details: { preserved: true },
      isError: false,
      timestamp: Date.now(),
    };

    const replacement = await applyMessageEndBudget(handlers, message);
    expect(replacement).toMatchObject({
      content: [],
      details: { preserved: true },
      isError: false,
    });
  });

  it("keeps useful head and tail text under the 10,000-token default", () => {
    const original = `HEAD:${"x".repeat(79_988)}:TAIL`;
    const bounded = boundToolResultContent([{ type: "text", text: original }]);
    const returned = (bounded.content[0] as { text: string }).text;

    expect(bounded.truncated).toBe(true);
    expect(bounded.originalEstimatedTokens).toBe(20_000);
    expect(bounded.returnedEstimatedTokens).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKENS);
    expect(returned).toContain("HEAD:");
    expect(returned).toContain(":TAIL");
    expect(returned).toContain("Forge tool output truncated");
    expect(returned).toContain("omitted approximately");
  });

  it("honors a lower call budget, a larger call budget, and the hard ceiling", async () => {
    const budget = createModelVisibleToolResultBudget();
    const tool = createTool("bounded_tool");
    budget.augmentToolDefinitions([tool]);
    const handlers = captureHandlers(budget.extensionFactory);

    const lowerInput = { max_output_tokens: 1_000 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: tool.name,
      toolCallId: "lower",
      input: lowerInput,
    });
    const lowerResult = await applyMessageEndBudget(handlers, {
      role: "toolResult",
      toolCallId: "lower",
      toolName: tool.name,
      content: [{ type: "text", text: "l".repeat(8_000) }],
      details: undefined,
      isError: false,
      timestamp: Date.now(),
    });
    expect(estimateToolResultContentTokens(lowerResult!.content)).toBeLessThanOrEqual(1_000);
    expect(lowerResult!.content[0]?.text).toContain("requested 1000 tokens");
    expect(lowerResult).toMatchObject({ isError: false });

    const largerInput = { max_output_tokens: 20_000 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: tool.name,
      toolCallId: "larger",
      input: largerInput,
    });
    expect(await applyMessageEndBudget(handlers, {
      role: "toolResult",
      toolCallId: "larger",
      toolName: tool.name,
      content: [{ type: "text", text: "h".repeat(60_000) }],
      details: undefined,
      isError: false,
      timestamp: Date.now(),
    })).toBeUndefined();

    const ceilingInput = { max_output_tokens: 100_000 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: tool.name,
      toolCallId: "ceiling",
      input: ceilingInput,
    });
    const ceilingResult = await applyMessageEndBudget(handlers, {
      role: "toolResult",
      toolCallId: "ceiling",
      toolName: tool.name,
      content: [{ type: "text", text: "c".repeat(240_000) }],
      details: undefined,
      isError: false,
      timestamp: Date.now(),
    });
    expect(estimateToolResultContentTokens(ceilingResult!.content)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_TOKENS);
    expect(ceilingResult!.content[0]?.text).toContain("capped at 50000");

    const tinyInput = { max_output_tokens: 1 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: tool.name,
      toolCallId: "tiny",
      input: tinyInput,
    });
    const tinyResult = await applyMessageEndBudget(handlers, {
      role: "toolResult",
      toolCallId: "tiny",
      toolName: tool.name,
      content: [{ type: "text", text: "t".repeat(8_000) }],
      details: undefined,
      isError: false,
      timestamp: Date.now(),
    });
    expect(estimateToolResultContentTokens(tinyResult!.content)).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS);
    expect(tinyResult!.content[0]?.text).toContain("Forge tool output truncated");
  });

  it("handles mixed images and Unicode without splitting surrogate pairs", () => {
    const images = Array.from({ length: 9 }, (_, index) => ({
      type: "image" as const,
      data: `image-${index}`,
      mimeType: "image/png",
    }));
    const mixed = boundToolResultContent([
      { type: "text", text: `HEAD-${"😀".repeat(12_000)}` },
      ...images,
      { type: "text", text: `${"🧭".repeat(12_000)}-TAIL` },
    ]);
    const serializedText = mixed.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(mixed.truncated).toBe(true);
    expect(mixed.returnedEstimatedTokens).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKENS);
    expect(serializedText).toContain("HEAD-");
    expect(serializedText).toContain("-TAIL");
    expect(serializedText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("caps the persisted result before the next provider request and keeps override metadata out of execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-tool-output-budget-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const faux = registerFauxProvider({
      api: "forge-output-budget-api",
      provider: "forge-output-budget",
      models: [{ id: "budget-model", contextWindow: 128_000, maxTokens: 2_048 }],
    });
    fauxRegistrations.push(faux);

    const seenExecutionInputs: Array<Record<string, unknown>> = [];
    const tool: ToolDefinition = {
      name: "large_output",
      label: "large_output",
      description: "Return deterministic large output",
      parameters: Type.Object({ marker: Type.String() }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        seenExecutionInputs.push({ ...input });
        const marker = (input as { marker: string }).marker;
        const text = marker === "default" ? `HEAD-${"d".repeat(79_990)}-TAIL` : "o".repeat(60_000);
        return { content: [{ type: "text", text }], details: { marker } };
      },
    };
    const budget = createModelVisibleToolResultBudget();
    budget.augmentToolDefinitions([tool]);
    const adversarialExtension: ExtensionFactory = (pi) => {
      pi.on("tool_call", (event) => {
        if ((event.input as { marker?: string }).marker === "blocked") {
          return {
            block: true,
            reason: `BLOCK_HEAD-${"b".repeat(79_980)}-BLOCK_TAIL`,
          };
        }
        return undefined;
      });
      pi.on("context", (event) => {
        const blocked = event.messages.some(
          (message) => message.role === "toolResult" && message.toolCallId === "blocked-call",
        );
        if (!blocked) {
          return undefined;
        }
        return {
          messages: event.messages.map((message) => message.role === "toolResult" && message.toolCallId === "blocked-call"
            ? {
                ...message,
                content: [{ type: "text" as const, text: `CONTEXT_HEAD-${"c".repeat(79_976)}-CONTEXT_TAIL` }],
              }
            : message),
        };
      });
    };

    let secondRequestToolResults: Array<{
      toolCallId: string;
      content: Array<{ type: string; text?: string }>;
      details?: unknown;
    }> = [];
    let secondRequestTools: Array<{ name: string; parameters: unknown }> = [];
    let postReloadToolResults: Array<{
      toolCallId: string;
      content: Array<{ type: string; text?: string }>;
    }> = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("large_output", { marker: "default" }, { id: "default-call" }),
        fauxToolCall("large_output", { marker: "override", max_output_tokens: 20_000 }, { id: "override-call" }),
        fauxToolCall("large_output", { marker: "blocked", max_output_tokens: 256 }, { id: "blocked-call" }),
      ], { stopReason: "toolUse" }),
      (context) => {
        secondRequestTools = (context.tools ?? []).map((activeTool) => ({
          name: activeTool.name,
          parameters: activeTool.parameters,
        }));
        secondRequestToolResults = context.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => ({
            toolCallId: message.toolCallId,
            content: message.content,
            details: message.details,
          }));
        return fauxAssistantMessage("done");
      },
    ]);

    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectExecutablesTrusted: false,
    });
    const settingsManager = SettingsManager.fromStorage(storage);
    const authStorage = AuthStorage.inMemory({});
    authStorage.setRuntimeApiKey("forge-output-budget", "faux-test-key");
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      extensionFactories: [adversarialExtension, budget.extensionFactory],
      extensionsOverride: (result) => budget.augmentExtensions(result),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      model: faux.getModel(),
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(root),
      resourceLoader,
      settingsManager,
      tools: ["read", "large_output"],
      customTools: [tool],
    });
    budget.augmentSessionTools(session);
    const executionEndResults = new Map<string, Array<{ type: string; text?: string }>>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end" && Array.isArray(event.result.content)) {
        executionEndResults.set(event.toolCallId, event.result.content);
      }
    });

    const activeDefinition = session.getToolDefinition("large_output")!;
    expect(readSchemaProperties(activeDefinition).max_output_tokens).toMatchObject({
      type: "integer",
      minimum: MIN_TOOL_OUTPUT_TOKENS,
    });
    expect(readSchemaProperties(session.getToolDefinition("read")!).max_output_tokens).toMatchObject({
      type: "integer",
      minimum: MIN_TOOL_OUTPUT_TOKENS,
    });
    await session.prompt("run both output cases");

    expect(seenExecutionInputs).toEqual([{ marker: "default" }, { marker: "override" }]);
    const defaultResult = secondRequestToolResults.find((message) => message.toolCallId === "default-call")!;
    const overrideResult = secondRequestToolResults.find((message) => message.toolCallId === "override-call")!;
    const blockedResult = secondRequestToolResults.find((message) => message.toolCallId === "blocked-call")!;
    expect(estimateToolResultContentTokens(defaultResult.content as any)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKENS);
    expect(defaultResult.content[0]?.text).toContain("Forge tool output truncated");
    expect(defaultResult.details).toEqual({ marker: "default" });
    expect(estimateToolResultContentTokens(overrideResult.content as any)).toBe(15_000);
    expect(estimateToolResultContentTokens(executionEndResults.get("default-call") as any))
      .toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKENS);
    expect(estimateToolResultContentTokens(executionEndResults.get("override-call") as any)).toBe(15_000);
    expect(estimateToolResultContentTokens(blockedResult.content as any)).toBeLessThanOrEqual(256);
    expect(blockedResult.content[0]?.text).toContain("CONTEXT_HEAD-");
    expect(blockedResult.content[0]?.text).toContain("-CONTEXT_TAIL");
    expect(blockedResult.content[0]?.text).toContain("Forge tool output truncated");
    expect(secondRequestTools.map((activeTool) => activeTool.name)).toEqual(["read", "large_output"]);
    for (const activeTool of secondRequestTools) {
      expect((activeTool.parameters as any).properties.max_output_tokens).toMatchObject({ type: "integer" });
    }

    const persistedToolResults = session.sessionManager.getBranch()
      .filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
      .map((entry) => entry.message)
      .filter((message) => message.role === "toolResult");
    const persistedById = new Map(persistedToolResults.map((message) => [message.toolCallId, message]));
    for (const toolCallId of ["default-call", "override-call"]) {
      expect(persistedById.get(toolCallId)).toMatchObject({
        content: secondRequestToolResults.find((message) => message.toolCallId === toolCallId)?.content,
        details: secondRequestToolResults.find((message) => message.toolCallId === toolCallId)?.details,
      });
    }
    const persistedBlocked = persistedById.get("blocked-call")!;
    expect(estimateToolResultContentTokens(persistedBlocked.content as any)).toBeLessThanOrEqual(256);
    expect((persistedBlocked.content[0] as { text: string }).text).toContain("BLOCK_HEAD-");

    await session.reload();
    expect(readSchemaProperties(session.getToolDefinition("read")!).max_output_tokens).toMatchObject({
      type: "integer",
      minimum: MIN_TOOL_OUTPUT_TOKENS,
    });
    const postReloadFaux = registerFauxProvider({
      api: "forge-output-budget-api",
      provider: "forge-output-budget",
      models: [{ id: "budget-model", contextWindow: 128_000, maxTokens: 2_048 }],
    });
    fauxRegistrations.push(postReloadFaux);
    postReloadFaux.setResponses([(context) => {
      postReloadToolResults = context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
          toolCallId: message.toolCallId,
          content: message.content,
        }));
      return fauxAssistantMessage("done after reload");
    }]);
    await session.prompt("verify persisted budgets after reload");
    const postReloadOverride = postReloadToolResults.find(
      (message) => message.toolCallId === "override-call",
    )!;
    expect(estimateToolResultContentTokens(postReloadOverride.content as any)).toBe(15_000);
    const postReloadBlocked = postReloadToolResults.find(
      (message) => message.toolCallId === "blocked-call",
    )!;
    expect(estimateToolResultContentTokens(postReloadBlocked.content as any)).toBeLessThanOrEqual(256);
    unsubscribe();
    session.dispose();
  });
});
