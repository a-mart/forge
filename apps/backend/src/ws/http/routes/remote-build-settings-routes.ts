import type {
  RemoteBuildSettingsMutationResponse,
  RemoteBuildSettingsResponse,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isCollaborationServerRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  RemoteBuildSettingsService,
  RemoteBuildSettingsValidationError,
} from "../../../collaboration/remote-build-settings-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const REMOTE_BUILD_SETTINGS_ENDPOINT = "/api/settings/remote-build";
const REMOTE_BUILD_SETTINGS_METHODS = "GET, PUT, OPTIONS";

/**
 * Admin-only instance settings for remote projects. Classified `admin` by the
 * collaboration HTTP middleware (settings routes are admin-forever); only
 * meaningful on collaboration-server instances.
 */
export function createRemoteBuildSettingsRoutes(options: {
  settingsService: RemoteBuildSettingsService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  const { settingsService, runtimeTarget } = options;

  return [
    {
      methods: REMOTE_BUILD_SETTINGS_METHODS,
      matches: (pathname) => pathname === REMOTE_BUILD_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleRemoteBuildSettingsRequest(request, response, settingsService, runtimeTarget);
      },
    },
  ];
}

async function handleRemoteBuildSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: RemoteBuildSettingsService,
  runtimeTarget: RuntimeTarget,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, REMOTE_BUILD_SETTINGS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, REMOTE_BUILD_SETTINGS_METHODS);

  if (!isCollaborationServerRuntimeTarget(runtimeTarget)) {
    sendJson(response, 404, { error: "Remote build settings are only available on collaboration-server instances." });
    return;
  }

  if (request.method === "GET") {
    const payload: RemoteBuildSettingsResponse = { settings: settingsService.getSettings() };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", REMOTE_BUILD_SETTINGS_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const settings = await settingsService.update(await readJsonBody(request));
    const payload: RemoteBuildSettingsMutationResponse = { ok: true, settings };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof RemoteBuildSettingsValidationError) {
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
