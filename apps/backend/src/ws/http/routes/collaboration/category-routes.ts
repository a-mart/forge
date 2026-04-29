import type { CollaborationCategory } from "@forge/protocol";
import { parseSwarmReasoningLevel } from "../../../../swarm/model-presets.js";
import type { CollaborationReadinessRequestService } from "../../../../collaboration/readiness-service.js";
import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices } from "./route-services.js";
import {
  expectObjectBody,
  mapCollaborationCategoryErrorStatus,
  parseSinglePathId,
  requireAdminRequestContext,
  requireAuthenticatedRequestContext,
  requireDefaultWorkspace,
  resolveDefaultWorkspace,
} from "./route-helpers.js";

const COLLABORATION_CATEGORIES_ENDPOINT_PATH = "/api/collaboration/categories";
const COLLABORATION_CATEGORIES_METHODS = "GET, POST, OPTIONS";
const COLLABORATION_CATEGORY_ENDPOINT_PATTERN = /^\/api\/collaboration\/categories\/([^/]+)$/;
const COLLABORATION_CATEGORY_METHODS = "PATCH, DELETE, OPTIONS";
const COLLABORATION_CATEGORIES_REORDER_ENDPOINT_PATH = "/api/collaboration/categories/reorder";
const COLLABORATION_CATEGORIES_REORDER_METHODS = "POST, OPTIONS";

export function createCollaborationCategoryRoutes(options: {
  getServices: () => Promise<CollaborationRouteServices>;
  readinessService?: CollaborationReadinessRequestService;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_CATEGORIES_METHODS,
      matches: (pathname) => pathname === COLLABORATION_CATEGORIES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CATEGORIES_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CATEGORIES_METHODS);

        if (request.method !== "GET" && request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_CATEGORIES_METHODS);
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
              sendJson(response, 200, { categories: [] });
              return;
            }

            const { categoryService } = await options.getServices();
            sendJson(response, 200, { categories: categoryService.listCategories(workspace.workspaceId) });
            return;
          }

          const adminContext = await requireAdminRequestContext(request, response, options.getServices);
          if (!adminContext) {
            return;
          }

          void adminContext;

          const workspace = await requireDefaultWorkspace(response, options.getServices, options.readinessService);
          if (!workspace) {
            return;
          }

          const { categoryService, broadcasts } = await options.getServices();
          const category = categoryService.createCategory({
            ...parseCreateCategoryBody(await readJsonBody(request)),
            workspaceId: workspace.workspaceId,
          });
          broadcasts?.broadcastCategoryCreated(category);
          sendJson(response, 200, { ok: true, category });
        } catch (error) {
          sendJson(response, mapCollaborationCategoryErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration categories",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CATEGORIES_REORDER_METHODS,
      matches: (pathname) => pathname === COLLABORATION_CATEGORIES_REORDER_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CATEGORIES_REORDER_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CATEGORIES_REORDER_METHODS);

        if (request.method !== "POST") {
          response.setHeader("Allow", COLLABORATION_CATEGORIES_REORDER_METHODS);
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
          if (!Array.isArray(body.categoryIds)) {
            throw new Error("categoryIds must be an array");
          }

          const { categoryService, broadcasts } = await options.getServices();
          const categories = categoryService.reorderCategories({
            workspaceId: workspace.workspaceId,
            categoryIds: body.categoryIds.map((value) => {
              if (typeof value !== "string") {
                throw new Error("categoryIds must contain only strings");
              }
              return value;
            }),
          });
          broadcasts?.broadcastCategoryReordered(categories);
          sendJson(response, 200, { ok: true, categories });
        } catch (error) {
          sendJson(response, mapCollaborationCategoryErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to reorder collaboration categories",
          });
        }
      },
    },
    {
      methods: COLLABORATION_CATEGORY_METHODS,
      matches: (pathname) => COLLABORATION_CATEGORY_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_CATEGORY_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_CATEGORY_METHODS);

        if (request.method !== "PATCH" && request.method !== "DELETE") {
          response.setHeader("Allow", COLLABORATION_CATEGORY_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const categoryId = parseSinglePathId(requestUrl.pathname, COLLABORATION_CATEGORY_ENDPOINT_PATTERN);
        if (!categoryId) {
          sendJson(response, 400, { error: "Missing categoryId" });
          return;
        }

        const adminContext = await requireAdminRequestContext(request, response, options.getServices);
        if (!adminContext) {
          return;
        }

        void adminContext;

        try {
          const { categoryService, dbHelpers, broadcasts } = await options.getServices();
          if (request.method === "DELETE") {
            const existingCategory = dbHelpers.getCategory(categoryId);
            categoryService.deleteCategory(categoryId);
            if (existingCategory) {
              broadcasts?.broadcastCategoryDeleted(existingCategory.workspaceId, categoryId);
            }
            sendJson(response, 200, { ok: true });
            return;
          }

          const category = categoryService.updateCategory(categoryId, parseUpdateCategoryBody(await readJsonBody(request)));
          broadcasts?.broadcastCategoryUpdated(category);
          sendJson(response, 200, { ok: true, category });
        } catch (error) {
          sendJson(response, mapCollaborationCategoryErrorStatus(error), {
            error: error instanceof Error ? error.message : "Unable to manage collaboration category",
          });
        }
      },
    },
  ];
}

