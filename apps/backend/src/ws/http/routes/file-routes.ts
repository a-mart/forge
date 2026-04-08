import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ServerEvent } from "@forge/protocol";
import {
  isPathWithinRoots,
  normalizeAllowlistRoots,
  resolveDirectoryPath
} from "../../../swarm/cwd-policy.js";
import { writeTrackedCortexPromptSurfaceFile } from "../../../swarm/cortex-prompt-surfaces.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  parseJsonBody,
  resolveReadFileContentType,
  sendJson
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const ATTACHMENT_ENDPOINT_PREFIX = "/api/attachments/";
const ATTACHMENT_METHODS = "GET, OPTIONS";
const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const READ_FILE_METHODS = "GET, POST, OPTIONS";
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

const WRITE_FILE_ENDPOINT_PATH = "/api/write-file";
const WRITE_FILE_METHODS = "POST, OPTIONS";
const MAX_WRITE_FILE_BODY_BYTES = 2 * 1024 * 1024;

interface FileAccessContext {
  rootDir: string;
  allowedRoots: string[];
}

export function normalizeFileAccessPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  if (/^\/+[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/^\/+/, "");
  }

  return trimmed;
}

function resolveFileAccessContext(swarmManager: SwarmManager, agentId?: string): FileAccessContext {
  const config = swarmManager.getConfig();
  const normalizedAgentId = agentId?.trim();
  const baseAllowedRoots = [config.paths.dataDir, config.paths.uploadsDir];

  if (!normalizedAgentId) {
    return {
      rootDir: config.paths.rootDir,
      allowedRoots: normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        ...baseAllowedRoots,
      ])
    };
  }

  const descriptor = swarmManager.getAgent(normalizedAgentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${normalizedAgentId}`);
  }

  const contextualRoots = [descriptor.cwd];
  if (descriptor.role === "worker") {
    const owner = swarmManager.getAgent(descriptor.managerId);
    if (owner?.role === "manager") {
      contextualRoots.push(owner.cwd);
    }
  }

  return {
    rootDir: descriptor.cwd,
    allowedRoots: normalizeAllowlistRoots([...contextualRoots, ...baseAllowedRoots])
  };
}

function resolveLegacyFileAccessContext(swarmManager: SwarmManager): FileAccessContext {
  const config = swarmManager.getConfig();
  return {
    rootDir: config.paths.rootDir,
    allowedRoots: normalizeAllowlistRoots([
      ...config.cwdAllowlistRoots,
      config.paths.rootDir,
      config.paths.dataDir,
      config.paths.uploadsDir,
      homedir(),
      tmpdir(),
    ])
  };
}

export function createFileRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent?: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  const resolveAllowedPath = async (requestedPath: string, agentId?: string): Promise<string> => {
    const accessContext = resolveFileAccessContext(swarmManager, agentId);
    const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
    const resolvedPath = resolveDirectoryPath(normalizedRequestedPath, accessContext.rootDir);

    if (await isPathWithinRoots(resolvedPath, accessContext.allowedRoots)) {
      return resolvedPath;
    }

    let existingAncestor = resolvedPath;
    while (true) {
      try {
        await stat(existingAncestor);
        break;
      } catch {
        const parentPath = dirname(existingAncestor);
        if (parentPath === existingAncestor) {
          break;
        }

        existingAncestor = parentPath;
      }
    }

    if (!(await isPathWithinRoots(existingAncestor, accessContext.allowedRoots))) {
      throw new Error("Path is outside allowed roots.");
    }

    return resolvedPath;
  };

  const resolveWriteAllowedPath = async (requestedPath: string): Promise<string> => {
    const accessContext = resolveLegacyFileAccessContext(swarmManager);
    const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
    const resolvedPath = resolveDirectoryPath(normalizedRequestedPath, accessContext.rootDir);

    if (await isPathWithinRoots(resolvedPath, accessContext.allowedRoots)) {
      return resolvedPath;
    }

    let existingAncestor = resolvedPath;
    while (true) {
      try {
        await stat(existingAncestor);
        break;
      } catch {
        const parentPath = dirname(existingAncestor);
        if (parentPath === existingAncestor) {
          break;
        }

        existingAncestor = parentPath;
      }
    }

    if (!(await isPathWithinRoots(existingAncestor, accessContext.allowedRoots))) {
      throw new Error("Path is outside allowed roots.");
    }

    return resolvedPath;
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

          if (request.method === "GET") {
            const pathFromQuery = requestUrl.searchParams.get("path");
            if (typeof pathFromQuery !== "string" || pathFromQuery.trim().length === 0) {
              sendJson(response, 400, { error: "path must be a non-empty string." });
              return;
            }
            requestedPath = pathFromQuery;
            const agentIdFromQuery = requestUrl.searchParams.get("agentId")?.trim();
            agentId = agentIdFromQuery ? agentIdFromQuery : undefined;
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
          }

          if (requestedPath.trim().length === 0) {
            sendJson(response, 400, { error: "path must be a non-empty string." });
            return;
          }

          const resolvedPath = await resolveAllowedPath(requestedPath, agentId);

          let fileStats;
          try {
            fileStats = await stat(resolvedPath);
          } catch {
            sendJson(response, 404, { error: "File not found." });
            return;
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

          if (message.includes("Path is outside allowed roots")) {
            sendJson(response, 403, { error: message });
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
    },
    {
      methods: WRITE_FILE_METHODS,
      matches: (pathname) => pathname === WRITE_FILE_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, WRITE_FILE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, WRITE_FILE_METHODS);
          response.setHeader("Allow", WRITE_FILE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, WRITE_FILE_METHODS);

        try {
          const payload = await parseJsonBody(request, MAX_WRITE_FILE_BODY_BYTES);
          if (!payload || typeof payload !== "object") {
            sendJson(response, 400, { error: "Request body must be a JSON object." });
            return;
          }

          const pathFromBody = (payload as { path?: unknown }).path;
          if (typeof pathFromBody !== "string" || pathFromBody.trim().length === 0) {
            sendJson(response, 400, { error: "path must be a non-empty string." });
            return;
          }

          const contentFromBody = (payload as { content?: unknown }).content;
          if (typeof contentFromBody !== "string") {
            sendJson(response, 400, { error: "content must be a string." });
            return;
          }

          const requestedVersioningSource = (payload as { versioningSource?: unknown }).versioningSource;
          const versioningSource = resolveWriteVersioningSource(requestedVersioningSource);

          const resolvedPath = await resolveWriteAllowedPath(pathFromBody);
          const trackedWrite = await maybeWriteTrackedCortexFile(
            swarmManager.getConfig().paths.dataDir,
            resolvedPath,
            contentFromBody,
            broadcastEvent,
          );

          if (!trackedWrite) {
            await mkdir(dirname(resolvedPath), { recursive: true });
            await writeFile(resolvedPath, contentFromBody, "utf8");
          }

          void swarmManager.getVersioningService()?.recordMutation({
            path: resolvedPath,
            action: "write",
            source: versioningSource
          }).catch(() => {
            // Fail open: file writes succeed even when versioning cannot record them.
          });

          sendJson(response, 200, {
            success: true,
            bytesWritten: trackedWrite?.bytesWritten ?? Buffer.byteLength(contentFromBody, "utf8")
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to write file.";

          if (message.includes("Path is outside allowed roots")) {
            sendJson(response, 403, { error: message });
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

function resolveWriteVersioningSource(rawValue: unknown): "api-write-file" | "api-write-file-restore" {
  if (rawValue === undefined) {
    return "api-write-file";
  }

  if (rawValue === "api-write-file" || rawValue === "api-write-file-restore") {
    return rawValue;
  }

  throw new Error("versioningSource must be one of: api-write-file, api-write-file-restore.");
}

async function maybeWriteTrackedCortexFile(
  dataDir: string,
  filePath: string,
  content: string,
  broadcastEvent?: (event: ServerEvent) => void,
): Promise<{ bytesWritten: number } | undefined> {
  try {
    return await writeTrackedCortexPromptSurfaceFile({
      dataDir,
      filePath,
      content,
      broadcastEvent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not a tracked Cortex prompt surface")) {
      return undefined;
    }
    throw error;
  }
}
