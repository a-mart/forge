import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isPathWithinRoots } from "../../../swarm/cwd-policy.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  parseJsonBody,
  resolveReadFileContentType,
  sendJson
} from "../../http-utils.js";
import {
  MAX_READ_FILE_CONTENT_BYTES,
  resolveReadFilePath,
} from "../../ws-file-access.js";
import { resolveGitSourceControlContext } from "../shared/route-helpers.js";
import type { HttpRoute } from "../shared/http-route.js";

const ATTACHMENT_ENDPOINT_PREFIX = "/api/attachments/";
const ATTACHMENT_METHODS = "GET, OPTIONS";
const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const READ_FILE_METHODS = "GET, POST, OPTIONS";
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;

export function createFileRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  const resolveAllowedPath = async (
    requestedPath: string,
    agentId?: string,
    worktreeId?: string
  ): Promise<string> => {
    const normalizedWorktreeId = worktreeId?.trim();
    if (normalizedWorktreeId) {
      if (!agentId || agentId.trim().length === 0) {
        throw new Error("agentId is required when worktreeId is provided.");
      }

      const gitContext = await resolveGitSourceControlContext(
        swarmManager,
        agentId.trim(),
        "workspace",
        normalizedWorktreeId
      );
      const trimmedPath = requestedPath.trim();
      const resolvedPath = resolve(gitContext.cwd, trimmedPath.length > 0 ? trimmedPath : ".");
      if (!(await isPathWithinRoots(resolvedPath, [gitContext.cwd]))) {
        throw new Error("Path is outside CWD.");
      }

      return resolvedPath;
    }

    return resolveReadFilePath(requestedPath, swarmManager, agentId, {
      includeCwdAllowlistRootsForAgent: false,
    });
  };

  const resolveAttachmentPath = (fileRef: string): string => {
    const normalizedRef = basename(fileRef.trim());
    if (!normalizedRef || normalizedRef !== fileRef.trim() || !/^[A-Za-z0-9._-]+$/.test(normalizedRef)) {
      throw new Error("Invalid attachment reference.");
    }

    return join(swarmManager.getConfig().paths.uploadsDir, normalizedRef);
  };

  return [
    {
      methods: ATTACHMENT_METHODS,
      matches: (pathname) => pathname.startsWith(ATTACHMENT_ENDPOINT_PREFIX),
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, ATTACHMENT_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, ATTACHMENT_METHODS);
          response.setHeader("Allow", ATTACHMENT_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, ATTACHMENT_METHODS);

        try {
          const rawRef = decodeURIComponent(requestUrl.pathname.slice(ATTACHMENT_ENDPOINT_PREFIX.length));
          const resolvedPath = resolveAttachmentPath(rawRef);
          const fileStats = await stat(resolvedPath);

          if (!fileStats.isFile()) {
            sendJson(response, 404, { error: "Attachment not found." });
            return;
          }

          if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
            sendJson(response, 413, {
              error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
            });
            return;
          }

          const content = await readFile(resolvedPath);
          response.statusCode = 200;
          response.setHeader("Content-Type", resolveReadFileContentType(resolvedPath));
          response.setHeader("Content-Length", String(content.byteLength));
          response.setHeader("Cache-Control", "no-store");
          response.end(content);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to read attachment.";
          if (message.includes("Invalid attachment reference")) {
            sendJson(response, 400, { error: message });
            return;
          }

          sendJson(response, 404, { error: "Attachment not found." });
        }
      }
    },
    {
      methods: READ_FILE_METHODS,
      matches: (pathname) => pathname === READ_FILE_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, READ_FILE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST" && request.method !== "GET") {
          applyCorsHeaders(request, response, READ_FILE_METHODS);
          response.setHeader("Allow", READ_FILE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, READ_FILE_METHODS);

        try {
          let requestedPath = "";
          let agentId: string | undefined;
          let worktreeId: string | undefined;

          if (request.method === "GET") {
            const pathFromQuery = requestUrl.searchParams.get("path");
            if (typeof pathFromQuery !== "string" || pathFromQuery.trim().length === 0) {
              sendJson(response, 400, { error: "path must be a non-empty string." });
              return;
            }
            requestedPath = pathFromQuery;
            const agentIdFromQuery = requestUrl.searchParams.get("agentId")?.trim();
            agentId = agentIdFromQuery ? agentIdFromQuery : undefined;
            const worktreeIdFromQuery = requestUrl.searchParams.get("worktreeId")?.trim();
            worktreeId = worktreeIdFromQuery ? worktreeIdFromQuery : undefined;
          } else {
            const payload = await parseJsonBody(request, MAX_READ_FILE_BODY_BYTES);
            if (!payload || typeof payload !== "object") {
              sendJson(response, 400, { error: "Request body must be a JSON object." });
              return;
            }

            const pathFromBody = (payload as { path?: unknown }).path;
            if (typeof pathFromBody !== "string" || pathFromBody.trim().length === 0) {
              sendJson(response, 400, { error: "path must be a non-empty string." });
              return;
            }

            requestedPath = pathFromBody;
            const agentIdFromBody = (payload as { agentId?: unknown }).agentId;
            if (typeof agentIdFromBody === "string" && agentIdFromBody.trim().length > 0) {
              agentId = agentIdFromBody.trim();
            }
            const worktreeIdFromBody = (payload as { worktreeId?: unknown }).worktreeId;
            if (typeof worktreeIdFromBody === "string" && worktreeIdFromBody.trim().length > 0) {
              worktreeId = worktreeIdFromBody.trim();
            }
          }

          if (requestedPath.trim().length === 0) {
            sendJson(response, 400, { error: "path must be a non-empty string." });
            return;
          }

          const resolvedPath = await resolveAllowedPath(requestedPath, agentId, worktreeId);

          let fileStats;
          try {
            fileStats = await stat(resolvedPath);
          } catch (error) {
            if ((error as { code?: unknown }).code === "ENOENT") {
              sendJson(response, 404, { error: "File not found." });
              return;
            }
            throw error;
          }

          if (!fileStats.isFile()) {
            sendJson(response, 400, { error: "Requested path must point to a file." });
            return;
          }

          if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
            sendJson(response, 413, {
              error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
            });
            return;
          }

          if (request.method === "GET") {
            const content = await readFile(resolvedPath);
            response.statusCode = 200;
            response.setHeader("Content-Type", resolveReadFileContentType(resolvedPath));
            response.setHeader("Content-Length", String(content.byteLength));
            response.setHeader("Cache-Control", "no-store");
            response.end(content);
            return;
          }

          const content = await readFile(resolvedPath, "utf8");
          sendJson(response, 200, {
            path: resolvedPath,
            content
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to read file.";

          if (message.includes("Unknown agent")) {
            sendJson(response, 404, { error: message });
            return;
          }

          if (
            message.includes("Unknown or invalid worktreeId") ||
            message.includes("worktreeId is not supported") ||
            message.includes("agentId is required when worktreeId is provided")
          ) {
            sendJson(response, 400, { error: message });
            return;
          }

          if (message.includes("Path is outside allowed roots") || message.includes("Path is outside CWD.")) {
            sendJson(response, 403, { error: message, code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
            return;
          }

          if (message.includes("Request body exceeds")) {
            sendJson(response, 413, { error: message });
            return;
          }

          if (message.includes("valid JSON")) {
            sendJson(response, 400, { error: message });
            return;
          }

          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}
