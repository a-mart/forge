import type { IncomingMessage, ServerResponse } from "node:http";
import {
  STREAM_DECK_ACTION_TYPES,
  STREAM_DECK_PROTOCOL_VERSION,
  STREAM_DECK_SURFACES,
  type ServerEvent,
  type StatsSnapshot,
  type StreamDeckActionRequest,
  type StreamDeckActionResponse,
  type StreamDeckProfileSummary,
  type StreamDeckSessionSummary,
  type StreamDeckSnapshot,
} from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import type { StatsService } from "../../../stats/stats-service.js";
import type { CliAccessService } from "../../../swarm/cli-access-service.js";
import type { StreamDeckAccessService } from "../../../swarm/stream-deck-access-service.js";
import type { UnreadTracker } from "../../../swarm/session/unread-tracker.js";
import type { AgentDescriptor, ManagerProfile } from "../../../swarm/types.js";
import {
  authenticateCliHttpRequest,
  CLI_CORS_ALLOWED_HEADERS,
  sendCliAuthFailure,
} from "../../cli-auth.js";
import { CLI_SERVER_VERSION } from "../../cli-capabilities.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export const STREAM_DECK_ROUTE_PREFIX = "/api/stream-deck";
const STREAM_DECK_HTTP_METHODS = "GET,POST,OPTIONS";
const MAX_ACTION_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_LENGTH = 8_000;

interface StreamDeckRouteSwarmManager {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
  getAgent(agentId: string): AgentDescriptor | undefined;
  getPendingChoiceIdsForSession(sessionAgentId: string): string[];
  createSession(
    profileId: string,
    options?: { label?: string },
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>;
  stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }>;
  resumeSession(agentId: string): Promise<void>;
  smartCompactAgentContext(
    agentId: string,
    options?: {
      sourceContext?: { channel: "cli"; channelId?: string; messageId?: string };
      trigger?: "cli";
    },
  ): Promise<unknown>;
  handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: "auto" | "followUp" | "steer";
      sourceContext?: { channel: "cli"; channelId?: string; messageId?: string };
      clientRequestId?: string;
    },
  ): Promise<void>;
}

export function createStreamDeckRoutes(options: {
  cliAccessService: CliAccessService;
  streamDeckAccessService: StreamDeckAccessService;
  runtimeTarget: RuntimeTarget;
  swarmManager: StreamDeckRouteSwarmManager;
  unreadTracker: Pick<UnreadTracker, "getSnapshot" | "markRead">;
  statsService: Pick<StatsService, "getSnapshot">;
  onUnreadChanged?: (sessionAgentId: string, count: number) => void;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    return [];
  }

  return [
    {
      methods: STREAM_DECK_HTTP_METHODS,
      matches: (pathname) =>
        pathname === `${STREAM_DECK_ROUTE_PREFIX}/snapshot` ||
        pathname === `${STREAM_DECK_ROUTE_PREFIX}/actions`,
      handle: async (request, response, requestUrl) => {
        await handleStreamDeckRequest(options, request, response, requestUrl);
      },
    },
  ];
}

async function handleStreamDeckRequest(
  options: Parameters<typeof createStreamDeckRoutes>[0],
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  applyCorsHeaders(request, response, STREAM_DECK_HTTP_METHODS, CLI_CORS_ALLOWED_HEADERS);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const deckAuthResult = await options.streamDeckAccessService.authenticateAuthorizationHeader(
    request.headers.authorization,
  );
  const authResult = deckAuthResult.ok
    ? deckAuthResult
    : await authenticateCliHttpRequest(options.cliAccessService, request);
  if (!authResult.ok) {
    sendCliAuthFailure(request, response, authResult);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === `${STREAM_DECK_ROUTE_PREFIX}/snapshot`) {
    const requestedFocus = normalizeIdentifier(requestUrl.searchParams.get("sessionAgentId"));
    const snapshot = await buildStreamDeckSnapshot(options, requestedFocus);
    sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === `${STREAM_DECK_ROUTE_PREFIX}/actions`) {
    await handleStreamDeckAction(options, request, response);
    return;
  }

  sendActionResponse(response, 404, {
    ok: false,
    requestId: null,
    code: "not_found",
    message: "Stream Deck endpoint not found",
  });
}

