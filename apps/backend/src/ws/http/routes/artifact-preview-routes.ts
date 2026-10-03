import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HTML_ARTIFACT_PREVIEW_ENDPOINT, HTML_ARTIFACT_PREVIEW_PATH_PREFIX } from "@forge/protocol";
import { getCollaborationRequestAuthContext } from "../../../collaboration/auth/collaboration-auth-middleware.js";
import {
  HtmlArtifactPreviewError,
  HtmlArtifactPreviewStore,
  buildHtmlArtifactPreviewCsp,
  htmlArtifactPreviewStatus,
} from "../../../swarm/session/html-artifact-preview.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../../http-utils.js";
import {
  invalidHtmlArtifactPreviewRequest,
  issueHtmlArtifactPreview,
  type HtmlArtifactPreviewSource,
} from "../services/html-artifact-preview-service.js";
import type { HttpRoute } from "../shared/http-route.js";

const ISSUE_METHODS = "POST, OPTIONS";
const MAX_ISSUE_BODY_BYTES = 64 * 1024;

export function createArtifactPreviewRoutes(options: {
  swarmManager: HtmlArtifactPreviewSource;
  previewStore?: HtmlArtifactPreviewStore;
}): HttpRoute[] {
  const store = options.previewStore ?? new HtmlArtifactPreviewStore();
  return [
    {
      methods: ISSUE_METHODS,
      matches: (pathname) => pathname === HTML_ARTIFACT_PREVIEW_ENDPOINT,
      handle: async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        applyCorsHeaders(request, response, ISSUE_METHODS);
        if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
        if (request.method !== "POST") {
          response.setHeader("Allow", ISSUE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        let payload: unknown;
        try { payload = await parseJsonBody(request, MAX_ISSUE_BODY_BYTES); } catch { sendJson(response, 400, invalidHtmlArtifactPreviewRequest().body); return; }
        const authBinding = getCollaborationRequestAuthContext(request)?.userId;
        const result = await issueHtmlArtifactPreview({
          source: options.swarmManager,
          store,
          payload,
          ...(authBinding ? { authBinding } : {}),
          includeCwdAllowlistRootsForAgent: false,
        });
        sendJson(response, result.status, result.body);
      },
    },
    {
      methods: "GET, HEAD",
      matches: (pathname) => pathname.startsWith(HTML_ARTIFACT_PREVIEW_PATH_PREFIX),
      handle: async (request, response, requestUrl) => {
        const rest = requestUrl.pathname.slice(HTML_ARTIFACT_PREVIEW_PATH_PREFIX.length);
        const slash = rest.indexOf("/");
        const token = slash === -1 ? rest : rest.slice(0, slash);
        const relativePath = slash === -1 ? "" : rest.slice(slash + 1);
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("Allow", "GET, HEAD");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const authBinding = getCollaborationRequestAuthContext(request)?.userId;
          const asset = await store.resolveAsset(token, relativePath, authBinding);
          sendAsset(request, response, asset, `${requestOrigin(request)}${HTML_ARTIFACT_PREVIEW_PATH_PREFIX}${token}/`);
        } catch (error) {
          const code = error instanceof HtmlArtifactPreviewError ? error.code : "not_found";
          response.setHeader("Cache-Control", "no-store");
          sendJson(response, htmlArtifactPreviewStatus(code), { error: code, code });
        }
      },
    },
  ];
}

function requestOrigin(request: IncomingMessage): string {
  const encrypted = (request.socket as { encrypted?: boolean }).encrypted === true;
  return `${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
}

function sendAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: { path: string; contentType: string; size: number },
  scope: string,
): void {
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Content-Security-Policy", buildHtmlArtifactPreviewCsp(scope));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  // No credentials: the token in the URL is the capability.
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Accept-Ranges", "bytes");

  let start = 0;
  let end = asset.size - 1;
  const range = typeof request.headers.range === "string" ? request.headers.range.trim() : "";
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const parsed = match ? parseRange(match[1] ?? "", match[2] ?? "", asset.size) : null;
    if (!parsed) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${asset.size}`);
      response.end();
      return;
    }
    ({ start, end } = parsed);
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${asset.size}`);
  } else {
    response.statusCode = 200;
  }

  const length = asset.size === 0 ? 0 : end - start + 1;
  response.setHeader("Content-Length", String(length));
  if (request.method === "HEAD" || length === 0) { response.end(); return; }
  const stream = createReadStream(asset.path, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

function parseRange(rawStart: string, rawEnd: string, size: number): { start: number; end: number } | null {
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return { start, end };
}
