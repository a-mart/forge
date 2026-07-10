import type {
  BuilderSidebarOrderConflictResponse,
  BuilderSidebarOrderUpdatedEvent,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  BuilderSidebarOrderConflictError,
  BuilderSidebarOrderService,
  BuilderSidebarOrderValidationError,
  MAX_BUILDER_SIDEBAR_ORDER_REQUEST_BYTES,
} from "../../../swarm/builder-sidebar-order-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export const BUILDER_SIDEBAR_ORDER_ENDPOINT = "/api/settings/builder-sidebar-order";
const METHODS = "GET, PUT, OPTIONS";

export function createBuilderSidebarOrderRoutes(options: {
  service: BuilderSidebarOrderService;
  runtimeTarget: RuntimeTarget;
  broadcastEvent?: (event: BuilderSidebarOrderUpdatedEvent) => void;
}): HttpRoute[] {
  return [
    {
      methods: METHODS,
      matches: (pathname) => pathname === BUILDER_SIDEBAR_ORDER_ENDPOINT,
      handle: async (request, response) => {
        await handleRequest(request, response, options);
      },
    },
  ];
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    service: BuilderSidebarOrderService;
    runtimeTarget: RuntimeTarget;
    broadcastEvent?: (event: BuilderSidebarOrderUpdatedEvent) => void;
  },
): Promise<void> {
  // Fail closed before even advertising CORS/method support. The production
  // collaboration runtime does not mount this route at all; this guard also
  // protects direct factory use and tests.
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    sendJson(response, 404, { error: "Builder sidebar order is only available in Builder runtime." });
    return;
  }

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, METHODS);

  if (request.method === "GET") {
    sendJson(response, 200, options.service.getState() as unknown as Record<string, unknown>);
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const state = await options.service.update(
      await readJsonBody(request, MAX_BUILDER_SIDEBAR_ORDER_REQUEST_BYTES),
    );
    options.broadcastEvent?.({ type: "builder_sidebar_order_updated", revision: state.revision });
    sendJson(response, 200, state as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof BuilderSidebarOrderConflictError) {
      const payload: BuilderSidebarOrderConflictResponse = {
        error: error.message,
        current: error.current,
      };
      sendJson(response, 409, payload as unknown as Record<string, unknown>);
      return;
    }
    if (error instanceof BuilderSidebarOrderValidationError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    if (error instanceof Error && isBadRequestBodyError(error.message)) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }
}

function isBadRequestBodyError(message: string): boolean {
  return message === "Request body must be valid JSON" || message.startsWith("Request body too large");
}
