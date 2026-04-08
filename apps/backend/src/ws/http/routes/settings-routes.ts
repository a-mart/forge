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
const OPENAI_CODEX_POOL_ADD_FLOW_KEY = "openai-codex:pool-add";

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
  // ── Credential pool routes: /api/settings/auth/openai-codex/accounts/* ──
  const poolPrefix = `${SETTINGS_AUTH_ENDPOINT_PATH}/openai-codex/accounts`;
  if (requestUrl.pathname === poolPrefix || requestUrl.pathname.startsWith(`${poolPrefix}/`)) {
    await handleCredentialPoolHttpRequest(swarmManager, activeSettingsAuthLoginFlows, request, response, requestUrl, poolPrefix);
    return;
  }

  // ── Pool strategy: /api/settings/auth/openai-codex/strategy ──
  const strategyPath = `${SETTINGS_AUTH_ENDPOINT_PATH}/openai-codex/strategy`;
  if (requestUrl.pathname === strategyPath) {
    await handleCredentialPoolStrategyHttpRequest(swarmManager, request, response);
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

    if (provider === "openai-codex") {
      sendJson(response, 400, { error: "Use pool management to remove OpenAI Codex accounts." });
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

  const relativePath = requestUrl.pathname.slice(poolPrefix.length);
  // relativePath examples: "", "/login", "/:id", "/:id/label", "/:id/primary", "/:id/cooldown"

  // GET /api/settings/auth/openai-codex/accounts — list pool
  if (request.method === "GET" && relativePath === "") {
    try {
      const pool = await swarmManager.listCredentialPool("openai-codex");
      sendJson(response, 200, { pool });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to list credential pool" });
    }
    return;
  }

  // POST /api/settings/auth/openai-codex/accounts/login — add account via OAuth SSE
  if (request.method === "POST" && relativePath === "/login") {
    await handlePoolAddAccountOAuthLogin(swarmManager, activeSettingsAuthLoginFlows, request, response);
    return;
  }

  // POST /api/settings/auth/openai-codex/accounts/login/respond — submit prompt input for pool OAuth flow
  if (request.method === "POST" && relativePath === "/login/respond") {
    const payload = parseSettingsAuthLoginRespondBody(await readJsonBody(request));
    // Find the active pool add-account flow (keyed as "openai-codex:add-<nonce>")
    let poolFlow: SettingsAuthLoginFlow | undefined;
    for (const [key, flow] of activeSettingsAuthLoginFlows.entries()) {
      if (key.startsWith("openai-codex:add-") && !flow.closed) {
        poolFlow = flow;
        break;
      }
    }
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

  // Routes with :id segment
  const idMatch = relativePath.match(/^\/([^/]+)(?:\/(.+))?$/);
  if (!idMatch) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const credentialId = decodeURIComponent(idMatch[1]);
  const action = idMatch[2]; // "label", "primary", "cooldown", or undefined

  // PATCH /api/settings/auth/openai-codex/accounts/:id/label — rename
  if (request.method === "PATCH" && action === "label") {
    try {
      const body = (await readJsonBody(request)) as { label?: unknown };
      if (typeof body?.label !== "string" || !body.label.trim()) {
        sendJson(response, 400, { error: "label must be a non-empty string" });
        return;
      }
      await swarmManager.renamePooledCredential("openai-codex", credentialId, body.label);
      const pool = await swarmManager.listCredentialPool("openai-codex");
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to rename credential" });
    }
    return;
  }

  // POST /api/settings/auth/openai-codex/accounts/:id/primary — set primary
  if (request.method === "POST" && action === "primary") {
    try {
      await swarmManager.setPrimaryPooledCredential("openai-codex", credentialId);
      const pool = await swarmManager.listCredentialPool("openai-codex");
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to set primary" });
    }
    return;
  }

  // DELETE /api/settings/auth/openai-codex/accounts/:id/cooldown — reset cooldown
  if (request.method === "DELETE" && action === "cooldown") {
    try {
      await swarmManager.resetPooledCredentialCooldown("openai-codex", credentialId);
      const pool = await swarmManager.listCredentialPool("openai-codex");
      sendJson(response, 200, { ok: true, pool });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Failed to reset cooldown" });
    }
    return;
  }

  // DELETE /api/settings/auth/openai-codex/accounts/:id — remove account
  if (request.method === "DELETE" && action === undefined) {
    try {
      await swarmManager.removePooledCredential("openai-codex", credentialId);
      const pool = await swarmManager.listCredentialPool("openai-codex");
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
  response: ServerResponse
): Promise<void> {
  const methods = "POST, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

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
    await swarmManager.setCredentialPoolStrategy("openai-codex", strategy as CredentialPoolStrategy);
    const pool = await swarmManager.listCredentialPool("openai-codex");
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
  response: ServerResponse
): Promise<void> {
  if (request.method !== "POST") {
    applyCorsHeaders(request, response, "POST, OPTIONS");
    response.setHeader("Allow", "POST, OPTIONS");
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  // Use a nonce key to avoid collisions with existing login flows
  const flowKey = `openai-codex:add-${Date.now()}`;

  // Check if there's already an add-account flow running or a provider-scoped login using the same provider.
  for (const [key, existingFlow] of activeSettingsAuthLoginFlows.entries()) {
    if (
      !existingFlow.closed &&
      (key.startsWith("openai-codex:add-") || key === OPENAI_CODEX_POOL_ADD_FLOW_KEY || key === "openai-codex")
    ) {
      applyCorsHeaders(request, response, "POST, OPTIONS");
      sendJson(response, 409, { error: "An OpenAI OAuth flow is already in progress" });
      return;
    }
  }

  const flow: SettingsAuthLoginFlow = {
    providerId: "openai-codex",
    pendingPrompt: null,
    abortController: new AbortController(),
    closed: false
  };
  activeSettingsAuthLoginFlows.set(flowKey, flow);
  activeSettingsAuthLoginFlows.set(OPENAI_CODEX_POOL_ADD_FLOW_KEY, flow);

  const provider = SETTINGS_AUTH_LOGIN_PROVIDERS["openai-codex"];

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
    const aliasFlow = activeSettingsAuthLoginFlows.get(OPENAI_CODEX_POOL_ADD_FLOW_KEY);
    if (aliasFlow === flow) {
      activeSettingsAuthLoginFlows.delete(OPENAI_CODEX_POOL_ADD_FLOW_KEY);
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

  sendSseEvent("progress", { message: "Starting OpenAI OAuth login for new account..." });

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

    // Store in credential pool instead of directly in auth.json
    await swarmManager.addPooledCredential(
      "openai-codex",
      { type: "oauth", ...credentials },
      { label: undefined } // Will auto-label as "Account N"
    );

    sendSseEvent("complete", { provider: "openai-codex", status: "connected" });
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
    const flow =
      activeSettingsAuthLoginFlows.get(providerId) ??
      (providerId === "openai-codex" ? activeSettingsAuthLoginFlows.get(OPENAI_CODEX_POOL_ADD_FLOW_KEY) : undefined);
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

  if (
    activeSettingsAuthLoginFlows.has(providerId) ||
    (providerId === "openai-codex" && activeSettingsAuthLoginFlows.has(OPENAI_CODEX_POOL_ADD_FLOW_KEY))
  ) {
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
