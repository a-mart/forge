import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isSystemProfile,
  type CliAgentShowResponse,
  type CliAgentsListResponse,
  type CliCapabilities,
  type CliCapabilitiesResponse,
  type CliHttpErrorResponse,
  type CliProfileShowResponse,
  type CliProfilesListResponse,
  type CliProjectAgentDescriptor,
  type CliProjectAgentShowResponse,
  type CliProjectAgentsListResponse,
  type CliSessionShowResponse,
  type CliSessionsListResponse,
  type CliStatusResponse,
} from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
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

const SERVER_VERSION = "1.0.0";
const HTTP_GET_ALLOW_HEADER = "GET, OPTIONS";

interface CliRouteSwarmManager {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
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

function buildCliCapabilities(runtimeTarget: RuntimeTarget): CliCapabilities {
  return {
    protocolVersion: 1,
    minCliVersion: "0.1.0",
    available: isBuilderRuntimeTarget(runtimeTarget),
    runtimeTarget,
    features: {
      bearerAuth: true,
      headlessWs: false,
      cliSourceContext: true,
      cliSessionMetadata: true,
      choiceOwnerLookup: false,
      activeToolSnapshot: false,
      projectAgentRunTarget: false,
      builderRuntimeOnly: true,
    },
  };
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

  if (segments.length === 1 && segments[0] === "capabilities") {
    const payload: CliCapabilitiesResponse = {
      serverTime: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
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
      serverVersion: SERVER_VERSION,
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
      agents: listCliAgents(options.swarmManager, profiles).map(toPublicAgentDescriptor),
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

    const payload: CliAgentShowResponse = { agent: toPublicAgentDescriptor(agent) };
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
        .map(toPublicAgentDescriptor),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (segments.length === 2 && segments[0] === "sessions") {
    const session = findCliAgent(options.swarmManager, segments[1]);
    if (!session || session.role !== "manager") {
      sendCliError(response, 404, "not_found", "Session not found");
      return;
    }

    const payload: CliSessionShowResponse = { session: toPublicAgentDescriptor(session) };
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

function getCliPathSegments(pathname: string): string[] {
  const relative = pathname.slice(CLI_HTTP_ROUTE_PREFIX.length).replace(/^\/+/, "");
  if (!relative) {
    return [];
  }

  return relative.split("/").map((segment) => decodeURIComponent(segment));
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

function toPublicAgentDescriptor(agent: AgentDescriptor): AgentDescriptor {
  const { sessionSystemPrompt: _sessionSystemPrompt, ...withoutPrompt } = agent;
  const publicProjectAgent = withoutPrompt.projectAgent
    ? {
        handle: withoutPrompt.projectAgent.handle,
        whenToUse: withoutPrompt.projectAgent.whenToUse,
        ...(withoutPrompt.projectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: withoutPrompt.projectAgent.creatorSessionId }
          : {}),
        ...(withoutPrompt.projectAgent.capabilities !== undefined
          ? { capabilities: [...withoutPrompt.projectAgent.capabilities] }
          : {}),
      }
    : undefined;

  return {
    ...withoutPrompt,
    model: { ...withoutPrompt.model },
    ...(withoutPrompt.contextUsage !== undefined ? { contextUsage: { ...withoutPrompt.contextUsage } } : {}),
    ...(withoutPrompt.collab !== undefined ? { collab: { ...withoutPrompt.collab } } : {}),
    ...(withoutPrompt.cli !== undefined ? { cli: { ...withoutPrompt.cli } } : {}),
    projectAgent: publicProjectAgent,
  };
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