function parseCreateCategoryBody(body: unknown): {
  name: string;
  channelCreationDefaults?: CollaborationCategory["channelCreationDefaults"] | null;
  defaultModelId?: string | null;
  defaultReasoningLevel?: CollaborationCategory["defaultReasoningLevel"] | null;
} {
  const parsed = parseCategoryBody(body);
  if (!parsed.name) {
    throw new Error("name must be a non-empty string");
  }

  return {
    name: parsed.name,
    ...(parsed.channelCreationDefaults !== undefined ? { channelCreationDefaults: parsed.channelCreationDefaults } : {}),
    ...(parsed.defaultModelId !== undefined ? { defaultModelId: parsed.defaultModelId } : {}),
    ...(parsed.defaultReasoningLevel !== undefined ? { defaultReasoningLevel: parsed.defaultReasoningLevel } : {}),
  };
}

function parseUpdateCategoryBody(body: unknown): {
  name?: string;
  channelCreationDefaults?: CollaborationCategory["channelCreationDefaults"] | null;
  defaultModelId?: string | null;
  defaultReasoningLevel?: CollaborationCategory["defaultReasoningLevel"] | null;
} {
  return parseCategoryBody(body);
}

function parseCategoryBody(body: unknown): {
  name?: string;
  channelCreationDefaults?: CollaborationCategory["channelCreationDefaults"] | null;
  defaultModelId?: string | null;
  defaultReasoningLevel?: CollaborationCategory["defaultReasoningLevel"] | null;
} {
  const input = expectObjectBody(body);
  const parsed: {
    name?: string;
    channelCreationDefaults?: CollaborationCategory["channelCreationDefaults"] | null;
    defaultModelId?: string | null;
    defaultReasoningLevel?: CollaborationCategory["defaultReasoningLevel"] | null;
  } = {};

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new Error("name must be a non-empty string when provided");
    }
    parsed.name = input.name.trim();
  }

  if (input.defaultModelId !== undefined) {
    if (input.defaultModelId !== null && (typeof input.defaultModelId !== "string" || input.defaultModelId.trim().length === 0)) {
      throw new Error("defaultModelId must be a non-empty string or null when provided");
    }
    parsed.defaultModelId = input.defaultModelId === null ? null : input.defaultModelId.trim();
  }

  if (input.defaultReasoningLevel !== undefined) {
    if (input.defaultReasoningLevel === null) {
      parsed.defaultReasoningLevel = null;
    } else {
      parsed.defaultReasoningLevel = parseSwarmReasoningLevel(
        input.defaultReasoningLevel,
        "defaultReasoningLevel",
      );
    }
  }

  if (input.channelCreationDefaults !== undefined) {
    if (input.channelCreationDefaults === null) {
      parsed.channelCreationDefaults = null;
    } else if (
      typeof input.channelCreationDefaults === "object" &&
      input.channelCreationDefaults !== null &&
      !Array.isArray(input.channelCreationDefaults)
    ) {
      const defaults = input.channelCreationDefaults as Record<string, unknown>;
      const model = defaults.model as Record<string, unknown> | undefined;
      if (!model || typeof model.provider !== "string" || typeof model.modelId !== "string" || typeof model.thinkingLevel !== "string") {
        throw new Error("channelCreationDefaults.model must include provider, modelId, and thinkingLevel");
      }
      parsed.channelCreationDefaults = {
        model: {
          provider: model.provider.trim(),
          modelId: model.modelId.trim(),
          thinkingLevel: model.thinkingLevel.trim(),
        },
        ...(typeof defaults.cwd === "string" && defaults.cwd.trim().length > 0 ? { cwd: defaults.cwd.trim() } : {}),
      };
    } else {
      throw new Error("channelCreationDefaults must be an object or null when provided");
    }
  }

  return parsed;
}
