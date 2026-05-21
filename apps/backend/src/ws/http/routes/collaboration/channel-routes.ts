import type { CollaborationChannelPromptPreviewResponse, CollaborationSkillSelectionInput, PromptPreviewResponse } from "@forge/protocol";
import { parseSwarmReasoningLevel } from "../../../../swarm/model-presets.js";
import {
  deleteChannelSpecialist,
  generateRosterBlock,
  resolveCollaborationChannelRoster,
  saveChannelSpecialist,
  type SaveSpecialistRequest,
} from "../../../../swarm/specialists/specialist-registry.js";
import type { SwarmConfig, SwarmReasoningLevel } from "../../../../swarm/types.js";
import {
  attachEffectiveChannelModelSettings,
  resolveRequestedChannelModelSettings,
} from "../../../../collaboration/channel-service.js";
import type { CollaborationReadinessRequestService } from "../../../../collaboration/readiness-service.js";
import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices, CollaborationRouteSwarmManager } from "./route-services.js";
import {
  expectObjectBody,
  mapCollaborationChannelErrorStatus,
  parseArchivedFilter,
  parseSinglePathId,
  redactCollaborationPromptPreview,
  requireAdminRequestContext,
  requireAuthenticatedRequestContext,
  requireDefaultWorkspace,
  resolveDefaultWorkspace,
} from "./route-helpers.js";

const COLLABORATION_CHANNELS_ENDPOINT_PATH = "/api/collaboration/channels";
const COLLABORATION_CHANNELS_METHODS = "GET, POST, OPTIONS";
const COLLABORATION_CHANNEL_ENDPOINT_PATTERN = /^\/api\/collaboration\/channels\/([^/]+)$/;
const COLLABORATION_CHANNEL_METHODS = "GET, PATCH, OPTIONS";
const COLLABORATION_CHANNEL_PROMPT_PREVIEW_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/prompt-preview$/;
const COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS = "GET, OPTIONS";
const COLLABORATION_CHANNEL_SPECIALISTS_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/specialists$/;
const COLLABORATION_CHANNEL_SPECIALISTS_METHODS = "GET, OPTIONS";
const COLLABORATION_CHANNEL_SPECIALIST_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/specialists\/([^/]+)$/;
const COLLABORATION_CHANNEL_SPECIALIST_METHODS = "PUT, DELETE, OPTIONS";
const COLLABORATION_CHANNEL_SPECIALISTS_ROSTER_PROMPT_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/specialists\/roster-prompt$/;
const COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/specialists\/selection$/;
const COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_METHODS = "PUT, OPTIONS";
const COLLABORATION_CHANNEL_SKILLS_SELECTION_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/skills\/selection$/;
const COLLABORATION_CHANNEL_SKILLS_SELECTION_METHODS = "PUT, OPTIONS";
const COLLABORATION_CHANNEL_ARCHIVE_ENDPOINT_PATTERN =
  /^\/api\/collaboration\/channels\/([^/]+)\/archive$/;
const COLLABORATION_CHANNEL_ARCHIVE_METHODS = "POST, OPTIONS";
const COLLABORATION_CHANNELS_REORDER_ENDPOINT_PATH = "/api/collaboration/channels/reorder";
const COLLABORATION_CHANNELS_REORDER_METHODS = "POST, OPTIONS";