export async function buildStreamDeckSnapshot(
  options: Parameters<typeof createStreamDeckRoutes>[0],
  requestedFocus: string | null,
): Promise<StreamDeckSnapshot> {
  const profiles = options.swarmManager.listProfiles().filter((profile) => !profile.archivedAt);
  const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const unreadCounts = options.unreadTracker.getSnapshot();
  const sessions = options.swarmManager
    .listAgents()
    .filter((agent) => agent.role === "manager" && !agent.archivedAt && profileById.has(agent.profileId ?? agent.agentId))
    .map((agent) => toSessionSummary(agent, profileById, unreadCounts, options.swarmManager))
    .sort(compareSessionAttention);

  const focusSessionAgentId =
    (requestedFocus && sessions.some((session) => session.agentId === requestedFocus)
      ? requestedFocus
      : sessions[0]?.agentId) ?? null;

  let stats: StatsSnapshot | null = null;
  try {
    stats = await options.statsService.getSnapshot("7d");
  } catch {
    stats = null;
  }

  return {
    protocolVersion: STREAM_DECK_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    serverVersion: CLI_SERVER_VERSION,
    summary: {
      profileCount: profiles.length,
      sessionCount: sessions.length,
      runningSessionCount: sessions.filter((session) => session.status === "streaming").length,
      activeWorkerCount: sessions.reduce((total, session) => total + session.activeWorkerCount, 0),
      pendingChoiceCount: sessions.reduce((total, session) => total + session.pendingChoiceCount, 0),
      unreadCount: sessions.reduce((total, session) => total + session.unreadCount, 0),
    },
    focusSessionAgentId,
    profiles: profiles
      .map((profile) => toProfileSummary(profile, sessions))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    sessions,
    stats: stats
      ? {
          tokensToday: stats.tokens.today,
          tokensLast7Days: stats.tokens.last7Days,
          cacheHitRate: stats.cache.hitRate,
          currentlyActiveWorkers: stats.workers.currentlyActive,
          totalWorkersRun: stats.workers.totalWorkersRun,
          activeSessions: stats.sessions.activeSessions,
          linesAdded: stats.code.linesAdded,
          linesDeleted: stats.code.linesDeleted,
          commits: stats.code.commits,
        }
      : null,
  };
}

function toSessionSummary(
  agent: AgentDescriptor,
  profiles: ReadonlyMap<string, ManagerProfile>,
  unreadCounts: Readonly<Record<string, number>>,
  swarmManager: StreamDeckRouteSwarmManager,
): StreamDeckSessionSummary {
  const profileId = agent.profileId ?? agent.agentId;
  const profile = profiles.get(profileId);
  return {
    agentId: agent.agentId,
    profileId,
    profileName: profile?.displayName ?? profileId,
    label: agent.sessionLabel ?? agent.displayName,
    status: agent.status,
    updatedAt: agent.updatedAt,
    ...(agent.lastUserMessageAt ? { lastUserMessageAt: agent.lastUserMessageAt } : {}),
    contextPercent: clampPercent(agent.contextUsage?.percent ?? 0),
    workerCount: nonNegativeInteger(agent.workerCount),
    activeWorkerCount: nonNegativeInteger(agent.activeWorkerCount),
    pendingChoiceCount: swarmManager.getPendingChoiceIdsForSession(agent.agentId).length,
    unreadCount: nonNegativeInteger(unreadCounts[agent.agentId]),
    compactionCount: nonNegativeInteger(agent.compactionCount),
  };
}

function toProfileSummary(
  profile: ManagerProfile,
  sessions: readonly StreamDeckSessionSummary[],
): StreamDeckProfileSummary {
  const profileSessions = sessions.filter((session) => session.profileId === profile.profileId);
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    updatedAt: profile.updatedAt,
    sessionCount: profileSessions.length,
    activeSessionCount: profileSessions.filter(
      (session) => session.status === "streaming" || session.activeWorkerCount > 0,
    ).length,
    unreadCount: profileSessions.reduce((total, session) => total + session.unreadCount, 0),
  };
}

