import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MANAGER_REASONING_LEVELS,
  type ManagerReasoningLevel,
  type ModelPresetInfo,
  type ServerEvent,
  type SpecialistTargetSpace,
  type TierConfig,
} from "@forge/protocol";
import {
  deleteProfileSpecialist,
  deleteSharedSpecialist,
  resolveRoster,
  resolveSharedRoster,
  resolveWorkspaceRoster,
  generateRosterBlock,
  getWorkerTemplate,
  resolveTierConfigs,
  saveTierConfigs,
  saveProfileSpecialist,
  saveSharedSpecialist,
  invalidateSpecialistCache,
  type SaveSpecialistRequest,
} from "../../../swarm/specialists/specialist-registry.js";
import { modelCatalogService } from "../../../swarm/model-catalog-service.js";
import { getManagedModelProviderCredentialAvailability } from "../../../swarm/secrets-env-service.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  SYSTEM_PROFILE_MUTATION_ERROR,
  requireNonSystemProfile,
} from "../../../swarm/system-profile-guards.js";
import { ProjectResourceSettingsStore } from "../../../swarm/project-resource-settings.js";
import { ProjectWorkspaceResolver } from "../../../swarm/project-workspace-resolver.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson,
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SPECIALISTS_ENDPOINT_PATH = "/api/settings/specialists";
const SPECIALIST_TIERS_ENDPOINT_PATH = "/api/settings/specialists/tiers";
const SETTINGS_MODELS_ENDPOINT_PATH = "/api/settings/models";
const ROSTER_PROMPT_SUFFIX = "/roster-prompt";
const METHODS = "GET, PUT, DELETE, OPTIONS";
const ENABLED_METHODS = "GET, PUT, OPTIONS";
const SETTINGS_MODELS_METHODS = "GET, OPTIONS";

