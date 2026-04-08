import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { CredentialPoolService, type CredentialPoolServiceDeps } from "../credential-pool.js";

let tempDir: string;
let authDir: string;
let authFile: string;
let deps: CredentialPoolServiceDeps;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cred-pool-test-"));
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

function makeApiKeyCredential(apiKey: string = "sk-test-123"): AuthCredential {
  return {
    type: "api_key",
    key: apiKey,
  } as AuthCredential;
}

function writeAuthFile(data: Record<string, unknown>): Promise<void> {
  return writeFile(authFile, JSON.stringify(data, null, 2), "utf8");
}

async function readPoolFile(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(authDir, "credential-pool.json"), "utf8");
  return JSON.parse(raw);
}

// ── Migration ──

describe("CredentialPoolService — migration", () => {
  it("auto-creates pool sidecar from existing auth.json credential", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");

    expect(pool.strategy).toBe("fill_first");
    expect(pool.credentials).toHaveLength(1);
    expect(pool.credentials[0].isPrimary).toBe(true);
    expect(pool.credentials[0].health).toBe("healthy");
    expect(pool.credentials[0].label).toBe("Primary Account");
  });

  it("returns empty pool when no auth.json exists", async () => {
    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");

    expect(pool.credentials).toHaveLength(0);
    expect(pool.strategy).toBe("fill_first");
  });

  it("returns empty pool when auth.json has no openai-codex entry", async () => {
    await writeAuthFile({ anthropic: makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");

    expect(pool.credentials).toHaveLength(0);
  });

  it("loads existing pool sidecar without re-migrating", async () => {
    // Set up auth.json and a pre-existing pool sidecar
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });
    const existingPool = {
      "openai-codex": {
        strategy: "least_used",
        credentials: [
          {
            id: "cred_existing",
            label: "My Existing Account",
            isPrimary: true,
            health: "healthy",
            cooldownUntil: null,
            requestCount: 99,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    await writeFile(join(authDir, "credential-pool.json"), JSON.stringify(existingPool), "utf8");

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");

    expect(pool.strategy).toBe("least_used");
    expect(pool.credentials).toHaveLength(1);
    expect(pool.credentials[0].id).toBe("cred_existing");
    expect(pool.credentials[0].requestCount).toBe(99);
  });

  it("auto-migrates anthropic OAuth credentials into a one-account pool", async () => {
    await writeAuthFile({ anthropic: makeOAuthCredential("anthropic_oauth_token") });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("anthropic");

    expect(pool.strategy).toBe("fill_first");
    expect(pool.credentials).toHaveLength(1);
    expect(pool.credentials[0].isPrimary).toBe(true);
    expect(pool.credentials[0].health).toBe("healthy");
    expect(pool.credentials[0].label).toBe("Primary Account");
  });

  it("does not auto-migrate anthropic API-key credentials into a pool", async () => {
    await writeAuthFile({ anthropic: makeApiKeyCredential("sk-ant-api-key") });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("anthropic");

    expect(pool.strategy).toBe("fill_first");
    expect(pool.credentials).toHaveLength(0);
  });
});

// ── Selection ──

describe("CredentialPoolService — selection", () => {
  it("selects the only credential", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const result = await service.select("openai-codex");

    expect(result).not.toBeNull();
    expect(result!.authStorageKey).toBe("openai-codex");
  });

  it("fill_first selects primary first", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    // Trigger migration for the first cred
    await service.listPool("openai-codex");

    // Add a second credential
    await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second Account",
    });

    const result = await service.select("openai-codex");
    expect(result).not.toBeNull();
    expect(result!.authStorageKey).toBe("openai-codex"); // primary key
  });

  it("fill_first falls back to secondary when primary is in cooldown", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second Account",
    });

    // Put primary in cooldown
    const pool = await service.listPool("openai-codex");
    const primaryId = pool.credentials.find((c) => c.isPrimary)!.id;
    await service.markExhausted("openai-codex", primaryId, { cooldownUntil: Date.now() + 60_000 });

    const result = await service.select("openai-codex");
    expect(result).not.toBeNull();
    expect(result!.credentialId).toBe(added.id);
  });

  it("returns null when all credentials are exhausted", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    await service.markExhausted("openai-codex", credId, { cooldownUntil: Date.now() + 60_000 });

    const result = await service.select("openai-codex");
    expect(result).toBeNull();
  });

  it("least_used selects credential with lowest requestCount", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");
    await service.setStrategy("openai-codex", "least_used");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second Account",
    });

    // Increment primary's count
    const pool = await service.listPool("openai-codex");
    const primaryId = pool.credentials.find((c) => c.isPrimary)!.id;
    await service.markUsed("openai-codex", primaryId);
    await service.markUsed("openai-codex", primaryId);
    await service.markUsed("openai-codex", primaryId);

    const result = await service.select("openai-codex");
    expect(result).not.toBeNull();
    expect(result!.credentialId).toBe(added.id); // lower count
  });

  it("least_used uses primary as tiebreaker when counts are equal", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");
    await service.setStrategy("openai-codex", "least_used");

    await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second Account",
    });

    const result = await service.select("openai-codex");
    expect(result).not.toBeNull();
    expect(result!.authStorageKey).toBe("openai-codex"); // primary wins tie
  });

  it("expired cooldowns are auto-cleared during selection", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    // Set cooldown to the past
    await service.markExhausted("openai-codex", credId, { cooldownUntil: Date.now() - 1000 });

    const result = await service.select("openai-codex");
    expect(result).not.toBeNull();
    expect(result!.credentialId).toBe(credId);
  });
});

