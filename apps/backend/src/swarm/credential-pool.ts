import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type { CredentialPoolState, CredentialPoolStrategy, PooledCredentialInfo } from "@forge/protocol";
import { renameWithRetry } from "./retry-rename.js";

// ── Storage types (persisted to credential-pool.json) ──

interface PersistedCredentialEntry {
  id: string;
  label: string;
  autoLabel?: string;
  isPrimary: boolean;
  accountId?: string;
  health: "healthy" | "cooldown" | "auth_error";
  cooldownUntil: number | null;
  requestCount: number;
  createdAt: string;
}

interface PersistedProviderPool {
  strategy: CredentialPoolStrategy;
  credentials: PersistedCredentialEntry[];
}

type PersistedPoolFile = Record<string, PersistedProviderPool>;

// ── Constants ──

const SUPPORTED_PROVIDER = "openai-codex";
const POOL_FILENAME = "credential-pool.json";

function generateCredentialId(): string {
  return `cred_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Returns the auth.json key for a pooled credential.
 * Primary credential uses the bare provider key; additional credentials use `provider:id`.
 */
function authStorageKey(provider: string, credentialId: string, isPrimary: boolean): string {
  return isPrimary ? provider : `${provider}:${credentialId}`;
}

// ── Service ──

export interface CredentialPoolServiceDeps {
  /** Path to the directory containing auth.json (sharedAuthDir) */
  authDir: string;
  /** Path to auth.json (sharedAuthFile) */
  authFile: string;
}

export class CredentialPoolService {
  private pool: PersistedPoolFile = {};
  private loaded = false;
  private readonly poolFilePath: string;
  private readonly deps: CredentialPoolServiceDeps;

  constructor(deps: CredentialPoolServiceDeps) {
    this.deps = deps;
    this.poolFilePath = join(deps.authDir, POOL_FILENAME);
  }

  // ── Lifecycle ──

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
  }

  private async load(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await readFile(this.poolFilePath, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) throw error;
    }

    if (raw) {
      try {
        this.pool = JSON.parse(raw) as PersistedPoolFile;
      } catch {
        // Malformed file — start fresh but migrate if possible
        this.pool = {};
      }
    } else {
      this.pool = {};
    }

    // Auto-migrate: if no pool for openai-codex but auth.json has a credential
    if (!this.pool[SUPPORTED_PROVIDER]) {
      await this.migrateFromAuthFile();
    }

    this.loaded = true;
  }

  private async migrateFromAuthFile(): Promise<void> {
    const authStorage = AuthStorage.create(this.deps.authFile);
    const credential = authStorage.get(SUPPORTED_PROVIDER);
    if (!credential) return;

    const token = extractAuthCredentialToken(credential);
    if (!token) return;

    const id = generateCredentialId();
    const now = new Date().toISOString();

    this.pool[SUPPORTED_PROVIDER] = {
      strategy: "fill_first",
      credentials: [
        {
          id,
          label: "Primary Account",
          isPrimary: true,
          health: "healthy",
          cooldownUntil: null,
          requestCount: 0,
          createdAt: now,
        },
      ],
    };

    await this.persist();
  }

  // ── Queries ──

  async listPool(provider: string): Promise<CredentialPoolState> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const providerPool = this.pool[provider];
    if (!providerPool) {
      return { strategy: "fill_first", credentials: [] };
    }

    // Expire stale cooldowns before returning
    this.expireCooldowns(provider);

    return {
      strategy: providerPool.strategy,
      credentials: providerPool.credentials.map(toPooledCredentialInfo),
    };
  }

  /**
   * Select a credential for use. Returns the credential ID and auth.json key,
   * or null if all credentials are exhausted.
   */
  async select(provider: string, _sessionPin?: string): Promise<{ credentialId: string; authStorageKey: string } | null> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const providerPool = this.pool[provider];
    if (!providerPool || providerPool.credentials.length === 0) return null;

    this.expireCooldowns(provider);

    const healthy = providerPool.credentials.filter((c) => c.health === "healthy");
    if (healthy.length === 0) return null;

    let selected: PersistedCredentialEntry;

    if (providerPool.strategy === "least_used") {
      healthy.sort((a, b) => {
        const countDiff = a.requestCount - b.requestCount;
        if (countDiff !== 0) return countDiff;
        // Tiebreaker: prefer primary
        if (a.isPrimary && !b.isPrimary) return -1;
        if (!a.isPrimary && b.isPrimary) return 1;
        return 0;
      });
      selected = healthy[0];
    } else {
      // fill_first: primary first, else creation order
      const primary = healthy.find((c) => c.isPrimary);
      selected = primary ?? healthy[0];
    }

    return {
      credentialId: selected.id,
      authStorageKey: authStorageKey(provider, selected.id, selected.isPrimary),
    };
  }

  /**
   * Returns the auth.json key for a specific credential.
   */
  async getCredentialAuthKey(provider: string, credentialId: string): Promise<string> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    return authStorageKey(provider, entry.id, entry.isPrimary);
  }

  /**
   * Returns the number of credentials in the pool for a provider.
   */
  async getPoolSize(provider: string): Promise<number> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();
    return this.pool[provider]?.credentials.length ?? 0;
  }

  /**
   * Read all auth credentials from auth.json and return an in-memory credential map
   * with the selected credential mapped to the bare provider key, plus all non-pooled
   * provider credentials unchanged. Used to build AuthStorage.inMemory() for runtime sessions.
   */
  async buildRuntimeAuthData(
    provider: string,
    credentialId: string
  ): Promise<Record<string, AuthCredential>> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    const selectedKey = authStorageKey(provider, entry.id, entry.isPrimary);

    const authStorage = AuthStorage.create(this.deps.authFile);
    const result: Record<string, AuthCredential> = {};

    // Read all keys from auth.json via the file-backed storage
    const rawData = await readAuthFileRaw(this.deps.authFile);
    for (const [key, value] of Object.entries(rawData)) {
      if (key === provider || key.startsWith(`${provider}:`)) {
        // Skip all pooled keys — we'll inject the selected one at the bare provider key
        continue;
      }
      // Keep non-pooled providers as-is (e.g., anthropic, xai)
      if (value && typeof value === "object") {
        result[key] = value as AuthCredential;
      }
    }

    // Place the selected credential at the bare provider key so Pi resolves it normally
    const selectedCredential = authStorage.get(selectedKey);
    if (selectedCredential) {
      result[provider] = selectedCredential;
    }

    return result;
  }

  /**
   * Returns the earliest cooldown expiry across all exhausted credentials,
   * or undefined if no credentials are in cooldown.
   */
  async getEarliestCooldownExpiry(provider: string): Promise<number | undefined> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const providerPool = this.pool[provider];
    if (!providerPool) return undefined;

    let earliest: number | undefined;
    for (const entry of providerPool.credentials) {
      if (entry.health === "cooldown" && entry.cooldownUntil !== null) {
        if (earliest === undefined || entry.cooldownUntil < earliest) {
          earliest = entry.cooldownUntil;
        }
      }
    }
    return earliest;
  }

  // ── Mutations ──

  async addCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const id = generateCredentialId();
    const now = new Date().toISOString();

    if (!this.pool[provider]) {
      this.pool[provider] = { strategy: "fill_first", credentials: [] };
    }

    const isFirst = this.pool[provider].credentials.length === 0;
    const entry: PersistedCredentialEntry = {
      id,
      label: identity?.label ?? (isFirst ? "Primary Account" : `Account ${this.pool[provider].credentials.length + 1}`),
      autoLabel: identity?.autoLabel,
      isPrimary: isFirst,
      accountId: identity?.accountId,
      health: "healthy",
      cooldownUntil: null,
      requestCount: 0,
      createdAt: now,
    };

    this.pool[provider].credentials.push(entry);

    // Write credential to auth.json
    const authStorage = AuthStorage.create(this.deps.authFile);
    const key = authStorageKey(provider, id, entry.isPrimary);
    authStorage.set(key, oauthCredential);

    await this.persist();
    return toPooledCredentialInfo(entry);
  }

  async removeCredential(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const providerPool = this.pool[provider];
    if (!providerPool) throw new Error(`No pool for provider: ${provider}`);

    const index = providerPool.credentials.findIndex((c) => c.id === credentialId);
    if (index === -1) throw new Error(`Credential not found: ${credentialId}`);

    if (providerPool.credentials.length === 1) {
      throw new Error("Cannot remove the only credential. Delete the provider authentication instead.");
    }

    const removed = providerPool.credentials[index];
    providerPool.credentials.splice(index, 1);

    if (removed.isPrimary && providerPool.credentials.length > 0) {
      const newPrimary = providerPool.credentials[0];
      await this.promotePrimaryAfterRemoval(provider, newPrimary.id);
      newPrimary.isPrimary = true;
    } else {
      const authStorage = AuthStorage.create(this.deps.authFile);
      authStorage.remove(authStorageKey(provider, removed.id, false));
    }

    await this.persist();
  }

  async setPrimary(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    if (entry.isPrimary) return; // Already primary

    await this.swapPrimary(provider, credentialId);
    await this.persist();
  }

  async setStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    if (strategy !== "fill_first" && strategy !== "least_used") {
      throw new Error(`Invalid strategy: ${strategy}`);
    }

    if (!this.pool[provider]) {
      this.pool[provider] = { strategy, credentials: [] };
    } else {
      this.pool[provider].strategy = strategy;
    }

    await this.persist();
  }

  async renameCredential(provider: string, credentialId: string, label: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const trimmed = label.trim();
    if (!trimmed) throw new Error("Label must be non-empty");

    const entry = this.findCredential(provider, credentialId);
    entry.label = trimmed;
    await this.persist();
  }

  async markUsed(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    entry.requestCount += 1;
    // Don't persist every increment — caller can batch or defer
  }

  async markExhausted(
    provider: string,
    credentialId: string,
    opts: { cooldownUntil?: number }
  ): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    entry.health = "cooldown";
    entry.cooldownUntil = opts.cooldownUntil ?? Date.now() + 60_000; // default 1 min
    await this.persist();
  }

  async markAuthError(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    entry.health = "auth_error";
    entry.cooldownUntil = null;
    await this.persist();
  }

  async markHealthy(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    entry.health = "healthy";
    entry.cooldownUntil = null;
    await this.persist();
  }

  async resetCooldown(provider: string, credentialId: string): Promise<void> {
    this.assertSupportedProvider(provider);
    await this.ensureLoaded();

    const entry = this.findCredential(provider, credentialId);
    if (entry.health === "cooldown") {
      entry.health = "healthy";
      entry.cooldownUntil = null;
      await this.persist();
    }
  }

  // ── Internal helpers ──

  private findCredential(provider: string, credentialId: string): PersistedCredentialEntry {
    const providerPool = this.pool[provider];
    if (!providerPool) throw new Error(`No pool for provider: ${provider}`);

    const entry = providerPool.credentials.find((c) => c.id === credentialId);
    if (!entry) throw new Error(`Credential not found: ${credentialId}`);
    return entry;
  }

  /**
   * Swap primary designation: moves the new primary's credential to the bare provider key
   * and the old primary's credential to a suffixed key, all atomically in auth.json.
   */
  private async swapPrimary(provider: string, newPrimaryId: string): Promise<void> {
    const providerPool = this.pool[provider];
    if (!providerPool) return;

    const oldPrimary = providerPool.credentials.find((c) => c.isPrimary);
    const newPrimary = providerPool.credentials.find((c) => c.id === newPrimaryId);
    if (!newPrimary) throw new Error(`Credential not found: ${newPrimaryId}`);
    if (newPrimary.isPrimary) return;

    const rawAuth = await readAuthFileRaw(this.deps.authFile);
    const newPrimaryOldKey = authStorageKey(provider, newPrimary.id, false);
    const newPrimaryCred = getAuthCredentialFromRaw(rawAuth, newPrimaryOldKey);
    if (!newPrimaryCred) {
      throw new Error(`Credential payload missing from auth store: ${newPrimaryOldKey}`);
    }

    const oldPrimaryCred = oldPrimary ? getAuthCredentialFromRaw(rawAuth, authStorageKey(provider, oldPrimary.id, true)) : undefined;

    delete rawAuth[newPrimaryOldKey];
    if (oldPrimary) {
      delete rawAuth[authStorageKey(provider, oldPrimary.id, true)];
    }
    rawAuth[provider] = newPrimaryCred;

    if (oldPrimary) {
      if (oldPrimaryCred) {
        rawAuth[authStorageKey(provider, oldPrimary.id, false)] = oldPrimaryCred;
      }
      oldPrimary.isPrimary = false;
    }

    await writeJsonFileAtomic(this.deps.authFile, rawAuth);
    newPrimary.isPrimary = true;
  }

  private expireCooldowns(provider: string): void {
    const providerPool = this.pool[provider];
    if (!providerPool) return;

    const now = Date.now();
    for (const entry of providerPool.credentials) {
      if (entry.health === "cooldown" && entry.cooldownUntil !== null && entry.cooldownUntil <= now) {
        entry.health = "healthy";
        entry.cooldownUntil = null;
      }
    }
  }

  private async persist(): Promise<void> {
    await writeJsonFileAtomic(this.poolFilePath, this.pool);
  }

  private assertSupportedProvider(provider: string): void {
    if (provider !== SUPPORTED_PROVIDER) {
      throw new Error(`Credential pooling is only supported for '${SUPPORTED_PROVIDER}', got '${provider}'`);
    }
  }

  private async promotePrimaryAfterRemoval(provider: string, newPrimaryId: string): Promise<void> {
    const rawAuth = await readAuthFileRaw(this.deps.authFile);
    const newPrimaryKey = authStorageKey(provider, newPrimaryId, false);
    const newPrimaryCred = getAuthCredentialFromRaw(rawAuth, newPrimaryKey);
    if (!newPrimaryCred) {
      throw new Error(`Credential payload missing from auth store: ${newPrimaryKey}`);
    }

    delete rawAuth[provider];
    delete rawAuth[newPrimaryKey];
    rawAuth[provider] = newPrimaryCred;

    await writeJsonFileAtomic(this.deps.authFile, rawAuth);
  }
}

// ── Helpers ──

function toPooledCredentialInfo(entry: PersistedCredentialEntry): PooledCredentialInfo {
  return {
    id: entry.id,
    label: entry.label,
    autoLabel: entry.autoLabel,
    isPrimary: entry.isPrimary,
    health: entry.health,
    cooldownUntil: entry.cooldownUntil,
    requestCount: entry.requestCount,
    createdAt: entry.createdAt,
  };
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") return undefined;
  if (credential.type === "api_key") {
    const apiKey = (credential as { key?: unknown }).key;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) return apiKey.trim();
  }
  const accessToken = (credential as { access?: unknown }).access;
  if (typeof accessToken === "string" && accessToken.trim().length > 0) return accessToken.trim();
  return undefined;
}

function getAuthCredentialFromRaw(
  rawAuth: Record<string, unknown>,
  key: string
): AuthCredential | undefined {
  const value = rawAuth[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as AuthCredential;
}

async function writeJsonFileAtomic(target: string, data: unknown): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  const tmp = `${target}.tmp.${Date.now()}.${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
}

async function readAuthFileRaw(authFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(authFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or malformed — return empty
  }
  return {};
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
