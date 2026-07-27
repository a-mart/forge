import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedAuthFilePath } from "../data-paths.js";
import { buildPiModelsProjection } from "../model-catalog-projection.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { normalizePersistedSwarmModelDescriptor } from "../model-presets.js";
import {
  parseXaiOAuthModelCatalog,
  refreshXaiOAuthModelDiscovery,
  XAI_OAUTH_MODELS_ENDPOINT,
} from "../catalog/xai-oauth-model-discovery.js";

async function writeCredential(dataDir: string, credential: Record<string, unknown>): Promise<void> {
  const authFile = getSharedAuthFilePath(dataDir);
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, JSON.stringify({ xai: credential }), "utf8");
}

function discoveryPayload(ids: string[]) {
  return {
    data: ids.map((id, index) => ({
      id,
      name: id === "grok-build" ? "Grok Build" : id === "grok-composer-2.5-fast" ? "Composer 2.5 Fast" : "Grok 4.5",
      limits: {
        context_window: 300_000 + index,
        max_output_tokens: 30_000 + index,
      },
      supported_reasoning_levels: id === "grok-composer-2.5-fast" ? ["low", "high"] : ["low", "medium", "high", "xhigh"],
      default_reasoning_level: "high",
      input_modes: ["text", "image"],
      capabilities: { tools: true, structured_output: id !== "grok-build" },
    })),
  };
}

afterEach(() => {
  modelCatalogService.setXaiOAuthDiscoveredModels(null);
  vi.restoreAllMocks();
});

