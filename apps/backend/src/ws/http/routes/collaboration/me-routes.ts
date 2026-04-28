import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices } from "./route-services.js";
import {
  appendSetCookieHeaders,
  expectObjectBody,
  mapCollaborationUserErrorStatus,
  resolveRequestAuthContext,
  toSessionUser,
} from "./route-helpers.js";

const COLLABORATION_ME_ENDPOINT_PATH = "/api/collaboration/me";
const COLLABORATION_ME_METHODS = "GET, OPTIONS";
const COLLABORATION_ME_PASSWORD_ENDPOINT_PATH = "/api/collaboration/me/password";
const COLLABORATION_ME_PASSWORD_METHODS = "POST, OPTIONS";

export function createCollaborationMeRoutes(options: {
  getServices: () => Promise<CollaborationRouteServices>;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_ME_METHODS,
      matches: (pathname) => pathname === COLLABORATION_ME_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_ME_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_ME_METHODS);

        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_ME_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const authContext = await resolveRequestAuthContext(request, options.getServices);
        if (!authContext) {
          sendJson(response, 200, { authenticated: false });
          return;
        }

        const { authService, broadcasts, userService } = await options.getServices();
        const userState = userService.getUserState(authContext.userId);

        if (!userState || userState.disabled) {
          if (userState?.disabled) {
            await authService.revokeUserSessions(userState.userId);
            broadcasts?.disconnectUserSockets(userState.userId);
            appendSetCookieHeaders(response, await authService.clearSessionCookies());
          }

          sendJson(response, 200, { authenticated: false });
          return;
        }

        sendJson(response, 200, {
          authenticated: true,
          user: toSessionUser(userState),
          ...(userState.passwordChangeRequired ? { passwordChangeRequired: true } : {}),
        });
      },
    },
    {
      methods: COLLABORATION_ME_PASSWORD_METHODS,
      matches: (pathname) => pathname === COLLABORATION_ME_PASSWORD_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_ME_PASSWORD_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_ME_PASSWORD_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_ME_PASSWORD_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const authContext = await resolveRequestAuthContext(request, options.getServices);
        if (!authContext) {
          sendJson(response, 401, { error: "Authentication required" });
          return;
        }

        if (authContext.disabled) {
          sendJson(response, 403, { error: "User account is disabled" });
          return;
        }

        try {
          const body = parseCollaborationMePasswordBody(await readJsonBody(request));
          const { auditService, broadcasts, userService } = await options.getServices();
          const sessionId = authContext.sessionId;
          if (!sessionId) {
            throw new Error("Missing collaboration session context");
          }

          const userState = await userService.changeOwnPassword(
            authContext.userId,
            body.currentPassword,
            body.newPassword,
            sessionId,
          );

          broadcasts?.disconnectUserSockets(authContext.userId, { excludeSessionId: sessionId });

          auditService.log({
            action: "collaboration_user_password_changed",
            actorUserId: authContext.userId,
            targetUserId: authContext.userId,
          });

          sendJson(response, 200, {
            ok: true,
            user: toSessionUser(userState),
          });
        } catch (error) {
          sendJson(response, mapCollaborationUserErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to change collaboration password",
          });
        }
      },
    },
  ];
}

function parseCollaborationMePasswordBody(body: unknown): { currentPassword: string; newPassword: string } {
  const input = expectObjectBody(body);
  return {
    currentPassword: requireStringField(input.currentPassword, "currentPassword"),
    newPassword: requireStringField(input.newPassword, "newPassword"),
  };
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}
