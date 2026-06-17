import type {
  FileBrowserSourceContext,
  FileContentResult,
  FileCountResult,
  FileDeleteResponse,
  FileListResult,
  FileSaveRequest,
  FileSaveResponse,
  FileSearchResult,
  FileVersionToken,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../../http-utils.js";
import {
  FileBrowserService,
  MAX_FILE_SAVE_BODY_BYTES,
  MAX_FILE_SAVE_BYTES,
} from "../services/file-browser-service.js";
import type { HttpRoute } from "../shared/http-route.js";
import {
  resolveCwdFromAgent,
  resolveGitSourceControlContext,
} from "../shared/route-helpers.js";

const FILE_BROWSER_GET_METHODS = "GET, OPTIONS";
const FILE_CONTENT_METHODS = "GET, PUT, DELETE, OPTIONS";
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
      const requestedPath = requestUrl.searchParams.get("path") ?? "";
      const { cwd, context } = await resolveFileBrowserContext(swarmManager, agentId, requestUrl);
      const result: FileListResult = await service.listDirectory(cwd, requestedPath);
      return attachFileBrowserContext(result, context);
    }),
    handleGet("/api/files/count", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const { cwd } = await resolveFileBrowserContext(swarmManager, agentId, requestUrl);
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
      const { cwd } = await resolveFileBrowserContext(swarmManager, agentId, requestUrl);
      const result: FileSearchResult = await service.searchFiles(cwd, query, limit);
      return result;
    }),
    {
      methods: FILE_CONTENT_METHODS,
      matches: (pathname) => pathname === "/api/files/content",
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, FILE_CONTENT_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method === "GET") {
          applyCorsHeaders(request, response, FILE_CONTENT_METHODS);

          try {
            const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
            const filePath = requireNonEmptyPathQuery(requestUrl.searchParams, "path");
            const { cwd } = await resolveFileBrowserContext(swarmManager, agentId, requestUrl);
            const result: FileContentResult = await service.getFileContent(cwd, filePath);
            sendJson(response, 200, result as unknown as Record<string, unknown>);
          } catch (error) {
            const message = error instanceof Error ? error.message : "File browser request failed.";
            sendJson(response, resolveHttpStatusCode(message), { error: message });
          }
          return;
        }

        if (request.method === "PUT") {
          applyCorsHeaders(request, response, FILE_CONTENT_METHODS);
          await handlePutFileContent(request, response, swarmManager, service);
          return;
        }

        if (request.method === "DELETE") {
          applyCorsHeaders(request, response, FILE_CONTENT_METHODS);
          await handleDeleteFileContent(request, response, swarmManager, service, requestUrl);
          return;
        }

        applyCorsHeaders(request, response, FILE_CONTENT_METHODS);
        response.setHeader("Allow", FILE_CONTENT_METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
      }
    }
  ];
}

async function handlePutFileContent(
  request: IncomingMessage,
  response: ServerResponse,
  swarmManager: SwarmManager,
  service: FileBrowserService
): Promise<void> {
  try {
    const payload = await parseJsonBody(request, MAX_FILE_SAVE_BODY_BYTES);
    if (!payload || typeof payload !== "object") {
      sendJson(response, 400, { error: "Request body must be a JSON object." });
      return;
    }

    const saveRequest = payload as Partial<FileSaveRequest>;
    const agentId = saveRequest.agentId;
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      sendJson(response, 400, { error: "agentId must be a non-empty string." });
      return;
    }

    const filePath = saveRequest.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      sendJson(response, 400, { error: "path must be a non-empty string." });
      return;
    }

    if (typeof saveRequest.content !== "string") {
      sendJson(response, 400, { error: "content must be a string." });
      return;
    }

    if (!isValidFileVersionToken(saveRequest.baseVersion)) {
      sendJson(response, 400, { error: "baseVersion must be a valid file version token." });
      return;
    }

    const contentBytes = Buffer.byteLength(saveRequest.content, "utf8");
    if (contentBytes > MAX_FILE_SAVE_BYTES) {
      sendJson(response, 413, { error: `Save content exceeds ${MAX_FILE_SAVE_BYTES} byte limit.` });
      return;
    }

    const normalizedAgentId = agentId.trim();
    const { cwd } = await resolveFileBrowserContextByWorktree(
      swarmManager,
      normalizedAgentId,
      saveRequest.worktreeId
    );

    const overwrite = saveRequest.overwrite === true;
    const result: FileSaveResponse = await service.saveFileContent({
      cwd,
      relativePath: filePath,
      content: saveRequest.content,
      baseVersion: saveRequest.baseVersion,
      overwrite,
      onSaved: ({ resolvedPath }) => {
        try {
          const versioningService = swarmManager.getVersioningService();
          if (!versioningService) {
            return;
          }

          let tracked = false;
          try {
            tracked = versioningService.isTrackedPath(resolvedPath);
          } catch {
            return;
          }

          if (!tracked) {
            return;
          }

          void versioningService.recordMutation({
            path: resolvedPath,
            action: "write",
            source: "api-write-file",
            agentId: normalizedAgentId
          }).catch(() => {
            // Fail open: editor saves succeed even when versioning cannot record them.
          });
        } catch {
          // Fail open: lookup/isTrackedPath/getVersioningService failures must not fail the save.
        }
      }
    });

    if (!result.success) {
      sendJson(response, 409, result as unknown as Record<string, unknown>);
      return;
    }

    sendJson(response, 200, result as unknown as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save file.";
    sendJson(response, resolveSaveHttpStatusCode(message), { error: message });
  }
}

