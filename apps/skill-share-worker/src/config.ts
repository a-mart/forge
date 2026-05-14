import type { SkillShareEnv } from "./types.js";

const MIB = 1024 * 1024;

export const OBJECT_PREFIX = "skill-shares/";
export const HARD_MAX_REQUEST_BYTES = 35 * MIB;
export const HARD_MAX_BUNDLE_BYTES = 25 * MIB;
export const HARD_MAX_FILE_BYTES = 2 * MIB;
export const HARD_MAX_FILES = 512;
export const HARD_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_TTL_SECONDS = 60;
export const DEFAULT_UPLOAD_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_DOWNLOAD_RATE_LIMIT_PER_MINUTE = 120;

export interface WorkerConfig {
  publicBaseUrl?: string;
  tokenSecret: string;
  shareTtlSeconds: number;
  maxRequestBytes: number;
  maxBundleBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  uploadRateLimitPerMinute: number;
  downloadRateLimitPerMinute: number;
}

export function loadWorkerConfig(env: SkillShareEnv): WorkerConfig {
  if (typeof env.TOKEN_HMAC_SECRET !== "string" || env.TOKEN_HMAC_SECRET.trim().length < 32) {
    throw new Error("TOKEN_HMAC_SECRET must be configured and at least 32 characters.");
  }

  return {
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || undefined,
    tokenSecret: env.TOKEN_HMAC_SECRET,
    shareTtlSeconds: readBoundedInteger(env.SHARE_TTL_SECONDS, HARD_MAX_TTL_SECONDS, {
      min: MIN_TTL_SECONDS,
      max: HARD_MAX_TTL_SECONDS
    }),
    maxRequestBytes: readBoundedInteger(env.MAX_REQUEST_BYTES, HARD_MAX_REQUEST_BYTES, {
      min: 1024,
      max: HARD_MAX_REQUEST_BYTES
    }),
    maxBundleBytes: readBoundedInteger(env.MAX_BUNDLE_BYTES, HARD_MAX_BUNDLE_BYTES, {
      min: 1024,
      max: HARD_MAX_BUNDLE_BYTES
    }),
    maxFileBytes: readBoundedInteger(env.MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, {
      min: 1,
      max: HARD_MAX_FILE_BYTES
    }),
    maxFiles: readBoundedInteger(env.MAX_FILES, HARD_MAX_FILES, {
      min: 1,
      max: HARD_MAX_FILES
    }),
    uploadRateLimitPerMinute: readBoundedInteger(env.UPLOAD_RATE_LIMIT_PER_MINUTE, DEFAULT_UPLOAD_RATE_LIMIT_PER_MINUTE, {
      min: 1,
      max: 600
    }),
    downloadRateLimitPerMinute: readBoundedInteger(env.DOWNLOAD_RATE_LIMIT_PER_MINUTE, DEFAULT_DOWNLOAD_RATE_LIMIT_PER_MINUTE, {
      min: 1,
      max: 1200
    })
  };
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}
