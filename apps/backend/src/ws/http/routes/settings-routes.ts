import {
  anthropicOAuthProvider,
  openaiCodexOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface
} from "@mariozechner/pi-ai/oauth";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CredentialPoolState,
  CredentialPoolStrategy,
  SettingsAuthLoginEventName,
  SettingsAuthLoginEventPayload,
  SettingsAuthLoginProviderId,
  SettingsAuthMutationResponse,
  SettingsAuthResponse,
  SettingsEnvMutationResponse,
  SettingsEnvResponse,
} from "@forge/protocol";
import { ensureCanonicalAuthFilePath } from "../../../swarm/auth-storage-paths.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SETTINGS_ENV_ENDPOINT_PATH = "/api/settings/env";
const SETTINGS_AUTH_ENDPOINT_PATH = "/api/settings/auth";
const SETTINGS_AUTH_LOGIN_ENDPOINT_PATH = "/api/settings/auth/login";
const SETTINGS_AUTH_LOGIN_METHODS = "POST, OPTIONS";
const SETTINGS_AUTH_METHODS = "GET, PUT, DELETE, POST, OPTIONS";

type PooledSettingsAuthProviderId = SettingsAuthLoginProviderId;

interface SettingsAuthLoginFlow {
  providerId: SettingsAuthLoginProviderId;
  pendingPrompt:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      }
    | null;
  abortController: AbortController;
  closed: boolean;
}

const SETTINGS_AUTH_LOGIN_PROVIDERS: Record<SettingsAuthLoginProviderId, OAuthProviderInterface> = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider
};

export interface SettingsRouteBundle {
  routes: HttpRoute[];
  cancelActiveSettingsAuthLoginFlows: () => void;
}

export function createSettingsRoutes(options: { swarmManager: SwarmManager }): SettingsRouteBundle {
  const { swarmManager } = options;
  const activeSettingsAuthLoginFlows = new Map<string, SettingsAuthLoginFlow>();

  const routes: HttpRoute[] = [
    {
      methods: "GET, PUT, DELETE, OPTIONS",
      matches: (pathname) => pathname === SETTINGS_ENV_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSettingsEnvHttpRequest(swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: SETTINGS_AUTH_METHODS,
      matches: (pathname) =>
        pathname === SETTINGS_AUTH_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSettingsAuthHttpRequest(
          swarmManager,
          activeSettingsAuthLoginFlows,
          request,
          response,
          requestUrl
        );
      }
    }
  ];

  return {
    routes,
    cancelActiveSettingsAuthLoginFlows: () => {
      for (const flow of activeSettingsAuthLoginFlows.values()) {
        flow.closed = true;
        flow.abortController.abort();
        if (flow.pendingPrompt) {
          const pendingPrompt = flow.pendingPrompt;
          flow.pendingPrompt = null;
          pendingPrompt.reject(new Error("OAuth login flow cancelled"));
        }
      }
      activeSettingsAuthLoginFlows.clear();
    }
  };
}

