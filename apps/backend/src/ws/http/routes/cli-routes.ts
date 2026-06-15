import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isSystemProfile,
  type ChoiceQuestion,
  type CliAgentShowResponse,
  type CliAgentsListResponse,
  type CliCapabilitiesResponse,
  type CliChoicesListResponse,
  type CliChoiceShowResponse,
  type CliHttpErrorResponse,
  type CliProfileShowResponse,
  type CliProfilesListResponse,
  type CliProjectAgentDescriptor,
  type CliProjectAgentShowResponse,
  type CliProjectAgentsListResponse,
  type CliSessionShowResponse,
  type CliSessionTranscriptResponse,
  type CliSessionsListResponse,
  type CliStatusResponse,
  type ConversationEntryEvent,
} from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import { buildCliCapabilities, CLI_SERVER_VERSION } from "../../cli-capabilities.js";
import {
  buildCliSessionTranscriptResponse,
  parseCliSessionTranscriptOptions,
} from "../../cli-session-transcript.js";
import {
  findCliVisibleChoiceSession,
  getCliChoiceOwner,
  listCliChoiceOwners,
  listCliChoiceOwnersForProfile,
  listCliChoiceOwnersForSession,
} from "../../cli-choice-owners.js";
import { toPublicCliAgentDescriptor } from "../../cli-public-descriptors.js";
import type { SidebarConversationHistoryDiagnostics } from "../../../stats/sidebar-perf-types.js";
import type { CliAccessService } from "../../../swarm/cli-access-service.js";
import type { AgentDescriptor, ManagerProfile } from "../../../swarm/types.js";
import {
  authenticateCliHttpRequest,
  CLI_CORS_ALLOWED_HEADERS,
  CLI_HTTP_METHODS,
  CLI_HTTP_ROUTE_PREFIX,
  sendCliAuthFailure,
} from "../../cli-auth.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const HTTP_GET_ALLOW_HEADER = "GET, OPTIONS";

interface CliRouteSwarmManager {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
  getPendingChoiceIdsForSession(sessionAgentId: string): string[];
  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined;
  getConversationHistoryWithDiagnostics(agentId: string): {
    history: ConversationEntryEvent[];
    diagnostics: SidebarConversationHistoryDiagnostics;
  };
}

export function createCliRoutes(options: {
  cliAccessService: CliAccessService;
  runtimeTarget: RuntimeTarget;
  swarmManager: CliRouteSwarmManager;
}): HttpRoute[] {
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    return [];
  }

  return [
    {
      methods: CLI_HTTP_METHODS,
      matches: (pathname) => pathname === CLI_HTTP_ROUTE_PREFIX || pathname.startsWith(`${CLI_HTTP_ROUTE_PREFIX}/`),
      handle: async (request, response, requestUrl) => {
        await handleCliHttpRequest(options, request, response, requestUrl);
      },
    },
  ];
}