export function createCollaborationChannelRoutes(options: {
  config: SwarmConfig;
  getServices: () => Promise<CollaborationRouteServices>;
  readinessService?: CollaborationReadinessRequestService;
  swarmManager?: CollaborationRouteSwarmManager;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_CHANNELS_METHODS,
      matches: (pathname) => pathname === COLLABORATION_CHANNELS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNELS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CHANNELS_METHODS);

        if (request.method !== "GET" && request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_CHANNELS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        try {
          if (request.method === "GET") {
            const authContext = await requireAuthenticatedRequestContext(request, response, options.getServices);
            if (!authContext) {
              return;
            }

            void authContext;

            const workspace = await resolveDefaultWorkspace(options.getServices, options.readinessService);
            if (!workspace) {
              sendJson(response, 200, { channels: [] });
              return;
            }

            const { channelService } = await options.getServices();
            sendJson(response, 200, {
              channels: channelService
                .listChannels({
                  workspaceId: workspace.workspaceId,
                  archived: parseArchivedFilter(requestUrl.searchParams.get("archived")),
                })
                .map((channel) => attachEffectiveChannelModelSettings(options.swarmManager, channel)),
            });
            return;
          }

          const adminContext = await requireAdminRequestContext(request, response, options.getServices);
          if (!adminContext) {
            return;
          }

          const workspace = await requireDefaultWorkspace(response, options.getServices, options.readinessService);
          if (!workspace) {
            return;
          }

          const { channelService, broadcasts } = await options.getServices();
          const channel = await channelService.createChannel({
            ...parseCreateChannelBody(await readJsonBody(request)),
            workspaceId: workspace.workspaceId,
            createdByUserId: adminContext.userId,
          });
          broadcasts?.broadcastChannelCreated(channel);
          sendJson(response, 200, { ok: true, channel });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration channels",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNELS_REORDER_METHODS,
      matches: (pathname) => pathname === COLLABORATION_CHANNELS_REORDER_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNELS_REORDER_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CHANNELS_REORDER_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_CHANNELS_REORDER_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        void adminContext;

        try {
          const workspace = await requireDefaultWorkspace(response, options.getServices, options.readinessService);
          if (!workspace) {
            return;
          }

          const body = expectObjectBody(await readJsonBody(request));
          if (!Array.isArray(body.channelIds)) {
            throw new Error("channelIds must be an array");
          }

          const { channelService, broadcasts } = await options.getServices();
          const channels = channelService.reorderChannels({
            workspaceId: workspace.workspaceId,
            channelIds: body.channelIds.map((value) => {
              if (typeof value !== "string") {
                throw new Error("channelIds must contain only strings");
              }
              return value;
            }),
          });
          broadcasts?.broadcastChannelReordered(channels);
          sendJson(response, 200, { ok: true, channels });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to reorder collaboration channels",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_METHODS);

        if (request.method !== "GET" && request.method !== "PATCH") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }

        try {
          const { channelService, promptOverlayService, broadcasts } = await options.getServices();

          if (request.method === "GET") {
            const authContext = await requireAuthenticatedRequestContext(request, response, options.getServices);
            if (!authContext) {
              return;
            }

            const channel = attachEffectiveChannelModelSettings(
              options.swarmManager,
              channelService.getChannel(channelId),
            );
            sendJson(response, 200, {
              channel:
                authContext.role === "admin"
                  ? await attachChannelAdminSettings(promptOverlayService, options.swarmManager, channel)
                  : channel,
            });
            return;
          }

          const adminContext = await requireAdminRequestContext(request, response, options.getServices);
          if (!adminContext) {
            return;
          }

          void adminContext;

          const existingChannel = attachEffectiveChannelModelSettings(
            options.swarmManager,
            channelService.getChannel(channelId),
          );
          const update = parseUpdateChannelBody(await readJsonBody(request));
          const nextModelSettings =
            update.modelId !== undefined || update.reasoningLevel !== undefined
              ? resolveRequestedChannelModelSettings(existingChannel, update)
              : null;
          if (nextModelSettings) {
            const updateCollaborationModel = options.swarmManager?.updateCollaborationSessionModel
              ?? options.swarmManager?.updateManagerModel;
            if (!updateCollaborationModel) {
              throw new Error("Collaboration channel model updates require swarm manager support");
            }

            const modelChanged = nextModelSettings.modelId !== existingChannel.modelId;
            const reasoningChanged = nextModelSettings.reasoningLevel !== existingChannel.reasoningLevel;
            if (modelChanged || reasoningChanged) {
              await updateCollaborationModel.call(
                options.swarmManager,
                existingChannel.sessionAgentId,
                nextModelSettings.modelId,
                nextModelSettings.reasoningLevel,
              );
            }
          }
          const channel = channelService.updateChannel(channelId, {
            ...update,
            ...(nextModelSettings
              ? {
                  modelId: nextModelSettings.modelId,
                  reasoningLevel: nextModelSettings.reasoningLevel,
                }
              : {}),
          });
          if (update.promptOverlay !== undefined) {
            await promptOverlayService.setPromptOverlay(channel.channelId, update.promptOverlay);
            await recycleCollaborationBackingSessionRuntime(options.swarmManager, channel.sessionAgentId);
          }
          if (update.activeSelectedSpecialistHandles !== undefined) {
            await notifyChannelSpecialistMutation(options.swarmManager, channel.sessionAgentId);
          }
          if (update.activeSkillSelection !== undefined) {
            await notifyChannelSkillSelectionMutation(options.swarmManager, channel.sessionAgentId);
          }
          broadcasts?.broadcastChannelUpdated(
            attachEffectiveChannelModelSettings(options.swarmManager, channelService.getChannel(channel.channelId)),
          );
          sendJson(response, 200, {
            ok: true,
            channel: await attachChannelAdminSettings(promptOverlayService, options.swarmManager, channel),
          });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration channel",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_SPECIALISTS_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_SPECIALISTS_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALISTS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }
        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALISTS_METHODS);
        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_SPECIALISTS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_SPECIALISTS_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }
        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }
        void adminContext;
        try {
          const { channelService } = await options.getServices();
          const channel = channelService.getChannel(channelId);
          const roster = await resolveCollaborationChannelRoster(options.config.paths.dataDir, {
            sessionAgentId: channel.sessionAgentId,
            selectedGlobalHandles: channel.activeSelectedSpecialistHandles,
          });
          const specialists = roster.map(({ sourcePath: _, ...rest }) => rest);
          sendJson(response, 200, {
            channelId: channel.channelId,
            specialists,
            selectedGlobalSpecialistHandles: channel.activeSelectedSpecialistHandles,
            missingSelectedSpecialistHandles: channel.missingSelectedSpecialistHandles ?? [],
          });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to list channel specialists",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_SPECIALISTS_ROSTER_PROMPT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }
        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);
        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_SPECIALISTS_ROSTER_PROMPT_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }
        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }
        void adminContext;
        try {
          const { channelService } = await options.getServices();
          const channel = channelService.getChannel(channelId);
          const roster = await resolveCollaborationChannelRoster(options.config.paths.dataDir, {
            sessionAgentId: channel.sessionAgentId,
            selectedGlobalHandles: channel.activeSelectedSpecialistHandles,
          });
          sendJson(response, 200, { markdown: generateRosterBlock(roster) });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to render channel specialist roster",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }
        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_METHODS);
        if (request.method !== "PUT") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }
        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }
        void adminContext;
        try {
          const body = expectObjectBody(await readJsonBody(request));
          const selectedGlobalSpecialistHandles = parseHandleArray(
            body.selectedGlobalSpecialistHandles,
            "selectedGlobalSpecialistHandles",
          );
          const { channelService, broadcasts } = await options.getServices();
          const channel = channelService.updateChannel(channelId, {
            activeSelectedSpecialistHandles: selectedGlobalSpecialistHandles,
          });
          await notifyChannelSpecialistMutation(options.swarmManager, channel.sessionAgentId);
          broadcasts?.broadcastChannelUpdated(attachEffectiveChannelModelSettings(options.swarmManager, channel));
          sendJson(response, 200, { ok: true, channel });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to update channel specialist selection",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_SKILLS_SELECTION_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_SKILLS_SELECTION_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SKILLS_SELECTION_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }
        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SKILLS_SELECTION_METHODS);
        if (request.method !== "PUT") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_SKILLS_SELECTION_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_SKILLS_SELECTION_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }
        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }
        void adminContext;
        try {
          const body = expectObjectBody(await readJsonBody(request));
          const activeSkillSelection = parseSkillSelectionInput(
            body.activeSkillSelection ?? body,
            body.activeSkillSelection !== undefined ? "activeSkillSelection" : "skillSelection",
          );
          const { channelService, broadcasts } = await options.getServices();
          const channel = channelService.updateChannel(channelId, { activeSkillSelection });
          await notifyChannelSkillSelectionMutation(options.swarmManager, channel.sessionAgentId);
          broadcasts?.broadcastChannelUpdated(attachEffectiveChannelModelSettings(options.swarmManager, channel));
          sendJson(response, 200, { ok: true, channel });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to update channel skill selection",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_SPECIALIST_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_SPECIALIST_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALIST_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }
        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_SPECIALIST_METHODS);
        if (request.method !== "PUT" && request.method !== "DELETE") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_SPECIALIST_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const match = COLLABORATION_CHANNEL_SPECIALIST_ENDPOINT_PATTERN.exec(requestUrl.pathname);
        const channelId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
        const handle = match?.[2] ? decodeURIComponent(match[2]) : undefined;
        if (!channelId || !handle || handle === "selection" || handle === "roster-prompt") {
          sendJson(response, 400, { error: "Missing channelId or specialist handle" });
          return;
        }
        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }
        void adminContext;
        try {
          const { channelService, broadcasts } = await options.getServices();
          const channel = channelService.getChannel(channelId);
          if (request.method === "PUT") {
            const data = parseSaveChannelSpecialistBody(await readJsonBody(request));
            await saveChannelSpecialist(options.config.paths.dataDir, channel.sessionAgentId, handle, data);
          } else {
            await deleteChannelSpecialist(options.config.paths.dataDir, channel.sessionAgentId, handle);
          }
          await notifyChannelSpecialistMutation(options.swarmManager, channel.sessionAgentId);
          broadcasts?.broadcastChannelUpdated(attachEffectiveChannelModelSettings(options.swarmManager, channelService.getChannel(channel.channelId)));
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage channel specialist",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_PROMPT_PREVIEW_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);

        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_PROMPT_PREVIEW_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_PROMPT_PREVIEW_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }

        const authContext = await requireAuthenticatedRequestContext(request, response, options.getServices);
        if (!authContext) {
          return;
        }

        void authContext;

        if (!options.swarmManager?.previewManagerSystemPromptForAgent) {
          sendJson(response, 501, { error: "Prompt preview not available" });
          return;
        }

        try {
          const { channelService } = await options.getServices();
          const channel = channelService.getChannel(channelId);
          const preview = await options.swarmManager.previewManagerSystemPromptForAgent(channel.sessionAgentId) as PromptPreviewResponse;
          const redacted = redactCollaborationPromptPreview(preview, options.config);
          const payload: CollaborationChannelPromptPreviewResponse = {
            channelId: channel.channelId,
            sections: redacted.sections,
            redacted: true,
          };
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to load collaboration prompt preview",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CHANNEL_ARCHIVE_METHODS,
      matches: (pathname) => COLLABORATION_CHANNEL_ARCHIVE_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CHANNEL_ARCHIVE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CHANNEL_ARCHIVE_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_CHANNEL_ARCHIVE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const channelId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CHANNEL_ARCHIVE_ENDPOINT_PATTERN);
        if (!channelId) {
          sendJson(response, 400, { error: "Missing channelId" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        try {
          const { channelService, broadcasts } = await options.getServices();
          const channel = await channelService.archiveChannel(channelId, adminContext.userId);
          broadcasts?.broadcastChannelArchived(channel.workspaceId, channel.channelId);
          sendJson(response, 200, { ok: true, channel });
        } catch (error) {
          sendJson(response, mapCollaborationChannelErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to archive collaboration channel",
          });
        }
      },
    },
  ];
}

