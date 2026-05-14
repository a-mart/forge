import { describe, expect, it } from "vitest";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import { computeSkillBundleContentSha256 } from "./bundle-validation.js";
import { createSkillShareWorker, createWorkerState, cleanupExpiredObjects } from "./index.js";
import { SkillShareLimiter } from "./limiter-do.js";
import type {
  DurableObjectIdBinding,
  DurableObjectNamespaceBinding,
  DurableObjectStateBinding,
  DurableObjectStorageBinding,
  DurableObjectStubBinding,
  R2BucketBinding,
  R2ListOptions,
  R2ListResult,
  R2ObjectBody,
  R2PutOptions,
  SkillShareEnv
} from "./types.js";

const SECRET = "x".repeat(64);
const START_MS = Date.parse("2026-05-13T12:00:00.000Z");
const TEXT_ENCODER = new TextEncoder();

class MockR2Object implements R2ObjectBody {
  constructor(
    readonly key: string,
    private readonly value: string,
    readonly customMetadata: Record<string, string> = {}
  ) {}

  async text(): Promise<string> {
    return this.value;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(TEXT_ENCODER.encode(this.value));
  }
}

class MemoryDurableObjectStorage implements DurableObjectStorageBinding {
  readonly data = new Map<string, unknown>();
  readonly listPrefixes: Array<string | undefined> = [];

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T = unknown>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    this.listPrefixes.push(options.prefix);
    const result = new Map<string, T>();
    for (const [key, value] of this.data.entries()) {
      if (!options.prefix || key.startsWith(options.prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }
}

class MockDurableObjectNamespace implements DurableObjectNamespaceBinding {
  readonly storage = new MemoryDurableObjectStorage();
  private readonly limiter = new SkillShareLimiter({ storage: this.storage } satisfies DurableObjectStateBinding);

  idFromName(name: string): DurableObjectIdBinding {
    return { name } as DurableObjectIdBinding;
  }

  get(_id: DurableObjectIdBinding): DurableObjectStubBinding {
    return {
      fetch: (input, init) => this.limiter.fetch(input instanceof Request ? input : new Request(input, init))
    };
  }
}

class MockR2Bucket implements R2BucketBinding {
  readonly objects = new Map<string, MockR2Object>();
  putCount = 0;
  getCount = 0;
  deleteCount = 0;
  throwOnGet = false;

  async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptions): Promise<void> {
    this.putCount += 1;
    const objectValue = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, new MockR2Object(key, objectValue, options?.customMetadata ?? {}));
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCount += 1;
    if (this.throwOnGet) {
      throw new Error("simulated R2 get failure");
    }
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.objects.delete(key);
  }

  async list(options: R2ListOptions = {}): Promise<R2ListResult> {
    const objects = Array.from(this.objects.values()).filter((object) => !options.prefix || object.key.startsWith(options.prefix));
    return { objects, truncated: false };
  }
}

