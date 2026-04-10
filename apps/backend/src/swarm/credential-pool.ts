import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { anthropicOAuthProvider, openaiCodexOAuthProvider } from "@mariozechner/pi-ai/oauth";
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

const SUPPORTED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const POOL_FILENAME = "credential-pool.json";
const POOLED_OAUTH_REFRESH_SKEW_MS = 5 * 60_000;
const POOLED_OAUTH_PROVIDERS = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider,
} as const;

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

class PooledCredentialAuthError extends Error {
  readonly provider: string;
  readonly credentialId: string;

  constructor(provider: string, credentialId: string, message: string) {
    super(message);
    this.name = "PooledCredentialAuthError";
    this.provider = provider;
    this.credentialId = credentialId;
  }
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

    // Auto-migrate: if no pool for a supported provider but auth.json has a credential
    for (const provider of SUPPORTED_PROVIDERS) {
      if (!this.pool[provider]) {
        await this.migrateFromAuthFile(provider);
      }
    }

    this.loaded = true;
  }

  private async migrateFromAuthFile(provider: string): Promise<void> {
    const authStorage = AuthStorage.create(this.deps.authFile);
    const credential = authStorage.get(provider);
    if (!shouldMigrateCredential(provider, credential)) return;

    const id = generateCredentialId();
    const now = new Date().toISOString();

    this.pool[provider] = {
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
    const rawAuth = await readAuthFileRaw(this.deps.authFile);

    return {
      strategy: providerPool.strategy,
      credentials: providerPool.credentials.map((entry) =>
        toPooledCredentialInfo(entry, resolveReportedCredentialHealth(provider, entry, rawAuth))
      ),
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

    const candidates = orderCredentialSelectionCandidates(providerPool);
    for (const candidate of candidates) {
      try {
        await this.ensureCredentialAvailable(provider, candidate.id);
        return {
          credentialId: candidate.id,
          authStorageKey: authStorageKey(provider, candidate.id, candidate.isPrimary),
        };
      } catch (error) {
        if (error instanceof PooledCredentialAuthError) {
          continue;
        }
        throw error;
      }
    }

    return null;
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

    const selectedCredential = await this.ensureCredentialAvailable(provider, credentialId);
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
    result[provider] = selectedCredential;

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

    const existingCredentialCount = this.pool[provider]?.credentials.length ?? 0;
    if (existingCredentialCount === 0) {
      this.assertNoBareCredentialConflict(provider);
    }

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

    const removed = providerPool.credentials[index];
    providerPool.credentials.splice(index, 1);

    if (providerPool.credentials.length === 0) {
      await this.clearProviderAuth(provider);
      delete this.pool[provider];
      await this.persist();
      return;
    }

    if (removed.isPrimary) {
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

  private async ensureCredentialAvailable(provider: string, credentialId: string): Promise<AuthCredential> {
    const entry = this.findCredential(provider, credentialId);
    const key = authStorageKey(provider, entry.id, entry.isPrimary);
    const authStorage = AuthStorage.create(this.deps.authFile);
    const credential = authStorage.get(key);

    if (!credential) {
      await this.markAuthError(provider, credentialId);
      throw new PooledCredentialAuthError(provider, credentialId, `Credential payload missing from auth store: ${key}`);
    }

    if (credential.type !== "oauth") {
      return credential;
    }

    if (!oauthCredentialNeedsRefresh(credential, POOLED_OAUTH_REFRESH_SKEW_MS)) {
      return credential;
    }

    const refreshableCredential = toRefreshableOAuthCredential(credential);
    const oauthProvider = getPooledOAuthProvider(provider);
    if (!refreshableCredential || !oauthProvider) {
      await this.markAuthError(provider, credentialId);
      throw new PooledCredentialAuthError(provider, credentialId, `Credential is missing refreshable OAuth fields: ${key}`);
    }

    try {
      const refreshedCredential = {
        type: "oauth",
        ...await oauthProvider.refreshToken(refreshableCredential),
      } as AuthCredential;
      authStorage.set(key, refreshedCredential);
      if (entry.health === "auth_error") {
        entry.health = "healthy";
        entry.cooldownUntil = null;
        await this.persist();
      }
      return refreshedCredential;
    } catch (error) {
      await this.markAuthError(provider, credentialId);
      throw new PooledCredentialAuthError(
        provider,
        credentialId,
        `Failed to refresh pooled ${provider} credential ${credentialId}: ${toErrorMessage(error)}`
      );
    }
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

  private assertNoBareCredentialConflict(provider: string): void {
    const authStorage = AuthStorage.create(this.deps.authFile);
    const existingCredential = authStorage.get(provider);
    if (!hasConflictingBareCredential(existingCredential)) {
      return;
    }

    throw new Error(getAddCredentialConflictMessage(provider));
  }

  private assertSupportedProvider(provider: string): void {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      const supportedProviders = Array.from(SUPPORTED_PROVIDERS).map((entry) => `'${entry}'`).join(", ");
      throw new Error(`Credential pooling is only supported for ${supportedProviders}, got '${provider}'`);
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

  private async clearProviderAuth(provider: string): Promise<void> {
    const rawAuth = await readAuthFileRaw(this.deps.authFile);
    delete rawAuth[provider];

    for (const key of Object.keys(rawAuth)) {
      if (key.startsWith(`${provider}:`)) {
        delete rawAuth[key];
      }
    }

    await writeJsonFileAtomic(this.deps.authFile, rawAuth);
  }
}

// ── Helpers ──

function toPooledCredentialInfo(
  entry: PersistedCredentialEntry,
  healthOverride?: PooledCredentialInfo["health"]
): PooledCredentialInfo {
  return {
    id: entry.id,
    label: entry.label,
    autoLabel: entry.autoLabel,
    isPrimary: entry.isPrimary,
    health: healthOverride ?? entry.health,
    cooldownUntil: entry.cooldownUntil,
    requestCount: entry.requestCount,
    createdAt: entry.createdAt,
  };
}

function orderCredentialSelectionCandidates(providerPool: PersistedProviderPool): PersistedCredentialEntry[] {
  const healthy = providerPool.credentials.filter((entry) => entry.health === "healthy");
  if (providerPool.strategy === "least_used") {
    return healthy.sort((a, b) => {
      const countDiff = a.requestCount - b.requestCount;
      if (countDiff !== 0) return countDiff;
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return 0;
    });
  }

  const primary = healthy.find((entry) => entry.isPrimary);
  if (!primary) {
    return healthy;
  }

  return [primary, ...healthy.filter((entry) => entry.id !== primary.id)];
}

function resolveReportedCredentialHealth(
  provider: string,
  entry: PersistedCredentialEntry,
  rawAuth: Record<string, unknown>
): PooledCredentialInfo["health"] {
  if (entry.health !== "healthy") {
    return entry.health;
  }

  const credential = getAuthCredentialFromRaw(rawAuth, authStorageKey(provider, entry.id, entry.isPrimary));
  if (!credential) {
    return "auth_error";
  }

  if (credential.type !== "oauth") {
    return "healthy";
  }

  if (!hasUsableOAuthAccessToken(credential) || oauthCredentialNeedsRefresh(credential, 0)) {
    return "auth_error";
  }

  return "healthy";
}

function getPooledOAuthProvider(provider: string) {
  return POOLED_OAUTH_PROVIDERS[provider as keyof typeof POOLED_OAUTH_PROVIDERS];
}

function toRefreshableOAuthCredential(credential: AuthCredential): OAuthCredentials | null {
  if (credential.type !== "oauth") {
    return null;
  }

  const refresh = normalizeAuthToken((credential as { refresh?: unknown }).refresh);
  if (!refresh) {
    return null;
  }

  const { type: _type, ...rest } = credential as AuthCredential & Record<string, unknown>;
  return {
    ...rest,
    access: normalizeAuthToken((credential as { access?: unknown }).access) ?? "",
    refresh,
    expires: normalizeCredentialExpiry((credential as { expires?: unknown }).expires) ?? 0,
  } as OAuthCredentials;
}

function hasUsableOAuthAccessToken(credential: AuthCredential): boolean {
  if (credential.type !== "oauth") {
    return false;
  }

  return Boolean(normalizeAuthToken((credential as { access?: unknown }).access));
}

function oauthCredentialNeedsRefresh(credential: AuthCredential, minValidityMs: number): boolean {
  if (credential.type !== "oauth") {
    return false;
  }

  const expiresAt = normalizeCredentialExpiry((credential as { expires?: unknown }).expires);
  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (!accessToken) {
    return true;
  }

  if (expiresAt === undefined) {
    return false;
  }

  return expiresAt <= Date.now() + minValidityMs;
}

function normalizeCredentialExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldMigrateCredential(provider: string, credential: AuthCredential | undefined): boolean {
  const token = extractAuthCredentialToken(credential);
  if (!token) return false;

  if (provider === "anthropic") {
    return credential?.type === "oauth";
  }

  return provider === "openai-codex";
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

function hasConflictingBareCredential(credential: AuthCredential | undefined): boolean {
  const token = extractAuthCredentialToken(credential);
  return Boolean(token) && credential?.type !== "oauth";
}

function getAddCredentialConflictMessage(provider: string): string {
  if (provider === "anthropic") {
    return "Remove the existing Anthropic API key before adding OAuth accounts";
  }

  if (provider === "openai-codex") {
    return "Remove the existing OpenAI API key before adding OAuth accounts";
  }

  return "Remove the existing API key before adding OAuth accounts";
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
