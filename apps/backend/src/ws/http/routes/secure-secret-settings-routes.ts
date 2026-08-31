import type {
  GetSecureSecretSettingsResponse,
  UpdateSecureSecretSettingsRequest,
  UpdateSecureSecretSettingsResponse,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  SecureSecretSettingsService,
  SecureSecretSettingsValidationError,
} from "../../../swarm/secure-sessions/secure-secret-settings-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SECURE_SECRET_SETTINGS_ENDPOINT = "/api/settings/secure-secrets";
const SECURE_SECRET_SETTINGS_METHODS = "GET, PUT, OPTIONS";

export function createSecureSecretSettingsRoutes(options: {
  settingsService: SecureSecretSettingsService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  const { settingsService, runtimeTarget } = options;

  return [
    {
      methods: SECURE_SECRET_SETTINGS_METHODS,
      matches: (pathname) => pathname === SECURE_SECRET_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleSecureSecretSettingsRequest(
          request,
          response,
          settingsService,
          runtimeTarget,
        );
      },
    },
  ];
}

async function handleSecureSecretSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: SecureSecretSettingsService,
  runtimeTarget: RuntimeTarget,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SECURE_SECRET_SETTINGS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SECURE_SECRET_SETTINGS_METHODS);

  if (!isBuilderRuntimeTarget(runtimeTarget)) {
    sendJson(response, 404, {
      error: "Secure secret settings are only available in Builder runtime.",
    });
    return;
  }

  if (request.method === "GET") {
    const payload: GetSecureSecretSettingsResponse = settingsService.getSettingsView();
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", SECURE_SECRET_SETTINGS_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const patch = parseSettingsPatch(await readJsonBody(request));
    const settings = await settingsService.update(patch);
    const payload: UpdateSecureSecretSettingsResponse = {
      ok: true,
      settings,
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof SecureSecretSettingsValidationError) {
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

function parseSettingsPatch(value: unknown): UpdateSecureSecretSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecureSecretSettingsValidationError("Request body must be a JSON object");
  }

  const maybe = value as Record<string, unknown>;
  const patch: UpdateSecureSecretSettingsRequest = {};
  if ("maxProjectDefaults" in maybe) {
    patch.maxProjectDefaults = maybe.maxProjectDefaults as number;
  }
  return patch;
}