describe("skill share worker", () => {
  it("uploads a valid bundle, stores it with expiry metadata, and serves landing/json downloads", async () => {
    const harness = await createHarness();
    const bundle = await createValidBundle();

    const upload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle })
    });
    expect(upload.status).toBe(201);
    expect(harness.bucket.putCount).toBe(1);

    const payload = await upload.json() as { shareUrl: string; importUrl: string; expiresAt: string; contentSha256: string; warnings: unknown[] };
    expect(payload.shareUrl).toMatch(/^https:\/\/share\.test\/s\//);
    expect(payload.importUrl).toBe(`forge://skill-import?url=${encodeURIComponent(payload.shareUrl)}`);
    expect(payload.expiresAt).toBe("2026-05-20T12:00:00.000Z");
    expect(payload.contentSha256).toBe(bundle.contentSha256);
    expect(payload.warnings).toEqual([]);

    const stored = Array.from(harness.bucket.objects.values())[0];
    expect(stored.customMetadata).toMatchObject({
      expiresAt: "2026-05-20T12:00:00.000Z",
      contentSha256: bundle.contentSha256,
      skillHandle: "test-skill",
      originPlatform: "darwin"
    });

    const landing = await harness.fetch(new URL(payload.shareUrl).pathname, { method: "GET" });
    const landingHtml = await landing.text();
    expect(landing.status).toBe(200);
    expect(landing.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(landingHtml).toContain("Open in Forge");
    expect(landingHtml).toContain("forge://skill-import");
    expect(landingHtml).not.toContain("# Test Skill Body");

    const jsonDownload = await harness.fetch(`/api/v1/skill-shares/${new URL(payload.shareUrl).pathname.split("/").at(-1)}`, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    expect(jsonDownload.status).toBe(200);
    expect(jsonDownload.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(jsonDownload.headers.get("content-disposition")).toBe("attachment; filename=\"test-skill.forge-skill.json\"");
    expect(await jsonDownload.json()).toMatchObject({
      format: "forge.skill.bundle.v1",
      skill: { handle: "test-skill", name: "Test Skill" }
    });
  });

  it("projects bundle warnings into the upload response", async () => {
    const harness = await createHarness();
    const upload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createWarningBundle() })
    });
    const payload = await upload.json() as { warnings: Array<{ severity: string; code: string; message: string }> };

    expect(upload.status).toBe(201);
    expect(payload.warnings).toEqual([
      {
        severity: "warning",
        code: "frontmatter_warning",
        message: "Unsupported SKILL.md frontmatter key: unsupportedKey"
      }
    ]);
  });

  it("fails closed when durable limiter binding is absent", async () => {
    const bucket = new MockR2Bucket();
    const worker = createSkillShareWorker(createWorkerState({ now: () => START_MS }));
    const env = {
      SKILL_SHARES_BUCKET: bucket,
      TOKEN_HMAC_SECRET: SECRET,
      PUBLIC_BASE_URL: "https://share.test"
    } as unknown as SkillShareEnv;

    const response = await worker.fetch(new Request("https://share.test/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("fail-closed") })
    }), env);
    expect(response.status).toBe(503);
    expect(bucket.putCount).toBe(0);
  });

  it("rejects oversized and invalid uploads before R2 writes", async () => {
    const harness = await createHarness({ env: { MAX_REQUEST_BYTES: "128" } });
    const bundle = await createValidBundle();
    const oversized = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      headers: { "content-length": "129" },
      body: JSON.stringify({ bundle })
    });
    expect(oversized.status).toBe(413);
    expect(harness.bucket.putCount).toBe(0);

    const invalidHarness = await createHarness();
    const invalidBundle = await createValidBundle();
    invalidBundle.contentSha256 = "0".repeat(64);
    const invalid = await invalidHarness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: invalidBundle })
    });
    expect(invalid.status).toBe(400);
    expect(invalidHarness.bucket.putCount).toBe(0);

    const sensitiveHarness = await createHarness();
    const sensitiveBundle = await createValidBundle("secret-skill");
    const secretFile = await createUtf8File(".env", "TOKEN=secret-value\n");
    sensitiveBundle.files.push(secretFile);
    sensitiveBundle.totals.fileCount += 1;
    sensitiveBundle.totals.byteCount += secretFile.size;
    sensitiveBundle.contentSha256 = await computeSkillBundleContentSha256(sensitiveBundle);
    const sensitive = await sensitiveHarness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: sensitiveBundle })
    });
    expect(sensitive.status).toBe(400);
    expect(sensitiveHarness.bucket.putCount).toBe(0);
  });

  it("enforces HMAC tokens and expiry at read time", async () => {
    let now = START_MS;
    const harness = await createHarness({ now: () => now, env: { SHARE_TTL_SECONDS: "60" } });
    const bundle = await createValidBundle();
    const upload = await harness.fetch("/api/v1/skill-shares", { method: "POST", body: JSON.stringify({ bundle }) });
    const payload = await upload.json() as { shareUrl: string };
    const token = new URL(payload.shareUrl).pathname.split("/").at(-1)!;

    const tamperedToken = `${token}.tampered`;
    expect(tamperedToken).not.toBe(token);
    const tampered = await harness.fetch(`/api/v1/skill-shares/${tamperedToken}`, { method: "GET" });
    expect(tampered.status).toBe(404);

    now = START_MS + 61_000;
    const expired = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
    expect(expired.status).toBe(410);
    expect(harness.bucket.objects.size).toBe(0);
  });

  it("enforces aggregate storage budgets before R2 writes", async () => {
    const harness = await createHarness({ env: { MAX_ACTIVE_OBJECTS: "1" } });
    const first = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("budget-one") })
    });
    const second = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("budget-two") })
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(507);
    expect(harness.bucket.putCount).toBe(1);
  });

  it("bounds per-share download egress after token verification", async () => {
    const harness = await createHarness({ env: { MAX_DOWNLOADS_PER_SHARE: "1" } });
    const upload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("download-quota") })
    });
    const payload = await upload.json() as { shareUrl: string };
    const token = new URL(payload.shareUrl).pathname.split("/").at(-1)!;

    const first = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
    const getCountAfterFirstDownload = harness.bucket.getCount;
    const second = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
    const landing = await harness.fetch(new URL(payload.shareUrl).pathname, { method: "GET" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect(landing.status).toBe(429);
    expect(landing.headers.get("retry-after")).toBeTruthy();
    expect(harness.bucket.getCount).toBe(getCountAfterFirstDownload);
  });

  it("rolls back download reservations when later R2 reads fail", async () => {
    await expectFailedReadDoesNotBurnDownloadQuota({
      name: "missing-object",
      expectedStatus: 404,
      breakObject: (harness, object) => harness.bucket.objects.delete(object.key),
      restoreObject: (harness, object, originalText) => harness.bucket.objects.set(
        object.key,
        new MockR2Object(object.key, originalText, object.customMetadata)
      )
    });
    await expectFailedReadDoesNotBurnDownloadQuota({
      name: "r2-get-throws",
      expectedStatus: 502,
      breakObject: (harness) => { harness.bucket.throwOnGet = true; },
      restoreObject: (harness) => { harness.bucket.throwOnGet = false; }
    });
    await expectFailedReadDoesNotBurnDownloadQuota({
      name: "corrupt-json",
      expectedStatus: 502,
      breakObject: (harness, object) => harness.bucket.objects.set(
        object.key,
        new MockR2Object(object.key, "{not-json", object.customMetadata)
      ),
      restoreObject: (harness, object, originalText) => harness.bucket.objects.set(
        object.key,
        new MockR2Object(object.key, originalText, object.customMetadata)
      )
    });
  });

  it("keeps download reservation cleanup scoped to the current share", async () => {
    const harness = await createHarness();
    await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("scoped-one") })
    });
    await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("scoped-two") })
    });
    const [firstShareId, secondShareId] = Array.from(harness.bucket.objects.keys()).map(extractShareIdFromObjectKey);
    harness.limiter.storage.listPrefixes.length = 0;

    await reserveDownloadForTest(harness.limiter, firstShareId, START_MS);
    await reserveDownloadForTest(harness.limiter, secondShareId, START_MS);
    await reserveDownloadForTest(harness.limiter, firstShareId, START_MS + 61_000);
    await callLimiterForTest(harness.limiter, "/release-share", { shareId: firstShareId });

    const reservationListPrefixes = harness.limiter.storage.listPrefixes.filter((prefix) => prefix?.startsWith("download-reservation:"));
    expect(reservationListPrefixes).toEqual([
      `download-reservation:${firstShareId}:`,
      `download-reservation:${secondShareId}:`,
      `download-reservation:${firstShareId}:`,
      `download-reservation:${firstShareId}:`
    ]);
    expect(reservationListPrefixes).not.toContain("download-reservation:");
    const reservationKeys = Array.from(harness.limiter.storage.data.keys()).filter((key) => key.startsWith("download-reservation:"));
    expect(reservationKeys.some((key) => key.startsWith(`download-reservation:${firstShareId}:`))).toBe(false);
    expect(reservationKeys.some((key) => key.startsWith(`download-reservation:${secondShareId}:`))).toBe(true);
  });

  it("releases quota when R2 metadata expiry rejects a valid token", async () => {
    const harness = await createHarness({ env: { MAX_ACTIVE_OBJECTS: "1" } });
    const firstUpload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("metadata-expired") })
    });
    const payload = await firstUpload.json() as { shareUrl: string };
    const object = Array.from(harness.bucket.objects.values())[0];
    harness.bucket.objects.set(object.key, new MockR2Object(object.key, await object.text(), {
      ...object.customMetadata,
      expiresAt: "2026-05-13T11:59:59.000Z"
    }));

    const expired = await harness.fetch(`/api/v1/skill-shares/${new URL(payload.shareUrl).pathname.split("/").at(-1)}`, { method: "GET" });
    expect(expired.status).toBe(410);
    expect(harness.bucket.objects.size).toBe(0);

    const secondUpload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("metadata-expiry-replacement") })
    });
    expect(secondUpload.status).toBe(201);
    expect(harness.bucket.putCount).toBe(2);
  });

  it("rate limits anonymous uploads per client IP", async () => {
    const harness = await createHarness({ env: { UPLOAD_RATE_LIMIT_PER_MINUTE: "1" } });
    const first = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle() })
    });
    const second = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("second-skill") })
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect(harness.bucket.putCount).toBe(1);
  });

  it("sets no-store, CORS, and browser hardening headers", async () => {
    const harness = await createHarness();
    const upload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("headers-skill") })
    });
    const payload = await upload.json() as { shareUrl: string };
    const landing = await harness.fetch(new URL(payload.shareUrl).pathname, { method: "GET" });
    expect(landing.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(landing.headers.get("x-content-type-options")).toBe("nosniff");
    expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
    expect(landing.headers.get("x-frame-options")).toBe("DENY");

    const token = new URL(payload.shareUrl).pathname.split("/").at(-1)!;
    const json = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
    expect(json.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(json.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("handles corrupt stored R2 JSON with a controlled response", async () => {
    const harness = await createHarness();
    const upload = await harness.fetch("/api/v1/skill-shares", {
      method: "POST",
      body: JSON.stringify({ bundle: await createValidBundle("corrupt-skill") })
    });
    const payload = await upload.json() as { shareUrl: string };
    const object = Array.from(harness.bucket.objects.values())[0];
    harness.bucket.objects.set(object.key, new MockR2Object(object.key, "{not-json", object.customMetadata));

    const response = await harness.fetch(`/api/v1/skill-shares/${new URL(payload.shareUrl).pathname.split("/").at(-1)}`, { method: "GET" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Unable to read skill share." });
  });

  it("does not expose a listing endpoint", async () => {
    const harness = await createHarness();
    const response = await harness.fetch("/api/v1/skill-shares", { method: "GET" });
    expect(response.status).toBe(404);
  });

  it("cron cleanup deletes expired R2 objects", async () => {
    const bucket = new MockR2Bucket();
    await bucket.put("skill-shares/expired.json", "{}", {
      customMetadata: { expiresAt: "2026-05-13T11:59:59.000Z" }
    });
    await bucket.put("skill-shares/live.json", "{}", {
      customMetadata: { expiresAt: "2026-05-13T12:30:00.000Z" }
    });

    const deleted = await cleanupExpiredObjects(bucket, new MockDurableObjectNamespace(), START_MS);
    expect(deleted).toBe(1);
    expect(bucket.objects.has("skill-shares/expired.json")).toBe(false);
    expect(bucket.objects.has("skill-shares/live.json")).toBe(true);
  });
});

async function createHarness(options: {
  now?: () => number;
  env?: Partial<SkillShareEnv>;
} = {}): Promise<{
  bucket: MockR2Bucket;
  limiter: MockDurableObjectNamespace;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
}> {
  const bucket = new MockR2Bucket();
  const limiter = new MockDurableObjectNamespace();
  const worker = createSkillShareWorker(createWorkerState({ now: options.now ?? (() => START_MS) }));
  const env: SkillShareEnv = {
    SKILL_SHARES_BUCKET: bucket,
    SHARE_LIMITER: limiter,
    TOKEN_HMAC_SECRET: SECRET,
    PUBLIC_BASE_URL: "https://share.test",
    ...options.env
  };

  return {
    bucket,
    limiter,
    fetch: (path, init) => worker.fetch(new Request(`https://share.test${path}`, {
      ...init,
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        ...init.headers
      }
    }), env)
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function reserveDownloadForTest(
  limiter: MockDurableObjectNamespace,
  shareId: string,
  nowMs: number
): Promise<Record<string, unknown>> {
  return callLimiterForTest(limiter, "/reserve-download", {
    shareId,
    nowMs,
    downloadRateLimitPerMinute: 120,
    maxDownloadsPerShare: 20,
    maxEgressBytesPerShare: 1024 * 1024 * 1024
  });
}

async function callLimiterForTest(
  limiter: MockDurableObjectNamespace,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await limiter.get(limiter.idFromName("global")).fetch(`https://limiter.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await response.json() as Record<string, unknown>;
}

function extractShareIdFromObjectKey(key: string): string {
  return key.replace(/^skill-shares\//, "").replace(/\.json$/, "");
}

async function expectFailedReadDoesNotBurnDownloadQuota(options: {
  name: string;
  expectedStatus: number;
  breakObject: (harness: Harness, object: MockR2Object) => void;
  restoreObject: (harness: Harness, object: MockR2Object, originalText: string) => void;
}): Promise<void> {
  const harness = await createHarness({ env: { MAX_DOWNLOADS_PER_SHARE: "1" } });
  const upload = await harness.fetch("/api/v1/skill-shares", {
    method: "POST",
    body: JSON.stringify({ bundle: await createValidBundle(`rollback-${options.name}`) })
  });
  const payload = await upload.json() as { shareUrl: string };
  const token = new URL(payload.shareUrl).pathname.split("/").at(-1)!;
  const object = Array.from(harness.bucket.objects.values())[0];
  const originalText = await object.text();

  options.breakObject(harness, object);
  const failed = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
  expect({ name: options.name, status: failed.status }).toEqual({ name: options.name, status: options.expectedStatus });

  options.restoreObject(harness, object, originalText);
  const success = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
  const denied = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
  expect({ name: options.name, status: success.status }).toEqual({ name: options.name, status: 200 });
  expect({ name: options.name, status: denied.status }).toEqual({ name: options.name, status: 429 });
}

async function createValidBundle(handle = "test-skill"): Promise<SkillBundleManifestV1> {
  const skillMarkdown = [
    "---",
    "name: Test Skill",
    "description: A temporary shared skill.",
    "env:",
    "  - name: TEST_API_KEY",
    "    description: Test API key",
    "    required: true",
    "---",
    "",
    "# Test Skill Body"
  ].join("\n");
  const file = await createUtf8File("SKILL.md", skillMarkdown);
  const bundle: SkillBundleManifestV1 = {
    format: "forge.skill.bundle.v1",
    bundleVersion: 1,
    createdAt: "2026-05-13T11:00:00.000Z",
    contentSha256: "0".repeat(64),
    origin: {
      platform: "darwin",
      arch: "arm64",
      osRelease: "test-release",
      skillSourceKind: "machine-local"
    },
    skill: {
      handle,
      name: "Test Skill",
      description: "A temporary shared skill.",
      env: [
        {
          name: "TEST_API_KEY",
          description: "Test API key",
          required: true
        }
      ],
      frontmatter: {
        knownForgeKeys: ["description", "env", "name"],
        knownPiKeys: ["description", "env", "name"],
        unsupportedKeys: [],
        warnings: []
      }
    },
    portability: {
      osIndicators: [],
      scripts: [],
      dependencies: []
    },
    files: [file],
    totals: {
      fileCount: 1,
      byteCount: file.size
    }
  };
  bundle.contentSha256 = await computeSkillBundleContentSha256(bundle);
  return bundle;
}

async function createWarningBundle(): Promise<SkillBundleManifestV1> {
  const skillMarkdown = [
    "---",
    "name: Warning Skill",
    "description: Warning-bearing skill.",
    "unsupportedKey: true",
    "---",
    "",
    "# Warning Skill Body"
  ].join("\n");
  const file = await createUtf8File("SKILL.md", skillMarkdown);
  const bundle: SkillBundleManifestV1 = {
    format: "forge.skill.bundle.v1",
    bundleVersion: 1,
    createdAt: "2026-05-13T11:00:00.000Z",
    contentSha256: "0".repeat(64),
    origin: {
      platform: "darwin",
      arch: "arm64",
      osRelease: "test-release",
      skillSourceKind: "machine-local"
    },
    skill: {
      handle: "warning-skill",
      name: "Warning Skill",
      description: "Warning-bearing skill.",
      env: [],
      frontmatter: {
        knownForgeKeys: ["description", "name"],
        knownPiKeys: ["description", "name"],
        unsupportedKeys: ["unsupportedKey"],
        warnings: ["Unsupported SKILL.md frontmatter key: unsupportedKey"]
      }
    },
    portability: {
      osIndicators: [],
      scripts: [],
      dependencies: []
    },
    files: [file],
    totals: {
      fileCount: 1,
      byteCount: file.size
    }
  };
  bundle.contentSha256 = await computeSkillBundleContentSha256(bundle);
  return bundle;
}

async function createUtf8File(path: string, content: string): Promise<SkillBundleManifestV1["files"][number]> {
  const bytes = TEXT_ENCODER.encode(content);
  return {
    path,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    encoding: "utf8",
    content
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
