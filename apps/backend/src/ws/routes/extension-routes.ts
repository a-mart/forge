import { join } from "node:path";
import type { SettingsExtensionsResponse } from "@forge/protocol";
import { getProfilesDir } from "../../swarm/data-paths.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SETTINGS_EXTENSIONS_ENDPOINT_PATH = "/api/settings/extensions";
const SETTINGS_EXTENSIONS_METHODS = "GET, OPTIONS";

export function createExtensionRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: SETTINGS_EXTENSIONS_METHODS,
      matches: (pathname) => pathname === SETTINGS_EXTENSIONS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
          response.setHeader("Allow", SETTINGS_EXTENSIONS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const config = swarmManager.getConfig();
        const payload: SettingsExtensionsResponse = {
          generatedAt: new Date().toISOString(),
          snapshots: swarmManager.listRuntimeExtensionSnapshots(),
          directories: {
            globalWorker: join(config.paths.agentDir, "extensions"),
            globalManager: join(config.paths.managerAgentDir, "extensions"),
            profileTemplate: join(getProfilesDir(config.paths.dataDir), "<profileId>", "pi", "extensions"),
            projectLocalRelative: ".pi/extensions"
          }
        };

        applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
        sendJson(response, 200, payload as unknown as Record<string, unknown>);
      }
    }
  ];
}