async function attachPromptOverlay(
  promptOverlayService: CollaborationRouteServices["promptOverlayService"],
  channel: ReturnType<CollaborationRouteServices["channelService"]["getChannel"]>,
) {
  const promptOverlay = await promptOverlayService.getPromptOverlay(channel.channelId);
  return promptOverlay ? { ...channel, promptOverlay } : channel;
}

async function attachChannelAdminSettings(
  promptOverlayService: CollaborationRouteServices["promptOverlayService"],
  swarmManager: CollaborationRouteSwarmManager | undefined,
  channel: ReturnType<CollaborationRouteServices["channelService"]["getChannel"]>,
) {
  return attachEffectiveChannelModelSettings(
    swarmManager,
    await attachPromptOverlay(promptOverlayService, channel),
  );
}

async function notifyChannelSpecialistMutation(
  swarmManager: CollaborationRouteSwarmManager | undefined,
  backingSessionAgentId: string,
): Promise<void> {
  const specialistRosterManager = swarmManager as (
    CollaborationRouteSwarmManager & {
      notifySpecialistRosterChanged?: (
        profileId: string,
        options?: { sessionAgentId?: string },
      ) => Promise<void>;
    }
  ) | undefined;
  if (specialistRosterManager?.notifySpecialistRosterChanged) {
    await specialistRosterManager.notifySpecialistRosterChanged("_collaboration", {
      sessionAgentId: backingSessionAgentId,
    });
    return;
  }

  await recycleCollaborationBackingSessionRuntime(swarmManager, backingSessionAgentId);
}