// ── Mutations ──

describe("CredentialPoolService — mutations", () => {
  it("addCredential creates an entry and writes to auth.json", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Work Account",
      autoLabel: "work@example.com",
    });

    expect(added.label).toBe("Work Account");
    expect(added.autoLabel).toBe("work@example.com");
    expect(added.isPrimary).toBe(false);

    const pool = await service.listPool("openai-codex");
    expect(pool.credentials).toHaveLength(2);

    // Verify auth.json has the new key
    const authStorage = AuthStorage.create(authFile);
    const key = `openai-codex:${added.id}`;
    const cred = authStorage.get(key);
    expect(cred).toBeDefined();
  });

  it("addCredential to empty pool makes it primary", async () => {
    // No existing auth.json entry
    await writeAuthFile({});

    const service = new CredentialPoolService(deps);
    const added = await service.addCredential("openai-codex", makeOAuthCredential(), {
      label: "First Account",
    });

    expect(added.isPrimary).toBe(true);

    // Verify it's at the bare key in auth.json
    const authStorage = AuthStorage.create(authFile);
    const cred = authStorage.get("openai-codex");
    expect(cred).toBeDefined();
  });

  it("addCredential rejects when a bare Anthropic API key already exists", async () => {
    await writeAuthFile({ anthropic: makeApiKeyCredential("sk-ant-api-key") });

    const service = new CredentialPoolService(deps);

    await expect(
      service.addCredential("anthropic", makeOAuthCredential("anthropic_oauth"), {
        label: "Anthropic OAuth Account",
      })
    ).rejects.toThrow("Remove the existing Anthropic API key before adding OAuth accounts");

    const pool = await service.listPool("anthropic");
    expect(pool.credentials).toHaveLength(0);

    const authStorage = AuthStorage.create(authFile);
    expect((authStorage.get("anthropic") as any)?.key).toBe("sk-ant-api-key");
  });

  it("removeCredential removes from pool and auth.json", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second",
    });

    await service.removeCredential("openai-codex", added.id);

    const pool = await service.listPool("openai-codex");
    expect(pool.credentials).toHaveLength(1);

    // Verify removed from auth.json
    const authStorage = AuthStorage.create(authFile);
    expect(authStorage.get(`openai-codex:${added.id}`)).toBeUndefined();
  });

  it("removeCredential allows removing the last pooled Anthropic credential and disconnects the provider", async () => {
    await writeAuthFile({ anthropic: makeOAuthCredential("anthropic_primary") });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("anthropic");
    const credId = pool.credentials[0].id;

    await service.removeCredential("anthropic", credId);

    const updatedPool = await service.listPool("anthropic");
    expect(updatedPool.credentials).toHaveLength(0);

    const authStorage = AuthStorage.create(authFile);
    expect(authStorage.get("anthropic")).toBeUndefined();
    expect(authStorage.get(`anthropic:${credId}`)).toBeUndefined();

    await expect(readPoolFile()).resolves.toEqual({});
  });

  it("removeCredential auto-promotes next credential when primary is removed", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second",
    });

    const pool = await service.listPool("openai-codex");
    const primaryId = pool.credentials.find((c) => c.isPrimary)!.id;

    await service.removeCredential("openai-codex", primaryId);

    const updatedPool = await service.listPool("openai-codex");
    expect(updatedPool.credentials).toHaveLength(1);
    expect(updatedPool.credentials[0].isPrimary).toBe(true);
    expect(updatedPool.credentials[0].id).toBe(added.id);

    // The new primary should now be at the bare key
    const authStorage = AuthStorage.create(authFile);
    expect(authStorage.get("openai-codex")).toBeDefined();
  });

  it("renameCredential updates label", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    await service.renameCredential("openai-codex", credId, "Renamed Account");

    const updated = await service.listPool("openai-codex");
    expect(updated.credentials[0].label).toBe("Renamed Account");
  });

  it("renameCredential rejects empty labels", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    await expect(service.renameCredential("openai-codex", credId, "  ")).rejects.toThrow(
      /Label must be non-empty/
    );
  });

  it("setStrategy changes strategy and persists", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.setStrategy("openai-codex", "least_used");

    const pool = await service.listPool("openai-codex");
    expect(pool.strategy).toBe("least_used");

    // Verify persistence by creating a new service instance
    const service2 = new CredentialPoolService(deps);
    const pool2 = await service2.listPool("openai-codex");
    expect(pool2.strategy).toBe("least_used");
  });

  it("setStrategy rejects invalid strategy", async () => {
    const service = new CredentialPoolService(deps);
    await expect(
      service.setStrategy("openai-codex", "invalid" as any)
    ).rejects.toThrow(/Invalid strategy/);
  });
});

