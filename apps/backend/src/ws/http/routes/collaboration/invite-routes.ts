import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices } from "./route-services.js";
import {
  expectObjectBody,
  mapCollaborationInviteErrorStatus,
  parseSinglePathId,
  requireAdminRequestContext,
} from "./route-helpers.js";

const COLLABORATION_INVITES_ENDPOINT_PATH = "/api/collaboration/invites";
const COLLABORATION_INVITES_METHODS = "GET, POST, OPTIONS";
const COLLABORATION_INVITE_ENDPOINT_PATTERN = /^\/api\/collaboration\/invites\/([^/]+)$/;
const COLLABORATION_INVITE_METHODS = "GET, DELETE, OPTIONS";
const COLLABORATION_INVITE_REDEEM_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/invites\/([^/]+)\/redeem$/;
const COLLABORATION_INVITE_REDEEM_METHODS = "POST, OPTIONS";

export function createCollaborationInviteRoutes(options: {
  getServices: () => Promise<CollaborationRouteServices>;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_INVITES_METHODS,
      matches: (pathname) => pathname === COLLABORATION_INVITES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_INVITES_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_INVITES_METHODS);

        if (request.method !== "GET" && request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_INVITES_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        try {
          const { inviteService } = await options.getServices();

          if (request.method === "GET") {
            sendJson(response, 200, { invites: inviteService.listInvites() });
            return;
          }

          const body = parseCreateInviteBody(await readJsonBody(request));
          const invite = inviteService.createInvite(adminContext.userId, body.email, body.expiresInDays);
          sendJson(response, 200, { ok: true, invite });
        } catch (error) {
          sendJson(response, mapCollaborationInviteErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration invites",
          });
        }
      },
    },
    {
      methods: COLLABORATION_INVITE_METHODS,
      matches: (pathname) => COLLABORATION_INVITE_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_INVITE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_INVITE_METHODS);

        if (request.method !== "GET" && request.method !== "DELETE") {
          response.setHeader("Allow", COLLABORATION_INVITE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const inviteTokenOrId = parseSinglePathId(requestUrl.pathname, COLLABORATION_INVITE_ENDPOINT_PATTERN);
        if (!inviteTokenOrId) {
          sendJson(response, 400, { error: "Missing invite identifier" });
          return;
        }

        try {
          const { inviteService } = await options.getServices();

          if (request.method === "GET") {
            sendJson(response, 200, inviteService.getInvite(inviteTokenOrId) as unknown as Record<string, unknown>);
            return;
          }

          const adminContext = await requireAdminRequestContext(request, response, options.getServices);
          if (!adminContext) {
            return;
          }

          inviteService.revokeInvite(inviteTokenOrId, adminContext.userId);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, mapCollaborationInviteErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration invite",
          });
        }
      },
    },
    {
      methods: COLLABORATION_INVITE_REDEEM_METHODS,
      matches: (pathname) => COLLABORATION_INVITE_REDEEM_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_INVITE_REDEEM_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_INVITE_REDEEM_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_INVITE_REDEEM_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const token = parseSinglePathId(requestUrl.pathname, COLLABORATION_INVITE_REDEEM_ENDPOINT_PATTERN);
        if (!token) {
          sendJson(response, 400, { error: "Missing invite token" });
          return;
        }

        try {
          const body = parseRedeemInviteBody(await readJsonBody(request));
          const { inviteService } = await options.getServices();
          const user = await inviteService.redeemInvite(token, body.email, body.name, body.password);
          sendJson(response, 200, { ok: true, user });
        } catch (error) {
          sendJson(response, mapCollaborationInviteErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to redeem collaboration invite",
          });
        }
      },
    },
  ];
}

function parseCreateInviteBody(body: unknown): { email: string; expiresInDays?: number } {
  const input = expectObjectBody(body);
  const email = requireStringField(input.email, "email");
  const expiresInDaysRaw = input.expiresInDays;
  if (expiresInDaysRaw !== undefined && typeof expiresInDaysRaw !== "number") {
    throw new Error("expiresInDays must be a positive integer when provided");
  }

  const expiresInDays = expiresInDaysRaw as number | undefined;
  if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays <= 0)) {
    throw new Error("expiresInDays must be a positive integer when provided");
  }

  return {
    email,
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
  };
}

function parseRedeemInviteBody(body: unknown): { email: string; name: string; password: string } {
  const input = expectObjectBody(body);
  return {
    email: requireStringField(input.email, "email"),
    name: requireStringField(input.name, "name"),
    password: requireStringField(input.password, "password"),
  };
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}
