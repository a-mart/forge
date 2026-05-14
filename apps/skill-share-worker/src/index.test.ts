import { describe, expect, it } from "vitest";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import { computeSkillBundleContentSha256 } from "./bundle-validation.js";
import { createSkillShareWorker, createWorkerState, cleanupExpiredObjects } from "./index.js";
import type { R2BucketBinding, R2ListOptions, R2ListResult, R2ObjectBody, R2PutOptions, SkillShareEnv } from "./types.js";

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

class MockR2Bucket implements R2BucketBinding {
  readonly objects = new Map<string, MockR2Object>();
  putCount = 0;
  deleteCount = 0;

  async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptions): Promise<void> {
    this.putCount += 1;
    const objectValue = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, new MockR2Object(key, objectValue, options?.customMetadata ?? {}));
  }

  async get(key: string): Promise<R2ObjectBody | null> {
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

    const payload = await upload.json() as { shareUrl: string; importUrl: string; expiresAt: string; contentSha256: string };
    expect(payload.shareUrl).toMatch(/^https:\/\/share\.test\/s\//);
    expect(payload.importUrl).toBe(`forge://skill-import?url=${encodeURIComponent(payload.shareUrl)}`);
    expect(payload.expiresAt).toBe("2026-05-20T12:00:00.000Z");
    expect(payload.contentSha256).toBe(bundle.contentSha256);

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
    expect(landing.headers.get("cache-control")).toBe("no-store");
    expect(landingHtml).toContain("Open in Forge");
    expect(landingHtml).toContain("forge://skill-import");
    expect(landingHtml).not.toContain("# Test Skill Body");

    const jsonDownload = await harness.fetch(`/api/v1/skill-shares/${new URL(payload.shareUrl).pathname.split("/").at(-1)}`, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    expect(jsonDownload.status).toBe(200);
    expect(jsonDownload.headers.get("cache-control")).toBe("no-store");
    expect(jsonDownload.headers.get("content-disposition")).toBe("attachment; filename=\"test-skill.forge-skill.json\"");
    expect(await jsonDownload.json()).toMatchObject({
      format: "forge.skill.bundle.v1",
      skill: { handle: "test-skill", name: "Test Skill" }
    });
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

    const tampered = await harness.fetch(`/api/v1/skill-shares/${token.slice(0, -1)}x`, { method: "GET" });
    expect(tampered.status).toBe(404);

    now = START_MS + 61_000;
    const expired = await harness.fetch(`/api/v1/skill-shares/${token}`, { method: "GET" });
    expect(expired.status).toBe(410);
    expect(harness.bucket.objects.size).toBe(0);
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

    const deleted = await cleanupExpiredObjects(bucket, START_MS);
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
  fetch: (path: string, init: RequestInit) => Promise<Response>;
}> {
  const bucket = new MockR2Bucket();
  const worker = createSkillShareWorker(createWorkerState({ now: options.now ?? (() => START_MS) }));
  const env: SkillShareEnv = {
    SKILL_SHARES_BUCKET: bucket,
    TOKEN_HMAC_SECRET: SECRET,
    PUBLIC_BASE_URL: "https://share.test",
    ...options.env
  };

  return {
    bucket,
    fetch: (path, init) => worker.fetch(new Request(`https://share.test${path}`, {
      ...init,
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        ...init.headers
      }
    }), env)
  };
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