// ── Primary swap ──

describe("CredentialPoolService — primary swap", () => {
  it("setPrimary swaps auth.json keys and updates pool flags", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential("primary_tok") });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("secondary_tok"), {
      label: "Secondary",
    });

    await service.setPrimary("openai-codex", added.id);

    const pool = await service.listPool("openai-codex");
    const newPrimary = pool.credentials.find((c) => c.isPrimary);
    expect(newPrimary).toBeDefined();
    expect(newPrimary!.id).toBe(added.id);

    // Verify auth.json: the new primary's credential is at the bare key
    const authStorage = AuthStorage.create(authFile);
    const bareKeyCredential = authStorage.get("openai-codex") as any;
    expect(bareKeyCredential).toBeDefined();
    expect(bareKeyCredential.access).toBe("secondary_tok");

    // Old primary is now at a suffixed key
    const oldPrimary = pool.credentials.find((c) => !c.isPrimary);
    expect(oldPrimary).toBeDefined();
    const demotedCred = authStorage.get(`openai-codex:${oldPrimary!.id}`) as any;
    expect(demotedCred).toBeDefined();
    expect(demotedCred.access).toBe("primary_tok");
  });

  it("setPrimary is a no-op when credential is already primary", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    // Should not throw or change anything
    await service.setPrimary("openai-codex", credId);

    const updated = await service.listPool("openai-codex");
    expect(updated.credentials[0].isPrimary).toBe(true);
  });
});

// ── Health management ──

describe("CredentialPoolService — health", () => {
  it("markExhausted sets cooldown", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    const cooldownUntil = Date.now() + 120_000;
    await service.markExhausted("openai-codex", credId, { cooldownUntil });

    const updated = await service.listPool("openai-codex");
    expect(updated.credentials[0].health).toBe("cooldown");
    expect(updated.credentials[0].cooldownUntil).toBe(cooldownUntil);
  });

  it("markHealthy clears cooldown", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    await service.markExhausted("openai-codex", credId, { cooldownUntil: Date.now() + 60_000 });
    await service.markHealthy("openai-codex", credId);

    const updated = await service.listPool("openai-codex");
    expect(updated.credentials[0].health).toBe("healthy");
    expect(updated.credentials[0].cooldownUntil).toBeNull();
  });

  it("resetCooldown only affects credentials in cooldown state", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    // Healthy credential — resetCooldown is a no-op
    await service.resetCooldown("openai-codex", credId);
    const pool2 = await service.listPool("openai-codex");
    expect(pool2.credentials[0].health).toBe("healthy");

    // Auth error credential — resetCooldown does not affect it
    await service.markAuthError("openai-codex", credId);
    await service.resetCooldown("openai-codex", credId);
    const pool3 = await service.listPool("openai-codex");
    expect(pool3.credentials[0].health).toBe("auth_error");
  });

  it("markAuthError marks credential as auth_error", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    await service.markAuthError("openai-codex", credId);

    const updated = await service.listPool("openai-codex");
    expect(updated.credentials[0].health).toBe("auth_error");

    // auth_error credentials should be skipped during selection
    const result = await service.select("openai-codex");
    expect(result).toBeNull();
  });
});

