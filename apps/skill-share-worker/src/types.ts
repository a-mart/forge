export interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface R2ObjectSummary {
  key: string;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2ObjectSummary {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResult {
  objects: R2ObjectSummary[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketBinding {
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
}

export interface DurableObjectIdBinding {}

export interface DurableObjectStubBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceBinding {
  idFromName(name: string): DurableObjectIdBinding;
  get(id: DurableObjectIdBinding): DurableObjectStubBinding;
}

export interface DurableObjectStorageBinding {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export interface DurableObjectStateBinding {
  storage: DurableObjectStorageBinding;
}

export interface SkillShareEnv {
  SKILL_SHARES_BUCKET: R2BucketBinding;
  SHARE_LIMITER: DurableObjectNamespaceBinding;
  TOKEN_HMAC_SECRET: string;
  PUBLIC_BASE_URL?: string;
  SHARE_TTL_SECONDS?: string;
  MAX_REQUEST_BYTES?: string;
  MAX_BUNDLE_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_FILES?: string;
  UPLOAD_RATE_LIMIT_PER_MINUTE?: string;
  DOWNLOAD_RATE_LIMIT_PER_MINUTE?: string;
  MAX_ACTIVE_OBJECTS?: string;
  MAX_ACTIVE_STORAGE_BYTES?: string;
  MAX_DOWNLOADS_PER_SHARE?: string;
  MAX_EGRESS_BYTES_PER_SHARE?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}
