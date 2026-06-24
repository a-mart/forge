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
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
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
const FILE_RAW_METHODS = "GET, HEAD, OPTIONS";
const FILE_RAW_CORS_ALLOWED_HEADERS = "content-type, range";
const FILE_RAW_CORS_EXPOSE_HEADERS = "Accept-Ranges, Content-Length, Content-Range, Content-Type";
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
    },
    {
      methods: FILE_RAW_METHODS,
      matches: (pathname) => pathname === "/api/files/raw",
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyRawFileCorsHeaders(request, response);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          applyRawFileCorsHeaders(request, response);
          response.setHeader("Allow", FILE_RAW_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyRawFileCorsHeaders(request, response);

        try {
          const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
          const filePath = requireNonEmptyPathQuery(requestUrl.searchParams, "path");
          const { cwd } = await resolveFileBrowserContext(swarmManager, agentId, requestUrl);
          const rawFile = await service.resolveRawFile(cwd, filePath);
          const contentType = resolveRawFileContentType(filePath);
          const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : undefined;
          const parsedRange = parseBytesRangeHeader(rangeHeader, rawFile.size);

          response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", contentType);
          response.setHeader("X-Content-Type-Options", "nosniff");

          if (parsedRange === "unsatisfiable") {
            response.statusCode = 416;
            response.setHeader("Content-Range", `bytes */${rawFile.size}`);
            response.end();
            return;
          }

          if (parsedRange) {
            const { start, end } = parsedRange;
            const contentLength = end - start + 1;
            response.statusCode = 206;
            response.setHeader("Content-Range", `bytes ${start}-${end}/${rawFile.size}`);
            response.setHeader("Content-Length", String(contentLength));

            if (request.method === "HEAD") {
              response.end();
              return;
            }

            pipeRawFileStream(response, rawFile.resolvedPath, { start, end });
            return;
          }

          response.statusCode = 200;
          response.setHeader("Content-Length", String(rawFile.size));

          if (request.method === "HEAD") {
            response.end();
            return;
          }

          pipeRawFileStream(response, rawFile.resolvedPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : "File browser request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
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

function applyRawFileCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  applyCorsHeaders(request, response, FILE_RAW_METHODS, FILE_RAW_CORS_ALLOWED_HEADERS);
  response.setHeader("Access-Control-Expose-Headers", FILE_RAW_CORS_EXPOSE_HEADERS);
}

function resolveRawFileContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".pdf") {
    return "application/pdf";
  }

  return "application/octet-stream";
}

function sendRawFileJsonError(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  response.removeHeader("Content-Length");
  response.removeHeader("Content-Range");
  sendJson(response, statusCode, body);
}

function pipeRawFileStream(
  response: ServerResponse,
  resolvedPath: string,
  range?: { start: number; end: number }
): void {
  const stream = range
    ? createReadStream(resolvedPath, { start: range.start, end: range.end })
    : createReadStream(resolvedPath);

  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendRawFileJsonError(response, 500, {
        error: error instanceof Error ? error.message : "Unable to read file."
      });
      return;
    }

    response.destroy(error instanceof Error ? error : undefined);
  });
  stream.pipe(response);
}

export type ParsedBytesRange = { start: number; end: number };

function parseStrictUnsignedDecimal(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}

export function parseBytesRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number
): ParsedBytesRange | null | "unsatisfiable" {
  if (!rangeHeader || rangeHeader.trim().length === 0) {
    return null;
  }

  const normalized = rangeHeader.trim();
  if (!normalized.startsWith("bytes=")) {
    return "unsatisfiable";
  }

  const rangeValue = normalized.slice("bytes=".length);
  if (rangeValue.includes(",")) {
    return "unsatisfiable";
  }

  const rangeSpec = rangeValue.trim();
  if (!rangeSpec) {
    return "unsatisfiable";
  }

  const separatorIndex = rangeSpec.indexOf("-");
  if (separatorIndex === -1) {
    return "unsatisfiable";
  }

  const rawStart = rangeSpec.slice(0, separatorIndex);
  const rawEnd = rangeSpec.slice(separatorIndex + 1);

  if (fileSize === 0) {
    return "unsatisfiable";
  }

  if (rawStart.length === 0) {
    if (rawEnd.length === 0) {
      return "unsatisfiable";
    }

    const suffixLength = parseStrictUnsignedDecimal(rawEnd);
    if (suffixLength === null || suffixLength <= 0) {
      return "unsatisfiable";
    }

    const start = Math.max(fileSize - suffixLength, 0);
    return { start, end: fileSize - 1 };
  }

  const start = parseStrictUnsignedDecimal(rawStart);
  if (start === null) {
    return "unsatisfiable";
  }

  if (start >= fileSize) {
    return "unsatisfiable";
  }

  let end = fileSize - 1;
  if (rawEnd.length > 0) {
    const parsedEnd = parseStrictUnsignedDecimal(rawEnd);
    if (parsedEnd === null || parsedEnd < start) {
      return "unsatisfiable";
    }

    end = Math.min(parsedEnd, fileSize - 1);
  }

  return { start, end };
}