async function handleCliHttpRequest(
  options: {
    cliAccessService: CliAccessService;
    runtimeTarget: RuntimeTarget;
    swarmManager: CliRouteSwarmManager;
  },
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  applyCorsHeaders(request, response, CLI_HTTP_METHODS, CLI_CORS_ALLOWED_HEADERS);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const authResult = await authenticateCliHttpRequest(options.cliAccessService, request);
  if (!authResult.ok) {
    sendCliAuthFailure(request, response, authResult);
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", HTTP_GET_ALLOW_HEADER);
    sendCliError(response, 405, "method_not_allowed", "Method Not Allowed");
    return;
  }

  const capabilities = buildCliCapabilities(options.runtimeTarget);
  const segments = getCliPathSegments(requestUrl.pathname);
  if (!segments) {
    sendCliError(response, 400, "bad_path", "Malformed CLI path");
    return;
  }

  if (segments.length === 1 && segments[0] === "capabilities") {
    const payload: CliCapabilitiesResponse = {
      serverTime: new Date().toISOString(),
      serverVersion: CLI_SERVER_VERSION,
      capabilities,
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "status") {
    const profiles = listCliProfiles(options.swarmManager);
    const agents = listCliAgents(options.swarmManager, profiles);
    const payload: CliStatusResponse = {
      status: "ok",
      serverTime: new Date().toISOString(),
      serverVersion: CLI_SERVER_VERSION,
      runtimeTarget: options.runtimeTarget,
      capabilities,
      summary: {
        profileCount: profiles.length,
        sessionCount: agents.filter((agent) => agent.role === "manager").length,
        agentCount: agents.length,
      },
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "profiles") {
    const payload: CliProfilesListResponse = {
      profiles: listCliProfiles(options.swarmManager).map(cloneProfile),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "profiles") {
    const profile = findCliProfile(options.swarmManager, segments[1]);
    if (!profile) {
      sendCliError(response, 404, "not_found", "Profile not found");
      return;
    }

    const payload: CliProfileShowResponse = { profile: cloneProfile(profile) };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "agents") {
    const profile = resolveOptionalProfileFilter(options.swarmManager, requestUrl, response);
    if (profile === null) {
      return;
    }

    const profiles = profile ? [profile] : listCliProfiles(options.swarmManager);
    const payload: CliAgentsListResponse = {
      agents: listCliAgents(options.swarmManager, profiles).map(toPublicCliAgentDescriptor),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "agents") {
    const agent = findCliAgent(options.swarmManager, segments[1]);
    if (!agent) {
      sendCliError(response, 404, "not_found", "Agent not found");
      return;
    }

    const payload: CliAgentShowResponse = { agent: toPublicCliAgentDescriptor(agent) };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "sessions") {
    const profile = resolveRequiredProfileFilter(options.swarmManager, requestUrl, response);
    if (!profile) {
      return;
    }

    const payload: CliSessionsListResponse = {
      sessions: listCliAgents(options.swarmManager, [profile])
        .filter((agent) => agent.role === "manager")
        .map(toPublicCliAgentDescriptor),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 3 && segments[0] === "sessions" && segments[2] === "transcript") {
    const session = findCliAgent(options.swarmManager, segments[1]);
    if (!session || session.role !== "manager") {
      sendCliError(response, 404, "not_found", "Session not found");
      return;
    }

    const transcriptOptionsResult = parseCliSessionTranscriptOptions(requestUrl.searchParams);
    if (!transcriptOptionsResult.ok) {
      sendCliError(
        response,
        transcriptOptionsResult.status,
        transcriptOptionsResult.code,
        transcriptOptionsResult.message,
      );
      return;
    }

    const { history } = options.swarmManager.getConversationHistoryWithDiagnostics(session.agentId);
    const payload: CliSessionTranscriptResponse = buildCliSessionTranscriptResponse({
      session,
      agents: listCliAgents(options.swarmManager, listCliProfiles(options.swarmManager)),
      history,
      transcriptOptions: transcriptOptionsResult.options,
    });
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "sessions") {
    const session = findCliAgent(options.swarmManager, segments[1]);
    if (!session || session.role !== "manager") {
      sendCliError(response, 404, "not_found", "Session not found");
      return;
    }

    const payload: CliSessionShowResponse = { session: toPublicCliAgentDescriptor(session) };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "choices") {
    const sessionAgentId = normalizeIdentifier(requestUrl.searchParams.get("sessionAgentId") ?? undefined);
    const profileId = normalizeIdentifier(requestUrl.searchParams.get("profileId") ?? undefined);

    let choices;
    if (sessionAgentId) {
      const session = findCliVisibleChoiceSession(options.swarmManager, sessionAgentId);
      if (!session || (profileId && (session.profileId ?? session.agentId) !== profileId)) {
        sendCliError(response, 404, "not_found", "Session not found");
        return;
      }
      choices = listCliChoiceOwnersForSession(options.swarmManager, session.agentId);
    } else if (profileId) {
      const profile = findCliProfile(options.swarmManager, profileId);
      if (!profile) {
        sendCliError(response, 404, "not_found", "Profile not found");
        return;
      }
      choices = listCliChoiceOwnersForProfile(options.swarmManager, profile.profileId);
    } else {
      choices = listCliChoiceOwners(options.swarmManager);
    }

    const payload: CliChoicesListResponse = { choices };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "choices") {
    const choice = getCliChoiceOwner(options.swarmManager, segments[1]);
    const requestedSessionAgentId = normalizeIdentifier(requestUrl.searchParams.get("sessionAgentId") ?? undefined);
    if (!choice || (requestedSessionAgentId && choice.sessionAgentId !== requestedSessionAgentId)) {
      sendCliError(response, 404, "not_found", "Choice not found");
      return;
    }

    const payload: CliChoiceShowResponse = { choice };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 1 && segments[0] === "project-agents") {
    const profile = resolveRequiredProfileFilter(options.swarmManager, requestUrl, response);
    if (!profile) {
      return;
    }

    const payload: CliProjectAgentsListResponse = {
      projectAgents: listCliProjectAgents(options.swarmManager, profile.profileId),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "project-agents") {
    const profile = resolveRequiredProfileFilter(options.swarmManager, requestUrl, response);
    if (!profile) {
      return;
    }

    const projectAgent = listCliProjectAgents(options.swarmManager, profile.profileId).find(
      (candidate) => candidate.handle === segments[1],
    );
    if (!projectAgent) {
      sendCliError(response, 404, "not_found", "Project agent not found");
      return;
    }

    const payload: CliProjectAgentShowResponse = { projectAgent };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  sendCliError(response, 404, "not_found", "Not Found");
}

function getCliPathSegments(pathname: string): string[] | null {
  const relative = pathname.slice(CLI_HTTP_ROUTE_PREFIX.length).replace(/^\/+/, "");
  if (!relative) {
    return [];
  }

  try {
    return relative.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function listCliProfiles(swarmManager: CliRouteSwarmManager): ManagerProfile[] {
  return swarmManager.listProfiles().filter((profile) => !isSystemProfile(profile));
}

function findCliProfile(swarmManager: CliRouteSwarmManager, profileId: string | undefined): ManagerProfile | undefined {
  const normalizedProfileId = normalizeIdentifier(profileId);
  if (!normalizedProfileId) {
    return undefined;
  }

  return listCliProfiles(swarmManager).find((profile) => profile.profileId === normalizedProfileId);
}

function resolveOptionalProfileFilter(
  swarmManager: CliRouteSwarmManager,
  requestUrl: URL,
  response: ServerResponse,
): ManagerProfile | null | undefined {
  const profileId = normalizeIdentifier(requestUrl.searchParams.get("profileId") ?? undefined);
  if (!profileId) {
    return undefined;
  }

  const profile = findCliProfile(swarmManager, profileId);
  if (!profile) {
    sendCliError(response, 404, "not_found", "Profile not found");
    return null;
  }

  return profile;
}

function resolveRequiredProfileFilter(
  swarmManager: CliRouteSwarmManager,
  requestUrl: URL,
  response: ServerResponse,
): ManagerProfile | undefined {
  const profileId = normalizeIdentifier(requestUrl.searchParams.get("profileId") ?? undefined);
  if (!profileId) {
    sendCliError(response, 400, "missing_profile_id", "profileId query parameter is required");
    return undefined;
  }

  const profile = findCliProfile(swarmManager, profileId);
  if (!profile) {
    sendCliError(response, 404, "not_found", "Profile not found");
    return undefined;
  }

  return profile;
}

function listCliAgents(swarmManager: CliRouteSwarmManager, profiles: ManagerProfile[]): AgentDescriptor[] {
  const allowedProfileIds = new Set(profiles.map((profile) => profile.profileId));
  return swarmManager
    .listAgents()
    .filter((agent) => agent.sessionSurface !== "collab")
    .filter((agent) => allowedProfileIds.has(agent.profileId ?? agent.agentId));
}

function findCliAgent(swarmManager: CliRouteSwarmManager, agentId: string | undefined): AgentDescriptor | undefined {
  const normalizedAgentId = normalizeIdentifier(agentId);
  if (!normalizedAgentId) {
    return undefined;
  }

  return listCliAgents(swarmManager, listCliProfiles(swarmManager)).find((agent) => agent.agentId === normalizedAgentId);
}

function listCliProjectAgents(swarmManager: CliRouteSwarmManager, profileId: string): CliProjectAgentDescriptor[] {
  return listCliAgents(swarmManager, listCliProfiles(swarmManager))
    .filter((agent) => agent.role === "manager" && agent.profileId === profileId && agent.projectAgent)
    .map((agent): CliProjectAgentDescriptor => {
      const projectAgent = agent.projectAgent!;
      return {
        profileId,
        agentId: agent.agentId,
        handle: projectAgent.handle,
        whenToUse: projectAgent.whenToUse,
        displayName: agent.sessionLabel ?? agent.displayName,
        ...(projectAgent.creatorSessionId !== undefined ? { creatorSessionId: projectAgent.creatorSessionId } : {}),
        ...(projectAgent.capabilities !== undefined ? { capabilities: [...projectAgent.capabilities] } : {}),
        updatedAt: agent.updatedAt,
      };
    })
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

function cloneProfile(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: { ...profile.defaultModel },
  };
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sendCliError(response: ServerResponse, status: number, code: string, message: string): void {
  const payload: CliHttpErrorResponse = {
    error: {
      code,
      message,
      status,
    },
  };
  sendJson(response, status, payload as unknown as Record<string, unknown>);
}
