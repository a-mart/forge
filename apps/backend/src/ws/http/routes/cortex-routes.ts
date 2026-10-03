import { readFile } from "node:fs/promises";
import type {
  CortexEntriesResponse,
  CortexIndexResponse,
  OnboardingState,
  OnboardingTechnicalLevel,
} from "@forge/protocol";
import { ONBOARDING_TECHNICAL_LEVEL_VALUES } from "@forge/protocol";
import {
  getKnowledgeIndexPath,
  getProfileKnowledgeIndexPath,
} from "../../../swarm/data-paths.js";
import { estimateTokens, type KnowledgeEntry, type KnowledgeEntryScope } from "../../../swarm/knowledge-service.js";
import { getOnboardingSnapshot, renderOnboardingCommonKnowledge, saveOnboardingPreferences, skipOnboarding } from "../../../swarm/onboarding-state.js";
import { readCortexReviewLogEntries } from "../../../swarm/scripts/cortex-review-state.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const ONBOARDING_STATE_ENDPOINT_PATH = "/api/onboarding/state";
const ONBOARDING_STATE_METHODS = "GET, OPTIONS";
const ONBOARDING_PREFERENCES_ENDPOINT_PATH = "/api/onboarding/preferences";
const ONBOARDING_PREFERENCES_METHODS = "POST, OPTIONS";
const CORTEX_INDEX_ENDPOINT_PATH = "/api/cortex/index";
const CORTEX_ENTRIES_ENDPOINT_PATH = "/api/cortex/entries";
const CORTEX_CHANGELOG_ENDPOINT_PATH = "/api/cortex/changelog";
const CORTEX_CONSOLIDATION_ENDPOINT_PATH = "/api/cortex/consolidation";
const ONBOARDING_PREFERRED_NAME_MAX_LENGTH = 200;
const ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH = 2000;

export function createCortexRoutes(options: { swarmManager: SwarmManager; cortexEnabled?: boolean }): HttpRoute[] {
  const { swarmManager } = options;
  const cortexEnabled = options.cortexEnabled !== false;

  return [
    {
      methods: ONBOARDING_STATE_METHODS,
      matches: (pathname) => pathname === ONBOARDING_STATE_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, ONBOARDING_STATE_METHODS);
        if (request.method !== "GET") return methodNotAllowed(request, response, ONBOARDING_STATE_METHODS);
        applyCorsHeaders(request, response, ONBOARDING_STATE_METHODS);
        try {
          const snapshot = await getOnboardingSnapshot(swarmManager.getConfig().paths.dataDir);
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : "Unable to load onboarding state." });
        }
      },
    },
    {
      methods: ONBOARDING_PREFERENCES_METHODS,
      matches: (pathname) => pathname === ONBOARDING_PREFERENCES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, ONBOARDING_PREFERENCES_METHODS);
        if (request.method !== "POST") return methodNotAllowed(request, response, ONBOARDING_PREFERENCES_METHODS);
        applyCorsHeaders(request, response, ONBOARDING_PREFERENCES_METHODS);
        try {
          const payload = await parseJsonBody(request, 8 * 1024);
          const mutation = parseOnboardingPreferencesPayload(payload);
          if (!mutation) {
            sendJson(response, 400, { error: "Request body must include onboarding preferences or skipped status." });
            return;
          }
          const dataDir = swarmManager.getConfig().paths.dataDir;
          const snapshot = "status" in mutation
            ? await skipOnboarding(dataDir)
            : await saveOnboardingPreferences(dataDir, mutation);
          await renderOnboardingCommonKnowledge(dataDir, snapshot, {
            knowledgeService: swarmManager.getKnowledgeService(),
            settingsService: swarmManager.getKnowledgeV2SettingsService(),
          });
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to save onboarding preferences.";
          sendJson(response, message.includes("Request body exceeds") ? 413 : 400, { error: message });
        }
      },
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === CORTEX_INDEX_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, "GET, OPTIONS");
        if (request.method !== "GET") return methodNotAllowed(request, response, "GET, OPTIONS");
        applyCorsHeaders(request, response, "GET, OPTIONS");
        if (!cortexEnabled) return sendJson(response, 503, { error: "Cortex is disabled" });
        const dataDir = swarmManager.getConfig().paths.dataDir;
        const settings = swarmManager.getKnowledgeV2SettingsService().getSettings();
        const entries = await swarmManager.getKnowledgeService().listEntries({ includeArchived: false });
        const scopes = Array.from(new Set<KnowledgeEntryScope>(["global", ...entries.map((entry) => entry.frontmatter.scope)]));
        const indexes = await Promise.all(scopes.map(async (scope) => {
          const path = scope === "global" ? getKnowledgeIndexPath(dataDir) : getProfileKnowledgeIndexPath(dataDir, scope.slice("profile:".length));
          const content = await readFile(path, "utf8").catch(() => "");
          return {
            scope,
            content,
            tokenCap: scope === "global" ? settings.indexCaps.global : settings.indexCaps.profile,
            tokenEstimate: estimateTokens(content),
            indexedEntryIds: extractIndexedEntryIds(content),
          };
        }));
        sendJson(response, 200, ({ indexes, settings } satisfies CortexIndexResponse) as unknown as Record<string, unknown>);
      },
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === CORTEX_ENTRIES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, "GET, OPTIONS");
        if (request.method !== "GET") return methodNotAllowed(request, response, "GET, OPTIONS");
        applyCorsHeaders(request, response, "GET, OPTIONS");
        if (!cortexEnabled) return sendJson(response, 503, { error: "Cortex is disabled" });
        const entries = await swarmManager.getKnowledgeService().listEntries({ includeArchived: true });
        sendJson(response, 200, ({ entries: entries.map(toEntryDto) } satisfies CortexEntriesResponse) as unknown as Record<string, unknown>);
      },
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === CORTEX_CHANGELOG_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, "GET, OPTIONS");
        if (request.method !== "GET") return methodNotAllowed(request, response, "GET, OPTIONS");
        applyCorsHeaders(request, response, "GET, OPTIONS");
        const changelog = await readCortexReviewLogEntries(swarmManager.getConfig().paths.dataDir);
        sendJson(response, 200, { changelog });
      },
    },
    {
      methods: "GET, POST, OPTIONS",
      matches: (pathname) => pathname === CORTEX_CONSOLIDATION_ENDPOINT_PATH,
      handle: async (request, response) => {
        const methods = "GET, POST, OPTIONS";
        if (request.method === "OPTIONS") return optionsResponse(request, response, methods);
        if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(request, response, methods);
        applyCorsHeaders(request, response, methods);
        if (!cortexEnabled) return sendJson(response, 503, { error: "Cortex is disabled" });
        if (request.method === "POST") {
          const run = await swarmManager.runCortexConsolidation("manual");
          sendJson(response, 202, { run });
          return;
        }
        const [consolidation, runs] = await Promise.all([
          swarmManager.getCortexConsolidationSnapshot(),
          swarmManager.listCortexConsolidationRuns(),
        ]);
        sendJson(response, 200, { consolidation, runs });
      },
    },
  ];
}

