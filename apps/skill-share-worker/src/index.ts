import type { SkillBundleManifestV1 } from "@forge/protocol";
import {
  HARD_MAX_REQUEST_BYTES,
  OBJECT_PREFIX,
  loadWorkerConfig,
  type WorkerConfig
} from "./config.js";
import { getClientIp, InMemoryRateLimiter } from "./rate-limit.js";
import { createShareToken, verifyShareToken } from "./token.js";
import type { ExecutionContextLike, R2BucketBinding, R2ObjectBody, ScheduledControllerLike, SkillShareEnv } from "./types.js";
import { validateSkillBundleForStorage } from "./bundle-validation.js";

interface WorkerState {
  uploadRateLimiter: InMemoryRateLimiter;
  downloadRateLimiter: InMemoryRateLimiter;
  now: () => number;
}

const DEFAULT_STATE: WorkerState = createWorkerState();

export function createWorkerState(options: { now?: () => number } = {}): WorkerState {
  return {
    uploadRateLimiter: new InMemoryRateLimiter(),
    downloadRateLimiter: new InMemoryRateLimiter(),
    now: options.now ?? (() => Date.now())
  };
}

export function createSkillShareWorker(state: WorkerState = DEFAULT_STATE) {
  return {
    fetch: (request: Request, env: SkillShareEnv, _ctx?: ExecutionContextLike) => handleRequest(request, env, state),
    scheduled: (_controller: ScheduledControllerLike, env: SkillShareEnv, ctx?: ExecutionContextLike) => {
      const cleanup = cleanupExpiredObjects(env.SKILL_SHARES_BUCKET, state.now());
      ctx?.waitUntil(cleanup);
      return cleanup;
    }
  };
}

export default createSkillShareWorker();

async function handleRequest(request: Request, env: SkillShareEnv, state: WorkerState): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(env);
  } catch {
    return jsonResponse({ error: "Skill share service is not configured." }, 503);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/skill-shares") {
    return handleUpload(request, env.SKILL_SHARES_BUCKET, config, state);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v1/skill-shares/")) {
    const token = decodePathToken(url.pathname.slice("/api/v1/skill-shares/".length));
    return token ? handleJsonDownload(request, token, env.SKILL_SHARES_BUCKET, config, state) : jsonResponse({ error: "Not found." }, 404);
  }

  if (request.method === "GET" && url.pathname.startsWith("/s/")) {
    const token = decodePathToken(url.pathname.slice("/s/".length));
    return token ? handleShareLandingOrDownload(request, token, env.SKILL_SHARES_BUCKET, config, state) : jsonResponse({ error: "Not found." }, 404);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

async function handleUpload(
  request: Request,
  bucket: R2BucketBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
  const rateLimit = state.uploadRateLimiter.check(getClientIp(request), config.uploadRateLimitPerMinute, state.now());
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds ?? 60);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > config.maxRequestBytes) {
    return jsonResponse({ error: "Request body too large." }, 413);
  }

  let bodyText: string;
  try {
    bodyText = await readRequestTextWithLimit(request, config.maxRequestBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request body too large.";
    return jsonResponse({ error: message }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const candidateBundle = isRecord(parsed) && "bundle" in parsed ? parsed.bundle : parsed;
  const validation = await validateSkillBundleForStorage(candidateBundle, {
    maxBundleBytes: config.maxBundleBytes,
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles
  });
  if (!validation.valid) {
    return jsonResponse({ error: "Invalid skill bundle.", details: validation.errors.slice(0, 10) }, 400);
  }

  const bundle = candidateBundle as SkillBundleManifestV1;
  const objectJson = JSON.stringify(bundle);
  if (new TextEncoder().encode(objectJson).byteLength > config.maxRequestBytes) {
    return jsonResponse({ error: "Stored bundle object would exceed request cap." }, 413);
  }

  const shareId = crypto.randomUUID();
  const nowMs = state.now();
  const expiresAtMs = nowMs + config.shareTtlSeconds * 1000;
  const token = await createShareToken({ shareId, expiresAtMs, secret: config.tokenSecret });
  const shareUrl = `${resolvePublicBaseUrl(config, request)}/s/${encodeURIComponent(token)}`;
  const importUrl = `forge://skill-import?url=${encodeURIComponent(shareUrl)}`;
  await bucket.put(`${OBJECT_PREFIX}${shareId}.json`, objectJson, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "no-store"
    },
    customMetadata: {
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      contentSha256: validation.contentSha256 ?? bundle.contentSha256,
      skillHandle: validation.skillHandle ?? bundle.skill.handle,
      originPlatform: validation.originPlatform ?? bundle.origin.platform
    }
  });

  return jsonResponse({
    shareUrl,
    importUrl,
    expiresAt: new Date(expiresAtMs).toISOString(),
    contentSha256: validation.contentSha256 ?? bundle.contentSha256
  }, 201);
}

async function handleJsonDownload(
  request: Request,
  token: string,
  bucket: R2BucketBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
  const result = await loadSharedObject(token, bucket, config, state, getClientIp(request));
  if (!result.ok) {
    return jsonResponse({ error: result.status === 410 ? "Share link expired." : "Not found." }, result.status);
  }

  return bundleJsonResponse(result.objectText, result.bundle);
}

