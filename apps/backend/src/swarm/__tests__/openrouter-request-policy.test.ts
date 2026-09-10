import { SwarmSpecialistFallbackManager } from "../swarm-specialist-fallback-manager.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installPiProviderContextImageResize } from "../runtime/pi/pi-runtime-creator.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, generateSummary, generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../pi/pi-ai-compat.js";
import { installOpenRouterRequestPolicy, withOpenRouterRequestPolicy } from "../runtime/pi/openrouter-request-policy.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { writeOpenRouterModels } from "../openrouter-models.js";
import { getOpenRouterModelsPath } from "../data-paths.js";
import { PiGenerationTelemetryAdapter } from "../runtime/generation-telemetry.js";
import { shouldRetrySpecialistSpawnWithFallback } from "../swarm-manager-utils.js";
import { runForgePiCompaction } from "../compaction/forge-pi-compaction.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { makeCompactionGuardDescriptor } from "../../test-support/compaction-guard-harness.js";

let root: string;
let bodies: Record<string, unknown>[];
let headers: Headers[];
const model = getModel("openrouter", "openai/gpt-4.1");
const context = { messages: [{ role: "user" as const, content: "Synthetic routing test", timestamp: 1 }] };
let respond: (() => Response | Promise<Response>) | undefined;
function ok() {
  return new Response('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"summary"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-routing-"));
  await modelCatalogService.loadOverrides(root);
  bodies = []; headers = []; respond = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("openrouter.ai");
    bodies.push(JSON.parse(await request.text()));
    headers.push(request.headers);
    return respond?.() ?? ok();
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function save(routingDefaults: Record<string, unknown>) {
  await writeOpenRouterModels(root, { version: 1, models: {}, routingDefaults });
  await modelCatalogService.reloadOpenRouterModels();
}
async function sessionFor(sessionManager = SessionManager.inMemory(root), customTools: ToolDefinition[] = []) {
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("openrouter", "synthetic-test-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, authStorage, modelRegistry, model, thinkingLevel: "off", sessionManager, resourceLoader, settingsManager, noTools: "builtin", customTools });
  installOpenRouterRequestPolicy(session);
  const telemetry = new PiGenerationTelemetryAdapter({ session, reasoningLevel: null, onGenerationEvent: () => {} });
  telemetry.install();
  return { session, telemetry };
}

describe("OpenRouter request boundary (real Pi HTTP serialization, synthetic transport only)", () => {
  it("refreshes existing manager/worker-equivalent sessions, retry and summary calls without replacing writers", async () => {
    const manager = await sessionFor();
    const worker = await sessionFor();
    await manager.session.prompt("first");
    expect(bodies[0].provider).toEqual({});
    await save({ zdr: true, only: ["azure"], max_price: { prompt: 1 }, quantizations: ["fp16"] });
    await manager.session.prompt("after save");
    await worker.session.prompt("worker after save");
    expect(bodies.slice(1).every((body) => (body.provider as { zdr: boolean }).zdr)).toBe(true);
    expect(headers.every((value) => value.get("authorization") === "Bearer synthetic-test-key")).toBe(true);
    await save({ data_collection: "deny" });
    await generateSummary(context.messages, model, 1000, "ignored-key", undefined, undefined, undefined, undefined, "off", manager.session.agent.streamFn);
    expect(bodies.at(-1)?.provider).toEqual({ data_collection: "deny" });
    await generateBranchSummary([{ type: "message", id: "branch-message", parentId: null, timestamp: new Date().toISOString(), message: context.messages[0] }], {
      model, apiKey: "ignored-key", signal: new AbortController().signal, streamFn: manager.session.agent.streamFn,
    });
    expect(bodies.at(-1)?.provider).toEqual({ data_collection: "deny" });
    expect(headers.at(-1)?.get("authorization")).toBe("Bearer synthetic-test-key");
    let attempt = 0;
    respond = async () => {
      if (attempt++ !== 0) return ok();
      await save({ zdr: true });
      return new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: { "content-type": "application/json" } });
    };
    await worker.session.prompt("retry");
    expect(attempt).toBe(2);
    expect(bodies.slice(-2).map((body) => body.provider)).toEqual([{ data_collection: "deny" }, { zdr: true }]);
    manager.session.dispose(); worker.session.dispose();
  });

  it("refreshes policy on a mid-turn tool continuation", async () => {
    const { session } = await sessionFor(undefined, [{
      name: "save_routing", label: "Save routing", description: "Synthetic local policy change",
      parameters: Type.Object({}),
      execute: async () => { await save({ zdr: true }); return { content: [{ type: "text", text: "saved" }], details: {} }; },
    }]);
    let calls = 0;
    respond = () => calls++ === 0 ? new Response('data: {"id":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_test","type":"function","function":{"name":"save_routing","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) : ok();
    await session.prompt("run synthetic tool");
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.provider)).toEqual([{}, { zdr: true }]);
    session.dispose();
  });

  it("enforces routing on the supported secure-bound Pi path after context guarding", async () => {
    await save({ zdr: true });
    const { session } = await sessionFor();
    const binding: SecureRuntimeBinding = {
      executeBash: vi.fn(), createOutputGuard: vi.fn(),
      guardValue: <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("synthetic-canary", "guarded")) as T,
    };
    // Secure Sessions keeps model dispatch in the host Pi session; only tools execute in the guest.
    installPiProviderContextImageResize(session, binding);
    await session.prompt("synthetic-canary");
    expect(bodies[0].provider).toEqual({ zdr: true });
    expect(JSON.stringify(bodies[0])).not.toContain("synthetic-canary");
    expect(JSON.stringify(bodies[0])).toContain("guarded");
    await save({ data_collection: "deny" });
    await session.prompt("after secure-bound save");
    expect(bodies[1].provider).toEqual({ data_collection: "deny" });
    session.dispose();
  });

  it("refreshes an unadded exact model after a model switch and a resumed session", async () => {
    const manager = SessionManager.inMemory(root);
    const first = await sessionFor(manager);
    await first.session.prompt("before resume");
    first.session.dispose();
    await save({ zdr: true });
    const resumed = await sessionFor(manager);
    await resumed.session.setModel({ ...model, id: "unadded/exact-model" });
    await resumed.session.prompt("resumed");
    expect(bodies.at(-1)).toMatchObject({ model: "unadded/exact-model", provider: { zdr: true } });
    resumed.session.dispose();
  });

  it("restores final policy after payload extensions strip/mutate it; rejects model fallback overrides before transport", async () => {
    await save({ zdr: true, only: ["azure"], allow_fallbacks: false });
    const stream = withOpenRouterRequestPolicy(streamSimple);
    const result = await (await stream(model, context, { apiKey: "synthetic", onPayload: (payload, callbackModel) => {
      callbackModel.compat!.openRouterRouting!.only!.push("untrusted");
      return { ...payload as object, provider: { zdr: false } };
    } })).result();
    expect(result.stopReason).toBe("stop");
    expect(bodies[0].provider).toEqual({ zdr: true, only: ["azure"], allow_fallbacks: false });
    for (const override of [{ model: "other/model" }, { models: ["other/model"] }, { route: "fallback" }]) {
      const result = await (await stream(model, context, { apiKey: "synthetic", onPayload: (payload) => ({ ...payload as object, ...override }) })).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("routing rejected");
    }
    expect(bodies).toHaveLength(1);
  });

  it.each([{}, { sort: "latency" }, { zdr: false, data_collection: "allow", require_parameters: false, allow_fallbacks: true }])("preserves stronger extension restrictions with Forge settings %j", async (policy) => {
    await save(policy);
    const extension = { zdr: true, data_collection: "deny", only: ["azure"], ignore: ["openai"], max_price: { prompt: 1 }, quantizations: ["fp16"], require_parameters: true, allow_fallbacks: false };
    const result = await (await withOpenRouterRequestPolicy(streamSimple)(model, context, {
      apiKey: "synthetic", onPayload: (payload) => ({ ...payload as object, provider: extension }),
    })).result();
    expect(result.stopReason).toBe("stop");
    expect(bodies[0].provider).toEqual({ ...policy, ...extension });
  });

  it.each([
    [{ only: ["azure"] }, { only: ["openai"] }],
    [{ ignore: ["azure"] }, { ignore: ["openai"] }],
    [{ max_price: { prompt: 1 } }, { max_price: { prompt: 0.1 } }],
    [{ quantizations: ["fp16"] }, { quantizations: ["fp8"] }],
    [{ sort: "price" }, { order: ["azure"], zdr: true }],
  ])("rejects conflicting extension/Forge filters before transport (%j / %j)", async (policy, extension) => {
    await save(policy);
    const result = await (await withOpenRouterRequestPolicy(streamSimple)(model, context, {
      apiKey: "synthetic", onPayload: (payload) => ({ ...payload as object, provider: extension }),
    })).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("align the extension and Forge routing settings");
    expect(bodies).toHaveLength(0);
  });

  it("fails closed on unreadable saved policy and custom endpoints while leaving non-OpenRouter unchanged", async () => {
    const stream = withOpenRouterRequestPolicy(streamSimple);
    await save({});
    await writeFile(getOpenRouterModelsPath(root), "{broken");
    await expect(modelCatalogService.reloadOpenRouterModels()).rejects.toThrow();
    expect(() => stream(model, context, { apiKey: "synthetic" })).toThrow("unreadable");
    expect(() => stream({ ...model, baseUrl: "https://other.example/api/v1" }, context)).toThrow("cannot be enforced");
    const otherStream = vi.fn(() => "sentinel" as never);
    const other = { ...model, provider: "unrelated" };
    expect(withOpenRouterRequestPolicy(otherStream)(other, context)).toBe("sentinel");
    expect(otherStream).toHaveBeenCalledWith(other, context, undefined);
    expect(bodies).toHaveLength(0);
  });

  it("enforces configured Forge compaction without re-resolving its explicit auth", async () => {
    await save({ zdr: true, require_parameters: true });
    const compactionSettings = createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 300000, model: { provider: "openrouter", modelId: model.id }, reasoningLevel: "none" }).getCompactionRuntimeSettings();
    await runForgePiCompaction({
      event: { preparation: { firstKeptEntryId: "entry-1", messagesToSummarize: context.messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 } }, signal: new AbortController().signal },
      ctx: { model, modelRegistry: {} as ModelRegistry }, descriptor: makeCompactionGuardDescriptor(), compactionSettings,
      combinedInstructions: undefined, pinnedInstructionsMerged: false, logDebug: () => {},
      compactionAuth: { model, apiKey: "explicit-summary-key", authSource: "active_runtime_registry" } as never,
    });
    expect(bodies[0].provider).toEqual({ zdr: true, require_parameters: true });
    expect(headers[0].get("authorization")).toBe("Bearer explicit-summary-key");
  });

  it.each([{ zdr: true }, { data_collection: "deny" }, { only: ["azure"] }, { ignore: ["azure"] }, { max_price: { prompt: 1 } }, { quantizations: ["fp16"] }, { allow_fallbacks: false }, { require_parameters: true }])("blocks cross-model/provider fallback with hard policy %j", async (policy) => {
    await save(policy);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openrouter", modelId: model.id })).toBe(false);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("invalid api key"), { provider: "openrouter", modelId: model.id })).toBe(false);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openai", modelId: "gpt-4.1" })).toBe(true);
    const getRuntime = vi.fn();
    const fallback = new SwarmSpecialistFallbackManager({
      descriptors: new Map([["worker", { role: "worker", model: { provider: "openrouter", modelId: model.id } }]]), getRuntime,
    } as never);
    expect(await fallback.maybeRecoverWorkerWithSpecialistFallback({
      agentId: "worker", errorMessage: "429 rate limit", sourcePhase: "prompt_dispatch",
      handleRuntimeStatus: async () => {}, handleRuntimeAgentEnd: async () => {},
    })).toBe(false);
    expect(getRuntime).not.toHaveBeenCalled();
  });
  it("preserves ordinary fallback for preferences-only policy and blocks unreadable policy", async () => {
    await save({ order: ["azure"], zdr: false, data_collection: "allow" });
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openrouter", modelId: model.id })).toBe(true);
    await writeFile(getOpenRouterModelsPath(root), "{broken");
    await expect(modelCatalogService.reloadOpenRouterModels()).rejects.toThrow();
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openrouter", modelId: model.id })).toBe(false);
  });
});
