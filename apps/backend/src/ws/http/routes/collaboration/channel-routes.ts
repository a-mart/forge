import type { CollaborationChannelPromptPreviewResponse, PromptPreviewResponse } from "@forge/protocol";
import { inferSwarmModelPresetFromDescriptor } from "../../../../swarm/model-presets.js";
import type { SwarmConfig } from "../../../../swarm/types.js";
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
              channels: channelService.listChannels({
                workspaceId: workspace.workspaceId,
                archived: parseArchivedFilter(requestUrl.searchParams.get("archived")),
              }),
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

            const channel = channelService.getChannel(channelId);
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

          const existingChannel = await attachChannelEffectiveModelId(
            options.swarmManager,
            channelService.getChannel(channelId),
          );
          const update = parseUpdateChannelBody(await readJsonBody(request));
          const channel = channelService.updateChannel(channelId, update);
          if (update.promptOverlay !== undefined) {
            await promptOverlayService.setPromptOverlay(channel.channelId, update.promptOverlay);
            await recycleCollaborationBackingSessionRuntime(options.swarmManager, channel.sessionAgentId);
          }
          if (update.modelId !== undefined && update.modelId !== existingChannel.modelId) {
            if (!options.swarmManager?.updateManagerModel) {
              throw new Error("Collaboration channel model updates require swarm manager support");
            }
            await options.swarmManager.updateManagerModel(channel.sessionAgentId, update.modelId);
          }
          broadcasts?.broadcastChannelUpdated(
            await attachChannelEffectiveModelId(options.swarmManager, channelService.getChannel(channel.channelId)),
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
  return attachChannelEffectiveModelId(swarmManager, await attachPromptOverlay(promptOverlayService, channel));
}

async function attachChannelEffectiveModelId(
  swarmManager: CollaborationRouteSwarmManager | undefined,
  channel: ReturnType<CollaborationRouteServices["channelService"]["getChannel"]>,
) {
  if (channel.modelId) {
    return channel;
  }

  const descriptor = swarmManager?.getAgent(channel.sessionAgentId);
  const inferredModelId = inferSwarmModelPresetFromDescriptor(descriptor?.model);
  if (!inferredModelId) {
    return channel;
  }

  return {
    ...channel,
    modelId: inferredModelId,
  };
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

function parseCreateChannelBody(body: unknown): {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  aiEnabled?: boolean;
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
  };
}

function parseUpdateChannelBody(body: unknown): {
  name?: string;
  categoryId?: string | null;
  description?: string | null;
  aiEnabled?: boolean;
  modelId?: string;
  promptOverlay?: string | null;
  position?: number;
} {
  const input = expectObjectBody(body);
  const parsed: {
    name?: string;
    categoryId?: string | null;
    description?: string | null;
    aiEnabled?: boolean;
    modelId?: string;
    promptOverlay?: string | null;
    position?: number;
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

  if (input.promptOverlay !== undefined) {
    parsed.promptOverlay = parseNullableStringField(input.promptOverlay, "promptOverlay");
  }

  if (input.position !== undefined) {
    if (typeof input.position !== "number" || !Number.isInteger(input.position) || input.position < 0) {
      throw new Error("position must be a non-negative integer when provided");
    }
    parsed.position = input.position;
  }

  return parsed;
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
