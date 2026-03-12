import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PromptCategory,
  PromptSourceLayer,
  PromptListEntry,
  PromptContentResponse,
  ServerEvent,
} from "@middleman/protocol";
import {
  PROMPT_METADATA,
  getPromptMetadata,
  isKnownPrompt,
  isValidPromptCategory,
  isValidPromptSourceLayer,
} from "../../swarm/prompt-metadata.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson,
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

// ---------------------------------------------------------------------------
// Minimal PromptRegistry interface consumed by these routes.
// The full implementation lives in `swarm/prompt-registry.ts` (built by
// another worker).  We define just the surface we need here so that the
// routes compile independently.
// ---------------------------------------------------------------------------

export interface PromptEntry {
  category: PromptCategory;
  promptId: string;
  content: string;
  sourceLayer: PromptSourceLayer;
  sourcePath: string;
}

export interface PromptRegistryForRoutes {
  resolveEntry(
    category: PromptCategory,
    promptId: string,
    profileId?: string,
  ): Promise<PromptEntry | undefined>;

  resolveAtLayer(
    category: PromptCategory,
    promptId: string,
    layer: PromptSourceLayer,
    profileId?: string,
  ): Promise<string | undefined>;

  listAll(profileId?: string): Promise<PromptEntry[]>;

  save(
    category: PromptCategory,
    promptId: string,
    content: string,
    profileId: string,
  ): Promise<void>;

  deleteOverride(
    category: PromptCategory,
    promptId: string,
    profileId: string,
  ): Promise<void>;

