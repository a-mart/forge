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
export const DEFAULT_MAX_ACTIVE_OBJECTS = 1000;
export const HARD_MAX_ACTIVE_OBJECTS = 10_000;
export const DEFAULT_MAX_ACTIVE_STORAGE_BYTES = 5 * 1024 * MIB;
export const HARD_MAX_ACTIVE_STORAGE_BYTES = 50 * 1024 * MIB;
export const DEFAULT_MAX_DOWNLOADS_PER_SHARE = 20;
export const HARD_MAX_DOWNLOADS_PER_SHARE = 100;
export const DEFAULT_MAX_EGRESS_BYTES_PER_SHARE = 250 * MIB;
export const HARD_MAX_EGRESS_BYTES_PER_SHARE = 1024 * MIB;

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
  maxActiveObjects: number;
  maxActiveStorageBytes: number;
  maxDownloadsPerShare: number;
  maxEgressBytesPerShare: number;
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
    }),
    maxActiveObjects: readBoundedInteger(env.MAX_ACTIVE_OBJECTS, DEFAULT_MAX_ACTIVE_OBJECTS, {
      min: 1,
      max: HARD_MAX_ACTIVE_OBJECTS
    }),
    maxActiveStorageBytes: readBoundedInteger(env.MAX_ACTIVE_STORAGE_BYTES, DEFAULT_MAX_ACTIVE_STORAGE_BYTES, {
      min: HARD_MAX_BUNDLE_BYTES,
      max: HARD_MAX_ACTIVE_STORAGE_BYTES
    }),
    maxDownloadsPerShare: readBoundedInteger(env.MAX_DOWNLOADS_PER_SHARE, DEFAULT_MAX_DOWNLOADS_PER_SHARE, {
      min: 1,
      max: HARD_MAX_DOWNLOADS_PER_SHARE
    }),
    maxEgressBytesPerShare: readBoundedInteger(env.MAX_EGRESS_BYTES_PER_SHARE, DEFAULT_MAX_EGRESS_BYTES_PER_SHARE, {
      min: HARD_MAX_BUNDLE_BYTES,
      max: HARD_MAX_EGRESS_BYTES_PER_SHARE
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
