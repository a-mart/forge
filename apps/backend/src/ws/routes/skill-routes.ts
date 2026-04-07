import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SETTINGS_SKILLS_ENDPOINT_PATH = "/api/settings/skills";
const SKILL_ROUTE_METHODS = "GET, OPTIONS";

export function createSkillRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: SKILL_ROUTE_METHODS,
      matches: (pathname) => pathname === SETTINGS_SKILLS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        try {
          await handleSkillHttpRequest(swarmManager, request, response, requestUrl);
        } catch (error) {
          if (!response.headersSent) {
            sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Internal server error"
            });
          }
        }
      }
    }
  ];
}

async function handleSkillHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SKILL_ROUTE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SKILL_ROUTE_METHODS);

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_SKILLS_ENDPOINT_PATH) {
    const profileId = requestUrl.searchParams.get("profileId") ?? undefined;
    const skills = await swarmManager.listSkillMetadata(profileId);
    sendJson(response, 200, { skills });
    return;
  }

  response.setHeader("Allow", SKILL_ROUTE_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}
