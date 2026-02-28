import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntegrationRegistryService } from "../../integrations/registry.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/integrations\/slack$/;
const MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/slack\/test$/;
const MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/slack\/channels$/;
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
      matches: (pathname) => isSlackIntegrationPath(pathname),
      handle: async (request, response, requestUrl) => {
        await handleSlackIntegrationHttpRequest(
          swarmManager,
          integrationRegistry,
          request,
          response,
          requestUrl
        );
      }
    },
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

type SlackIntegrationRoute = {
  managerId: string;
  action: "config" | "test" | "channels";
};

type TelegramIntegrationRoute = {
  managerId: string;
  action: "config" | "test";
};

async function handleSlackIntegrationHttpRequest(
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
    sendJson(response, 501, { error: "Slack integration is unavailable" });
    return;
  }

  const route = resolveSlackIntegrationRoute(requestUrl.pathname);
  if (!route) {
    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  if (!isManagerAgent(swarmManager, route.managerId)) {
    sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
    return;
  }

  if (route.action === "config") {
    if (request.method === "GET") {
      const snapshot = await integrationRegistry.getSlackSnapshot(route.managerId);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "PUT") {
      const payload = await readJsonBody(request);
      const updated = await integrationRegistry.updateSlackConfig(route.managerId, payload);
      sendJson(response, 200, { ok: true, ...updated });
      return;
    }

    if (request.method === "DELETE") {
      const disabled = await integrationRegistry.disableSlack(route.managerId);
      sendJson(response, 200, { ok: true, ...disabled });
      return;
    }
  }

  if (route.action === "test" && request.method === "POST") {
    const payload = await readJsonBody(request);
    const result = await integrationRegistry.testSlackConnection(route.managerId, payload);
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (route.action === "channels" && request.method === "GET") {
    const includePrivate = parseOptionalBoolean(requestUrl.searchParams.get("includePrivateChannels"));

    const channels = await integrationRegistry.listSlackChannels(route.managerId, {
      includePrivateChannels: includePrivate
    });

    sendJson(response, 200, { channels });
    return;
  }

  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

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

  if (!isManagerAgent(swarmManager, route.managerId)) {
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

function isManagerAgent(swarmManager: SwarmManager, managerId: string): boolean {
  const descriptor = swarmManager.getAgent(managerId);
  return Boolean(descriptor && descriptor.role === "manager");
}

function isSlackIntegrationPath(pathname: string): boolean {
  return (
    MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN.test(pathname)
  );
}

function isTelegramIntegrationPath(pathname: string): boolean {
  return (
    MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN.test(pathname)
  );
}

function resolveSlackIntegrationRoute(pathname: string): SlackIntegrationRoute | null {
  const configMatch = matchPathPattern(pathname, MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN);
  if (configMatch) {
    const managerId = decodePathSegment(configMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "config" };
  }

  const testMatch = matchPathPattern(pathname, MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN);
  if (testMatch) {
    const managerId = decodePathSegment(testMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "test" };
  }

  const channelsMatch = matchPathPattern(pathname, MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN);
  if (channelsMatch) {
    const managerId = decodePathSegment(channelsMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "channels" };
  }

  return null;
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

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}