export function compareSessionAttention(
  left: StreamDeckSessionSummary,
  right: StreamDeckSessionSummary,
): number {
  const score = (session: StreamDeckSessionSummary): number => {
    if (session.pendingChoiceCount > 0) return 5;
    if (session.status === "error") return 4;
    if (session.unreadCount > 0) return 3;
    if (session.status === "streaming" || session.activeWorkerCount > 0) return 2;
    return 1;
  };
  return score(right) - score(left) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

async function handleStreamDeckAction(
  options: Parameters<typeof createStreamDeckRoutes>[0],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_ACTION_BODY_BYTES);
  } catch (error) {
    sendActionResponse(response, 400, actionError(null, "invalid_json", error));
    return;
  }

  const parsed = parseStreamDeckAction(body);
  if (!parsed.ok) {
    sendActionResponse(response, 400, parsed.error);
    return;
  }

  const action = parsed.action;
  try {
    const result = await executeStreamDeckAction(options, action);
    sendActionResponse(response, 200, result);
  } catch (error) {
    sendActionResponse(response, 409, actionError(action.requestId, "action_failed", error));
  }
}

export async function executeStreamDeckAction(
  options: Parameters<typeof createStreamDeckRoutes>[0],
  action: StreamDeckActionRequest,
): Promise<StreamDeckActionResponse> {
  if (action.type === "navigate") {
    if (action.sessionAgentId) {
      requireSession(options.swarmManager, action.sessionAgentId);
    }
    options.broadcastEvent({
      type: "stream_deck_navigation_requested",
      requestId: action.requestId,
      surface: action.surface,
      ...(action.sessionAgentId ? { sessionAgentId: action.sessionAgentId } : {}),
      requestedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      requestId: action.requestId,
      type: action.type,
      ...(action.sessionAgentId ? { sessionAgentId: action.sessionAgentId } : {}),
      message: `Requested ${action.surface} in Forge`,
    };
  }

  if (action.type === "create_session") {
    const profile = options.swarmManager.listProfiles().find((candidate) => candidate.profileId === action.profileId);
    if (!profile || profile.archivedAt) {
      throw new Error("Profile not found");
    }
    const created = await options.swarmManager.createSession(action.profileId, {
      ...(action.label ? { label: action.label } : {}),
    });
    return {
      ok: true,
      requestId: action.requestId,
      type: action.type,
      sessionAgentId: created.sessionAgent.agentId,
      message: `Created ${created.sessionAgent.sessionLabel ?? created.sessionAgent.displayName}`,
    };
  }

  const session = requireSession(options.swarmManager, action.sessionAgentId);

  if (action.type === "send_prompt") {
    await options.swarmManager.handleUserMessage(action.text, {
      targetAgentId: session.agentId,
      delivery: action.delivery ?? "auto",
      sourceContext: {
        channel: "cli",
        channelId: "stream-deck",
        messageId: action.requestId,
      },
      clientRequestId: action.requestId,
    });
    return success(action, session.agentId, "Prompt delivered");
  }

  if (action.type === "toggle_session") {
    if (session.status === "stopped" || session.status === "terminated" || session.status === "error") {
      await options.swarmManager.resumeSession(session.agentId);
      return success(action, session.agentId, "Session resumed");
    }
    await options.swarmManager.stopSession(session.agentId);
    return success(action, session.agentId, "Session stopped");
  }

  if (action.type === "stop_session") {
    await options.swarmManager.stopSession(session.agentId);
    return success(action, session.agentId, "Session stopped");
  }

  if (action.type === "resume_session") {
    await options.swarmManager.resumeSession(session.agentId);
    return success(action, session.agentId, "Session resumed");
  }

  if (action.type === "smart_compact") {
    await options.swarmManager.smartCompactAgentContext(session.agentId, {
      sourceContext: { channel: "cli", channelId: "stream-deck", messageId: action.requestId },
      trigger: "cli",
    });
    return success(action, session.agentId, "Smart compaction started");
  }

  const previous = options.unreadTracker.markRead(session.profileId ?? session.agentId, session.agentId);
  if (previous > 0) {
    options.onUnreadChanged?.(session.agentId, 0);
  }
  return success(action, session.agentId, previous > 0 ? "Marked read" : "Already read");
}

export function parseStreamDeckAction(
  body: unknown,
): { ok: true; action: StreamDeckActionRequest } | { ok: false; error: Extract<StreamDeckActionResponse, { ok: false }> } {
  if (!isRecord(body)) {
    return { ok: false, error: actionError(null, "invalid_action", "Action must be an object") };
  }

  const requestId = normalizeIdentifier(body.requestId);
  const type = normalizeIdentifier(body.type);
  if (!requestId || !type || !STREAM_DECK_ACTION_TYPES.includes(type as StreamDeckActionRequest["type"])) {
    return { ok: false, error: actionError(requestId, "invalid_action", "requestId and a valid type are required") };
  }

  if (type === "create_session") {
    const profileId = normalizeIdentifier(body.profileId);
    const label = normalizeOptionalText(body.label, 120);
    if (!profileId) {
      return { ok: false, error: actionError(requestId, "invalid_action", "profileId is required") };
    }
    return {
      ok: true,
      action: { requestId, type, profileId, ...(label ? { label } : {}) },
    };
  }

  const sessionAgentId = normalizeIdentifier(body.sessionAgentId);
  if (type === "navigate") {
    const surface = normalizeIdentifier(body.surface);
    if (!surface || !STREAM_DECK_SURFACES.includes(surface as (typeof STREAM_DECK_SURFACES)[number])) {
      return { ok: false, error: actionError(requestId, "invalid_action", "A valid surface is required") };
    }
    if (!sessionAgentId && surface !== "stats" && surface !== "tokens") {
      return { ok: false, error: actionError(requestId, "invalid_action", "sessionAgentId is required") };
    }
    return {
      ok: true,
      action: {
        requestId,
        type,
        surface: surface as (typeof STREAM_DECK_SURFACES)[number],
        ...(sessionAgentId ? { sessionAgentId } : {}),
      },
    };
  }

  if (!sessionAgentId) {
    return { ok: false, error: actionError(requestId, "invalid_action", "sessionAgentId is required") };
  }

  if (type === "send_prompt") {
    const text = normalizeOptionalText(body.text, MAX_PROMPT_LENGTH);
    const delivery =
      body.delivery === "auto" || body.delivery === "followUp" || body.delivery === "steer"
        ? body.delivery
        : undefined;
    if (!text) {
      return { ok: false, error: actionError(requestId, "invalid_action", "Prompt text is required") };
    }
    return {
      ok: true,
      action: { requestId, type, sessionAgentId, text, ...(delivery ? { delivery } : {}) },
    };
  }

  return {
    ok: true,
    action: { requestId, type, sessionAgentId } as StreamDeckActionRequest,
  };
}

function requireSession(
  swarmManager: StreamDeckRouteSwarmManager,
  sessionAgentId: string,
): AgentDescriptor {
  const session = swarmManager.getAgent(sessionAgentId);
  if (!session || session.role !== "manager" || session.archivedAt) {
    throw new Error("Session not found");
  }
  return session;
}

function success(
  action: StreamDeckActionRequest,
  sessionAgentId: string,
  message: string,
): StreamDeckActionResponse {
  return { ok: true, requestId: action.requestId, type: action.type, sessionAgentId, message };
}

function sendActionResponse(response: ServerResponse, status: number, payload: StreamDeckActionResponse): void {
  sendJson(response, status, payload as unknown as Record<string, unknown>);
}

function actionError(
  requestId: string | null,
  code: string,
  error: unknown,
): Extract<StreamDeckActionResponse, { ok: false }> {
  return {
    ok: false,
    requestId,
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 240 ? trimmed : null;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
