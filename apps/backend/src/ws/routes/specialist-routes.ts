import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "@forge/protocol";
import {
  deleteProfileSpecialist,
  resolveRoster,
  generateRosterBlock,
  saveProfileSpecialist,
  type SaveSpecialistRequest,
} from "../../swarm/specialists/specialist-registry.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson,
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SPECIALISTS_ENDPOINT_PATH = "/api/settings/specialists";
const ROSTER_PROMPT_SUFFIX = "/roster-prompt";
const METHODS = "GET, PUT, DELETE, OPTIONS";

export function createSpecialistRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: METHODS,
      matches: (pathname) =>
        pathname === SPECIALISTS_ENDPOINT_PATH ||
        pathname.startsWith(`${SPECIALISTS_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSpecialistRequest(swarmManager, broadcastEvent, request, response, requestUrl);
      },
    },
  ];
}

async function handleSpecialistRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;
  const profileId = requestUrl.searchParams.get("profileId")?.trim();

  if (!profileId) {
    sendJson(response, 400, { error: "profileId query parameter is required" });
    return;
  }

  if (!swarmManager.listProfiles().some((profile) => profile.profileId === profileId)) {
    sendJson(response, 404, { error: `Unknown profile: ${profileId}` });
    return;
  }

  const relativePath = requestUrl.pathname.slice(SPECIALISTS_ENDPOINT_PATH.length);

  // GET /api/settings/specialists/roster-prompt?profileId=X
  if (request.method === "GET" && relativePath === ROSTER_PROMPT_SUFFIX) {
    try {
      const roster = await resolveRoster(profileId, dataDir);
      const markdown = generateRosterBlock(roster);
      sendJson(response, 200, { markdown });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  // GET /api/settings/specialists?profileId=X
  if (request.method === "GET" && relativePath === "") {
    try {
      const specialists = await resolveRoster(profileId, dataDir);
      // Strip sourcePath — it's a server filesystem detail the UI doesn't need.
      const sanitized = specialists.map(({ sourcePath: _, ...rest }) => rest);
      sendJson(response, 200, { specialists: sanitized });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  // Extract handle from /<handle> segment
  const handle = relativePath.startsWith("/") ? decodeURIComponent(relativePath.slice(1)) : "";
  if (!handle) {
    sendJson(response, 400, { error: "Missing specialist handle in URL path" });
    return;
  }

  // PUT /api/settings/specialists/<handle>?profileId=X
  if (request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const data = parseSaveSpecialistBody(body);
      await saveProfileSpecialist(dataDir, profileId, handle, data);
      await notifySpecialistRosterMutation({
        swarmManager,
        broadcastEvent,
        dataDir,
        profileId,
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = isBadRequestMessage(message) ? 400 : 500;
      sendJson(response, statusCode, { error: message });
    }
    return;
  }

  // DELETE /api/settings/specialists/<handle>?profileId=X
  if (request.method === "DELETE") {
    try {
      await deleteProfileSpecialist(dataDir, profileId, handle);
      await notifySpecialistRosterMutation({
        swarmManager,
        broadcastEvent,
        dataDir,
        profileId,
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = isBadRequestMessage(message) ? 400 : 500;
      sendJson(response, statusCode, { error: message });
    }
    return;
  }

  response.setHeader("Allow", METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function notifySpecialistRosterMutation(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
  dataDir: string;
  profileId: string;
}): Promise<void> {
  const { swarmManager, broadcastEvent, dataDir, profileId } = options;
  const roster = await resolveRoster(profileId, dataDir);

  broadcastEvent({
    type: "specialist_roster_changed",
    profileId,
    specialistIds: roster.map((entry) => entry.specialistId),
    updatedAt: new Date().toISOString(),
  });

  await swarmManager.notifySpecialistRosterChanged(profileId);
}

function parseSaveSpecialistBody(value: unknown): SaveSpecialistRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const obj = value as Record<string, unknown>;

  return {
    displayName: readRequiredStringField(obj, "displayName"),
    color: readRequiredStringField(obj, "color"),
    enabled: readRequiredBooleanField(obj, "enabled"),
    whenToUse: readRequiredStringField(obj, "whenToUse"),
    model: readRequiredStringField(obj, "model"),
    reasoningLevel: readOptionalStringField(obj, "reasoningLevel"),
    promptBody: readRequiredStringField(obj, "promptBody"),
  };
}

function readRequiredStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return value;
}

function readOptionalStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }

  return value;
}

function readRequiredBooleanField(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }

  return value;
}

function isBadRequestMessage(message: string): boolean {
  return (
    message.includes("is required") ||
    message.includes("must be") ||
    message.includes("Invalid")
  );
}
