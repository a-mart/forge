import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCorsHeaders, matchPathPattern, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MERMAID_PREVIEW_PREFIX = "/mermaid-preview";
const MERMAID_PREVIEW_ROOT_ENDPOINT = MERMAID_PREVIEW_PREFIX;
const MERMAID_PREVIEW_STANDALONE_ENDPOINT = `${MERMAID_PREVIEW_PREFIX}/`;
const MERMAID_PREVIEW_EMBED_ENDPOINT = `${MERMAID_PREVIEW_PREFIX}/embed`;
const MERMAID_PREVIEW_ASSET_PATH = /^\/mermaid-preview\/assets\/(.+)$/;

const STATIC_ASSET_ROOT = resolveMermaidPreviewStaticRoot();
const STATIC_ASSET_VENDORED_ROOT = resolve(STATIC_ASSET_ROOT, "assets");

function resolveMermaidPreviewStaticRoot(): string {
  const candidateRoots = [
    resolve(process.cwd(), "apps", "backend", "static", "mermaid-preview"),
    process.env.FORGE_RESOURCES_DIR?.trim()
      ? resolve(process.env.FORGE_RESOURCES_DIR.trim(), "apps", "backend", "static", "mermaid-preview")
      : null,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../static/mermaid-preview"),
  ];

  for (const candidateRoot of candidateRoots) {
    if (candidateRoot && existsSync(candidateRoot)) {
      return candidateRoot;
    }
  }

  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../static/mermaid-preview");
}

export function createMermaidPreviewRoutes(): HttpRoute[] {
  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) =>
        pathname === MERMAID_PREVIEW_ROOT_ENDPOINT ||
        pathname === MERMAID_PREVIEW_STANDALONE_ENDPOINT ||
        pathname === MERMAID_PREVIEW_EMBED_ENDPOINT,
      handle: async (request, response, requestUrl) => {
        await handleEmbedDocumentRequest(request, response, requestUrl);
      },
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => MERMAID_PREVIEW_ASSET_PATH.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleAssetRequest(request, response, requestUrl);
      },
    },
  ];
}

async function handleEmbedDocumentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (!beginMermaidPreviewRequest(request, response, "GET, OPTIONS")) {
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const themeMode = requestUrl.searchParams.get("theme") === "light" ? "light" : "dark";

  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Security-Policy", buildEmbedDocumentCsp());
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(buildEmbedDocumentHtml({ themeMode }));
}

async function handleAssetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (!beginMermaidPreviewRequest(request, response, "GET, OPTIONS")) {
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const match = matchPathPattern(requestUrl.pathname, MERMAID_PREVIEW_ASSET_PATH);
  if (!match) {
    sendJson(response, 404, { error: "Not Found" });
    return;
  }

  const relativePath = decodeURIComponent(match[1] ?? "");
  const assetPath = resolveStaticAssetPath(STATIC_ASSET_VENDORED_ROOT, relativePath);
  if (!assetPath) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(assetPath);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", resolveAssetContentType(assetPath));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Asset not found" });
  }
}

function beginMermaidPreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
): boolean {
  applyCorsHeaders(request, response, methods);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return false;
  }

  return true;
}

function resolveStaticAssetPath(rootPath: string, requestedPath: string): string | null {
  const normalizedPath = requestedPath.trim();
  if (!normalizedPath || normalizedPath.includes("\0")) {
    return null;
  }

  const resolvedPath = resolve(rootPath, normalizedPath);
  const relativeToRoot = relative(rootPath, resolvedPath);

  if (!relativeToRoot || relativeToRoot === ".") {
    return null;
  }

  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return null;
  }

  return resolvedPath;
}

function resolveAssetContentType(pathValue: string): string {
  switch (extname(pathValue).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function buildEmbedDocumentCsp(): string {
  // Mermaid's runtime requires 'unsafe-eval' (it uses Function("return this")()
  // to resolve the global object) and 'unsafe-inline' for style-src (it injects
  // <style> elements for diagram themes).  The iframe is sandboxed without
  // allow-same-origin and has connect-src 'none', so these grants are narrowly
  // scoped and safe.
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'self'",
    "form-action 'none'",
    "img-src data: blob:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
  ].join("; ");
}

function buildEmbedDocumentHtml(options: { themeMode: "light" | "dark" }): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>Forge Mermaid Preview</title>
    <link rel="stylesheet" href="${MERMAID_PREVIEW_PREFIX}/assets/embed.css" />
    <script src="${MERMAID_PREVIEW_PREFIX}/assets/vendor/mermaid.min.js"></script>
    <script type="module" src="${MERMAID_PREVIEW_PREFIX}/assets/embed.js"></script>
  </head>
  <body data-theme-mode="${options.themeMode}">
    <main id="app" class="mermaid-preview-shell" data-theme-mode="${options.themeMode}">
      <div class="mermaid-preview-status" id="status">Waiting for Mermaid source…</div>
      <div class="mermaid-preview-canvas" id="canvas" role="img" aria-label="Mermaid preview surface"></div>
    </main>
  </body>
</html>`;
}