async function handleDeleteFileContent(
  _request: IncomingMessage,
  response: ServerResponse,
  swarmManager: SwarmManager,
  service: FileBrowserService,
  requestUrl: URL
): Promise<void> {
  try {
    const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
    const filePath = requireNonEmptyPathQuery(requestUrl.searchParams, "path");
    const worktreeId = optionalTrimmedQuery(requestUrl.searchParams.get("worktreeId"));
    const { cwd } = await resolveFileBrowserContextByWorktree(swarmManager, agentId, worktreeId);

    const result: FileDeleteResponse = await service.deletePath(cwd, filePath, ({ resolvedPath }) => {
      try {
        const versioningService = swarmManager.getVersioningService();
        if (!versioningService) {
          return;
        }

        let tracked = false;
        try {
          tracked = versioningService.isTrackedPath(resolvedPath);
        } catch {
          return;
        }

        if (!tracked) {
          return;
        }

        void versioningService.recordMutation({
          path: resolvedPath,
          action: "delete",
          source: "api-write-file",
          agentId,
        }).catch(() => {
          // Fail open: editor deletes succeed even when versioning cannot record them.
        });
      } catch {
        // Fail open: lookup/isTrackedPath/getVersioningService failures must not fail the delete.
      }
    });

    sendJson(response, 200, result as unknown as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete file.";
    sendJson(response, resolveHttpStatusCode(message), { error: message });
  }
}

async function resolveFileBrowserContext(
  swarmManager: SwarmManager,
  agentId: string,
  requestUrl: URL
): Promise<{ cwd: string; context: FileBrowserSourceContext }> {
  const worktreeId = optionalTrimmedQuery(requestUrl.searchParams.get("worktreeId"));
  return resolveFileBrowserContextByWorktree(swarmManager, agentId, worktreeId);
}

async function resolveFileBrowserContextByWorktree(
  swarmManager: SwarmManager,
  agentId: string,
  worktreeId?: string | null
): Promise<{ cwd: string; context: FileBrowserSourceContext }> {
  const sessionCwd = resolveCwdFromAgent(swarmManager, agentId);
  const normalizedWorktreeId = optionalTrimmedQuery(
    typeof worktreeId === "string" ? worktreeId : null
  );

  if (!normalizedWorktreeId) {
    return {
      cwd: sessionCwd,
      context: {
        kind: "workspace",
        isSessionCwd: true
      }
    };
  }

  const gitContext = await resolveGitSourceControlContext(swarmManager, agentId, "workspace", normalizedWorktreeId);
  return {
    cwd: gitContext.cwd,
    context: {
      kind: "worktree",
      worktreeId: gitContext.worktreeId,
      worktreePath: gitContext.worktreePath,
      isSessionCwd: false
    }
  };
}

function attachFileBrowserContext(
  result: FileListResult,
  context: FileBrowserSourceContext
): FileListResult {
  return {
    ...result,
    context
  };
}

function isValidFileVersionToken(value: unknown): value is FileVersionToken {
  if (!value || typeof value !== "object") {
    return false;
  }

  const token = value as FileVersionToken;
  return (
    token.kind === "sha256-stat-v1" &&
    typeof token.sha256 === "string" &&
    token.sha256.length > 0 &&
    typeof token.size === "number" &&
    Number.isFinite(token.size) &&
    typeof token.mtimeMs === "number" &&
    Number.isFinite(token.mtimeMs)
  );
}

function optionalTrimmedQuery(value: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireNonEmptyPathQuery(searchParams: URLSearchParams, key: string): string {
  const value = searchParams.get(key);
  if (value === null || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value;
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

  if (normalized.includes("outside cwd") || normalized.includes("not readable") || normalized.includes("not writable")) {
    return 403;
  }

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("cannot delete") ||
    normalized.includes("unknown or invalid worktreeid") ||
    normalized.includes("no cwd")
  ) {
    return 400;
  }

  if (normalized.includes("too large") || normalized.includes("exceeds")) {
    return 413;
  }

  if (normalized.includes("unknown agent") || normalized.includes("not found")) {
    return 404;
  }

  return 500;
}

function resolveSaveHttpStatusCode(message: string): number {
  if (message.includes("Request body exceeds")) {
    return 413;
  }

  if (message.includes("Save content exceeds")) {
    return 413;
  }

  return resolveHttpStatusCode(message);
}
