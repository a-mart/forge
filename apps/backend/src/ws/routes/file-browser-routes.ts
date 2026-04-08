import type {
  FileContentResult,
  FileCountResult,
  FileListResult,
  FileSearchResult,
} from "@forge/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import { FileBrowserService } from "./file-browser-service.js";
import type { HttpRoute } from "./http-route.js";
import { resolveCwdFromAgent } from "./route-utils.js";

const FILE_BROWSER_GET_METHODS = "GET, OPTIONS";
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

export function createFileBrowserRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;
  const service = new FileBrowserService();

  const handleGet = (
    endpoint: string,
    handler: (requestUrl: URL) => Promise<unknown>
  ): HttpRoute => ({
    methods: FILE_BROWSER_GET_METHODS,
    matches: (pathname) => pathname === endpoint,
    handle: async (request, response, requestUrl) => {
      if (request.method === "OPTIONS") {
        applyCorsHeaders(request, response, FILE_BROWSER_GET_METHODS);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method !== "GET") {
        applyCorsHeaders(request, response, FILE_BROWSER_GET_METHODS);
        response.setHeader("Allow", FILE_BROWSER_GET_METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }

      applyCorsHeaders(request, response, FILE_BROWSER_GET_METHODS);

      try {
        const payload = await handler(requestUrl);
        sendJson(response, 200, payload as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : "File browser request failed.";
        sendJson(response, resolveHttpStatusCode(message), { error: message });
      }
    }
  });

  return [
    handleGet("/api/files/list", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const requestedPath = requestUrl.searchParams.get("path")?.trim() ?? "";
      const cwd = resolveCwdFromAgent(swarmManager, agentId);
      const result: FileListResult = await service.listDirectory(cwd, requestedPath);
      return result;
    }),
    handleGet("/api/files/count", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const cwd = resolveCwdFromAgent(swarmManager, agentId);
      const result: FileCountResult = await service.getFileCount(cwd);
      return result;
    }),
    handleGet("/api/files/search", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const query = requireNonEmptyQuery(requestUrl.searchParams, "query");
      const limit = parseNumberParam(
        requestUrl.searchParams.get("limit"),
        DEFAULT_SEARCH_LIMIT,
        1,
        MAX_SEARCH_LIMIT,
        "limit"
      );
      const cwd = resolveCwdFromAgent(swarmManager, agentId);
      const result: FileSearchResult = await service.searchFiles(cwd, query, limit);
      return result;
    }),
    handleGet("/api/files/content", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const filePath = requireNonEmptyQuery(requestUrl.searchParams, "path");
      const cwd = resolveCwdFromAgent(swarmManager, agentId);
      const result: FileContentResult = await service.getFileContent(cwd, filePath);
      return result;
    })
  ];
}

function requireNonEmptyQuery(searchParams: URLSearchParams, key: string): string {
  const value = searchParams.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value.trim();
}

function parseNumberParam(
  rawValue: string | null,
  fallback: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function resolveHttpStatusCode(message: string): number {
  const normalized = message.toLowerCase();

  if (normalized.includes("outside cwd") || normalized.includes("not readable")) {
    return 403;
  }

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("no cwd")
  ) {
    return 400;
  }

  if (normalized.includes("unknown agent") || normalized.includes("not found")) {
    return 404;
  }

  return 500;
}