async function notifyChannelSkillSelectionMutation(
  swarmManager: CollaborationRouteSwarmManager | undefined,
  backingSessionAgentId: string,
): Promise<void> {
  await recycleCollaborationBackingSessionRuntime(swarmManager, backingSessionAgentId);
}

async function recycleCollaborationBackingSessionRuntime(
  swarmManager: CollaborationRouteSwarmManager | undefined,
  backingSessionAgentId: string,
): Promise<void> {
  const runtimeRecycleManager = swarmManager as (
    CollaborationRouteSwarmManager & {
      applyManagerRuntimeRecyclePolicy?: (
        agentId: string,
        reason: "prompt_mode_change",
      ) => Promise<"recycled" | "deferred" | "none">;
    }
  ) | undefined;
  if (!runtimeRecycleManager?.applyManagerRuntimeRecyclePolicy) {
    return;
  }

  await runtimeRecycleManager.applyManagerRuntimeRecyclePolicy(backingSessionAgentId, "prompt_mode_change");
}

function parseSaveChannelSpecialistBody(body: unknown): SaveSpecialistRequest {
  const input = expectObjectBody(body);
  return {
    displayName: requireStringField(input.displayName, "displayName"),
    color: requireStringField(input.color, "color"),
    enabled: requireBooleanField(input.enabled, "enabled"),
    whenToUse: requireStringField(input.whenToUse, "whenToUse"),
    modelId: requireStringField(input.modelId, "modelId"),
    provider: input.provider !== undefined ? requireStringField(input.provider, "provider") : undefined,
    reasoningLevel: input.reasoningLevel !== undefined ? requireStringField(input.reasoningLevel, "reasoningLevel") : undefined,
    fallbackModelId: input.fallbackModelId !== undefined ? requireStringField(input.fallbackModelId, "fallbackModelId") : undefined,
    fallbackProvider: input.fallbackProvider !== undefined ? requireStringField(input.fallbackProvider, "fallbackProvider") : undefined,
    fallbackReasoningLevel: input.fallbackReasoningLevel !== undefined
      ? requireStringField(input.fallbackReasoningLevel, "fallbackReasoningLevel")
      : undefined,
    pinned: input.pinned !== undefined ? requireBooleanField(input.pinned, "pinned") : undefined,
    webSearch: input.webSearch !== undefined ? requireBooleanField(input.webSearch, "webSearch") : undefined,
    targetSpace: ["collaboration"],
    promptBody: requireStringField(input.promptBody, "promptBody"),
  };
}