export function createSpecialistRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: SETTINGS_MODELS_METHODS,
      matches: (pathname) => pathname === SETTINGS_MODELS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleSettingsModelsRequest(swarmManager, request, response, requestUrl);
      },
    },
    {
      methods: ENABLED_METHODS,
      matches: (pathname) => pathname === SPECIALIST_TIERS_ENDPOINT_PATH,
      handle: async (request, response) => {
        await handleSpecialistTiersRequest(swarmManager, broadcastEvent, request, response);
      },
    },
    {
      methods: METHODS,
      matches: (pathname) =>
        pathname === SPECIALISTS_ENDPOINT_PATH ||
        pathname.startsWith(`${SPECIALISTS_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSpecialistRequest(swarmManager, broadcastEvent, request, response, requestUrl);
      },
    },
  ];
}

async function handleSettingsModelsRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
    await swarmManager.reloadModelCatalogOverridesAndProjection();
    const credentialPoolService = typeof swarmManager.getCredentialPoolService === "function"
      ? swarmManager.getCredentialPoolService()
      : undefined;
    const providerAvailability = await getManagedModelProviderCredentialAvailability(
      swarmManager.getConfig(),
      { credentialPoolService }
    );
    const models = [
      ...modelCatalogService.getSpecialistModelPresetInfoList(),
      ...buildOpenRouterSelectableModels(),
    ].filter((model) => {
      // Providers without a managed credential check stay visible.
      const isAvailable = providerAvailability.get(model.provider);
      return isAvailable ?? true;
    });

    sendJson(response, 200, { models });
    return;
  }

  response.setHeader("Allow", SETTINGS_MODELS_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function buildOpenRouterSelectableModels(): ModelPresetInfo[] {
  return modelCatalogService.getOpenRouterModels().map((model) => ({
    presetId: `openrouter:${model.modelId}`,
    displayName: model.displayName,
    provider: "openrouter",
    modelId: model.modelId,
    defaultReasoningLevel: model.supportsReasoning ? "medium" : "none",
    supportedReasoningLevels: normalizeReasoningLevels(model.supportedReasoningLevels, model.supportsReasoning),
  }));
}

function normalizeReasoningLevels(
  levels: readonly string[],
  supportsReasoning: boolean,
): ManagerReasoningLevel[] {
  const normalized = levels.filter((level): level is ManagerReasoningLevel =>
    MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel),
  );

  if (normalized.length > 0) {
    return normalized;
  }

  return supportsReasoning ? ["none", "low", "medium", "high"] : ["none"];
}

async function handleSpecialistTiersRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, ENABLED_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, ENABLED_METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;

  if (request.method === "GET") {
    try {
      sendJson(response, 200, { tiers: await resolveTierConfigs(dataDir) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  if (request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const tiers = parseTierConfigBody(body);
      const saved = await saveTierConfigs(dataDir, tiers);
      invalidateSpecialistCache();
      await notifyGlobalSpecialistMutation({ swarmManager, broadcastEvent, dataDir });
      sendJson(response, 200, { tiers: saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
    }
    return;
  }

  response.setHeader("Allow", ENABLED_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSpecialistRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;
  const profileId = requestUrl.searchParams.get("profileId")?.trim() || undefined;
  const sessionAgentId = requestUrl.searchParams.get("sessionAgentId")?.trim() || undefined;
  let targetSpace: SpecialistTargetSpace;
  try {
    targetSpace = parseTargetSpaceQuery(requestUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 400, { error: message });
    return;
  }
  const relativePath = requestUrl.pathname.slice(SPECIALISTS_ENDPOINT_PATH.length);

  // Tombstone the removed toggle route so older clients cannot accidentally create
  // a custom specialist named "enabled" through the generic handle route.
  if (relativePath === "/enabled") {
    sendJson(response, 410, {
      error: "The specialist enable/disable toggle was removed; delegation is always available.",
    });
    return;
  }

  // GET /api/settings/specialists/template — returns worker.md content (no profileId required)
  if (request.method === "GET" && relativePath === "/template") {
    try {
      const template = await getWorkerTemplate();
      sendJson(response, 200, { template });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  const profiles = swarmManager.listProfiles();
  const targetProfile = profileId
    ? profiles.find((profile) => profile.profileId === profileId)
    : undefined;

  // If profileId is provided, validate it exists
  if (profileId && !targetProfile) {
    sendJson(response, 404, { error: `Unknown profile: ${profileId}` });
    return;
  }

  // --- Global (no profileId) routes ---

  if (!profileId) {
    // GET /api/settings/specialists — returns shared/global specialists only
    if (request.method === "GET" && relativePath === "") {
      try {
        const specialists = await resolveSharedRoster(dataDir, targetSpace);
        const sanitized = specialists.map(({ sourcePath: _, ...rest }) => rest);
        sendJson(response, 200, { specialists: sanitized });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { error: message });
      }
      return;
    }

    let handle: string | null;
    try {
      handle = parseHandleFromRelativePath(relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
      return;
    }

    if (!handle) {
      sendJson(response, 400, { error: "Missing specialist handle in URL path" });
      return;
    }

    // PUT /api/settings/specialists/<handle> — saves to shared dir
    if (request.method === "PUT") {
      try {
        const body = await readJsonBody(request);
        const data = parseSaveSpecialistBody(body, targetSpace);
        await saveSharedSpecialist(dataDir, handle, data);
        await notifyGlobalSpecialistMutation({ swarmManager, broadcastEvent, dataDir });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, getErrorStatusCode(message), { error: message });
      }
      return;
    }

    // DELETE /api/settings/specialists/<handle> — deletes from shared dir (rejects builtins)
    if (request.method === "DELETE") {
      try {
        await deleteSharedSpecialist(dataDir, handle);
        await notifyGlobalSpecialistMutation({ swarmManager, broadcastEvent, dataDir });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, getErrorStatusCode(message), { error: message });
      }
      return;
    }

    response.setHeader("Allow", METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  // --- Profile-scoped routes (profileId present) ---

  // GET /api/settings/specialists/roster-prompt?profileId=X
  if (request.method === "GET" && relativePath === ROSTER_PROMPT_SUFFIX) {
    try {
      const workspaceSpecialistsDir = await resolveWorkspaceSpecialistsDir(swarmManager, profileId, sessionAgentId, targetSpace);
      const roster = await resolveProfileRoster(profileId, dataDir, workspaceSpecialistsDir, targetSpace);
      const markdown = generateRosterBlock(roster);
      sendJson(response, 200, { markdown });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  // GET /api/settings/specialists?profileId=X
  if (request.method === "GET" && relativePath === "") {
    try {
      const workspaceSpecialistsDir = await resolveWorkspaceSpecialistsDir(swarmManager, profileId, sessionAgentId, targetSpace);
      const specialists = await resolveProfileRoster(profileId, dataDir, workspaceSpecialistsDir, targetSpace);
      // Strip sourcePath — it's a server filesystem detail the UI doesn't need.
      const sanitized = specialists.map(({ sourcePath: _, ...rest }) => rest);
      sendJson(response, 200, { specialists: sanitized });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  let handle: string | null;
  try {
    handle = parseHandleFromRelativePath(relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, getErrorStatusCode(message), { error: message });
    return;
  }

  if (!handle) {
    sendJson(response, 400, { error: "Missing specialist handle in URL path" });
    return;
  }

  // PUT /api/settings/specialists/<handle>?profileId=X
  if (request.method === "PUT") {
    try {
      requireNonSystemProfile(profileId, profiles);
      const body = await readJsonBody(request);
      const data = parseSaveSpecialistBody(body, targetSpace);
      await saveProfileSpecialist(dataDir, profileId, handle, data);
      await notifySpecialistRosterMutation({
        swarmManager,
        broadcastEvent,
        dataDir,
        profileId,
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
    }
    return;
  }

  // DELETE /api/settings/specialists/<handle>?profileId=X
  if (request.method === "DELETE") {
    try {
      requireNonSystemProfile(profileId, profiles);
      await deleteProfileSpecialist(dataDir, profileId, handle);
      await notifySpecialistRosterMutation({
        swarmManager,
        broadcastEvent,
        dataDir,
        profileId,
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
    }
    return;
  }

  response.setHeader("Allow", METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function resolveProfileRoster(
  profileId: string,
  dataDir: string,
  workspaceSpecialistsDir: string | undefined,
  targetSpace: SpecialistTargetSpace,
) {
  return workspaceSpecialistsDir
    ? resolveWorkspaceRoster(profileId, dataDir, workspaceSpecialistsDir, targetSpace)
    : resolveRoster(profileId, dataDir, targetSpace);
}

async function resolveWorkspaceSpecialistsDir(
  swarmManager: SwarmManager,
  profileId: string,
  sessionAgentId: string | undefined,
  targetSpace: SpecialistTargetSpace,
): Promise<string | undefined> {
  if (!sessionAgentId || targetSpace === "collaboration") {
    return undefined;
  }
  const session = swarmManager.listAgents().find((agent) => agent.agentId === sessionAgentId);
  if (!session || session.role !== "manager" || session.profileId !== profileId) {
    return undefined;
  }
  const resolution = await new ProjectWorkspaceResolver({
    dataDir: swarmManager.getConfig().paths.dataDir,
    settingsStore: new ProjectResourceSettingsStore(swarmManager.getConfig().paths.dataDir),
  }).resolvePassive({
    profileId,
    sessionAgentId: session.agentId,
    cwd: session.cwd,
  });
  return resolution.repoRootResources.specialistsDir;
}

async function notifySpecialistRosterMutation(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
  dataDir: string;
  profileId: string;
}): Promise<void> {
  const { swarmManager, broadcastEvent, dataDir, profileId } = options;
  const [builderRoster, collaborationRoster] = await Promise.all([
    resolveRoster(profileId, dataDir, "builder"),
    resolveRoster(profileId, dataDir, "collaboration"),
  ]);
  const specialistIds = [...new Set([...builderRoster, ...collaborationRoster].map((entry) => entry.specialistId))];

  broadcastEvent({
    type: "specialist_roster_changed",
    profileId,
    specialistIds,
    updatedAt: new Date().toISOString(),
  });

  await swarmManager.notifySpecialistRosterChanged(profileId);
}

/** Notify all profiles when a shared/global specialist changes. */
async function notifyGlobalSpecialistMutation(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
  dataDir: string;
}): Promise<void> {
  const { swarmManager, broadcastEvent, dataDir } = options;
  const profiles = swarmManager.listProfiles();

  for (const profile of profiles) {
    if (profile.profileId === "_collaboration") {
      continue;
    }

    await notifySpecialistRosterMutation({
      swarmManager,
      broadcastEvent,
      dataDir,
      profileId: profile.profileId,
    });
  }

  const collaborationSessions = swarmManager.listAgents().filter(
    (agent) => agent.role === "manager" && agent.profileId === "_collaboration" && agent.sessionSurface === "collab",
  );
  if (collaborationSessions.length === 0) {
    return;
  }

  const collaborationRoster = await resolveRoster("_collaboration", dataDir, "collaboration");
  const specialistIds = [...new Set(collaborationRoster.map((entry) => entry.specialistId))];
  broadcastEvent({
    type: "specialist_roster_changed",
    profileId: "_collaboration",
    specialistIds,
    updatedAt: new Date().toISOString(),
  });

  for (const session of collaborationSessions) {
    await swarmManager.notifySpecialistRosterChanged("_collaboration", {
      sessionAgentId: session.agentId,
    });
  }
}

function parseTargetSpaceQuery(requestUrl: URL): SpecialistTargetSpace {
  const raw = requestUrl.searchParams.get("targetSpace")?.trim();
  if (raw === undefined || raw.length === 0) {
    return "builder";
  }
  if (raw === "builder" || raw === "collaboration") {
    return raw;
  }
  throw new Error("targetSpace query must be builder or collaboration");
}

function parseSaveSpecialistBody(
  value: unknown,
  fallbackTargetSpace: SpecialistTargetSpace,
): SaveSpecialistRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const obj = value as Record<string, unknown>;

  return {
    displayName: readRequiredStringField(obj, "displayName"),
    color: readRequiredStringField(obj, "color"),
    enabled: readRequiredBooleanField(obj, "enabled"),
    whenToUse: readRequiredStringField(obj, "whenToUse"),
    modelId: readOptionalStringField(obj, "modelId"),
    provider: readOptionalStringField(obj, "provider"),
    reasoningLevel: readOptionalStringField(obj, "reasoningLevel"),
    fallbackModelId: readOptionalStringField(obj, "fallbackModelId"),
    fallbackProvider: readOptionalStringField(obj, "fallbackProvider"),
    fallbackReasoningLevel: readOptionalStringField(obj, "fallbackReasoningLevel"),
    pinned: readOptionalBooleanField(obj, "pinned"),
    webSearch: readOptionalBooleanField(obj, "webSearch"),
    targetSpace: readOptionalTargetSpaceField(obj, "targetSpace") ?? [fallbackTargetSpace],
    defaultTier: readOptionalEffortTierField(obj, "defaultTier"),
    promptBody: readRequiredStringField(obj, "promptBody"),
  };
}

function readOptionalEffortTierField(obj: Record<string, unknown>, key: string): TierConfig["tier"] | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (value !== "light" && value !== "fast" && value !== "standard" && value !== "deep" && value !== "max") {
    throw new Error(`${key} must be one of light|fast|standard|deep|max`);
  }
  return value;
}

function parseTierConfigBody(value: unknown): TierConfig[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const tiers = (value as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) {
    throw new Error("tiers must be an array");
  }

  return tiers.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`tiers[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    return {
      tier: readRequiredStringField(obj, "tier") as TierConfig["tier"],
      displayName: readRequiredStringField(obj, "displayName"),
      description: readRequiredStringField(obj, "description"),
      color: readRequiredStringField(obj, "color"),
      modelId: readRequiredStringField(obj, "modelId"),
      provider: readRequiredStringField(obj, "provider"),
      reasoningLevel: readOptionalStringField(obj, "reasoningLevel"),
      fallbackModelId: readOptionalStringField(obj, "fallbackModelId"),
      fallbackProvider: readOptionalStringField(obj, "fallbackProvider"),
      fallbackReasoningLevel: readOptionalStringField(obj, "fallbackReasoningLevel"),
    };
  });
}

function readRequiredStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return value;
}

function readOptionalStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }

  return value;
}

function readRequiredBooleanField(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }

  return value;
}

function readOptionalBooleanField(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided`);
  }

  return value;
}

function readOptionalTargetSpaceField(
  obj: Record<string, unknown>,
  key: string,
): SpecialistTargetSpace[] | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array when provided`);
  }

  const spaces: SpecialistTargetSpace[] = [];
  for (const entry of value) {
    if (entry !== "builder" && entry !== "collaboration") {
      throw new Error(`${key} entries must be builder or collaboration`);
    }
    if (!spaces.includes(entry)) {
      spaces.push(entry);
    }
  }

  return spaces;
}

function parseHandleFromRelativePath(relativePath: string): string | null {
  if (!relativePath.startsWith("/")) {
    return null;
  }

  const rawHandle = relativePath.slice(1);
  if (!rawHandle) {
    return null;
  }

  if (rawHandle.includes("/")) {
    throw new Error("Malformed URL path");
  }

  try {
    return decodeURIComponent(rawHandle);
  } catch {
    throw new Error("Malformed URL path");
  }
}

function getErrorStatusCode(message: string): number {
  if (message === "Malformed URL path") {
    return 400;
  }

  if (message.startsWith("Unknown specialist:")) {
    return 404;
  }

  if (message.startsWith("Cannot delete builtin specialist:")) {
    return 409;
  }

  if (message === SYSTEM_PROFILE_MUTATION_ERROR) {
    return 403;
  }

  if (
    message.includes("Request body") ||
    message.includes("is required") ||
    message.includes("must be") ||
    message.includes("Invalid")
  ) {
    return 400;
  }

  return 500;
}
