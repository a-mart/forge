import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChromeCdpConfig,
  ChromeCdpPreviewTab,
  ChromeCdpProfile,
  ChromeCdpStatus,
  ChromeCdpTargetInfo,
  ChromeCdpVersionInfo
} from "@forge/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  queryChromeBrowserContexts,
  queryChromeCdpTargets,
  queryChromeCdpVersion,
  resolveChromeCdpEndpoint
} from "./chrome-cdp-helper.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const CHROME_CDP_SETTINGS_ENDPOINT_PATH = "/api/settings/chrome-cdp";
const CHROME_CDP_TEST_ENDPOINT_PATH = "/api/settings/chrome-cdp/test";
const CHROME_CDP_PROFILES_ENDPOINT_PATH = "/api/settings/chrome-cdp/profiles";
const CHROME_CDP_PREVIEW_ENDPOINT_PATH = "/api/settings/chrome-cdp/preview";
const CHROME_CDP_METHODS = "GET, PUT, POST, OPTIONS";

interface ChromeCdpConfigUpdate {
  contextId?: string | null;
  urlAllow?: string[];
  urlBlock?: string[];
}

export function createChromeCdpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: CHROME_CDP_METHODS,
      matches: (pathname) =>
        pathname === CHROME_CDP_SETTINGS_ENDPOINT_PATH ||
        pathname === CHROME_CDP_TEST_ENDPOINT_PATH ||
        pathname === CHROME_CDP_PROFILES_ENDPOINT_PATH ||
        pathname === CHROME_CDP_PREVIEW_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        try {
          await handleChromeCdpHttpRequest(swarmManager, request, response, requestUrl);
        } catch (error) {
          if (!response.headersSent) {
            sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Internal server error"
            });
          }
        }
      }
    }
  ];
}