function parseCreateChannelBody(body: unknown): {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  aiEnabled?: boolean;
  activeSelectedSpecialistHandles?: string[];
  activeSkillSelection?: CollaborationSkillSelectionInput;
} {
  const input = expectObjectBody(body);
  const name = requireStringField(input.name, "name");
  return {
    name,
    ...(input.categoryId !== undefined
      ? { categoryId: parseNullableStringField(input.categoryId, "categoryId") }
      : {}),
    ...(input.description !== undefined
      ? { description: parseNullableStringField(input.description, "description") }
      : {}),
    ...(input.aiEnabled !== undefined
      ? { aiEnabled: requireBooleanField(input.aiEnabled, "aiEnabled") }
      : {}),
    ...(input.selectedGlobalSpecialistHandles !== undefined || input.activeSelectedSpecialistHandles !== undefined
      ? {
          activeSelectedSpecialistHandles: parseHandleArray(
            input.selectedGlobalSpecialistHandles ?? input.activeSelectedSpecialistHandles,
            input.selectedGlobalSpecialistHandles !== undefined
              ? "selectedGlobalSpecialistHandles"
              : "activeSelectedSpecialistHandles",
          ),
        }
      : {}),
    ...(input.activeSkillSelection !== undefined
      ? { activeSkillSelection: parseSkillSelectionInput(input.activeSkillSelection, "activeSkillSelection") }
      : {}),
  };
}

