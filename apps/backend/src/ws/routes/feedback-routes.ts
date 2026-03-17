import { FEEDBACK_REASON_CODES, type FeedbackEvent, type FeedbackSubmitValue } from "@forge/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { FeedbackService, type FeedbackAcrossSessionsOptions, type FeedbackListOptions } from "../../swarm/feedback-service.js";
import { applyCorsHeaders, decodePathSegment, matchPathPattern, readJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SESSION_FEEDBACK_ENDPOINT_PATTERN = /^\/api\/v1\/profiles\/([^/]+)\/sessions\/([^/]+)\/feedback$/;
const SESSION_FEEDBACK_STATE_ENDPOINT_PATTERN = /^\/api\/v1\/profiles\/([^/]+)\/sessions\/([^/]+)\/feedback\/state$/;
const FEEDBACK_QUERY_ENDPOINT_PATH = "/api/v1/feedback";

export function createFeedbackRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;
  const feedbackService = new FeedbackService(swarmManager.getConfig().paths.dataDir);

  return [
    {
      methods: "POST, GET, OPTIONS",
      matches: (pathname) => SESSION_FEEDBACK_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "POST, GET, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST" && request.method !== "GET") {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveSessionRoute(requestUrl.pathname, SESSION_FEEDBACK_ENDPOINT_PATTERN);
        if (!route) {
          sendJson(response, 400, { error: "Invalid profileId or sessionId." });
          return;
        }

        if (!isExistingSession(swarmManager, route.profileId, route.sessionId)) {
          sendJson(response, 404, { error: `Unknown session: ${route.profileId}/${route.sessionId}` });
          return;
        }

        try {
          if (request.method === "POST") {
            const payload = await readJsonBody(request);
            const parsed = parseSubmitFeedbackBody(payload, route.sessionId);

            const submitted = await feedbackService.submitFeedback({
              profileId: route.profileId,
              sessionId: route.sessionId,
              scope: parsed.scope,
              targetId: parsed.targetId,
              value: parsed.value,
              reasonCodes: parsed.reasonCodes,
              comment: parsed.comment,
              channel: parsed.channel,
              actor: "user",
              ...(parsed.clearKind ? { clearKind: parsed.clearKind } : {})
            });

            sendJson(response, 201, { feedback: submitted });
            return;
          }

          const filters = parseFeedbackFilterParams(requestUrl.searchParams);
          const events = await feedbackService.listFeedback(route.profileId, route.sessionId, filters);
          sendJson(response, 200, { feedback: events });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to process feedback request.";
          const statusCode = isInvalidRequestError(message) ? 400 : 500;
          sendJson(response, statusCode, { error: message });
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => SESSION_FEEDBACK_STATE_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "GET, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveSessionRoute(requestUrl.pathname, SESSION_FEEDBACK_STATE_ENDPOINT_PATTERN);
        if (!route) {
          sendJson(response, 400, { error: "Invalid profileId or sessionId." });
          return;
        }

        if (!isExistingSession(swarmManager, route.profileId, route.sessionId)) {
          sendJson(response, 404, { error: `Unknown session: ${route.profileId}/${route.sessionId}` });
          return;
        }

        try {
          const states = await feedbackService.getLatestStates(route.profileId, route.sessionId);
          sendJson(response, 200, { states });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to load feedback state.";
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === FEEDBACK_QUERY_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        const methods = "GET, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);

        try {
          const filters = parseFeedbackAcrossSessionsFilterParams(requestUrl.searchParams);
          const events = await feedbackService.queryFeedbackAcrossSessions(filters);
          sendJson(response, 200, { feedback: events });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to query feedback.";
          const statusCode = isInvalidRequestError(message) ? 400 : 500;
          sendJson(response, statusCode, { error: message });
        }
      }
    }
  ];
}

function resolveSessionRoute(pathname: string, pattern: RegExp): { profileId: string; sessionId: string } | null {
  const matched = matchPathPattern(pathname, pattern);
  if (!matched) {
    return null;
  }

  const profileId = decodePathSegment(matched[1]);
  const sessionId = decodePathSegment(matched[2]);

  if (!profileId || !sessionId) {
    return null;
  }

  return { profileId, sessionId };
}

function isExistingSession(swarmManager: SwarmManager, profileId: string, sessionId: string): boolean {
  const descriptor = swarmManager.getAgent(sessionId);
  if (!descriptor || descriptor.role !== "manager") {
    return false;
  }

  return (descriptor.profileId ?? descriptor.agentId) === profileId;
}

function parseSubmitFeedbackBody(
  value: unknown,
  sessionId: string
): {
  scope: FeedbackEvent["scope"];
  targetId: string;
  value: FeedbackSubmitValue;
  reasonCodes: string[];
  comment: string;
  channel: FeedbackEvent["channel"];
  clearKind?: "vote" | "comment";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }

  const maybe = value as {
    scope?: unknown;
    targetId?: unknown;
    value?: unknown;
    reasonCodes?: unknown;
    comment?: unknown;
    channel?: unknown;
    clearKind?: unknown;
  };

  const scope = parseScopeValue(maybe.scope, "scope");
  if (!scope) {
    throw new Error("scope is required.");
  }

  const targetIdRaw = typeof maybe.targetId === "string" ? maybe.targetId.trim() : "";
  const targetId = scope === "session" ? targetIdRaw || sessionId : targetIdRaw;
  if (targetId.length === 0) {
    throw new Error("targetId must be a non-empty string.");
  }

  const feedbackValue = parseVoteValue(maybe.value, "value");
  if (!feedbackValue) {
    throw new Error("value is required.");
  }

  const reasonCodes = parseReasonCodes(maybe.reasonCodes ?? []);

  if (maybe.comment !== undefined && typeof maybe.comment !== "string") {
    throw new Error("comment must be a string.");
  }

  const comment = typeof maybe.comment === "string" ? maybe.comment : "";
  if (comment.length > 2000) {
    throw new Error("comment must not exceed 2000 characters.");
  }

  if (feedbackValue === "comment" && comment.trim().length === 0) {
    throw new Error("comment must be a non-empty string.");
  }

  const clearKind = parseClearKindValue(maybe.clearKind, "clearKind");

  const channel = parseChannelValue(maybe.channel ?? "web", "channel");

  return {
    scope,
    targetId,
    value: feedbackValue,
    reasonCodes,
    comment,
    channel,
    ...(feedbackValue === "clear" && clearKind ? { clearKind } : {})
  };
}

