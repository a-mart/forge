import type { SkillBundleIssue, SkillBundleManifestV1 } from "@forge/protocol";
import {
  HARD_MAX_REQUEST_BYTES,
  OBJECT_PREFIX,
  loadWorkerConfig,
  type WorkerConfig
} from "./config.js";
import { getClientIp } from "./rate-limit.js";
import { createShareToken, verifyShareToken } from "./token.js";
import type { DurableObjectNamespaceBinding, ExecutionContextLike, R2BucketBinding, R2ObjectBody, ScheduledControllerLike, SkillShareEnv } from "./types.js";
import { validateSkillBundleForStorage } from "./bundle-validation.js";

export { SkillShareLimiter } from "./limiter-do.js";

interface WorkerState {
  now: () => number;
}

const DEFAULT_STATE: WorkerState = createWorkerState();

export function createWorkerState(options: { now?: () => number } = {}): WorkerState {
  return {
    now: options.now ?? (() => Date.now())
  };
}

export function createSkillShareWorker(state: WorkerState = DEFAULT_STATE) {
  return {
    fetch: (request: Request, env: SkillShareEnv, _ctx?: ExecutionContextLike) => handleRequest(request, env, state),
    scheduled: (_controller: ScheduledControllerLike, env: SkillShareEnv, ctx?: ExecutionContextLike) => {
      const cleanup = cleanupExpiredObjects(env.SKILL_SHARES_BUCKET, env.SHARE_LIMITER, state.now());
      ctx?.waitUntil(cleanup);
      return cleanup;
    }
  };
}

export default createSkillShareWorker();

async function handleRequest(request: Request, env: SkillShareEnv, state: WorkerState): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...securityHeaders("api"), ...corsHeaders() } });
  }

  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(env);
  } catch {
    return jsonResponse({ error: "Skill share service is not configured." }, 503);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/skill-shares") {
    if (!env.SHARE_LIMITER) return jsonResponse({ error: "Skill share limiter binding is required." }, 503);
    return handleUpload(request, env.SKILL_SHARES_BUCKET, env.SHARE_LIMITER, config, state);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v1/skill-shares/")) {
    const token = decodePathToken(url.pathname.slice("/api/v1/skill-shares/".length));
    if (!env.SHARE_LIMITER) return jsonResponse({ error: "Skill share limiter binding is required." }, 503);
    return token ? handleJsonDownload(token, env.SKILL_SHARES_BUCKET, env.SHARE_LIMITER, config, state) : jsonResponse({ error: "Not found." }, 404);
  }

  if (request.method === "GET" && url.pathname.startsWith("/s/")) {
    const token = decodePathToken(url.pathname.slice("/s/".length));
    if (!env.SHARE_LIMITER) return htmlResponse(renderServiceUnavailablePage(), 503);
    return token ? handleShareLandingOrDownload(request, token, env.SKILL_SHARES_BUCKET, env.SHARE_LIMITER, config, state) : jsonResponse({ error: "Not found." }, 404);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

async function handleUpload(
  request: Request,
  bucket: R2BucketBinding,
  limiter: DurableObjectNamespaceBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
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
  const objectBytes = new TextEncoder().encode(objectJson).byteLength;
  if (objectBytes > config.maxRequestBytes) {
    return jsonResponse({ error: "Stored bundle object would exceed request cap." }, 413);
  }

  const shareId = crypto.randomUUID();
  const nowMs = state.now();
  const expiresAtMs = nowMs + config.shareTtlSeconds * 1000;
  const reservation = await reserveUpload(limiter, {
    ip: getClientIp(request),
    shareId,
    bytes: objectBytes,
    expiresAtMs,
    nowMs,
    uploadRateLimitPerMinute: config.uploadRateLimitPerMinute,
    maxActiveObjects: config.maxActiveObjects,
    maxActiveStorageBytes: config.maxActiveStorageBytes
  });
  if (!reservation.ok) {
    return limiterFailureResponse(reservation, "upload");
  }
  const token = await createShareToken({ shareId, expiresAtMs, secret: config.tokenSecret });
  const shareUrl = `${resolvePublicBaseUrl(config, request)}/s/${encodeURIComponent(token)}`;
  const importUrl = `forge://skill-import?url=${encodeURIComponent(shareUrl)}`;
  try {
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
        originPlatform: validation.originPlatform ?? bundle.origin.platform,
        bytes: String(objectBytes)
      }
    });
  } catch {
    await releaseShare(limiter, shareId);
    return jsonResponse({ error: "Unable to store skill share." }, 502);
  }

  return jsonResponse({
    shareUrl,
    importUrl,
    expiresAt: new Date(expiresAtMs).toISOString(),
    contentSha256: validation.contentSha256 ?? bundle.contentSha256,
    warnings: projectBundleWarnings(bundle)
  }, 201);
}