function parseUpdateChannelBody(body: unknown): {
  name?: string;
  categoryId?: string | null;
  description?: string | null;
  aiEnabled?: boolean;
  modelId?: string;
  reasoningLevel?: SwarmReasoningLevel | null;
  promptOverlay?: string | null;
  position?: number;
  activeSelectedSpecialistHandles?: string[];
  activeSkillSelection?: CollaborationSkillSelectionInput;
} {
  const input = expectObjectBody(body);
  const parsed: {
    name?: string;
    categoryId?: string | null;
    description?: string | null;
    aiEnabled?: boolean;
    modelId?: string;
    reasoningLevel?: SwarmReasoningLevel | null;
    promptOverlay?: string | null;
    position?: number;
    activeSelectedSpecialistHandles?: string[];
    activeSkillSelection?: CollaborationSkillSelectionInput;
  } = {};

  if (input.name !== undefined) {
    parsed.name = requireStringField(input.name, "name");
  }

  if (input.categoryId !== undefined) {
    parsed.categoryId = parseNullableStringField(input.categoryId, "categoryId");
  }

  if (input.description !== undefined) {
    parsed.description = parseNullableStringField(input.description, "description");
  }

  if (input.aiEnabled !== undefined) {
    parsed.aiEnabled = requireBooleanField(input.aiEnabled, "aiEnabled");
  }

  if (input.modelId !== undefined) {
    parsed.modelId = requireStringField(input.modelId, "modelId");
  }

  if (input.reasoningLevel !== undefined) {
    parsed.reasoningLevel =
      input.reasoningLevel === null
        ? null
        : parseSwarmReasoningLevel(input.reasoningLevel, "reasoningLevel");
  }

  if (input.promptOverlay !== undefined) {
    parsed.promptOverlay = parseNullableStringField(input.promptOverlay, "promptOverlay");
  }

  if (input.position !== undefined) {
    if (typeof input.position !== "number" || !Number.isInteger(input.position) || input.position < 0) {
      throw new Error("position must be a non-negative integer when provided");
    }
    parsed.position = input.position;
  }

  if (input.selectedGlobalSpecialistHandles !== undefined || input.activeSelectedSpecialistHandles !== undefined) {
    parsed.activeSelectedSpecialistHandles = parseHandleArray(
      input.selectedGlobalSpecialistHandles ?? input.activeSelectedSpecialistHandles,
      input.selectedGlobalSpecialistHandles !== undefined
        ? "selectedGlobalSpecialistHandles"
        : "activeSelectedSpecialistHandles",
    );
  }

  if (input.activeSkillSelection !== undefined) {
    parsed.activeSkillSelection = parseSkillSelectionInput(input.activeSkillSelection, "activeSkillSelection");
  }

  return parsed;
}

function parseHandleArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array when provided`);
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${fieldName} must contain only non-empty strings`);
    }
    return entry.trim();
  });
}

function parseSkillSelectionInput(value: unknown, fieldName: string): CollaborationSkillSelectionInput {
  const input = expectObjectBody(value);
  if (input.mode === "all") {
    return { mode: "all" };
  }

  if (input.mode !== "custom") {
    throw new Error(`${fieldName}.mode must be 'all' or 'custom'`);
  }

  return {
    mode: "custom",
    savedSelectedSkillHandles: parseHandleArray(
      input.savedSelectedSkillHandles,
      `${fieldName}.savedSelectedSkillHandles`,
    ),
  };
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function requireBooleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function parseNullableStringField(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string when provided`);
  }

  return value.trim();
}