async function handleChromeCdpHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, CHROME_CDP_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, CHROME_CDP_METHODS);

  if (request.method === "GET" && requestUrl.pathname === CHROME_CDP_SETTINGS_ENDPOINT_PATH) {
    const config = readCurrentChromeCdpConfig();
    const status = await readChromeCdpStatus();
    sendJson(response, 200, { config, status });
    return;
  }

  if (request.method === "PUT" && requestUrl.pathname === CHROME_CDP_SETTINGS_ENDPOINT_PATH) {
    const update = parseChromeCdpConfigUpdateBody(await readJsonBody(request));
    await saveChromeCdpConfigUpdate(swarmManager, update);
    sendJson(response, 200, { ok: true, config: readCurrentChromeCdpConfig() });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === CHROME_CDP_TEST_ENDPOINT_PATH) {
    const result = await runChromeCdpConnectionTest();
    sendJson(response, 200, { ...result });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === CHROME_CDP_PROFILES_ENDPOINT_PATH) {
    const profilesResult = await discoverChromeCdpProfiles();
    sendJson(response, 200, profilesResult);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === CHROME_CDP_PREVIEW_ENDPOINT_PATH) {
    const update = parseChromeCdpConfigUpdateBody(await readJsonBody(request));
    const base = readCurrentChromeCdpConfig();
    const merged: ChromeCdpConfig = {
      contextId: "contextId" in update ? normalizeContextId(update.contextId) : base.contextId,
      urlAllow: "urlAllow" in update ? normalizePatternList(update.urlAllow ?? []) : base.urlAllow,
      urlBlock: "urlBlock" in update ? normalizePatternList(update.urlBlock ?? []) : base.urlBlock
    };
    const preview = await previewChromeCdpTabs(merged);
    sendJson(response, 200, preview);
    return;
  }

  response.setHeader("Allow", CHROME_CDP_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function readCurrentChromeCdpConfig(): ChromeCdpConfig {
  return {
    contextId: normalizeContextId(process.env.CDP_CONTEXT_ID),
    urlAllow: parsePatternListFromEnv(process.env.CDP_URL_ALLOW),
    urlBlock: parsePatternListFromEnv(process.env.CDP_URL_BLOCK)
  };
}

async function readChromeCdpStatus(): Promise<ChromeCdpStatus> {
  try {
    const endpoint = await resolveChromeCdpEndpoint();
    const { version } = await queryChromeCdpVersion({ endpoint });
    const browserInfo = parseBrowserVersion(version);

    return {
      connected: true,
      port: endpoint.port,
      ...(browserInfo.browser ? { browser: browserInfo.browser } : {}),
      ...(browserInfo.version ? { version: browserInfo.version } : {})
    };
  } catch {
    return {
      connected: false
    };
  }
}

async function saveChromeCdpConfigUpdate(
  swarmManager: SwarmManager,
  update: ChromeCdpConfigUpdate
): Promise<void> {
  const updates: Record<string, string> = {};
  const deletions = new Set<string>();

  if ("contextId" in update) {
    const contextId = normalizeContextId(update.contextId);
    if (contextId) {
      updates.CDP_CONTEXT_ID = contextId;
    } else {
      deletions.add("CDP_CONTEXT_ID");
    }
  }

  if ("urlAllow" in update) {
    const allow = normalizePatternList(update.urlAllow ?? []);
    if (allow.length > 0) {
      updates.CDP_URL_ALLOW = allow.join(",");
    } else {
      deletions.add("CDP_URL_ALLOW");
    }
  }

  if ("urlBlock" in update) {
    const block = normalizePatternList(update.urlBlock ?? []);
    if (block.length > 0) {
      updates.CDP_URL_BLOCK = block.join(",");
    } else {
      deletions.add("CDP_URL_BLOCK");
    }
  }

  if (Object.keys(updates).length > 0) {
    await swarmManager.updateSettingsEnv(updates);
  }

  for (const name of deletions) {
    await swarmManager.deleteSettingsEnv(name);
  }
}

async function runChromeCdpConnectionTest(): Promise<ChromeCdpStatus> {
  try {
    const endpoint = await resolveChromeCdpEndpoint();
    const [{ version }, { targets }] = await Promise.all([
      queryChromeCdpVersion({ endpoint }),
      queryChromeCdpTargets({ endpoint })
    ]);

    const pageTargets = targets.filter(isChromePageTarget);
    const browserInfo = parseBrowserVersion(version);

    return {
      connected: true,
      port: endpoint.port,
      ...(browserInfo.browser ? { browser: browserInfo.browser } : {}),
      ...(browserInfo.version ? { version: browserInfo.version } : {}),
      tabCount: pageTargets.length
    };
  } catch (error) {
    return {
      connected: false,
      error: toErrorMessage(error)
    };
  }
}

async function discoverChromeCdpProfiles(): Promise<{
  profiles: ChromeCdpProfile[];
  error?: string;
}> {
  try {
    const endpoint = await resolveChromeCdpEndpoint();
    const [{ targets }, browserContexts] = await Promise.all([
      queryChromeCdpTargets({ endpoint }),
      queryChromeBrowserContexts({ endpoint }).catch(() => ({
        endpoint,
        defaultBrowserContextId: undefined,
        browserContextIds: [] as string[]
      }))
    ]);

    const pageTargets = targets.filter(isChromePageTarget);
    const defaultContextId = normalizeContextId(browserContexts.defaultBrowserContextId) ?? null;

    const groupedProfiles = new Map<
      string,
      { contextId: string; isDefault: boolean; tabs: ChromeCdpTargetInfo[] }
    >();

    for (const target of pageTargets) {
      const normalizedContextId = normalizeContextId(target.browserContextId);
      const isDefault = !normalizedContextId || normalizedContextId === defaultContextId;
      const contextKey = isDefault ? "default" : normalizedContextId;

      const existing = groupedProfiles.get(contextKey);
      if (existing) {
        existing.tabs.push(target);
        continue;
      }

      groupedProfiles.set(contextKey, {
        contextId: contextKey,
        isDefault,
        tabs: [target]
      });
    }

    const profiles: ChromeCdpProfile[] = Array.from(groupedProfiles.values())
      .map((group) => ({
        contextId: group.contextId,
        tabCount: group.tabs.length,
        sampleUrls: uniqueNonEmpty(group.tabs.map((tab) => tab.url)).slice(0, 5),
        isDefault: group.isDefault
      }))
      .sort((left, right) => {
        if (left.isDefault && !right.isDefault) {
          return -1;
        }
        if (!left.isDefault && right.isDefault) {
          return 1;
        }

        const byCount = right.tabCount - left.tabCount;
        if (byCount !== 0) {
          return byCount;
        }

        return left.contextId.localeCompare(right.contextId);
      });

    return { profiles };
  } catch (error) {
    return {
      profiles: [],
      error: toErrorMessage(error)
    };
  }
}

async function previewChromeCdpTabs(config: ChromeCdpConfig): Promise<{
  tabs: ChromeCdpPreviewTab[];
  totalFiltered: number;
  totalUnfiltered: number;
  error?: string;
}> {
  try {
    const { targets } = await queryChromeCdpTargets();
    const pageTargets = targets.filter(isChromePageTarget);
    const filteredTargets = pageTargets.filter((target) => passesPagePolicy(target, config));

    return {
      tabs: filteredTargets.map((target) => ({
        targetId: target.targetId,
        title: target.title,
        url: target.url
      })),
      totalFiltered: Math.max(0, pageTargets.length - filteredTargets.length),
      totalUnfiltered: pageTargets.length
    };
  } catch (error) {
    return {
      tabs: [],
      totalFiltered: 0,
      totalUnfiltered: 0,
      error: toErrorMessage(error)
    };
  }
}

function parseChromeCdpConfigUpdateBody(value: unknown): ChromeCdpConfigUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const payload = value as Record<string, unknown>;
  const update: ChromeCdpConfigUpdate = {};

  if ("contextId" in payload) {
    const raw = payload.contextId;
    if (raw !== null && typeof raw !== "string") {
      throw new Error("contextId must be a string or null");
    }

    update.contextId = raw;
  }

  if ("urlAllow" in payload) {
    update.urlAllow = parsePatternArray(payload.urlAllow, "urlAllow");
  }

  if ("urlBlock" in payload) {
    update.urlBlock = parsePatternArray(payload.urlBlock, "urlBlock");
  }

  return update;
}

function parsePatternArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${fieldName} must be an array of strings`);
    }

    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }

    parsed.push(normalized);
  }

  return parsed;
}

function parsePatternListFromEnv(rawValue: string | undefined): string[] {
  if (typeof rawValue !== "string") {
    return [];
  }

  return normalizePatternList(rawValue.split(","));
}

function normalizePatternList(values: string[]): string[] {
  const deduped = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    deduped.add(normalized);
  }

  return Array.from(deduped);
}

function normalizeContextId(rawValue: string | null | undefined): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const normalized = rawValue.trim();
  return normalized.length > 0 ? normalized : null;
}

function isChromePageTarget(target: ChromeCdpTargetInfo): boolean {
  return target.type === "page" && !target.url.startsWith("chrome://");
}

function passesPagePolicy(target: ChromeCdpTargetInfo, config: ChromeCdpConfig): boolean {
  if (!passesContextPolicy(target, config.contextId)) {
    return false;
  }

  return passesUrlPolicy(target.url, config.urlAllow, config.urlBlock);
}

function passesContextPolicy(target: ChromeCdpTargetInfo, contextId: string | null): boolean {
  if (!contextId) {
    return true;
  }

  return (target.browserContextId ?? "").trim() === contextId;
}

function passesUrlPolicy(url: string, allowPatterns: string[], blockPatterns: string[]): boolean {
  if (allowPatterns.length > 0 && !matchesAnyPattern(url, allowPatterns)) {
    return false;
  }

  if (blockPatterns.length > 0 && matchesAnyPattern(url, blockPatterns)) {
    return false;
  }

  return true;
}

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(escaped, "i");
}

function parseBrowserVersion(versionInfo: ChromeCdpVersionInfo): {
  browser?: string;
  version?: string;
} {
  const raw = firstNonEmptyString(versionInfo.Browser, versionInfo.product);
  if (!raw) {
    return {};
  }

  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    return { browser: raw };
  }

  return {
    browser: raw.slice(0, slashIndex),
    version: raw.slice(slashIndex + 1)
  };
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const deduped = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    deduped.add(normalized);
  }

  return Array.from(deduped);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
