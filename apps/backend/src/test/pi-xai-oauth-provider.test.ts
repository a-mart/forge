import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { getOAuthProvider, resetOAuthProviders, xaiOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildPiModelsProjection } from "../swarm/catalog/model-catalog-projection.js";
import { modelCatalogService } from "../swarm/catalog/model-catalog-service.js";
import { parseXaiOAuthModelCatalog } from "../swarm/catalog/xai-oauth-model-discovery.js";

const XAI_API_BASE_URL = "https://api.x.ai/v1";
const XAI_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetOAuthProviders();
  modelCatalogService.setXaiOAuthDiscoveredModels(null);
});

describe("patched Pi xAI OAuth provider", () => {
  it("remains registered after the OAuth registry is reset", () => {
    resetOAuthProviders();

    expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
  });

  it("routes only OAuth-backed xAI models through the CLI proxy with its required header", () => {
    const apiKeyRegistry = ModelRegistry.create(AuthStorage.inMemory({
      xai: { type: "api_key", key: "test-api-key" },
    }));
    const apiKeyXaiModel = apiKeyRegistry.getAll().find((model) => model.provider === "xai");

    expect(apiKeyXaiModel?.baseUrl).toBe(XAI_API_BASE_URL);
    expect(apiKeyXaiModel?.headers?.["X-XAI-Token-Auth"]).toBeUndefined();

    const oauthRegistry = ModelRegistry.create(AuthStorage.inMemory({
      xai: {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 60_000,
      },
    }));
    const oauthXaiModels = oauthRegistry.getAll().filter((model) => model.provider === "xai");
    const oauthNonXaiModel = oauthRegistry.getAll().find((model) => model.provider !== "xai");

    expect(oauthXaiModels.length).toBeGreaterThan(0);
    expect(oauthXaiModels.every((model) => model.baseUrl === XAI_OAUTH_BASE_URL)).toBe(true);
    expect(oauthXaiModels.every((model) => model.headers?.["X-XAI-Token-Auth"] === "xai-grok-cli")).toBe(true);
    expect(oauthNonXaiModel?.baseUrl).not.toBe(XAI_OAUTH_BASE_URL);
  });

  it("resolves env-only xAI auth through the Forge projection and sends it only to api.x.ai", async () => {
    vi.stubEnv("XAI_API_KEY", "env-only-xai-key");
    const root = await mkdtemp(join(tmpdir(), "forge-xai-env-projection-"));
    const projectionPath = join(root, "pi-models.json");
    await writeFile(projectionPath, JSON.stringify(buildPiModelsProjection()), "utf8");

    const registry = ModelRegistry.create(AuthStorage.inMemory({}), projectionPath);
    const model = registry.getAll().find((candidate) => candidate.provider === "xai");
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe(XAI_API_BASE_URL);

    const resolvedAuth = await registry.getApiKeyAndHeaders(model!);
    expect(resolvedAuth).toMatchObject({ ok: true, apiKey: "env-only-xai-key" });
    await expect(registry.getApiKeyForProvider("xai")).resolves.toBe("env-only-xai-key");

    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("data: [DONE]\\n\\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));

    if (!resolvedAuth.ok || !resolvedAuth.apiKey) {
      throw new Error("Expected the xAI environment API key to resolve");
    }
    for await (const event of streamOpenAIResponses(model as any, { messages: [] } as any, {
      apiKey: resolvedAuth.apiKey,
    })) {
      void event;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer env-only-xai-key");
    expect(requests[0].headers.get("X-XAI-Token-Auth")).toBeNull();
  });

  it("does not fall back to XAI_API_KEY when stored OAuth refresh fails on a proxy-routed model", async () => {
    vi.stubEnv("XAI_API_KEY", "must-not-reach-oauth-proxy");
    const root = await mkdtemp(join(tmpdir(), "forge-xai-oauth-env-shadow-"));
    const projectionPath = join(root, "pi-models.json");
    await writeFile(projectionPath, JSON.stringify(buildPiModelsProjection()), "utf8");

    const registry = ModelRegistry.create(AuthStorage.inMemory({
      xai: {
        type: "oauth",
        access: "expired-access-token",
        refresh: "expired-refresh-token",
        expires: 0,
      },
    }), projectionPath);
    const model = registry.getAll().find((candidate) => candidate.provider === "xai");
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe(XAI_OAUTH_BASE_URL);
    expect(model?.headers?.["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(registry.isUsingOAuth(model!)).toBe(true);

    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolvedAuth = await registry.getApiKeyAndHeaders(model!);
    const providerApiKey = await registry.getApiKeyForProvider("xai");

    expect(resolvedAuth).toEqual({ ok: true, apiKey: undefined, headers: { "X-XAI-Token-Auth": "xai-grok-cli" }, env: undefined });
    expect(providerApiKey).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0].url).toBe("https://auth.x.ai/oauth2/token");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests.some((request) => request.url.startsWith(XAI_OAUTH_BASE_URL))).toBe(false);
  });

  it("reroutes stored OAuth models to api.x.ai when a runtime API key override becomes effective", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-xai-oauth-runtime-override-"));
    const projectionPath = join(root, "pi-models.json");
    await writeFile(projectionPath, JSON.stringify(buildPiModelsProjection()), "utf8");

    const authStorage = AuthStorage.inMemory({
      xai: {
        type: "oauth",
        access: "stored-oauth-access-token",
        refresh: "stored-oauth-refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    const registry = ModelRegistry.create(authStorage, projectionPath);
    const model = registry.getAll().find((candidate) => candidate.provider === "xai");
    expect(model?.baseUrl).toBe(XAI_OAUTH_BASE_URL);
    expect(model?.headers?.["X-XAI-Token-Auth"]).toBe("xai-grok-cli");

    // Install the highest-precedence credential after the proxy-routed model has
    // already been selected. The request boundary must atomically restore routing.
    authStorage.setRuntimeApiKey("xai", "runtime-xai-api-key");
    const resolvedAuth = await registry.getApiKeyAndHeaders(model!);
    expect(resolvedAuth).toMatchObject({ ok: true, apiKey: "runtime-xai-api-key" });
    expect(registry.isUsingOAuth(model!)).toBe(false);
    expect(model?.baseUrl).toBe(XAI_API_BASE_URL);
    expect(model?.headers?.["X-XAI-Token-Auth"]).toBeUndefined();

    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("data: [DONE]\\n\\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));

    if (!resolvedAuth.ok || !resolvedAuth.apiKey) {
      throw new Error("Expected the xAI runtime API key override to resolve");
    }
    for await (const event of streamOpenAIResponses(model as any, { messages: [] } as any, {
      apiKey: resolvedAuth.apiKey,
    })) {
      void event;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer runtime-xai-api-key");
    expect(requests[0].headers.get("X-XAI-Token-Auth")).toBeNull();
  });

  it("rejects a discovered OAuth-only model after a runtime API-key override becomes effective", async () => {
    modelCatalogService.setXaiOAuthDiscoveredModels(parseXaiOAuthModelCatalog({
      data: ["grok-build", "grok-composer-2.5-fast"].map((id) => ({
        id,
        context_window: 300_000,
        max_output_tokens: 30_000,
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        default_reasoning_level: "high",
        input_modes: ["text"],
        capabilities: { tools: true, structured_output: false },
      })),
    }));
    const projection = buildPiModelsProjection();
    for (const modelId of ["grok-build", "grok-composer-2.5-fast"]) {
      expect(projection.providers.xai?.models?.find((model) => model.id === modelId)).toMatchObject({
        authScope: "oauth",
      });
    }

    const root = await mkdtemp(join(tmpdir(), "forge-xai-oauth-only-runtime-override-"));
    const projectionPath = join(root, "pi-models.json");
    await writeFile(projectionPath, JSON.stringify(projection), "utf8");
    const authStorage = AuthStorage.inMemory({
      xai: {
        type: "oauth",
        access: "stored-oauth-access-token",
        refresh: "stored-oauth-refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    const registry = ModelRegistry.create(authStorage, projectionPath);
    const selectedModel = registry.find("xai", "grok-build");
    expect(selectedModel).toMatchObject({
      id: "grok-build",
      baseUrl: XAI_OAUTH_BASE_URL,
      authScope: "oauth",
      headers: { "X-XAI-Token-Auth": "xai-grok-cli" },
    });

    authStorage.setRuntimeApiKey("xai", "must-not-pair-with-oauth-only-model");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    for (const modelId of ["grok-build", "grok-composer-2.5-fast"]) {
      expect(registry.find("xai", modelId)).toBeUndefined();
      expect(registry.getAll().some((model) => model.provider === "xai" && model.id === modelId)).toBe(false);
      expect(registry.getAvailable().some((model) => model.provider === "xai" && model.id === modelId)).toBe(false);
    }
    await expect(registry.getApiKeyAndHeaders(selectedModel!)).resolves.toEqual({
      ok: false,
      error: 'Model "xai/grok-build" requires OAuth authentication.',
    });
    expect(selectedModel?.baseUrl).toBe(XAI_API_BASE_URL);
    expect(selectedModel?.headers?.["X-XAI-Token-Auth"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const apiKeyRegistry = ModelRegistry.create(AuthStorage.inMemory({
      xai: { type: "api_key", key: "api-key-auth" },
    }), projectionPath);
    expect(apiKeyRegistry.find("xai", "grok-build")).toBeUndefined();
    expect(apiKeyRegistry.find("xai", "grok-composer-2.5-fast")).toBeUndefined();

    vi.stubEnv("XAI_API_KEY", "environment-api-key-auth");
    const environmentRegistry = ModelRegistry.create(AuthStorage.inMemory({}), projectionPath);
    expect(environmentRegistry.find("xai", "grok-build")).toBeUndefined();
    expect(environmentRegistry.find("xai", "grok-composer-2.5-fast")).toBeUndefined();
  });

  it("sends API keys to api.x.ai while OAuth uses the CLI proxy bearer contract", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("data: [DONE]\\n\\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const apiKeyModel = {
      id: "grok-test",
      name: "Grok Test",
      api: "openai-responses",
      provider: "xai",
      baseUrl: XAI_API_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } as any;
    const oauthModel = xaiOAuthProvider.modifyModels!([apiKeyModel], {
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: Date.now() + 60_000,
    })[0];
    const context = { messages: [] } as any;

    for await (const event of streamOpenAIResponses(apiKeyModel, context, { apiKey: "xai-api-key" })) {
      void event; // Drain the synthetic stream so the request completes.
    }
    for await (const event of streamOpenAIResponses(oauthModel as any, context, { apiKey: "oauth-access-token" })) {
      void event; // Drain the synthetic stream so the request completes.
    }

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer xai-api-key");
    expect(requests[0].headers.get("X-XAI-Token-Auth")).toBeNull();
    expect(requests[1].url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(requests[1].headers.get("authorization")).toBe("Bearer oauth-access-token");
    expect(requests[1].headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
  });

  it("runs Authorization Code + S256 PKCE with the narrow Grok inference scopes", async () => {
    const nativeFetch = globalThis.fetch;
    const exchanges: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      exchanges.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: "browser-access-token",
        refresh_token: "browser-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    let authorizeUrl: URL | undefined;
    const credentials = await xaiOAuthProvider.login({
      onSelect: async () => "browser",
      onAuth: ({ url }) => {
        authorizeUrl = new URL(url);
        const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
        void nativeFetch(callback);
      },
      onDeviceCode: () => undefined,
      onPrompt: async () => "",
      onProgress: () => undefined,
      onManualCodeInput: async () => "",
    });

    expect(credentials).toMatchObject({ access: "browser-access-token", refresh: "browser-refresh-token" });
    expect(authorizeUrl?.origin).toBe("https://auth.x.ai");
    expect(authorizeUrl?.pathname).toBe("/oauth2/authorize");
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl?.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "grok-cli:access",
      "api:access",
      "conversations:read",
      "conversations:write",
    ]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].url).toBe("https://auth.x.ai/oauth2/token");
    const exchangeBody = new URLSearchParams(String(exchanges[0].init?.body));
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects mismatched manual callbacks and accepts a later state-valid retry", async () => {
    const exchanges: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      exchanges.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: "retry-access-token",
        refresh_token: "retry-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    let authorizeUrl: URL | undefined;
    const progressMessages: string[] = [];
    const pendingInputs: Array<(value: string) => void> = [];
    const login = xaiOAuthProvider.login({
      onSelect: async () => "browser",
      onAuth: ({ url }) => {
        authorizeUrl = new URL(url);
      },
      onDeviceCode: () => undefined,
      onPrompt: async () => "",
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onManualCodeInput: () => new Promise<string>((resolve) => {
        pendingInputs.push(resolve);
      }),
    });

    await vi.waitFor(() => {
      expect(authorizeUrl).toBeDefined();
      expect(pendingInputs).toHaveLength(1);
    });

    pendingInputs[0]!("not-a-callback-url");
    await vi.waitFor(() => {
      expect(progressMessages.some((message) => message.includes("invalid or did not match"))).toBe(true);
      expect(pendingInputs).toHaveLength(2);
    });

    const mismatched = new URL(authorizeUrl!.searchParams.get("redirect_uri")!);
    mismatched.searchParams.set("code", "authorization-code");
    mismatched.searchParams.set("state", "stale-or-foreign-state");
    pendingInputs[1]!(mismatched.toString());
    await vi.waitFor(() => expect(pendingInputs).toHaveLength(3));
    expect(exchanges).toHaveLength(0);

    const matching = new URL(authorizeUrl!.searchParams.get("redirect_uri")!);
    matching.searchParams.set("code", "authorization-code");
    matching.searchParams.set("state", authorizeUrl!.searchParams.get("state")!);
    pendingInputs[2]!(matching.toString());

    await expect(login).resolves.toMatchObject({
      access: "retry-access-token",
      refresh: "retry-refresh-token",
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].url).toBe("https://auth.x.ai/oauth2/token");
  });

  it("supports the xAI device flow for headless login", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: "opaque-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.x.ai/device",
        expires_in: 900,
        interval: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "device-access-token",
        refresh_token: "device-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onDeviceCode = vi.fn();

    const login = xaiOAuthProvider.login({
      onSelect: async () => "device",
      onAuth: () => undefined,
      onDeviceCode,
      onPrompt: async () => "",
      onProgress: () => undefined,
    });
    await vi.runAllTimersAsync();

    await expect(login).resolves.toMatchObject({
      access: "device-access-token",
      refresh: "device-refresh-token",
    });
    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.x.ai/device",
      expiresInSeconds: 900,
      intervalSeconds: 1,
    });
  });

  it("uses the pinned refresh endpoint and returns a rotated refresh token without leaking response bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "rotated-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await xaiOAuthProvider.refreshToken({
      access: "expired-access-token",
      refresh: "old-refresh-token",
      expires: 0,
    });

    expect(refreshed).toMatchObject({
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    expect(new Headers(init.headers).get("X-XAI-Token-Auth")).toBeNull();
    expect(new URLSearchParams(String(init.body))).toEqual(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    }));
  });

  it("serializes concurrent refreshes and persists the rotating refresh token", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-xai-oauth-lock-"));
    const authFile = join(root, "auth.json");
    const first = AuthStorage.create(authFile);
    first.set("xai", {
      type: "oauth",
      access: "expired-access-token",
      refresh: "old-refresh-token",
      expires: 0,
    });
    const second = AuthStorage.create(authFile);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "fresh-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(Promise.all([first.getApiKey("xai"), second.getApiKey("xai")])).resolves.toEqual([
      "fresh-access-token",
      "fresh-access-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await readFile(authFile, "utf8"));
    expect(persisted.xai).toMatchObject({
      type: "oauth",
      access: "fresh-access-token",
      refresh: "rotated-refresh-token",
    });
  });
});
