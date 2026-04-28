import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices } from "./route-services.js";
import {
  expectObjectBody,
  mapCollaborationUserErrorStatus,
  parseSinglePathId,
  requireAdminRequestContext,
} from "./route-helpers.js";

const COLLABORATION_USERS_ENDPOINT_PATH = "/api/collaboration/users";
const COLLABORATION_USERS_METHODS = "GET, OPTIONS";
const COLLABORATION_USER_ENDPOINT_PATTERN = /^\/api\/collaboration\/users\/([^/]+)$/;
const COLLABORATION_USER_METHODS = "PATCH, DELETE, OPTIONS";
const COLLABORATION_USER_PASSWORD_RESET_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/users\/([^/]+)\/password-reset$/;
const COLLABORATION_USER_PASSWORD_RESET_METHODS = "POST, OPTIONS";

export function createCollaborationUserRoutes(options: {
  getServices: () => Promise<CollaborationRouteServices>;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_USERS_METHODS,
      matches: (pathname) => pathname === COLLABORATION_USERS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_USERS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_USERS_METHODS);

        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_USERS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        void adminContext;
        const { userService } = await options.getServices();
        sendJson(response, 200, { users: userService.listUsers() });
      },
    },
    {
      methods: COLLABORATION_USER_METHODS,
      matches: (pathname) => COLLABORATION_USER_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_USER_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_USER_METHODS);

        if (request.method !== "PATCH" && request.method !== "DELETE") {
          response.setHeader("Allow", COLLABORATION_USER_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const userId = parseSinglePathId(requestUrl.pathname, COLLABORATION_USER_ENDPOINT_PATTERN);
        if (!userId) {
          sendJson(response, 400, { error: "Missing userId" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        try {
          const { auditService, authService, broadcasts, userService } = await options.getServices();

          if (request.method === "DELETE") {
            const deletedUser = userService.deleteUser(userId);
            await authService.revokeUserSessions(userId).catch(() => undefined);
            broadcasts?.disconnectUserSockets(deletedUser.userId);
            auditService.log({
              action: "collaboration_user_deleted",
              actorUserId: adminContext.userId,
              metadata: {
                deletedUserId: deletedUser.userId,
                role: deletedUser.role,
                disabled: deletedUser.disabled,
                passwordChangeRequired: deletedUser.passwordChangeRequired,
              },
            });
            sendJson(response, 200, { ok: true });
            return;
          }

          const update = parseCollaborationUserUpdate(await readJsonBody(request));
          const result = await userService.updateUser(userId, update);
          if (result.roleChanged || result.disabledChanged) {
            broadcasts?.disconnectUserSockets(result.user.userId);
          }
          auditService.log({
            action: "collaboration_user_updated",
            actorUserId: adminContext.userId,
            targetUserId: result.user.userId,
            metadata: {
              roleChanged: result.roleChanged,
              disabledChanged: result.disabledChanged,
              nameChanged: result.nameChanged,
              role: result.user.role,
              disabled: result.user.disabled,
            },
          });
          sendJson(response, 200, { ok: true, user: result.user });
        } catch (error) {
          sendJson(response, mapCollaborationUserErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to update collaboration user",
          });
        }
      },
    },
    {
      methods: COLLABORATION_USER_PASSWORD_RESET_METHODS,
      matches: (pathname) => COLLABORATION_USER_PASSWORD_RESET_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_USER_PASSWORD_RESET_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_USER_PASSWORD_RESET_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_USER_PASSWORD_RESET_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const userId = parseSinglePathId(requestUrl.pathname, COLLABORATION_USER_PASSWORD_RESET_ENDPOINT_PATTERN);
        if (!userId) {
          sendJson(response, 400, { error: "Missing userId" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        try {
          const body = parsePasswordResetBody(await readJsonBody(request));
          const { auditService, authService, broadcasts, userService } = await options.getServices();
          const userState = await userService.resetUserPassword(userId, body.temporaryPassword);
          await authService.revokeUserSessions(userId);
          broadcasts?.disconnectUserSockets(userState.userId);

          auditService.log({
            action: "collaboration_user_password_reset",
            actorUserId: adminContext.userId,
            targetUserId: userId,
            metadata: {
              passwordChangeRequired: userState.passwordChangeRequired,
              disabled: userState.disabled,
            },
          });

          sendJson(response, 200, {
            ok: true,
            user: {
              userId: userState.userId,
              email: userState.email,
              name: userState.name,
              role: userState.role,
              disabled: userState.disabled,
              authMethods: userState.authMethods,
              createdAt: userState.createdAt,
              updatedAt: userState.updatedAt,
            },
            passwordChangeRequired: true,
          });
        } catch (error) {
          sendJson(response, mapCollaborationUserErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to reset collaboration password",
          });
        }
      },
    },
  ];
}

function parseCollaborationUserUpdate(body: unknown): { role?: "admin" | "member"; disabled?: boolean; name?: string } {
  const input = expectObjectBody(body);
  const update: { role?: "admin" | "member"; disabled?: boolean; name?: string } = {};

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new Error("name must be a non-empty string when provided");
    }
    update.name = input.name.trim();
  }

  if (input.role !== undefined) {
    if (input.role !== "admin" && input.role !== "member") {
      throw new Error("role must be \"admin\" or \"member\" when provided");
    }
    update.role = input.role;
  }

  if (input.disabled !== undefined) {
    if (typeof input.disabled !== "boolean") {
      throw new Error("disabled must be a boolean when provided");
    }
    update.disabled = input.disabled;
  }

  return update;
}

function parsePasswordResetBody(body: unknown): { temporaryPassword: string } {
  const input = expectObjectBody(body);
  if (typeof input.temporaryPassword !== "string" || input.temporaryPassword.length === 0) {
    throw new Error("temporaryPassword must be a non-empty string");
  }

  return { temporaryPassword: input.temporaryPassword };
}