async function handleSettingsEnvHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, PUT, DELETE, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const variables = await swarmManager.listSettingsEnv();
    const payload: SettingsEnvResponse = { variables };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "PUT" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const payload = parseSettingsEnvUpdateBody(await readJsonBody(request));
    await swarmManager.updateSettingsEnv(payload);
    const variables = await swarmManager.listSettingsEnv();
    const responsePayload: SettingsEnvMutationResponse = { ok: true, variables };
    sendJson(response, 200, responsePayload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)) {
    applyCorsHeaders(request, response, methods);
    const variableName = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_ENV_ENDPOINT_PATH.length + 1));
    if (!variableName) {
      sendJson(response, 400, { error: "Missing environment variable name" });
      return;
    }

    await swarmManager.deleteSettingsEnv(variableName);
    const variables = await swarmManager.listSettingsEnv();
    const payload: SettingsEnvMutationResponse = { ok: true, variables };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSettingsAuthHttpRequest(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const authRelativePath = requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)
    ? requestUrl.pathname.slice(SETTINGS_AUTH_ENDPOINT_PATH.length + 1)
    : "";
  const authPathSegments = authRelativePath.split("/").filter((segment) => segment.length > 0);
  const rawProviderSegment = authPathSegments[0] ?? "";

  if (authPathSegments[1] === "accounts") {
    const poolPrefix = `${SETTINGS_AUTH_ENDPOINT_PATH}/${rawProviderSegment}/accounts`;
    await handleCredentialPoolHttpRequest(
      swarmManager,
      activeSettingsAuthLoginFlows,
      request,
      response,
      requestUrl,
      decodeURIComponent(rawProviderSegment),
      poolPrefix
    );
    return;
  }

  if (authPathSegments[1] === "strategy" && authPathSegments.length === 2) {
    await handleCredentialPoolStrategyHttpRequest(
      swarmManager,
      request,
      response,
      decodeURIComponent(rawProviderSegment)
    );
    return;
  }

  // ── Legacy OAuth login flow ──
  if (
    requestUrl.pathname === SETTINGS_AUTH_LOGIN_ENDPOINT_PATH ||
    requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
  ) {
    await handleSettingsAuthLoginHttpRequest(swarmManager, activeSettingsAuthLoginFlows, request, response, requestUrl);
    return;
  }

  const methods = SETTINGS_AUTH_METHODS;

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const providers = await swarmManager.listSettingsAuth();
    const payload: SettingsAuthResponse = { providers };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "PUT" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const payload = parseSettingsAuthUpdateBody(await readJsonBody(request));
    await swarmManager.updateSettingsAuth(payload);
    const providers = await swarmManager.listSettingsAuth();
    const responsePayload: SettingsAuthMutationResponse = { ok: true, providers };
    sendJson(response, 200, responsePayload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)) {
    applyCorsHeaders(request, response, methods);
    const provider = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_AUTH_ENDPOINT_PATH.length + 1));
    if (!provider) {
      sendJson(response, 400, { error: "Missing auth provider" });
      return;
    }

    const pooledState = await tryListPooledCredentialState(swarmManager, provider);
    if (pooledState && pooledState.credentials.length > 0) {
      sendJson(response, 400, { error: `Use pool management to remove ${getSettingsAuthProviderLabel(provider)} accounts.` });
      return;
    }

    await swarmManager.deleteSettingsAuth(provider);
    const providers = await swarmManager.listSettingsAuth();
    const payload: SettingsAuthMutationResponse = { ok: true, providers };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

// ── Credential Pool Routes ──

