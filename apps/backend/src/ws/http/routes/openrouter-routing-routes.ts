import { parseOpenRouterRoutingConfig, resolveOpenRouterRouting, type OpenRouterModelsFile, type OpenRouterRoutingSettingsResponse, type ServerEvent } from "@forge/protocol";
import { getOpenRouterRoutingRevision, mutateOpenRouterModelsFile, readOpenRouterModels } from "../../../swarm/openrouter-models.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, decodePathSegment, parseJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";
import { OpenRouterEndpointDiscovery } from "../services/openrouter-endpoints.js";
const ROUTING = "/api/settings/openrouter/routing";
const MODELS = `${ROUTING}/models/`;
const ENDPOINTS = "/api/settings/openrouter/endpoints/";
class RoutingHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function snapshot(file: OpenRouterModelsFile, modelId?: string): OpenRouterRoutingSettingsResponse {
  const defaults = file.routingDefaults ?? {};
  if (modelId && !Object.hasOwn(file.models, modelId)) throw new RoutingHttpError(404, "Add this OpenRouter model before configuring its routing");
  const routing = modelId ? file.models[modelId].routing ?? {} : undefined;
  return { revision: getOpenRouterRoutingRevision(file), defaults, ...(modelId ? { modelId, routing } : {}), effective: resolveOpenRouterRouting(defaults, routing) };
}
export function createOpenRouterRoutingRoutes(options: { swarmManager: SwarmManager; broadcastEvent: (event: ServerEvent) => void }): HttpRoute[] {
  const discovery = new OpenRouterEndpointDiscovery();
  return [{
    methods: "GET, PUT, OPTIONS",
    matches: (path) => path === ROUTING || path.startsWith(MODELS) || path.startsWith(ENDPOINTS),
    handle: async (request, response, url) => {
      const isDiscovery = url.pathname.startsWith(ENDPOINTS);
      const methods = isDiscovery ? "GET, OPTIONS" : "GET, PUT, OPTIONS";
      applyCorsHeaders(request, response, methods);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      if (request.method !== "GET" && (isDiscovery || request.method !== "PUT")) {
        response.setHeader("Allow", methods); sendJson(response, 405, { error: "Method Not Allowed" }); return;
      }
      try {
        const modelId = url.pathname === ROUTING ? undefined : decodePathSegment(url.pathname.slice(isDiscovery ? ENDPOINTS.length : MODELS.length));
        if (modelId !== undefined && (!modelId || modelId.length > 300 || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/.test(modelId) || modelId.split("/").some((part) => part === "." || part === ".."))) throw new RoutingHttpError(400, "Invalid OpenRouter model id");
        if (isDiscovery) { sendJson(response, 200, { ...await discovery.discover(modelId!, url.searchParams.get("refresh") === "true") }); return; }
        const dataDir = options.swarmManager.getConfig().paths.dataDir;
        if (request.method === "GET") { sendJson(response, 200, { ...snapshot(await readOpenRouterModels(dataDir), modelId) }); return; }
        let revision: string;
        let routing: ReturnType<typeof parseOpenRouterRoutingConfig>;
        try {
          const body = await parseJsonBody(request, 32 * 1024) as Record<string, unknown>;
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "revision" && key !== "routing") || typeof body.revision !== "string") throw new Error("Expected { revision, routing }");
          revision = body.revision;
          routing = parseOpenRouterRoutingConfig(body.routing);
        } catch (error) { throw new RoutingHttpError(400, error instanceof Error ? error.message : String(error)); }
        const result = await mutateOpenRouterModelsFile(dataDir, (current) => {
          snapshot(current, modelId);
          if (revision !== getOpenRouterRoutingRevision(current)) throw new RoutingHttpError(409, "OpenRouter settings changed. Reload and review before saving.");
          const next = modelId ? { ...current, models: { ...current.models, [modelId]: { ...current.models[modelId], routing } } } : { ...current, routingDefaults: routing };
          try {
            resolveOpenRouterRouting(next.routingDefaults);
            for (const model of Object.values(next.models)) resolveOpenRouterRouting(next.routingDefaults, model.routing);
          } catch (error) { throw new RoutingHttpError(400, error instanceof Error ? error.message : String(error)); }
          return next;
        }, () => options.swarmManager.reloadOpenRouterModelsAndProjection());
        options.broadcastEvent({ type: "model_config_changed", updatedAt: new Date().toISOString() });
        sendJson(response, 200, { ...snapshot(result.nextFile, modelId) });
      } catch (error) { sendJson(response, error instanceof RoutingHttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }); }
    },
  }];
}
