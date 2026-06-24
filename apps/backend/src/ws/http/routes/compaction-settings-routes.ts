import type {
  GetCompactionSettingsResponse,
  UpdateCompactionSettingsRequest,
  UpdateCompactionSettingsResponse,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  CompactionSettingsService,
  CompactionSettingsValidationError,
} from "../../../swarm/compaction-settings-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const COMPACTION_SETTINGS_ENDPOINT = "/api/settings/compaction";
const COMPACTION_SETTINGS_METHODS = "GET, PUT, OPTIONS";

export function createCompactionSettingsRoutes(options: {
  settingsService: CompactionSettingsService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  const { settingsService, runtimeTarget } = options;

  return [
    {
      methods: COMPACTION_SETTINGS_METHODS,
      matches: (pathname) => pathname === COMPACTION_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleCompactionSettingsRequest(request, response, settingsService, runtimeTarget);
      },
    },
  ];
}

async function handleCompactionSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: CompactionSettingsService,
  runtimeTarget: RuntimeTarget,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, COMPACTION_SETTINGS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, COMPACTION_SETTINGS_METHODS);

  if (!isBuilderRuntimeTarget(runtimeTarget)) {
    sendJson(response, 404, { error: "Compaction settings are only available in Builder runtime." });
    return;
  }

  if (request.method === "GET") {
    const view = await settingsService.getSettingsView();
    const payload: GetCompactionSettingsResponse = view;
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", COMPACTION_SETTINGS_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const patch = parseSettingsPatch(await readJsonBody(request));
    const result = await settingsService.update(patch);
    const payload: UpdateCompactionSettingsResponse = {
      ok: true,
      settings: result.settings,
      availability: result.availability,
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof CompactionSettingsValidationError) {
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
  return message === "Request body must be valid JSON" || message === "Request body is too large";
}

function parseSettingsPatch(value: unknown): UpdateCompactionSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompactionSettingsValidationError("Request body must be a JSON object");
  }

  const maybe = value as Record<string, unknown>;
  const patch: UpdateCompactionSettingsRequest = {};

  if ("model" in maybe) {
    if (!maybe.model || typeof maybe.model !== "object" || Array.isArray(maybe.model)) {
      throw new CompactionSettingsValidationError("model must be an object with provider and modelId");
    }

    const model = maybe.model as Record<string, unknown>;
    patch.model = {
      provider: String(model.provider ?? ""),
      modelId: String(model.modelId ?? ""),
    };
  }

  if ("reasoningLevel" in maybe) {
    patch.reasoningLevel = maybe.reasoningLevel as UpdateCompactionSettingsRequest["reasoningLevel"];
  }

  if ("timeoutMs" in maybe) {
    patch.timeoutMs = maybe.timeoutMs as number;
  }

  return patch;
}