describe("xAI OAuth model discovery", () => {
  it("accepts only approved exact IDs and keeps native Composer provider identity distinct", () => {
    const models = parseXaiOAuthModelCatalog({
      data: [
        ...discoveryPayload(["grok-build", "grok-composer-2.5-fast"]).data,
        { ...discoveryPayload(["grok-build"]).data[0], id: "grok-build-0.1" },
        { ...discoveryPayload(["grok-build"]).data[0], id: "grok-multi-agent" },
      ],
    });

    expect(models.map((model) => model.modelId)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect(models[0]).toMatchObject({
      provider: "xai",
      familyId: "pi-grok",
      authScope: "oauth",
      contextWindow: 300_000,
      maxOutputTokens: 30_000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
      supportsTools: true,
      supportsStructuredOutput: false,
    });
    expect(models[1].modelId).not.toBe("grok-4.5");
    expect(models[1].modelId).not.toBe("composer-2.5");
  });

  it("keeps OAuth Grok 4.5 bounded to fallback levels unless discovery advertises xhigh", () => {
    modelCatalogService.setXaiOAuthDiscoveredModels([]);
    expect(modelCatalogService.getModel("grok-4.5", "xai")?.supportedReasoningLevels).toEqual([
      "low", "medium", "high",
    ]);

    modelCatalogService.setXaiOAuthDiscoveredModels(parseXaiOAuthModelCatalog({
      data: [{
        id: "grok-4.5",
        context_window: 999_999,
        max_output_tokens: 999_999,
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
      }],
    }));
    expect(modelCatalogService.getModel("grok-4.5", "xai")).toMatchObject({
      contextWindow: 500_000,
      maxOutputTokens: 500_000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoningLevel: "high",
    });
  });

  it("never calls the OAuth proxy for API-key auth and retains API-key Grok 4.5 xhigh support", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-xai-api-key-discovery-"));
    await writeCredential(dataDir, { type: "api_key", key: "not-sent" });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(refreshXaiOAuthModelDiscovery(dataDir, { fetchImpl })).resolves.toEqual([]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(modelCatalogService.getModel("grok-build", "xai")).toBeUndefined();
    expect(modelCatalogService.getModel("grok-composer-2.5-fast", "xai")).toBeUndefined();
    expect(modelCatalogService.getModel("grok-4.5", "xai")?.supportedReasoningLevels).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
  });

  it("uses pinned authenticated discovery metadata and refreshes account entitlements fail-closed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-xai-oauth-discovery-"));
    await writeCredential(dataDir, {
      type: "oauth",
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: Date.now() + 60_000,
    });
    const payloads = [discoveryPayload(["grok-build"]), discoveryPayload(["grok-composer-2.5-fast"])];
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(payloads.shift());
    });

    await refreshXaiOAuthModelDiscovery(dataDir, { fetchImpl });
    expect(modelCatalogService.getModel("grok-build", "xai")).toMatchObject({
      discovered: true,
      contextWindow: 300_000,
      maxOutputTokens: 30_000,
    });
    expect(modelCatalogService.getModel("grok-4.5", "xai")?.supportedReasoningLevels).toEqual([
      "low", "medium", "high",
    ]);
    expect(buildPiModelsProjection().providers.xai?.models?.some((model) => model.id === "grok-build")).toBe(true);

    await refreshXaiOAuthModelDiscovery(dataDir, { fetchImpl });
    expect(modelCatalogService.getModel("grok-build", "xai")).toBeUndefined();
    expect(modelCatalogService.getModel("grok-composer-2.5-fast", "xai")).toMatchObject({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      contextWindow: 300_000,
      maxOutputTokens: 30_000,
      supportedReasoningLevels: ["low", "high"],
    });
    expect(
      modelCatalogService.getModelPresetInfoList()
        .find((preset) => preset.presetId === "pi-grok")
        ?.variants?.find((variant) => variant.modelId === "grok-composer-2.5-fast"),
    ).toMatchObject({
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    });
    expect(normalizePersistedSwarmModelDescriptor({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      thinkingLevel: "low",
    })).toEqual({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      thinkingLevel: "low",
    });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url === XAI_OAUTH_MODELS_ENDPOINT)).toBe(true);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer oauth-access-token")).toBe(true);
    expect(requests.every((request) => request.headers.get("X-XAI-Token-Auth") === "xai-grok-cli")).toBe(true);
  });

  it("keeps only the newest current account when discovery responses finish out of order", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-xai-oauth-account-race-"));
    const oauthCredential = (account: string) => ({
      type: "oauth",
      access: `${account}-access-token`,
      refresh: `${account}-refresh-token`,
      expires: Date.now() + 60_000,
    });
    await writeCredential(dataDir, oauthCredential("account-a"));

    const pendingResponses = new Map<string, (response: Response) => void>();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return new Promise<Response>((resolve) => {
        if (authorization) pendingResponses.set(authorization, resolve);
      });
    });

    const firstRefresh = refreshXaiOAuthModelDiscovery(dataDir, { fetchImpl });
    await vi.waitFor(() => expect(pendingResponses.has("Bearer account-a-access-token")).toBe(true));

    await writeCredential(dataDir, oauthCredential("account-b"));
    const secondRefresh = refreshXaiOAuthModelDiscovery(dataDir, { fetchImpl });
    await vi.waitFor(() => expect(pendingResponses.has("Bearer account-b-access-token")).toBe(true));

    pendingResponses.get("Bearer account-b-access-token")?.(
      Response.json(discoveryPayload(["grok-composer-2.5-fast"])),
    );
    await expect(secondRefresh).resolves.toMatchObject([{ modelId: "grok-composer-2.5-fast" }]);

    pendingResponses.get("Bearer account-a-access-token")?.(
      Response.json(discoveryPayload(["grok-build"])),
    );
    await expect(firstRefresh).resolves.toEqual([]);

    expect(modelCatalogService.getModel("grok-build", "xai")).toBeUndefined();
    expect(modelCatalogService.getModel("grok-composer-2.5-fast", "xai")).toMatchObject({
      modelId: "grok-composer-2.5-fast",
      authScope: "oauth",
    });
    expect(buildPiModelsProjection().providers.xai?.models?.map((model) => model.id)).toContain(
      "grok-composer-2.5-fast",
    );
    expect(buildPiModelsProjection().providers.xai?.models?.map((model) => model.id)).not.toContain("grok-build");
  });

  it("rejects oversized discovery responses before exposing entitlement rows", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-xai-oauth-oversized-"));
    await writeCredential(dataDir, {
      type: "oauth",
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(refreshXaiOAuthModelDiscovery(dataDir, {
      fetchImpl: async () => new Response(`{"data":[],"padding":"${"x".repeat(1_000_000)}"}`),
    })).resolves.toEqual([]);
    expect(modelCatalogService.getModel("grok-build", "xai")).toBeUndefined();
  });

  it("does not expose entitlement rows when discovery errors", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-xai-oauth-error-"));
    await writeCredential(dataDir, {
      type: "oauth",
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(refreshXaiOAuthModelDiscovery(dataDir, {
      fetchImpl: async () => new Response(JSON.stringify({ error: "sensitive upstream detail" }), { status: 403 }),
    })).resolves.toEqual([]);
    expect(modelCatalogService.getModel("grok-build", "xai")).toBeUndefined();
    expect(modelCatalogService.getModel("grok-composer-2.5-fast", "xai")).toBeUndefined();
  });
});