async function handleCredentialPoolHttpRequest(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  rawProvider: string,
  poolPrefix: string
): Promise<void> {
  const methods = "GET, POST, PATCH, DELETE, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  const resolvedProvider = await resolvePooledSettingsAuthProvider(swarmManager, rawProvider);
  if (!resolvedProvider) {
    sendJson(response, 400, { error: "Invalid pooled auth provider" });
    return;
  }

  const { providerId, pool: initialPool } = resolvedProvider;
  const relativePath = requestUrl.pathname.slice(poolPrefix.length);

  if (request.method === "GET" && relativePath === "") {
    sendJson(response, 200, { pool: initialPool });
    return;
  }

  if (request.method === "POST" && relativePath === "/login") {
    await handlePoolAddAccountOAuthLogin(
      swarmManager,
      activeSettingsAuthLoginFlows,
      request,
      response,
      providerId
    );
    return;
  }

  if (request.method === "POST" && relativePath === "/login/respond") {
    const payload = parseSettingsAuthLoginRespondBody(await readJsonBody(request));
    const poolFlow = findActivePoolAddFlow(activeSettingsAuthLoginFlows, providerId);
    if (!poolFlow) {
      sendJson(response, 409, { error: "No active pool add-account OAuth flow" });
      return;
    }
    if (!poolFlow.pendingPrompt) {
      sendJson(response, 409, { error: "OAuth login flow is not waiting for input" });
      return;
    }
    const pendingPrompt = poolFlow.pendingPrompt;
    poolFlow.pendingPrompt = null;
    pendingPrompt.resolve(payload.value);
    sendJson(response, 200, { ok: true });
    return;
  }

  const idMatch = relativePath.match(/^\/([^/]+)(?:\/(.+))?$/);
  if (!idMatch) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const credentialId = decodeURIComponent(idMatch[1]);
  const action = idMatch[2];

  if (request.method === "PATCH" && action === "label") {
    try {
      const body = (await readJsonBody(request)) as { label?: unknown };
      if (typeof body?.label !== "string" || !body.label.trim()) {
        sendJson(response, 400, { error: "label must be a non-empty string" });
        return;
      }
      await swarmManager.renamePooledCredential(providerId, credentialId, body.label);
      const pool = await swarmManager.listCredentialPool(providerId);
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to rename credential" });
    }
    return;
  }

  if (request.method === "POST" && action === "primary") {
    try {
      await swarmManager.setPrimaryPooledCredential(providerId, credentialId);
      const pool = await swarmManager.listCredentialPool(providerId);
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to set primary" });
    }
    return;
  }

  if (request.method === "DELETE" && action === "cooldown") {
    try {
      await swarmManager.resetPooledCredentialCooldown(providerId, credentialId);
      const pool = await swarmManager.listCredentialPool(providerId);
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to reset cooldown" });
    }
    return;
  }

  if (request.method === "DELETE" && action === undefined) {
    try {
      await swarmManager.removePooledCredential(providerId, credentialId);
      const pool = await swarmManager.listCredentialPool(providerId);
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to remove credential" });
    }
    return;
  }

  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleCredentialPoolStrategyHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  rawProvider: string
): Promise<void> {
  const methods = "POST, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  const resolvedProvider = await resolvePooledSettingsAuthProvider(swarmManager, rawProvider);
  if (!resolvedProvider) {
    sendJson(response, 400, { error: "Invalid pooled auth provider" });
    return;
  }

  const { providerId } = resolvedProvider;

  if (request.method !== "POST") {
    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const body = (await readJsonBody(request)) as { strategy?: unknown };
    const strategy = body?.strategy;
    if (strategy !== "fill_first" && strategy !== "least_used") {
      sendJson(response, 400, { error: "strategy must be 'fill_first' or 'least_used'" });
      return;
    }
    await swarmManager.setCredentialPoolStrategy(providerId, strategy as CredentialPoolStrategy);
    const pool = await swarmManager.listCredentialPool(providerId);
    sendJson(response, 200, { ok: true, pool });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to set strategy" });
  }
}

/**
 * Add-account OAuth SSE flow. Reuses the existing OAuth SSE pattern but
 * stores the credential in the pool instead of directly in auth.json.
 */
