import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { CredentialPoolService, type CredentialPoolServiceDeps } from "../credential-pool.js";
import { classifyRuntimeCapacityError } from "../runtime-utils.js";

let tempDir: string;
let authDir: string;
let authFile: string;
let deps: CredentialPoolServiceDeps;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cred-pool-runtime-test-"));
  authDir = join(tempDir, "auth");
  authFile = join(authDir, "auth.json");
  await mkdir(authDir, { recursive: true });
  deps = { authDir, authFile };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeOAuthCredential(accessToken: string = "access_tok_123"): AuthCredential {
  return {
    type: "oauth",
    access: accessToken,
    refresh: "refresh_tok_123",
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as AuthCredential;
}

function writeAuthFile(data: Record<string, unknown>): Promise<void> {
  return writeFile(authFile, JSON.stringify(data, null, 2), "utf8");
}

// ── Pool service runtime helpers ──

describe("CredentialPoolService runtime helpers", () => {
  describe("getPoolSize", () => {
    it("returns 0 when no pool exists and no auth.json", async () => {
      const pool = new CredentialPoolService(deps);
      const size = await pool.getPoolSize("openai-codex");
      expect(size).toBe(0);
    });

    it("returns 1 after migration from existing auth.json", async () => {
      await writeAuthFile({ "openai-codex": makeOAuthCredential() });
      const pool = new CredentialPoolService(deps);
      const size = await pool.getPoolSize("openai-codex");
      expect(size).toBe(1);
    });

    it("returns correct count with multiple credentials", async () => {
      await writeAuthFile({
        "openai-codex": makeOAuthCredential("tok_primary"),
        "openai-codex:cred_second": makeOAuthCredential("tok_second"),
      });
      const pool = new CredentialPoolService(deps);
      // First call triggers migration of existing single credential
      await pool.ensureLoaded();
      // Add second credential
      await pool.addCredential("openai-codex", makeOAuthCredential("tok_second"), {
        label: "Second Account",
      });
      const size = await pool.getPoolSize("openai-codex");
      expect(size).toBe(2);
    });
  });

  describe("buildRuntimeAuthData", () => {
    it("maps selected credential to bare provider key", async () => {
      await writeAuthFile({ "openai-codex": makeOAuthCredential("tok_primary") });
      const pool = new CredentialPoolService(deps);
      await pool.ensureLoaded();

      // Add second credential
      const second = await pool.addCredential(
        "openai-codex",
        makeOAuthCredential("tok_second"),
        { label: "Second" }
      );

      const authData = await pool.buildRuntimeAuthData("openai-codex", second.id);
      // The selected (non-primary) credential should be placed at the bare key
      const codexCred = authData["openai-codex"] as any;
      expect(codexCred).toBeDefined();
      expect(codexCred.access).toBe("tok_second");

      // No suffixed keys should be present
      const suffixedKeys = Object.keys(authData).filter((k) => k.startsWith("openai-codex:"));
      expect(suffixedKeys).toHaveLength(0);
    });

    it("preserves non-OpenAI credentials", async () => {
      await writeAuthFile({
        "openai-codex": makeOAuthCredential("tok_primary"),
        anthropic: makeOAuthCredential("tok_anthropic"),
        xai: { type: "api_key", key: "xai_key_123" },
      });
      const pool = new CredentialPoolService(deps);
      await pool.ensureLoaded();

      // Get primary credential id
      const poolState = await pool.listPool("openai-codex");
      const primaryId = poolState.credentials[0].id;

      const authData = await pool.buildRuntimeAuthData("openai-codex", primaryId);
      expect(authData["anthropic"]).toBeDefined();
      expect((authData["anthropic"] as any).access).toBe("tok_anthropic");
      expect(authData["xai"]).toBeDefined();
      expect((authData["xai"] as any).key).toBe("xai_key_123");
    });

    it("selects primary credential at bare key", async () => {
      await writeAuthFile({ "openai-codex": makeOAuthCredential("tok_primary") });
      const pool = new CredentialPoolService(deps);
      await pool.ensureLoaded();

      const poolState = await pool.listPool("openai-codex");
      const primaryId = poolState.credentials[0].id;

      const authData = await pool.buildRuntimeAuthData("openai-codex", primaryId);
      expect((authData["openai-codex"] as any).access).toBe("tok_primary");
    });
  });

  describe("getEarliestCooldownExpiry", () => {
    it("returns undefined when no credentials in cooldown", async () => {
      await writeAuthFile({ "openai-codex": makeOAuthCredential() });
      const pool = new CredentialPoolService(deps);
      const expiry = await pool.getEarliestCooldownExpiry("openai-codex");
      expect(expiry).toBeUndefined();
    });

    it("returns earliest cooldown timestamp", async () => {
      await writeAuthFile({ "openai-codex": makeOAuthCredential("tok_primary") });
      const pool = new CredentialPoolService(deps);
      await pool.ensureLoaded();

      const second = await pool.addCredential(
        "openai-codex",
        makeOAuthCredential("tok_second"),
        { label: "Second" }
      );

      const poolState = await pool.listPool("openai-codex");
      const primaryId = poolState.credentials[0].id;

      const earlyTime = Date.now() + 30_000;
      const lateTime = Date.now() + 120_000;
      await pool.markExhausted("openai-codex", primaryId, { cooldownUntil: lateTime });
      await pool.markExhausted("openai-codex", second.id, { cooldownUntil: earlyTime });

      const expiry = await pool.getEarliestCooldownExpiry("openai-codex");
      expect(expiry).toBe(earlyTime);
    });
  });
});

// ── Error classification ──

describe("classifyRuntimeCapacityError — 402 patterns", () => {
  it("classifies 402 payment required as quota/rate limit", () => {
    const result = classifyRuntimeCapacityError("402 payment required");
    expect(result.isQuotaOrRateLimit).toBe(true);
  });

  it("classifies status: 402 as quota/rate limit", () => {
    const result = classifyRuntimeCapacityError("Request failed with status: 402");
    expect(result.isQuotaOrRateLimit).toBe(true);
  });

  it("classifies insufficient funds as quota/rate limit", () => {
    const result = classifyRuntimeCapacityError("Insufficient funds for this request");
    expect(result.isQuotaOrRateLimit).toBe(true);
  });
});

// ── Credential rotation integration ──

describe("credential pool rotation flow", () => {
  it("429 → markExhausted → select next healthy credential", async () => {
    await writeAuthFile({
      "openai-codex": makeOAuthCredential("tok_primary"),
    });
    const pool = new CredentialPoolService(deps);
    await pool.ensureLoaded();

    // Add second credential
    const second = await pool.addCredential(
      "openai-codex",
      makeOAuthCredential("tok_second"),
      { label: "Second Account" }
    );

    // Get primary credential
    const poolState = await pool.listPool("openai-codex");
    const primaryId = poolState.credentials.find((c) => c.isPrimary)!.id;

    // Simulate: select primary first (fill_first strategy)
    const firstSelection = await pool.select("openai-codex");
    expect(firstSelection).not.toBeNull();
    expect(firstSelection!.credentialId).toBe(primaryId);

    // Mark primary exhausted (simulating 429)
    await pool.markExhausted("openai-codex", primaryId, {
      cooldownUntil: Date.now() + 60_000,
    });

    // Next select should return the second credential
    const nextSelection = await pool.select("openai-codex");
    expect(nextSelection).not.toBeNull();
    expect(nextSelection!.credentialId).toBe(second.id);
  });

  it("all exhausted → select returns null", async () => {
    await writeAuthFile({
      "openai-codex": makeOAuthCredential("tok_primary"),
    });
    const pool = new CredentialPoolService(deps);
    await pool.ensureLoaded();

    const second = await pool.addCredential(
      "openai-codex",
      makeOAuthCredential("tok_second"),
      { label: "Second" }
    );

    const poolState = await pool.listPool("openai-codex");
    const primaryId = poolState.credentials.find((c) => c.isPrimary)!.id;

    // Exhaust both
    await pool.markExhausted("openai-codex", primaryId, {
      cooldownUntil: Date.now() + 60_000,
    });
    await pool.markExhausted("openai-codex", second.id, {
      cooldownUntil: Date.now() + 60_000,
    });

    const selection = await pool.select("openai-codex");
    expect(selection).toBeNull();
  });

  it("single credential pool → no rotation possible", async () => {
    await writeAuthFile({
      "openai-codex": makeOAuthCredential("tok_only"),
    });
    const pool = new CredentialPoolService(deps);
    await pool.ensureLoaded();

    const poolState = await pool.listPool("openai-codex");
    expect(poolState.credentials).toHaveLength(1);
    const onlyId = poolState.credentials[0].id;

    // Exhaust the only credential
    await pool.markExhausted("openai-codex", onlyId, {
      cooldownUntil: Date.now() + 60_000,
    });

    // select returns null — no rotation possible
    const selection = await pool.select("openai-codex");
    expect(selection).toBeNull();
  });

  it("non-OpenAI providers are unaffected by pool operations", async () => {
    const pool = new CredentialPoolService(deps);
    await expect(pool.select("anthropic")).rejects.toThrow(
      /only supported for 'openai-codex'/
    );
    await expect(pool.getPoolSize("anthropic")).rejects.toThrow(
      /only supported for 'openai-codex'/
    );
    await expect(pool.buildRuntimeAuthData("anthropic", "cred_123")).rejects.toThrow(
      /only supported for 'openai-codex'/
    );
  });

  it("buildRuntimeAuthData works with rotated credential for retry", async () => {
    await writeAuthFile({
      "openai-codex": makeOAuthCredential("tok_primary"),
      anthropic: makeOAuthCredential("tok_anthropic"),
    });
    const pool = new CredentialPoolService(deps);
    await pool.ensureLoaded();

    // Add second credential
    const second = await pool.addCredential(
      "openai-codex",
      makeOAuthCredential("tok_second"),
      { label: "Second" }
    );

    // Build auth data for the second credential
    const authData = await pool.buildRuntimeAuthData("openai-codex", second.id);

    // Verify: bare openai-codex key has the second credential's token
    expect((authData["openai-codex"] as any).access).toBe("tok_second");

    // Verify: anthropic is preserved
    expect((authData["anthropic"] as any).access).toBe("tok_anthropic");

    // Verify: no pooled suffixed keys leak through
    const codexKeys = Object.keys(authData).filter((k) => k.startsWith("openai-codex"));
    expect(codexKeys).toEqual(["openai-codex"]);

    // Verify: can create in-memory AuthStorage with this data
    const inMemory = AuthStorage.inMemory(authData);
    expect(inMemory.has("openai-codex")).toBe(true);
    expect(inMemory.has("anthropic")).toBe(true);
  });

  it("session pin selection: pool with multiple credentials picks based on strategy", async () => {
    await writeAuthFile({
      "openai-codex": makeOAuthCredential("tok_primary"),
    });
    const pool = new CredentialPoolService(deps);
    await pool.ensureLoaded();

    // Add second credential
    const second = await pool.addCredential(
      "openai-codex",
      makeOAuthCredential("tok_second"),
      { label: "Second" }
    );

    // fill_first: should select primary
    const fill = await pool.select("openai-codex");
    const poolState = await pool.listPool("openai-codex");
    const primaryId = poolState.credentials.find((c) => c.isPrimary)!.id;
    expect(fill!.credentialId).toBe(primaryId);

    // Switch to least_used, mark primary as having more usage
    await pool.setStrategy("openai-codex", "least_used");
    await pool.markUsed("openai-codex", primaryId);
    await pool.markUsed("openai-codex", primaryId);
    await pool.markUsed("openai-codex", primaryId);

    const leastUsed = await pool.select("openai-codex");
    expect(leastUsed!.credentialId).toBe(second.id);
  });
});
