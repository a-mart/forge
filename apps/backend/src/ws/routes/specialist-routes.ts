import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "@forge/protocol";
import {
  deleteProfileSpecialist,
  deleteSharedSpecialist,
  resolveRoster,
  resolveSharedRoster,
  generateRosterBlock,
  getWorkerTemplate,
  getSpecialistsEnabled,
  setSpecialistsEnabled,
  saveProfileSpecialist,
  saveSharedSpecialist,
  invalidateSpecialistCache,
  type SaveSpecialistRequest,
} from "../../swarm/specialists/specialist-registry.js";
import { getModelPresetInfoList } from "../../swarm/model-presets.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson,
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SPECIALISTS_ENDPOINT_PATH = "/api/settings/specialists";
const SPECIALISTS_ENABLED_ENDPOINT_PATH = "/api/settings/specialists/enabled";
const SETTINGS_MODELS_ENDPOINT_PATH = "/api/settings/models";
const ROSTER_PROMPT_SUFFIX = "/roster-prompt";
const METHODS = "GET, PUT, DELETE, OPTIONS";
const ENABLED_METHODS = "GET, PUT, OPTIONS";
const SETTINGS_MODELS_METHODS = "GET, OPTIONS";

export function createSpecialistRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: SETTINGS_MODELS_METHODS,
      matches: (pathname) => pathname === SETTINGS_MODELS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleSettingsModelsRequest(request, response, requestUrl);
      },
    },
    {
      methods: ENABLED_METHODS,
      matches: (pathname) => pathname === SPECIALISTS_ENABLED_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleSpecialistsEnabledRequest(swarmManager, broadcastEvent, request, response, requestUrl);
      },
    },
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

async function handleSettingsModelsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
    sendJson(response, 200, { models: getModelPresetInfoList() });
    return;
  }

  response.setHeader("Allow", SETTINGS_MODELS_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSpecialistsEnabledRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  _requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, ENABLED_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, ENABLED_METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;

  if (request.method === "GET") {
    try {
      const enabled = await getSpecialistsEnabled(dataDir);
      sendJson(response, 200, { enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  if (request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(response, 400, { error: "Request body must be a JSON object" });
        return;
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.enabled !== "boolean") {
        sendJson(response, 400, { error: "enabled must be a boolean" });
        return;
      }

      await setSpecialistsEnabled(dataDir, obj.enabled);
      invalidateSpecialistCache();

      // Broadcast change to all profiles and recycle managers
      const profiles = swarmManager.listProfiles();
      for (const profile of profiles) {
        await notifySpecialistRosterMutation({
          swarmManager,
          broadcastEvent,
          dataDir,
          profileId: profile.profileId,
        });
      }

      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  response.setHeader("Allow", ENABLED_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
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
  const profileId = requestUrl.searchParams.get("profileId")?.trim() || undefined;
  const relativePath = requestUrl.pathname.slice(SPECIALISTS_ENDPOINT_PATH.length);

  // GET /api/settings/specialists/template — returns worker.md content (no profileId required)
  if (request.method === "GET" && relativePath === "/template") {
    try {
      const template = await getWorkerTemplate();
      sendJson(response, 200, { template });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  // If profileId is provided, validate it exists
  if (profileId && !swarmManager.listProfiles().some((profile) => profile.profileId === profileId)) {
    sendJson(response, 404, { error: `Unknown profile: ${profileId}` });
    return;
  }

  // --- Global (no profileId) routes ---

  if (!profileId) {
    // GET /api/settings/specialists — returns shared/global specialists only
    if (request.method === "GET" && relativePath === "") {
      try {
        const specialists = await resolveSharedRoster(dataDir);
        const sanitized = specialists.map(({ sourcePath: _, ...rest }) => rest);
        sendJson(response, 200, { specialists: sanitized });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { error: message });
      }
      return;
    }

    let handle: string | null;
    try {
      handle = parseHandleFromRelativePath(relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
      return;
    }

    if (!handle) {
      sendJson(response, 400, { error: "Missing specialist handle in URL path" });
      return;
    }

    // PUT /api/settings/specialists/<handle> — saves to shared dir
    if (request.method === "PUT") {
      try {
        const body = await readJsonBody(request);
        const data = parseSaveSpecialistBody(body);
        await saveSharedSpecialist(dataDir, handle, data);
        await notifyGlobalSpecialistMutation({ swarmManager, broadcastEvent, dataDir });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, getErrorStatusCode(message), { error: message });
      }
      return;
    }

    // DELETE /api/settings/specialists/<handle> — deletes from shared dir (rejects builtins)
    if (request.method === "DELETE") {
      try {
        await deleteSharedSpecialist(dataDir, handle);
        await notifyGlobalSpecialistMutation({ swarmManager, broadcastEvent, dataDir });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, getErrorStatusCode(message), { error: message });
      }
      return;
    }

    response.setHeader("Allow", METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  // --- Profile-scoped routes (profileId present) ---

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

  let handle: string | null;
  try {
    handle = parseHandleFromRelativePath(relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, getErrorStatusCode(message), { error: message });
    return;
  }

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
      sendJson(response, getErrorStatusCode(message), { error: message });
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
      sendJson(response, getErrorStatusCode(message), { error: message });
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

/** Notify all profiles when a shared/global specialist changes. */
async function notifyGlobalSpecialistMutation(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
  dataDir: string;
}): Promise<void> {
  const { swarmManager, broadcastEvent, dataDir } = options;
  const profiles = swarmManager.listProfiles();

  for (const profile of profiles) {
    await notifySpecialistRosterMutation({
      swarmManager,
      broadcastEvent,
      dataDir,
      profileId: profile.profileId,
    });
  }
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
    modelId: readRequiredStringField(obj, "modelId"),
    reasoningLevel: readOptionalStringField(obj, "reasoningLevel"),
    fallbackModelId: readOptionalStringField(obj, "fallbackModelId"),
    fallbackReasoningLevel: readOptionalStringField(obj, "fallbackReasoningLevel"),
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

function parseHandleFromRelativePath(relativePath: string): string | null {
  if (!relativePath.startsWith("/")) {
    return null;
  }

  const rawHandle = relativePath.slice(1);
  if (!rawHandle) {
    return null;
  }

  if (rawHandle.includes("/")) {
    throw new Error("Malformed URL path");
  }

  try {
    return decodeURIComponent(rawHandle);
  } catch {
    throw new Error("Malformed URL path");
  }
}

function getErrorStatusCode(message: string): number {
  if (message === "Malformed URL path") {
    return 400;
  }

  if (message.startsWith("Unknown specialist:")) {
    return 404;
  }

  if (message.startsWith("Cannot delete builtin specialist:")) {
    return 409;
  }

  if (
    message.includes("Request body") ||
    message.includes("is required") ||
    message.includes("must be") ||
    message.includes("Invalid")
  ) {
    return 400;
  }

  return 500;
}
