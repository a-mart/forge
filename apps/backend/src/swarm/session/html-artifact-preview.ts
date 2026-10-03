import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { HTML_ARTIFACT_PREVIEW_PATH_PREFIX } from "@forge/protocol";

/**
 * Short-lived, folder-scoped capability for rendering an authorized HTML
 * artifact together with the web assets beside it (screenshots, video, CSS).
 *
 * The capability only ever serves web-asset types under the HTML file's
 * folder: no dot-segments, no symlink escapes, nothing outside the folder.
 * Responses are rendered under `buildHtmlArtifactPreviewCsp`, whose sandbox
 * gives the page an opaque origin and no network reads, so page scripts can
 * render sibling files but never read them or reach Forge APIs.
 */

export const HTML_ARTIFACT_PREVIEW_TTL_MS = 60 * 60_000;
const MAX_HTML_ARTIFACT_PREVIEWS = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function isHtmlArtifactPath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".html" || extension === ".htm";
}

export type HtmlArtifactPreviewErrorCode = "not_html" | "not_found" | "expired" | "forbidden";

export class HtmlArtifactPreviewError extends Error {
  constructor(public readonly code: HtmlArtifactPreviewErrorCode) { super(code); }
}

export function htmlArtifactPreviewStatus(code: HtmlArtifactPreviewErrorCode): number {
  switch (code) {
    case "not_html": return 400;
    case "forbidden": return 403;
    case "expired": return 410;
    default: return 404;
  }
}

/**
 * `scope` is the absolute preview folder URL (`<origin>/api/artifact-previews/<token>/`).
 * CSP path matching confines every same-server load to that folder.
 */
export function buildHtmlArtifactPreviewCsp(scope: string): string {
  return [
    // Opaque origin: no cookies/storage of the Forge origin, cross-origin to its APIs.
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    `base-uri ${scope}`,
    `script-src ${scope} 'unsafe-inline' 'unsafe-eval' https:`,
    `style-src ${scope} 'unsafe-inline' https:`,
    `img-src ${scope} data: blob: https:`,
    `media-src ${scope} data: blob: https:`,
    `font-src ${scope} data: https:`,
    `frame-src ${scope}`,
    // Scripts may render sibling files but never read them (no exfiltration path).
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

interface PreviewRecord {
  root: string;
  entry: string;
  expiresAtMs: number;
  authBinding?: string;
}

export interface HtmlArtifactPreviewAsset {
  path: string;
  contentType: string;
  size: number;
}

export class HtmlArtifactPreviewStore {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPreviews: number;

  constructor(options: { now?: () => number; ttlMs?: number; maxPreviews?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? HTML_ARTIFACT_PREVIEW_TTL_MS;
    this.maxPreviews = Math.max(1, options.maxPreviews ?? MAX_HTML_ARTIFACT_PREVIEWS);
  }

  /** `htmlPath` must already be authorized by the caller's read policy. */
  async issue(htmlPath: string, authBinding?: string): Promise<{ url: string; expiresAt: string }> {
    if (!isHtmlArtifactPath(htmlPath)) throw new HtmlArtifactPreviewError("not_html");
    const real = await realpathOrNotFound(htmlPath);
    if (!isHtmlArtifactPath(real) || !(await isRegularFile(real))) throw new HtmlArtifactPreviewError("not_found");

    this.prune();
    while (this.previews.size >= this.maxPreviews) {
      this.previews.delete(this.previews.keys().next().value as string);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    const entry = basename(real);
    this.previews.set(token, {
      root: dirname(real),
      entry,
      expiresAtMs,
      ...(authBinding !== undefined ? { authBinding } : {}),
    });
    return {
      url: `${HTML_ARTIFACT_PREVIEW_PATH_PREFIX}${token}/${encodeURIComponent(entry)}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** `relativePath` is the raw (still percent-encoded) remainder after the token. */
  async resolveAsset(token: string, relativePath: string, authBinding?: string): Promise<HtmlArtifactPreviewAsset> {
    if (!TOKEN_PATTERN.test(token)) throw new HtmlArtifactPreviewError("not_found");
    const preview = this.previews.get(token);
    // A binding mismatch is indistinguishable from an unknown token.
    if (!preview || preview.authBinding !== authBinding) throw new HtmlArtifactPreviewError("not_found");
    if (preview.expiresAtMs <= this.now()) {
      this.previews.delete(token);
      throw new HtmlArtifactPreviewError("expired");
    }

    const segments = decodeSegments(relativePath === "" ? encodeURIComponent(preview.entry) : relativePath);
    const contentType = ASSET_CONTENT_TYPES[extname(segments.at(-1) ?? "").toLowerCase()];
    if (!contentType) throw new HtmlArtifactPreviewError("forbidden");

    const real = await realpathOrNotFound(join(preview.root, ...segments));
    if (!real.startsWith(preview.root + sep)) throw new HtmlArtifactPreviewError("forbidden");
    const fileStat = await stat(real).catch(() => null);
    if (!fileStat?.isFile()) throw new HtmlArtifactPreviewError("not_found");
    return { path: real, contentType, size: fileStat.size };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAtMs <= now) this.previews.delete(token);
    }
  }
}

function decodeSegments(relativePath: string): string[] {
  const segments = relativePath.split("/").map((segment) => {
    try { return decodeURIComponent(segment); } catch { throw new HtmlArtifactPreviewError("forbidden"); }
  });
  for (const segment of segments) {
    // Rejects "", ".", "..", dot-files/folders, and encoded separators or NUL.
    if (!segment || segment.startsWith(".") || /[\\/\0]/.test(segment)) throw new HtmlArtifactPreviewError("forbidden");
  }
  return segments;
}

async function realpathOrNotFound(path: string): Promise<string> {
  try { return await realpath(path); } catch { throw new HtmlArtifactPreviewError("not_found"); }
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