function toEntryDto(entry: KnowledgeEntry) {
  return {
    ...entry.frontmatter,
    body: entry.body,
    tokenEstimate: estimateTokens(`${entry.frontmatter.title}\n${entry.body}`),
  };
}

function extractIndexedEntryIds(content: string): string[] {
  return Array.from(content.matchAll(/^- \[([^\]]+)\]/gmu)).map((match) => match[1]).filter(Boolean);
}

function buildOnboardingStateResponse(snapshot: OnboardingState) {
  return {
    status: snapshot.status,
    completedAt: snapshot.completedAt,
    skippedAt: snapshot.skippedAt,
    preferences: snapshot.preferences,
  };
}

function parseOnboardingPreferencesPayload(
  payload: unknown,
):
  | { status: "skipped" }
  | { preferredName: string; technicalLevel: OnboardingTechnicalLevel; additionalPreferences?: string | null }
  | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const maybe = payload as Record<string, unknown>;
  if (maybe.status === "skipped") return { status: "skipped" };
  const preferredName = typeof maybe.preferredName === "string" ? maybe.preferredName.trim() : "";
  const technicalLevel = typeof maybe.technicalLevel === "string" ? maybe.technicalLevel.trim() as OnboardingTechnicalLevel : null;
  const additionalPreferences = typeof maybe.additionalPreferences === "string" && maybe.additionalPreferences.trim()
    ? maybe.additionalPreferences.trim()
    : null;
  if (preferredName.length > ONBOARDING_PREFERRED_NAME_MAX_LENGTH) throw new Error(`preferredName must be ${ONBOARDING_PREFERRED_NAME_MAX_LENGTH} characters or fewer.`);
  if (additionalPreferences && additionalPreferences.length > ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH) throw new Error(`additionalPreferences must be ${ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH} characters or fewer.`);
  if (!preferredName || !technicalLevel || !ONBOARDING_TECHNICAL_LEVEL_VALUES.includes(technicalLevel)) return null;
  return { preferredName, technicalLevel, additionalPreferences };
}

function optionsResponse(request: Parameters<HttpRoute["handle"]>[0], response: Parameters<HttpRoute["handle"]>[1], methods: string): void {
  applyCorsHeaders(request, response, methods);
  response.statusCode = 204;
  response.end();
}

function methodNotAllowed(request: Parameters<HttpRoute["handle"]>[0], response: Parameters<HttpRoute["handle"]>[1], methods: string): void {
  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}
