import type { IncomingMessage, ServerResponse } from "node:http";
import { isSharedIntegrationManagerId } from "../../../integrations/shared-config.js";
import type { IntegrationRegistryService } from "../../../integrations/registry.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/integrations\/telegram$/;
const MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/telegram\/test$/;

export function createIntegrationRoutes(options: {
  swarmManager: SwarmManager;
  integrationRegistry: IntegrationRegistryService | null;
}): HttpRoute[] {
  const { swarmManager, integrationRegistry } = options;

  return [
    {
      methods: "GET, PUT, DELETE, POST, OPTIONS",
      matches: (pathname) => isTelegramIntegrationPath(pathname),
      handle: async (request, response, requestUrl) => {
        await handleTelegramIntegrationHttpRequest(
          swarmManager,
          integrationRegistry,
          request,
          response,
          requestUrl
        );
      }
    }
  ];
}

type TelegramIntegrationRoute = {
  managerId: string;
  action: "config" | "test";
};

async function handleTelegramIntegrationHttpRequest(
  swarmManager: SwarmManager,
  integrationRegistry: IntegrationRegistryService | null,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, PUT, DELETE, POST, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  if (!integrationRegistry) {
    sendJson(response, 501, { error: "Telegram integration is unavailable" });
    return;
  }

  const route = resolveTelegramIntegrationRoute(requestUrl.pathname);
  if (!route) {
    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  if (!isManagerOrSharedIntegrationTarget(swarmManager, route.managerId)) {
    sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
    return;
  }

  if (route.action === "config") {
    if (request.method === "GET") {
      const snapshot = await integrationRegistry.getTelegramSnapshot(route.managerId);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "PUT") {
      const payload = await readJsonBody(request);
      const updated = await integrationRegistry.updateTelegramConfig(route.managerId, payload);
      sendJson(response, 200, { ok: true, ...updated });
      return;
    }

    if (request.method === "DELETE") {
      const disabled = await integrationRegistry.disableTelegram(route.managerId);
      sendJson(response, 200, { ok: true, ...disabled });
      return;
    }
  }

  if (route.action === "test" && request.method === "POST") {
    const payload = await readJsonBody(request);
    const result = await integrationRegistry.testTelegramConnection(route.managerId, payload);
    sendJson(response, 200, { ok: true, result });
    return;
  }

  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function isManagerOrSharedIntegrationTarget(
  swarmManager: SwarmManager,
  managerId: string
): boolean {
  if (isSharedIntegrationManagerId(managerId)) {
    return true;
  }

  const descriptor = swarmManager.getAgent(managerId);
  return Boolean(descriptor && descriptor.role === "manager");
}

function isTelegramIntegrationPath(pathname: string): boolean {
  return (
    MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN.test(pathname)
  );
}

function resolveTelegramIntegrationRoute(pathname: string): TelegramIntegrationRoute | null {
  const configMatch = matchPathPattern(pathname, MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN);
  if (configMatch) {
    const managerId = decodePathSegment(configMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "config" };
  }

  const testMatch = matchPathPattern(pathname, MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN);
  if (testMatch) {
    const managerId = decodePathSegment(testMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "test" };
  }

  return null;
}