  hasOverride(
    category: PromptCategory,
    promptId: string,
    profileId: string,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Route path patterns
// ---------------------------------------------------------------------------

const PROMPTS_LIST_PATH = "/api/prompts";
const PROMPTS_PREVIEW_PATH = "/api/prompts/preview";
// Matches /api/prompts/<category>/<promptId>
const PROMPT_ITEM_PATTERN = /^\/api\/prompts\/([^/]+)\/([^/]+)$/;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PromptPreviewSection {
  label: string;
  content: string;
  source: string;
}

export interface PromptPreviewResponse {
  sections: PromptPreviewSection[];
}

export interface PromptPreviewProvider {
  previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse>;
}

export function createPromptRoutes(options: {
  promptRegistry: PromptRegistryForRoutes;
  broadcastEvent: (event: ServerEvent) => void;
  promptPreviewProvider?: PromptPreviewProvider;
}): HttpRoute[] {
  const { promptRegistry, broadcastEvent, promptPreviewProvider } = options;

  return [
    // ── Preview full manager runtime context ──────────────────
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === PROMPTS_PREVIEW_PATH,
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

        if (!promptPreviewProvider) {
          sendJson(response, 501, { error: "Prompt preview not available" });
          return;
        }

        const profileId = requestUrl.searchParams.get("profileId");
        if (!profileId || profileId.trim().length === 0) {
          sendJson(response, 400, { error: "profileId query parameter is required." });
          return;
        }

        try {
          const result = await promptPreviewProvider.previewManagerSystemPrompt(profileId);
          sendJson(response, 200, result as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const statusCode = message.includes("Unknown profile") ? 404 : 500;
          sendJson(response, statusCode, { error: message });
        }
      },
    },

    // ── List all prompts ──────────────────────────────────────
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === PROMPTS_LIST_PATH,
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

        const profileId = requestUrl.searchParams.get("profileId") ?? undefined;

        try {
          const entries = await promptRegistry.listAll(profileId);
          const entryMap = new Map<string, PromptEntry>();
          for (const entry of entries) {
            entryMap.set(`${entry.category}:${entry.promptId}`, entry);
          }

          // Filter out prompts scoped to a different profile
          const applicableMetadata = PROMPT_METADATA.filter(
            (meta) => !meta.profileScope || meta.profileScope === profileId,
          );

          const prompts: PromptListEntry[] = applicableMetadata.map((meta) => {
            const entry = entryMap.get(`${meta.category}:${meta.promptId}`);
            const hasProfileOverride = profileId
              ? entry?.sourceLayer === "profile"
              : false;

            return {
              category: meta.category,
              promptId: meta.promptId,
              displayName: meta.displayName,
              description: meta.description,
              activeLayer: entry?.sourceLayer ?? "builtin",
              hasProfileOverride,
              variables: meta.variables,
            };
          });

          sendJson(response, 200, { prompts });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { error: message });
        }
      },
    },

    // ── Get / Save / Delete a single prompt ───────────────────
    {
      methods: "GET, PUT, DELETE, OPTIONS",
      matches: (pathname) => PROMPT_ITEM_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "GET, PUT, DELETE, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, methods);

        // ── Parse & validate path params ──
        const match = requestUrl.pathname.match(PROMPT_ITEM_PATTERN);
        if (!match) {
          sendJson(response, 400, { error: "Invalid prompt path" });
          return;
        }

        const rawCategory = decodeURIComponent(match[1]);
        const rawPromptId = decodeURIComponent(match[2]);

        if (!isValidPromptCategory(rawCategory)) {
          sendJson(response, 400, {
            error: `Invalid category '${rawCategory}'. Must be 'archetype' or 'operational'.`,
          });
          return;
        }

        const category: PromptCategory = rawCategory;
        const promptId = rawPromptId;

        if (!isKnownPrompt(category, promptId)) {
          sendJson(response, 404, {
            error: `Unknown prompt '${category}/${promptId}'.`,
          });
          return;
        }

        // ── GET — read prompt content ──
        if (request.method === "GET") {
          await handleGetPrompt(
            promptRegistry,
            request,
            response,
            requestUrl,
            category,
            promptId,
          );
          return;
        }

        // ── PUT — save override ──
        if (request.method === "PUT") {
          await handleSavePrompt(
            promptRegistry,
            broadcastEvent,
            request,
            response,
            category,
            promptId,
          );
          return;
        }

        // ── DELETE — remove override ──
        if (request.method === "DELETE") {
          await handleDeletePrompt(
            promptRegistry,
            broadcastEvent,
            request,
            response,
            requestUrl,
            category,
            promptId,
          );
          return;
        }

        response.setHeader("Allow", methods);
        sendJson(response, 405, { error: "Method Not Allowed" });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GET /api/prompts/:category/:promptId
// ---------------------------------------------------------------------------

async function handleGetPrompt(
  registry: PromptRegistryForRoutes,
  _request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  category: PromptCategory,
  promptId: string,
): Promise<void> {
  const profileId = requestUrl.searchParams.get("profileId") ?? undefined;
  const rawLayer = requestUrl.searchParams.get("layer");

  try {
    // If a specific layer was requested, resolve at that layer only.
    if (rawLayer !== null) {
      if (!isValidPromptSourceLayer(rawLayer)) {
        sendJson(response, 400, {
          error: `Invalid layer '${rawLayer}'. Must be 'profile', 'repo', or 'builtin'.`,
        });
        return;
      }

      const content = await registry.resolveAtLayer(
        category,
        promptId,
        rawLayer as PromptSourceLayer,
        profileId,
      );

      if (content === undefined) {
        sendJson(response, 404, {
          error: `No content at layer '${rawLayer}' for ${category}/${promptId}.`,
        });
        return;
      }

      const meta = getPromptMetadata(category, promptId);
      const body: PromptContentResponse = {
        category,
        promptId,
        content,
        sourceLayer: rawLayer as PromptSourceLayer,
        sourcePath: "", // layer-specific path not available via resolveAtLayer
        variables: meta?.variables ?? [],
      };

      sendJson(response, 200, body as unknown as Record<string, unknown>);
      return;
    }

    // Default: resolve using the full resolution chain.
    const entry = await registry.resolveEntry(category, promptId, profileId);
    if (!entry) {
      sendJson(response, 404, {
        error: `Prompt '${category}/${promptId}' not found.`,
      });
      return;
    }

    const meta = getPromptMetadata(category, promptId);
    const body: PromptContentResponse = {
      category,
      promptId,
      content: entry.content,
      sourceLayer: entry.sourceLayer,
      sourcePath: entry.sourcePath,
      variables: meta?.variables ?? [],
    };

    sendJson(response, 200, body as unknown as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/prompts/:category/:promptId
// ---------------------------------------------------------------------------

async function handleSavePrompt(
  registry: PromptRegistryForRoutes,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  category: PromptCategory,
  promptId: string,
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const { content, profileId } = parseSaveBody(body);

    await registry.save(category, promptId, content, profileId);

    broadcastEvent({
      type: "prompt_changed",
      category,
      promptId,
      layer: "profile",
      action: "saved",
    });

    sendJson(response, 200, { saved: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = isBadRequestMessage(message) ? 400 : 500;
    sendJson(response, statusCode, { error: message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/prompts/:category/:promptId
// ---------------------------------------------------------------------------

async function handleDeletePrompt(
  registry: PromptRegistryForRoutes,
  broadcastEvent: (event: ServerEvent) => void,
  _request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  category: PromptCategory,
  promptId: string,
): Promise<void> {
  const profileId = requestUrl.searchParams.get("profileId");

  if (!profileId || profileId.trim().length === 0) {
    sendJson(response, 400, { error: "profileId query parameter is required." });
    return;
  }

  try {
    const hasOverride = await registry.hasOverride(category, promptId, profileId);
    if (!hasOverride) {
      sendJson(response, 404, {
        error: `No profile override exists for ${category}/${promptId}.`,
      });
      return;
    }

    await registry.deleteOverride(category, promptId, profileId);

    broadcastEvent({
      type: "prompt_changed",
      category,
      promptId,
      layer: "profile",
      action: "deleted",
    });

    sendJson(response, 200, { deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

function parseSaveBody(value: unknown): { content: string; profileId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }

  const maybe = value as { content?: unknown; profileId?: unknown };

  if (typeof maybe.profileId !== "string" || maybe.profileId.trim().length === 0) {
    throw new Error("profileId must be a non-empty string.");
  }

  if (typeof maybe.content !== "string" || maybe.content.trim().length === 0) {
    throw new Error("content must be a non-empty string.");
  }

  return {
    content: maybe.content,
    profileId: maybe.profileId.trim(),
  };
}

function isBadRequestMessage(message: string): boolean {
  return (
    message.includes("must be") ||
    message.includes("required") ||
    message.includes("Request body")
  );
}