// ── Provider guard ──

describe("CredentialPoolService — provider guard", () => {
  it("rejects unsupported providers", async () => {
    const service = new CredentialPoolService(deps);

    await expect(service.listPool("xai")).rejects.toThrow(/only supported for/);
    await expect(service.select("xai")).rejects.toThrow(/only supported for/);
    await expect(service.setStrategy("xai", "fill_first")).rejects.toThrow(/only supported for/);
  });
});

// ── Persistence round-trip ──

describe("CredentialPoolService — anthropic", () => {
  it("supports anthropic selection, primary swap, and removal behavior", async () => {
    await writeAuthFile({ anthropic: makeOAuthCredential("anthropic_primary") });

    const service = new CredentialPoolService(deps);
    const initialPool = await service.listPool("anthropic");
    const originalPrimaryId = initialPool.credentials[0].id;

    const second = await service.addCredential("anthropic", makeOAuthCredential("anthropic_second"), {
      label: "Second Anthropic Account",
    });

    const selection = await service.select("anthropic");
    expect(selection).not.toBeNull();
    expect(selection!.credentialId).toBe(originalPrimaryId);
    expect(selection!.authStorageKey).toBe("anthropic");

    await service.setPrimary("anthropic", second.id);

    let authStorage = AuthStorage.create(authFile);
    expect((authStorage.get("anthropic") as any).access).toBe("anthropic_second");
    expect((authStorage.get(`anthropic:${originalPrimaryId}`) as any).access).toBe("anthropic_primary");

    await service.removeCredential("anthropic", second.id);

    const updatedPool = await service.listPool("anthropic");
    expect(updatedPool.credentials).toHaveLength(1);
    expect(updatedPool.credentials[0].id).toBe(originalPrimaryId);
    expect(updatedPool.credentials[0].isPrimary).toBe(true);
    authStorage = AuthStorage.create(authFile);
    expect((authStorage.get("anthropic") as any).access).toBe("anthropic_primary");
  });

  it("buildRuntimeAuthData maps selected anthropic credential to the bare provider key", async () => {
    await writeAuthFile({
      anthropic: makeOAuthCredential("anthropic_primary"),
      "openai-codex": makeOAuthCredential("openai_primary"),
      xai: makeApiKeyCredential("xai_api_key"),
    });

    const service = new CredentialPoolService(deps);
    await service.listPool("anthropic");

    const second = await service.addCredential("anthropic", makeOAuthCredential("anthropic_second"), {
      label: "Second Anthropic Account",
    });

    const authData = await service.buildRuntimeAuthData("anthropic", second.id);

    expect((authData["anthropic"] as any).access).toBe("anthropic_second");
    expect(Object.keys(authData).filter((key) => key.startsWith("anthropic:"))).toHaveLength(0);
    expect((authData["openai-codex"] as any).access).toBe("openai_primary");
    expect((authData["xai"] as any).key).toBe("xai_api_key");
  });
});

describe("CredentialPoolService — persistence", () => {
  it("persists and reloads pool state across service instances", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service1 = new CredentialPoolService(deps);
    await service1.listPool("openai-codex");
    const added = await service1.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Persistent Account",
      autoLabel: "user@test.com",
    });
    await service1.setStrategy("openai-codex", "least_used");

    // Create a fresh service instance — should load persisted state
    const service2 = new CredentialPoolService(deps);
    const pool = await service2.listPool("openai-codex");

    expect(pool.strategy).toBe("least_used");
    expect(pool.credentials).toHaveLength(2);
    const found = pool.credentials.find((c) => c.id === added.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe("Persistent Account");
    expect(found!.autoLabel).toBe("user@test.com");
  });
});

// ── getCredentialAuthKey ──

describe("CredentialPoolService — getCredentialAuthKey", () => {
  it("returns bare provider key for primary credential", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    const credId = pool.credentials[0].id;

    const key = await service.getCredentialAuthKey("openai-codex", credId);
    expect(key).toBe("openai-codex");
  });

  it("returns suffixed key for non-primary credential", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Second",
    });

    const key = await service.getCredentialAuthKey("openai-codex", added.id);
    expect(key).toBe(`openai-codex:${added.id}`);
  });
});