function parseFeedbackFilterParams(searchParams: URLSearchParams): FeedbackListOptions {
  return {
    since: parseSinceValue(searchParams.get("since")),
    scope: parseScopeValue(searchParams.get("scope"), "scope", true),
    value: parseVoteValue(searchParams.get("value"), "value", true)
  };
}

function parseFeedbackAcrossSessionsFilterParams(searchParams: URLSearchParams): FeedbackAcrossSessionsOptions {
  const profileIdRaw = searchParams.get("profileId");
  const profileId = profileIdRaw !== null ? profileIdRaw.trim() : undefined;
  if (profileId !== undefined && profileId.length === 0) {
    throw new Error("profileId must be a non-empty string.");
  }

  return {
    profileId,
    since: parseSinceValue(searchParams.get("since")),
    scope: parseScopeValue(searchParams.get("scope"), "scope", true),
    value: parseVoteValue(searchParams.get("value"), "value", true)
  };
}

function parseSinceValue(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("since must be a non-empty ISO-8601 timestamp.");
  }

  if (!Number.isFinite(Date.parse(trimmed))) {
    throw new Error("since must be a valid ISO-8601 timestamp.");
  }

  return trimmed;
}

function parseScopeValue(
  value: unknown,
  fieldName: string,
  allowMissing = false
): FeedbackEvent["scope"] | undefined {
  if (value === undefined || value === null) {
    if (allowMissing) {
      return undefined;
    }

    throw new Error(`${fieldName} is required.`);
  }

  if (value !== "message" && value !== "session") {
    throw new Error(`${fieldName} must be one of: message, session.`);
  }

  return value;
}

function parseVoteValue(
  value: unknown,
  fieldName: string,
  allowMissing = false
): FeedbackSubmitValue | undefined {
  if (value === undefined || value === null) {
    if (allowMissing) {
      return undefined;
    }

    throw new Error(`${fieldName} is required.`);
  }

  if (value !== "up" && value !== "down" && value !== "comment" && value !== "clear") {
    throw new Error(`${fieldName} must be one of: up, down, comment, clear.`);
  }

  return value;
}

function parseClearKindValue(value: unknown, fieldName: string): "vote" | "comment" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value !== "vote" && value !== "comment") {
    throw new Error(`${fieldName} must be one of: vote, comment.`);
  }

  return value;
}

function parseChannelValue(value: unknown, fieldName: string): FeedbackEvent["channel"] {
  if (value !== "web" && value !== "telegram" && value !== "slack") {
    throw new Error(`${fieldName} must be one of: web, telegram, slack.`);
  }

  return value;
}

function parseReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("reasonCodes must be an array of strings.");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawCode of value) {
    if (typeof rawCode !== "string") {
      throw new Error("reasonCodes must be an array of strings.");
    }

    const code = rawCode.trim();
    if (!FEEDBACK_REASON_CODES.includes(code as (typeof FEEDBACK_REASON_CODES)[number])) {
      throw new Error(`Unknown feedback reason code: ${code}`);
    }

    if (seen.has(code)) {
      continue;
    }

    seen.add(code);
    normalized.push(code);
  }

  return normalized;
}

function isInvalidRequestError(message: string): boolean {
  return (
    message.includes("must") ||
    message.includes("required") ||
    message.includes("Unknown feedback reason code") ||
    message.includes("Invalid path segment") ||
    message.includes("Request body")
  );
}
