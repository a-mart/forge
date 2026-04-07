import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SETTINGS_SKILLS_ENDPOINT_PATH = "/api/settings/skills";
const SKILL_ROUTE_METHODS = "GET, OPTIONS";

type SkillRouteAction = "inventory" | "files" | "content";

export function createSkillRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: SKILL_ROUTE_METHODS,
      matches: (pathname) => pathname === SETTINGS_SKILLS_ENDPOINT_PATH || parseSkillRoutePath(pathname) !== null,
      handle: async (request, response, requestUrl) => {
        try {
          await handleSkillHttpRequest(swarmManager, request, response, requestUrl);
        } catch (error) {
          if (!response.headersSent) {
            const message = error instanceof Error ? error.message : "Internal server error";
            sendJson(response, resolveSkillRouteStatusCode(message), {
              error: message
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
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_SKILLS_ENDPOINT_PATH) {
    const profileId = requestUrl.searchParams.get("profileId")?.trim() || undefined;
    if (profileId && !swarmManager.listProfiles().some((profile) => profile.profileId === profileId)) {
      sendJson(response, 404, { error: `Unknown profile: ${profileId}` });
      return;
    }

    const skills = await swarmManager.listSkillMetadata(profileId);
    sendJson(response, 200, { skills });
    return;
  }

  if (request.method === "GET") {
    const parsedRoute = parseSkillRoutePath(requestUrl.pathname);
    if (parsedRoute?.action === "files") {
      const relativePath = requestUrl.searchParams.get("path") ?? "";
      const result = await swarmManager.listSkillFiles(parsedRoute.skillId, relativePath);
      sendJson(response, 200, result);
      return;
    }

    if (parsedRoute?.action === "content") {
      const relativePath = requestUrl.searchParams.get("path");
      if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
        sendJson(response, 400, { error: "path must be a non-empty relative path." });
        return;
      }

      const result = await swarmManager.getSkillFileContent(parsedRoute.skillId, relativePath);
      sendJson(response, 200, result);
      return;
    }
  }

  response.setHeader("Allow", SKILL_ROUTE_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function parseSkillRoutePath(pathname: string): { skillId: string; action: SkillRouteAction } | null {
  const match = pathname.match(/^\/api\/settings\/skills\/([^/]+)\/(files|content)$/);
  if (!match) {
    return null;
  }

  const encodedSkillId = match[1];
  const action = match[2];
  if (!encodedSkillId || (action !== "files" && action !== "content")) {
    return null;
  }

  try {
    return {
      skillId: decodeURIComponent(encodedSkillId),
      action
    };
  } catch {
    return null;
  }
}

function resolveSkillRouteStatusCode(message: string): number {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("relative path") ||
    normalized.includes("traversal")
  ) {
    return 400;
  }

  if (normalized.includes("unknown skill") || normalized.includes("not found")) {
    return 404;
  }

  if (normalized.includes("too large")) {
    return 413;
  }

  if (
    normalized.includes("outside skill root") ||
    normalized.includes("not readable")
  ) {
    return 403;
  }

  return 500;
}
