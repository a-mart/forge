import type {
  GetKnowledgeV2SettingsResponse,
  UpdateKnowledgeV2SettingsRequest,
  UpdateKnowledgeV2SettingsResponse,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  KnowledgeV2SettingsService,
  KnowledgeV2SettingsValidationError,
} from "../../../swarm/knowledge-v2-settings-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const KNOWLEDGE_V2_SETTINGS_ENDPOINT = "/api/settings/knowledge-v2";
const KNOWLEDGE_V2_SETTINGS_METHODS = "GET, PUT, OPTIONS";

export function createKnowledgeV2SettingsRoutes(options: {
  settingsService: KnowledgeV2SettingsService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  return [
    {
      methods: KNOWLEDGE_V2_SETTINGS_METHODS,
      matches: (pathname) => pathname === KNOWLEDGE_V2_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleKnowledgeV2SettingsRequest(
          request,
          response,
          options.settingsService,
          options.runtimeTarget,
        );
      },
    },
  ];
}

async function handleKnowledgeV2SettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: KnowledgeV2SettingsService,
  runtimeTarget: RuntimeTarget,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, KNOWLEDGE_V2_SETTINGS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, KNOWLEDGE_V2_SETTINGS_METHODS);

  if (!isBuilderRuntimeTarget(runtimeTarget)) {
    sendJson(response, 404, { error: "Knowledge v2 settings are only available in Builder runtime." });
    return;
  }

  if (request.method === "GET") {
    const payload: GetKnowledgeV2SettingsResponse = settingsService.getSettingsView();
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", KNOWLEDGE_V2_SETTINGS_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const settings = await settingsService.update(parseSettingsPatch(await readJsonBody(request)));
    const payload: UpdateKnowledgeV2SettingsResponse = {
      ok: true,
      settings,
      defaults: settingsService.getDefaults(),
      constraints: settingsService.getSettingsView().constraints,
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof KnowledgeV2SettingsValidationError) {
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

function parseSettingsPatch(value: unknown): UpdateKnowledgeV2SettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeV2SettingsValidationError("Request body must be a JSON object");
  }
  const maybe = value as Record<string, unknown>;
  const patch: UpdateKnowledgeV2SettingsRequest = {};
  if ("enabled" in maybe) {
    patch.enabled = maybe.enabled as boolean;
  }
  if ("legacyCleanupConfirmed" in maybe) {
    patch.legacyCleanupConfirmed = maybe.legacyCleanupConfirmed as boolean;
  }
  if ("indexCaps" in maybe) {
    if (!maybe.indexCaps || typeof maybe.indexCaps !== "object" || Array.isArray(maybe.indexCaps)) {
      throw new KnowledgeV2SettingsValidationError("indexCaps must be an object");
    }
    const caps = maybe.indexCaps as Record<string, unknown>;
    patch.indexCaps = {};
    if ("global" in caps) {
      patch.indexCaps.global = caps.global as number;
    }
    if ("profile" in caps) {
      patch.indexCaps.profile = caps.profile as number;
    }
  }
  return patch;
}

function isBadRequestBodyError(message: string): boolean {
  return message === "Request body must be valid JSON" || message.startsWith("Request body too large");
}
