import type { RemoteUpdateAwarenessProjectOverride } from "@forge/protocol";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import {
  LocalRemoteUpdateAwarenessService,
  RemoteUpdateAwarenessConflictError,
  RemoteUpdateAwarenessNotFoundError,
} from "../services/remote-update-awareness-service.js";
import type { HttpRoute } from "../shared/http-route.js";

const GET_METHODS = "GET, OPTIONS";
const MUTATION_METHODS = "POST, OPTIONS";
const BASE = "/api/git/remote-update-awareness";

export function createRemoteUpdateAwarenessRoutes(options: {
  service: LocalRemoteUpdateAwarenessService;
}): HttpRoute[] {
  const { service } = options;
  return [
    {
      methods: "GET, PATCH, OPTIONS",
      matches: (pathname) => pathname === `${BASE}/settings`,
      handle: async (request, response) => {
        applyCorsHeaders(request, response, "GET, PATCH, OPTIONS");
        if (handleOptions(request, response)) return;
        try {
          if (request.method === "GET") {
            sendJson(response, 200, service.getSettingsSnapshot() as unknown as Record<string, unknown>);
            return;
          }
          if (request.method !== "PATCH") return methodNotAllowed(response, "GET, PATCH, OPTIONS");
          const body = requireObject(await readJsonBody(request));
          if (typeof body.globalEnabled !== "boolean") throw new Error("globalEnabled must be a boolean");
          sendJson(response, 200, service.setGlobalEnabled(body.globalEnabled) as unknown as Record<string, unknown>);
        } catch (error) {
          sendRouteError(response, error);
        }
      },
    },
    {
      methods: "GET, PATCH, OPTIONS",
      matches: (pathname) => pathname === `${BASE}/project`,
      handle: async (request, response, requestUrl) => {
        applyCorsHeaders(request, response, "GET, PATCH, OPTIONS");
        if (handleOptions(request, response)) return;
        try {
          if (request.method === "GET") {
            const projectId = requireProjectQuery(requestUrl);
            sendJson(response, 200, { snapshot: service.getProjectSnapshot(projectId) } as unknown as Record<string, unknown>);
            return;
          }
          if (request.method !== "PATCH") return methodNotAllowed(response, "GET, PATCH, OPTIONS");
          const body = requireObject(await readJsonBody(request));
          const projectId = requireProjectId(body.projectId);
          const override = requireOverride(body.override);
          const snapshot = service.setProjectOverride(projectId, override);
          sendJson(response, 200, {
            project: {
              projectId,
              override: snapshot.override,
              effectiveEnabled: snapshot.effectiveEnabled,
            },
          });
        } catch (error) {
          sendRouteError(response, error);
        }
      },
    },
    createProjectMutationRoute(`${BASE}/activate`, async (service, projectId) => ({
      snapshot: service.activateProject(projectId),
    }), service),
    createProjectMutationRoute(`${BASE}/refresh`, async (service, projectId) => ({
      snapshot: await service.refreshProject(projectId),
    }), service),
    {
      methods: MUTATION_METHODS,
      matches: (pathname) => pathname === `${BASE}/dismiss`,
      handle: async (request, response) => {
        applyCorsHeaders(request, response, MUTATION_METHODS);
        if (handleOptions(request, response)) return;
        if (request.method !== "POST") return methodNotAllowed(response, MUTATION_METHODS);
        try {
          const body = requireObject(await readJsonBody(request));
          const projectId = requireProjectId(body.projectId);
          const target = requireObject(body.dismissalTarget);
          if (!Number.isSafeInteger(target.generation) || (target.generation as number) < 0) {
            throw new Error("dismissalTarget.generation must be a non-negative integer");
          }
          sendJson(response, 200, {
            snapshot: service.dismissProject(projectId, target.generation as number),
          } as unknown as Record<string, unknown>);
        } catch (error) {
          sendRouteError(response, error);
        }
      },
    },
    {
      methods: GET_METHODS,
      matches: (pathname) => pathname === `${BASE}/incoming`,
      handle: async (request, response, requestUrl) => {
        applyCorsHeaders(request, response, GET_METHODS);
        if (handleOptions(request, response)) return;
        if (request.method !== "GET") return methodNotAllowed(response, GET_METHODS);
        try {
          sendJson(response, 200, {
            incoming: await service.getIncoming(requireProjectQuery(requestUrl)),
          } as unknown as Record<string, unknown>);
        } catch (error) {
          sendRouteError(response, error);
        }
      },
    },
  ];
}

function createProjectMutationRoute(
  endpoint: string,
  execute: (
    service: LocalRemoteUpdateAwarenessService,
    projectId: string
  ) => Promise<Record<string, unknown>>,
  service: LocalRemoteUpdateAwarenessService
): HttpRoute {
  return {
    methods: MUTATION_METHODS,
    matches: (pathname) => pathname === endpoint,
    handle: async (request, response) => {
      applyCorsHeaders(request, response, MUTATION_METHODS);
      if (handleOptions(request, response)) return;
      if (request.method !== "POST") return methodNotAllowed(response, MUTATION_METHODS);
      try {
        const body = requireObject(await readJsonBody(request));
        sendJson(response, 200, await execute(service, requireProjectId(body.projectId)));
      } catch (error) {
        sendRouteError(response, error);
      }
    },
  };
}

function requireProjectQuery(requestUrl: URL): string {
  return requireProjectId(requestUrl.searchParams.get("projectId"));
}

function requireProjectId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("projectId must be a non-empty string");
  return value.trim();
}

function requireOverride(value: unknown): RemoteUpdateAwarenessProjectOverride {
  if (value !== "inherit" && value !== "on" && value !== "off") {
    throw new Error("override must be one of: inherit, on, off");
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function handleOptions(request: { method?: string }, response: { statusCode: number; end(): void }): boolean {
  if (request.method !== "OPTIONS") return false;
  response.statusCode = 204;
  response.end();
  return true;
}

function methodNotAllowed(
  response: { statusCode: number; setHeader(name: string, value: string): void; end(value?: string): void },
  allow: string
): void {
  response.statusCode = 405;
  response.setHeader("Allow", allow);
  response.end(JSON.stringify({ error: "Method Not Allowed" }));
}

function sendRouteError(response: Parameters<typeof sendJson>[0], error: unknown): void {
  const status = error instanceof RemoteUpdateAwarenessNotFoundError
    ? 404
    : error instanceof RemoteUpdateAwarenessConflictError
      ? 409
      : error instanceof Error && /must be|Request body/.test(error.message)
        ? 400
        : 503;
  sendJson(response, status, { error: error instanceof Error ? error.message : "Remote update awareness request failed" });
}