async function handlePoolAddAccountOAuthLogin(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  providerId: PooledSettingsAuthProviderId
): Promise<void> {
  if (request.method !== "POST") {
    applyCorsHeaders(request, response, "POST, OPTIONS");
    response.setHeader("Allow", "POST, OPTIONS");
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const flowKey = `${getPoolAddFlowKeyPrefix(providerId)}${Date.now()}`;
  const flowAliasKey = getPoolAddFlowAliasKey(providerId);
  const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];

  for (const [key, existingFlow] of activeSettingsAuthLoginFlows.entries()) {
    if (
      !existingFlow.closed &&
      (key.startsWith(getPoolAddFlowKeyPrefix(providerId)) || key === flowAliasKey || key === providerId)
    ) {
      applyCorsHeaders(request, response, "POST, OPTIONS");
      sendJson(response, 409, { error: `${provider.name} OAuth flow is already in progress` });
      return;
    }
  }

  const flow: SettingsAuthLoginFlow = {
    providerId,
    pendingPrompt: null,
    abortController: new AbortController(),
    closed: false
  };
  activeSettingsAuthLoginFlows.set(flowKey, flow);
  activeSettingsAuthLoginFlows.set(flowAliasKey, flow);

  applyCorsHeaders(request, response, "POST, OPTIONS");
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("X-Accel-Buffering", "no");

  if (typeof response.flushHeaders === "function") {
    response.flushHeaders();
  }

  const sendSseEvent = <TEventName extends SettingsAuthLoginEventName>(
    eventName: TEventName,
    data: SettingsAuthLoginEventPayload[TEventName]
  ): void => {
    if (flow.closed || response.writableEnded || response.destroyed) return;
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const closeFlow = (reason: string): void => {
    if (flow.closed) return;
    flow.closed = true;
    flow.abortController.abort();
    if (flow.pendingPrompt) {
      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.reject(new Error(reason));
    }
    const activeFlow = activeSettingsAuthLoginFlows.get(flowKey);
    if (activeFlow === flow) {
      activeSettingsAuthLoginFlows.delete(flowKey);
    }
    const aliasFlow = activeSettingsAuthLoginFlows.get(flowAliasKey);
    if (aliasFlow === flow) {
      activeSettingsAuthLoginFlows.delete(flowAliasKey);
    }
  };

  const requestPromptInput = (prompt: {
    message: string;
    placeholder?: string;
  }): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (flow.closed) {
        reject(new Error("OAuth login flow is closed"));
        return;
      }
      if (flow.pendingPrompt) {
        const previousPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        previousPrompt.reject(new Error("OAuth login prompt replaced"));
      }
      const wrappedResolve = (value: string): void => {
        if (flow.pendingPrompt?.resolve === wrappedResolve) flow.pendingPrompt = null;
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        if (flow.pendingPrompt?.reject === wrappedReject) flow.pendingPrompt = null;
        reject(error);
      };
      flow.pendingPrompt = { resolve: wrappedResolve, reject: wrappedReject };
      sendSseEvent("prompt", prompt);
    });

  const onClose = (): void => closeFlow("OAuth login stream closed");
  request.on("close", onClose);
  response.on("close", onClose);

  sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login for new account...` });

  try {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        sendSseEvent("auth_url", { url: info.url, instructions: info.instructions });
      },
      onPrompt: (prompt) =>
        requestPromptInput({ message: prompt.message, placeholder: prompt.placeholder }),
      onProgress: (message) => {
        sendSseEvent("progress", { message });
      },
      signal: flow.abortController.signal
    };

    if (provider.usesCallbackServer) {
      callbacks.onManualCodeInput = () =>
        requestPromptInput({
          message: "Paste redirect URL below, or complete login in browser:",
          placeholder: "http://localhost:1455/auth/callback?code=..."
        });
    }

    const credentials = (await provider.login(callbacks)) as OAuthCredentials;
    if (flow.closed) return;

    await swarmManager.addPooledCredential(
      providerId,
      { type: "oauth", ...credentials },
      { label: undefined }
    );

    sendSseEvent("complete", { provider: providerId, status: "connected" });
  } catch (error) {
    if (!flow.closed) {
      const message = error instanceof Error ? error.message : String(error);
      sendSseEvent("error", { message });
    }
  } finally {
    request.off("close", onClose);
    response.off("close", onClose);
    closeFlow("OAuth login flow closed");
    if (!response.writableEnded) response.end();
  }
}

// ── Legacy OAuth Login Routes ──

async function handleSettingsAuthLoginHttpRequest(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  const relativePath = requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
    ? requestUrl.pathname.slice(SETTINGS_AUTH_LOGIN_ENDPOINT_PATH.length + 1)
    : "";
  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
  const rawProvider = pathSegments[0] ?? "";
  const providerId = resolveSettingsAuthLoginProviderId(rawProvider);
  const action = pathSegments[1];

  applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);

  if (!providerId) {
    sendJson(response, 400, { error: "Invalid OAuth provider" });
    return;
  }

  if (action === "respond") {
    if (request.method !== "POST") {
      response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
      sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (pathSegments.length !== 2) {
      sendJson(response, 400, { error: "Invalid OAuth login respond path" });
      return;
    }

    const payload = parseSettingsAuthLoginRespondBody(await readJsonBody(request));
    const flow = activeSettingsAuthLoginFlows.get(providerId) ?? findActivePoolAddFlow(activeSettingsAuthLoginFlows, providerId);
    if (!flow) {
      sendJson(response, 409, { error: "No active OAuth login flow for provider" });
      return;
    }

    if (!flow.pendingPrompt) {
      sendJson(response, 409, { error: "OAuth login flow is not waiting for input" });
      return;
    }

    const pendingPrompt = flow.pendingPrompt;
    flow.pendingPrompt = null;
    pendingPrompt.resolve(payload.value);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (action !== undefined || pathSegments.length !== 1) {
    sendJson(response, 400, { error: "Invalid OAuth login path" });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  if (activeSettingsAuthLoginFlows.has(providerId) || hasActivePoolAddFlow(activeSettingsAuthLoginFlows, providerId)) {
    sendJson(response, 409, { error: "OAuth login already in progress for provider" });
    return;
  }

  const flow: SettingsAuthLoginFlow = {
    providerId,
    pendingPrompt: null,
    abortController: new AbortController(),
    closed: false
  };
  activeSettingsAuthLoginFlows.set(providerId, flow);

  const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];
  const authFilePath = await ensureCanonicalAuthFilePath(swarmManager.getConfig());
  const authStorage = AuthStorage.create(authFilePath);

  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("X-Accel-Buffering", "no");

  if (typeof response.flushHeaders === "function") {
    response.flushHeaders();
  }

  const sendSseEvent = <TEventName extends SettingsAuthLoginEventName>(
    eventName: TEventName,
    data: SettingsAuthLoginEventPayload[TEventName]
  ): void => {
    if (flow.closed || response.writableEnded || response.destroyed) {
      return;
    }

    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const closeFlow = (reason: string): void => {
    if (flow.closed) {
      return;
    }

    flow.closed = true;
    flow.abortController.abort();

    if (flow.pendingPrompt) {
      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.reject(new Error(reason));
    }

    const activeFlow = activeSettingsAuthLoginFlows.get(providerId);
    if (activeFlow === flow) {
      activeSettingsAuthLoginFlows.delete(providerId);
    }
  };

  const requestPromptInput = (prompt: {
    message: string;
    placeholder?: string;
  }): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (flow.closed) {
        reject(new Error("OAuth login flow is closed"));
        return;
      }

      if (flow.pendingPrompt) {
        const previousPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        previousPrompt.reject(new Error("OAuth login prompt replaced by a newer request"));
      }

      const wrappedResolve = (value: string): void => {
        if (flow.pendingPrompt?.resolve === wrappedResolve) {
          flow.pendingPrompt = null;
        }
        resolve(value);
      };

      const wrappedReject = (error: Error): void => {
        if (flow.pendingPrompt?.reject === wrappedReject) {
          flow.pendingPrompt = null;
        }
        reject(error);
      };

      flow.pendingPrompt = {
        resolve: wrappedResolve,
        reject: wrappedReject
      };

      sendSseEvent("prompt", prompt);
    });

  const onClose = (): void => {
    closeFlow("OAuth login stream closed");
  };

  request.on("close", onClose);
  response.on("close", onClose);

  sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login...` });

  try {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        sendSseEvent("auth_url", {
          url: info.url,
          instructions: info.instructions
        });
      },
      onPrompt: (prompt) =>
        requestPromptInput({
          message: prompt.message,
          placeholder: prompt.placeholder
        }),
      onProgress: (message) => {
        sendSseEvent("progress", { message });
      },
      signal: flow.abortController.signal
    };

    if (provider.usesCallbackServer) {
      callbacks.onManualCodeInput = () =>
        requestPromptInput({
          message: "Paste redirect URL below, or complete login in browser:",
          placeholder: "http://localhost:1455/auth/callback?code=..."
        });
    }

    const credentials = (await provider.login(callbacks)) as OAuthCredentials;
    if (flow.closed) {
      return;
    }

    authStorage.set(providerId, {
      type: "oauth",
      ...credentials
    });

    sendSseEvent("complete", {
      provider: flow.providerId,
      status: "connected"
    });
  } catch (error) {
    if (!flow.closed) {
      const message = error instanceof Error ? error.message : String(error);
      sendSseEvent("error", { message });
    }
  } finally {
    request.off("close", onClose);
    response.off("close", onClose);
    closeFlow("OAuth login flow closed");
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function resolvePooledSettingsAuthProvider(
  swarmManager: SwarmManager,
  rawProvider: string
): Promise<{ providerId: PooledSettingsAuthProviderId; pool: CredentialPoolState } | undefined> {
  const provider = rawProvider.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }

  try {
    const pool = await swarmManager.listCredentialPool(provider);
    const providerId = resolveSettingsAuthLoginProviderId(provider);
    if (!providerId) {
      return undefined;
    }

    return {
      providerId,
      pool
    };
  } catch (error) {
    if (isUnsupportedPooledProviderError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function tryListPooledCredentialState(
  swarmManager: SwarmManager,
  provider: string
): Promise<CredentialPoolState | undefined> {
  try {
    return await swarmManager.listCredentialPool(provider.trim().toLowerCase());
  } catch (error) {
    if (isUnsupportedPooledProviderError(error)) {
      return undefined;
    }
    throw error;
  }
}

function hasActivePoolAddFlow(
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  providerId: PooledSettingsAuthProviderId
): boolean {
  return findActivePoolAddFlow(activeSettingsAuthLoginFlows, providerId) !== undefined;
}

function findActivePoolAddFlow(
  activeSettingsAuthLoginFlows: Map<string, SettingsAuthLoginFlow>,
  providerId: PooledSettingsAuthProviderId
): SettingsAuthLoginFlow | undefined {
  const aliasFlow = activeSettingsAuthLoginFlows.get(getPoolAddFlowAliasKey(providerId));
  if (aliasFlow && !aliasFlow.closed) {
    return aliasFlow;
  }

  const flowKeyPrefix = getPoolAddFlowKeyPrefix(providerId);
  for (const [key, flow] of activeSettingsAuthLoginFlows.entries()) {
    if (key.startsWith(flowKeyPrefix) && !flow.closed) {
      return flow;
    }
  }

  return undefined;
}

function getPoolAddFlowKeyPrefix(providerId: PooledSettingsAuthProviderId): string {
  return `${providerId}:add-`;
}

function getPoolAddFlowAliasKey(providerId: PooledSettingsAuthProviderId): string {
  return `${providerId}:pool-add`;
}

function getSettingsAuthProviderLabel(provider: string): string {
  const providerId = resolveSettingsAuthLoginProviderId(provider);
  switch (providerId) {
    case "anthropic":
      return "Anthropic";
    case "openai-codex":
      return "OpenAI Codex";
    default:
      return provider;
  }
}

function isUnsupportedPooledProviderError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Credential pooling is only supported for");
}

function parseSettingsEnvUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybeValues = "values" in value ? (value as { values?: unknown }).values : value;
  if (!maybeValues || typeof maybeValues !== "object" || Array.isArray(maybeValues)) {
    throw new Error("settings env payload must be an object map");
  }

  const updates: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(maybeValues)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings env value for ${name} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings env value for ${name} must be a non-empty string`);
    }

    updates[name] = normalized;
  }

  return updates;
}

function parseSettingsAuthUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const updates: Record<string, string> = {};

  for (const [provider, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings auth value for ${provider} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings auth value for ${provider} must be a non-empty string`);
    }

    updates[provider] = normalized;
  }

  return updates;
}

function parseSettingsAuthLoginRespondBody(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const rawValue = (value as { value?: unknown }).value;
  if (typeof rawValue !== "string") {
    throw new Error("OAuth response value must be a string");
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    throw new Error("OAuth response value must be a non-empty string");
  }

  return { value: normalized };
}

function resolveSettingsAuthLoginProviderId(rawProvider: string): SettingsAuthLoginProviderId | undefined {
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "openai-codex") {
    return normalized;
  }

  return undefined;
}
