import type { MobilePushService } from "../../mobile/mobile-push-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const PUSH_REGISTER_PATH = "/api/mobile/push/register";
const PUSH_UNREGISTER_PATH = "/api/mobile/push/unregister";
const PUSH_TEST_PATH = "/api/mobile/push/test";
const NOTIFICATION_PREFERENCES_PATH = "/api/mobile/notification-preferences";

const POST_METHODS = "POST, OPTIONS";
const PREFS_METHODS = "GET, PUT, OPTIONS";

export function createMobileRoutes(options: { mobilePushService: MobilePushService }): HttpRoute[] {
  const { mobilePushService } = options;

  return [
    {
      methods: POST_METHODS,
      matches: (pathname) => pathname === PUSH_REGISTER_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.setHeader("Allow", POST_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, POST_METHODS);
        const payload = await readJsonBody(request);
        const device = await mobilePushService.registerDevice(payload);
        sendJson(response, 200, { ok: true, device });
      }
    },
    {
      methods: POST_METHODS,
      matches: (pathname) => pathname === PUSH_UNREGISTER_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.setHeader("Allow", POST_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, POST_METHODS);
        const payload = await readJsonBody(request);
        const removed = await mobilePushService.unregisterDevice(payload);
        sendJson(response, 200, { ok: true, removed });
      }
    },
    {
      methods: PREFS_METHODS,
      matches: (pathname) => pathname === NOTIFICATION_PREFERENCES_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, PREFS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, PREFS_METHODS);

        if (request.method === "GET") {
          const preferences = await mobilePushService.getNotificationPreferences();
          sendJson(response, 200, { preferences });
          return;
        }

        if (request.method === "PUT") {
          const payload = await readJsonBody(request);
          const preferences = await mobilePushService.updateNotificationPreferences(payload);
          sendJson(response, 200, { ok: true, preferences });
          return;
        }

        response.setHeader("Allow", PREFS_METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
      }
    },
    {
      methods: POST_METHODS,
      matches: (pathname) => pathname === PUSH_TEST_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, POST_METHODS);
          response.setHeader("Allow", POST_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, POST_METHODS);
        const payload = await readJsonBody(request);
        const result = await mobilePushService.sendTestNotification(payload);

        if (!result.ok) {
          sendJson(response, 502, {
            ok: false,
            error: result.error ?? "Failed to send Expo push notification"
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ticketId: result.ticketId
        });
      }
    }
  ];
}