async function handleShareLandingOrDownload(
  request: Request,
  token: string,
  bucket: R2BucketBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
  const result = await loadSharedObject(token, bucket, config, state, getClientIp(request));
  if (!result.ok) {
    return result.status === 410
      ? htmlResponse(renderExpiredPage(), 410)
      : htmlResponse(renderNotFoundPage(), 404);
  }

  const url = new URL(request.url);
  const wantsJson = request.headers.get("accept")?.includes("application/json") || url.searchParams.get("download") === "1";
  if (wantsJson) {
    return bundleJsonResponse(result.objectText, result.bundle);
  }

  const shareUrl = `${resolvePublicBaseUrl(config, request)}/s/${encodeURIComponent(token)}`;
  const importUrl = `forge://skill-import?url=${encodeURIComponent(shareUrl)}`;
  return htmlResponse(renderLandingPage({ bundle: result.bundle, shareUrl, importUrl }));
}

async function loadSharedObject(
  token: string,
  bucket: R2BucketBinding,
  config: WorkerConfig,
  state: WorkerState,
  rateLimitKey: string
): Promise<
  | { ok: true; bundle: SkillBundleManifestV1; object: R2ObjectBody; objectText: string }
  | { ok: false; status: 404 | 410 }
> {
  const rateLimit = state.downloadRateLimiter.check(rateLimitKey, config.downloadRateLimitPerMinute, state.now());
  if (!rateLimit.allowed) {
    return { ok: false, status: 404 };
  }

  const verification = await verifyShareToken(token, config.tokenSecret, state.now());
  if (!verification.ok) {
    if (verification.status === 410 && verification.id) {
      await bucket.delete(`${OBJECT_PREFIX}${verification.id}.json`);
    }
    return { ok: false, status: verification.status };
  }

  const objectKey = `${OBJECT_PREFIX}${verification.id}.json`;
  const object = await bucket.get(objectKey);
  if (!object) {
    return { ok: false, status: 404 };
  }

  const metadataExpiresAtMs = Date.parse(object.customMetadata?.expiresAt ?? "");
  if (!Number.isFinite(metadataExpiresAtMs) || metadataExpiresAtMs <= state.now()) {
    await bucket.delete(objectKey);
    return { ok: false, status: 410 };
  }

  const objectText = await object.text();
  const bundle = JSON.parse(objectText) as SkillBundleManifestV1;
  return { ok: true, bundle, object, objectText };
}

export async function cleanupExpiredObjects(bucket: R2BucketBinding, nowMs: number): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: OBJECT_PREFIX, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const expiresAt = Date.parse(object.customMetadata?.expiresAt ?? "");
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        await bucket.delete(object.key);
        deleted += 1;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > Math.min(maxBytes, HARD_MAX_REQUEST_BYTES)) {
      throw new Error("Request body too large.");
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function bundleJsonResponse(objectText: string, bundle: SkillBundleManifestV1): Response {
  return new Response(objectText, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${safeAttachmentName(bundle.skill.handle)}.forge-skill.json"`,
      ...corsHeaders()
    }
  });
}

function renderLandingPage(options: { bundle: SkillBundleManifestV1; shareUrl: string; importUrl: string }): string {
  const { bundle, shareUrl, importUrl } = options;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forge skill share</title>${styleTag()}</head>
<body>
  <main>
    <p class="eyebrow">Forge skill share</p>
    <h1>${escapeHtml(bundle.skill.name)}</h1>
    ${bundle.skill.description ? `<p>${escapeHtml(bundle.skill.description)}</p>` : ""}
    <p class="warning">Anyone with this link can download and import this skill until the link expires. Review scripts, dependencies, and environment variables in Forge before installing.</p>
    <a class="button" href="${escapeHtml(importUrl)}">Open in Forge</a>
    <p class="fallback">If Forge does not open, copy this URL and paste it in Settings &gt; Skills &gt; Import from URL.</p>
    <code>${escapeHtml(shareUrl)}</code>
  </main>
</body>
</html>`;
}

function renderExpiredPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forge skill share expired</title>${styleTag()}</head><body><main><h1>Share link expired</h1><p>This temporary Forge skill share is no longer available.</p></main></body></html>`;
}

function renderNotFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forge skill share not found</title>${styleTag()}</head><body><main><h1>Share not found</h1><p>This Forge skill share link is invalid or unavailable.</p></main></body></html>`;
}

function styleTag(): string {
  return `<style>body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:42rem;margin:2rem;padding:2rem;background:#111827;border:1px solid #334155;border-radius:18px}.eyebrow{color:#93c5fd;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem}.warning{background:#1f2937;border:1px solid #475569;border-radius:12px;padding:1rem}.button{display:inline-block;background:#8b5cf6;color:white;text-decoration:none;padding:.8rem 1rem;border-radius:10px;font-weight:700}code{display:block;white-space:pre-wrap;word-break:break-all;background:#020617;padding:.75rem;border-radius:10px}</style>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders()
    }
  });
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds),
      ...corsHeaders()
    }
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function resolvePublicBaseUrl(config: WorkerConfig, request: Request): string {
  return (config.publicBaseUrl ?? new URL(request.url).origin).replace(/\/+$/u, "");
}

function decodePathToken(token: string): string | undefined {
  if (!token || token.includes("/")) return undefined;
  try {
    return decodeURIComponent(token);
  } catch {
    return undefined;
  }
}

function safeAttachmentName(handle: string): string {
  return handle.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "skill";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