async function handleJsonDownload(
  token: string,
  bucket: R2BucketBinding,
  limiter: DurableObjectNamespaceBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
  const result = await loadSharedObject(token, bucket, limiter, config, state);
  if (!result.ok) {
    return result.status === 429
      ? rateLimitResponse(result.retryAfterSeconds ?? 60, loadFailureMessage(result.status))
      : jsonResponse({ error: loadFailureMessage(result.status) }, result.status);
  }

  return bundleJsonResponse(result.objectText, result.bundle);
}

async function handleShareLandingOrDownload(
  request: Request,
  token: string,
  bucket: R2BucketBinding,
  limiter: DurableObjectNamespaceBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<Response> {
  const result = await loadSharedObject(token, bucket, limiter, config, state);
  if (!result.ok) {
    return htmlResponse(
      renderFailurePage(result.status, loadFailureMessage(result.status)),
      result.status,
      result.status === 429 ? { "Retry-After": String(result.retryAfterSeconds ?? 60) } : undefined
    );
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
  limiter: DurableObjectNamespaceBinding,
  config: WorkerConfig,
  state: WorkerState
): Promise<
  | { ok: true; bundle: SkillBundleManifestV1; object: R2ObjectBody; objectText: string }
  | { ok: false; status: 404 | 410 | 429 | 502 | 503; retryAfterSeconds?: number }
> {
  const verification = await verifyShareToken(token, config.tokenSecret, state.now());
  if (!verification.ok) {
    if (verification.status === 410 && verification.id) {
      await safeDeleteAndRelease(bucket, limiter, verification.id);
    }
    return { ok: false, status: verification.status };
  }

  const quota = await recordDownload(limiter, {
    shareId: verification.id,
    nowMs: state.now(),
    downloadRateLimitPerMinute: config.downloadRateLimitPerMinute,
    maxDownloadsPerShare: config.maxDownloadsPerShare,
    maxEgressBytesPerShare: config.maxEgressBytesPerShare
  });
  if (!quota.ok) {
    if (quota.status === 410) {
      await safeDeleteAndRelease(bucket, limiter, verification.id);
    }
    return { ok: false, status: quota.status, retryAfterSeconds: quota.retryAfterSeconds };
  }

  const objectKey = `${OBJECT_PREFIX}${verification.id}.json`;
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(objectKey);
  } catch {
    return { ok: false, status: 502 };
  }
  if (!object) {
    return { ok: false, status: 404 };
  }

  const metadataExpiresAtMs = Date.parse(object.customMetadata?.expiresAt ?? "");
  if (!Number.isFinite(metadataExpiresAtMs) || metadataExpiresAtMs <= state.now()) {
    await safeDeleteAndRelease(bucket, limiter, verification.id);
    return { ok: false, status: 410 };
  }

  let objectText: string;
  let bundle: SkillBundleManifestV1;
  try {
    objectText = await object.text();
    bundle = JSON.parse(objectText) as SkillBundleManifestV1;
  } catch {
    return { ok: false, status: 502 };
  }

  return { ok: true, bundle, object, objectText };
}

interface LimiterResult {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

async function reserveUpload(
  limiter: DurableObjectNamespaceBinding,
  body: Record<string, unknown>
): Promise<LimiterResult> {
  return callLimiter(limiter, "/reserve-upload", body);
}

async function recordDownload(
  limiter: DurableObjectNamespaceBinding,
  body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; status: 410 | 429 | 503; retryAfterSeconds?: number }> {
  const result = await callLimiter(limiter, "/record-download", body);
  if (result.ok) return { ok: true };
  if (result.reason === "expired") {
    return { ok: false, status: 410, retryAfterSeconds: result.retryAfterSeconds };
  }
  if (result.reason === "download_rate_limited" || result.reason?.includes("budget")) {
    return { ok: false, status: 429, retryAfterSeconds: result.retryAfterSeconds };
  }
  return { ok: false, status: 503, retryAfterSeconds: result.retryAfterSeconds };
}

async function releaseShare(limiter: DurableObjectNamespaceBinding, shareId: string): Promise<void> {
  await callLimiter(limiter, "/release-share", { shareId });
}

async function safeDeleteAndRelease(bucket: R2BucketBinding, limiter: DurableObjectNamespaceBinding, shareId: string): Promise<void> {
  await Promise.allSettled([
    bucket.delete(`${OBJECT_PREFIX}${shareId}.json`),
    releaseShare(limiter, shareId)
  ]);
}

async function callLimiter(
  limiter: DurableObjectNamespaceBinding,
  path: string,
  body: Record<string, unknown>
): Promise<LimiterResult> {
  try {
    const stub = limiter.get(limiter.idFromName("global"));
    const response = await stub.fetch(`https://limiter.local${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      return { ok: false, reason: "limiter_unavailable" };
    }
    return await response.json() as LimiterResult;
  } catch {
    return { ok: false, reason: "limiter_unavailable" };
  }
}

function limiterFailureResponse(result: LimiterResult, operation: "upload"): Response {
  if (result.reason === "upload_rate_limited") {
    return rateLimitResponse(result.retryAfterSeconds ?? 60);
  }
  if (result.reason?.includes("budget")) {
    return jsonResponse({ error: "Skill share service budget exceeded." }, 507);
  }
  return jsonResponse({ error: `Skill share ${operation} limiter unavailable.` }, 503);
}

export async function cleanupExpiredObjects(
  bucket: R2BucketBinding,
  limiter: DurableObjectNamespaceBinding | undefined,
  nowMs: number
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: OBJECT_PREFIX, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const expiresAt = Date.parse(object.customMetadata?.expiresAt ?? "");
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        await bucket.delete(object.key);
        const shareId = object.key.startsWith(OBJECT_PREFIX) && object.key.endsWith(".json")
          ? object.key.slice(OBJECT_PREFIX.length, -".json".length)
          : undefined;
        if (shareId && limiter) {
          await releaseShare(limiter, shareId);
        }
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

function projectBundleWarnings(bundle: SkillBundleManifestV1): SkillBundleIssue[] {
  return bundle.skill.frontmatter.warnings
    .filter((warning) => warning.trim().length > 0)
    .map((warning) => ({
      severity: "warning",
      code: "frontmatter_warning",
      message: warning
    }));
}

function bundleJsonResponse(objectText: string, bundle: SkillBundleManifestV1): Response {
  return new Response(objectText, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Content-Disposition": `attachment; filename="${safeAttachmentName(bundle.skill.handle)}.forge-skill.json"`,
      ...securityHeaders("api"),
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

function renderFailurePage(status: number, message: string): string {
  const title = status === 410 ? "Share link expired" : status === 429 ? "Share temporarily unavailable" : "Share unavailable";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${styleTag()}</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function renderServiceUnavailablePage(): string {
  return renderFailurePage(503, "Skill share service is not configured.");
}

function loadFailureMessage(status: number): string {
  if (status === 410) return "Share link expired.";
  if (status === 429) return "Share download quota exceeded or rate limited.";
  if (status === 502) return "Unable to read skill share.";
  if (status === 503) return "Skill share quota service unavailable.";
  return "Not found.";
}

function styleTag(): string {
  return `<style>body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:42rem;margin:2rem;padding:2rem;background:#111827;border:1px solid #334155;border-radius:18px}.eyebrow{color:#93c5fd;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem}.warning{background:#1f2937;border:1px solid #475569;border-radius:12px;padding:1rem}.button{display:inline-block;background:#8b5cf6;color:white;text-decoration:none;padding:.8rem 1rem;border-radius:10px;font-weight:700}code{display:block;white-space:pre-wrap;word-break:break-all;background:#020617;padding:.75rem;border-radius:10px}</style>`;
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> | undefined = undefined): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...securityHeaders("html"),
      ...(extraHeaders ?? {})
    }
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...securityHeaders("api"),
      ...corsHeaders()
    }
  });
}

function rateLimitResponse(retryAfterSeconds: number, message = "Rate limit exceeded."): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Retry-After": String(retryAfterSeconds),
      ...securityHeaders("api"),
      ...corsHeaders()
    }
  });
}

function securityHeaders(surface: "api" | "html"): Record<string, string> {
  return {
    "Content-Security-Policy": surface === "html"
      ? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; img-src 'none'; script-src 'none'"
      : "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  };
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
