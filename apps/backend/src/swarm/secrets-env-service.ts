import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { copyFileIfMissing } from "./copy-file-if-missing.js";
import { CredentialPoolService } from "./credential-pool.js";
import {
  LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
  OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
  OpenAIAuthSettingsService,
} from "./openai-auth/openai-auth-settings-service.js";
import { OpenAIAuthBrokerRuntimeService } from "./openai-auth/openai-auth-broker-runtime-service.js";
import { normalizeEnvVarName, type ParsedSkillEnvDeclaration } from "./skill-frontmatter.js";
import { renameWithRetry } from "./retry-rename.js";
import { isEnoentError } from "../utils/fs-errors.js";
import type {
  ForgeProviderCredentialAuthType,
  ForgeProviderCredentialSource,
  ForgeProviderCredentialSummary,
} from "@forge/protocol";
import type {
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SkillEnvRequirement,
  SwarmConfig
} from "./types.js";

const SETTINGS_ENV_MASK = "********";
const SETTINGS_AUTH_MASK = "********";
const API_KEY_POOL_CONFLICT_MESSAGE = "Remove pooled accounts before setting an API key";
const POOLED_SETTINGS_AUTH_PROVIDERS = new Set<string>(["anthropic", "openai-codex"]);
const RESERVED_NON_ENV_SECRET_KEYS = new Set<string>([
  OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
  LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
]);

const SETTINGS_AUTH_PROVIDER_DEFINITIONS: Array<{
  provider: SettingsAuthProviderName;
  storageProvider: string;
}> = [
  {
    provider: "anthropic",
    storageProvider: "anthropic"
  },
  {
    provider: "openai-codex",
    storageProvider: "openai-codex"
  },
  {
    provider: "xai",
    storageProvider: "xai"
  },
  {
    provider: "openrouter",
    storageProvider: "openrouter"
  },
  {
    provider: "cursor-sdk",
    storageProvider: "cursor-sdk"
  }
];

const MANAGED_MODEL_PROVIDER_ENV_VARS: Record<SettingsAuthProviderName, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "cursor-sdk": ["CURSOR_API_KEY"]
};

interface SkillMetadataForSettings {
  skillName: string;
  env: ParsedSkillEnvDeclaration[];
}

interface SecretsEnvServiceDependencies {
  config: SwarmConfig;
  ensureSkillMetadataLoaded: () => Promise<void>;
  getSkillMetadata: () => SkillMetadataForSettings[];
}

export class SecretsEnvService {
  private readonly originalProcessEnvByName = new Map<string, string | undefined>();
  private secrets: Record<string, string> = {};
  private credentialPoolServiceInstance: CredentialPoolService | null = null;
  private openAIAuthBrokerRuntimeServiceInstance: OpenAIAuthBrokerRuntimeService | null = null;

  constructor(private readonly deps: SecretsEnvServiceDependencies) {}

  getCredentialPoolService(): CredentialPoolService {
    if (!this.credentialPoolServiceInstance) {
      this.credentialPoolServiceInstance = new CredentialPoolService({
        authDir: this.deps.config.paths.sharedAuthDir,
        authFile: this.deps.config.paths.sharedAuthFile,
      });
    }
    return this.credentialPoolServiceInstance;
  }

  getOpenAIAuthBrokerRuntimeService(): OpenAIAuthBrokerRuntimeService {
    if (!this.openAIAuthBrokerRuntimeServiceInstance) {
      this.openAIAuthBrokerRuntimeServiceInstance = new OpenAIAuthBrokerRuntimeService({
        config: this.deps.config,
      });
    }
    return this.openAIAuthBrokerRuntimeServiceInstance;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    await this.deps.ensureSkillMetadataLoaded();
    const skillMetadata = this.deps.getSkillMetadata();

    const requirements: SkillEnvRequirement[] = [];

    for (const skill of skillMetadata) {
      for (const declaration of skill.env) {
        const resolvedValue = this.resolveEnvValue(declaration.name);
        requirements.push({
          name: declaration.name,
          description: declaration.description,
          required: declaration.required,
          helpUrl: declaration.helpUrl,
          skillName: skill.skillName,
          isSet: typeof resolvedValue === "string" && resolvedValue.trim().length > 0,
          maskedValue: resolvedValue ? SETTINGS_ENV_MASK : undefined
        });
      }
    }

    requirements.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.skillName.localeCompare(right.skillName);
    });

    return requirements;
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    for (const [rawName, rawValue] of entries) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        throw new Error(`Invalid environment variable name: ${rawName}`);
      }
      if (RESERVED_NON_ENV_SECRET_KEYS.has(normalizedName)) {
        throw new Error(`Environment variable ${normalizedName} is managed by Forge Auth broker settings`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Environment variable ${normalizedName} must be a non-empty string`);
      }

      this.secrets[normalizedName] = normalizedValue;
      this.applySecretToProcessEnv(normalizedName, normalizedValue);
    }

    await this.saveSecretsStore();
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    const normalizedName = normalizeEnvVarName(name);
    if (!normalizedName) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }

    if (!(normalizedName in this.secrets)) {
      return;
    }

    delete this.secrets[normalizedName];
    this.restoreProcessEnvForSecret(normalizedName);
    await this.saveSecretsStore();
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const authFile = await this.resolveAuthFileForRead();
    const authStorage = AuthStorage.create(authFile);

    return SETTINGS_AUTH_PROVIDER_DEFINITIONS.map((definition) => {
      const credential = authStorage.get(definition.storageProvider);
      const resolvedToken = extractSettingsAuthProviderToken(definition.provider, credential);

      return {
        provider: definition.provider,
        configured: typeof resolvedToken === "string" && resolvedToken.length > 0,
        authType: resolvedToken ? resolveAuthCredentialType(credential) : undefined,
        maskedValue: resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    await this.resolveAuthFileForWrite();

    const resolvedEntries = await Promise.all(entries.map(async ([rawProvider, rawValue]) => {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

      await this.assertNoPooledCredentialConflict(resolvedProvider.storageProvider);

      return {
        resolvedProvider,
        normalizedValue,
      };
    }));

    const authStorage = AuthStorage.create(this.deps.config.paths.sharedAuthFile);

    for (const { resolvedProvider, normalizedValue } of resolvedEntries) {
      const credential = {
        type: "api_key",
        key: normalizedValue,
        access: normalizedValue,
        refresh: "",
        expires: ""
      } as unknown as AuthCredential;

      authStorage.set(resolvedProvider.storageProvider, credential);
      await this.syncLegacyAuthProvider(resolvedProvider.storageProvider, credential);
    }
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authFile = await this.resolveAuthFileForWrite();
    const authStorage = AuthStorage.create(authFile);
    authStorage.remove(resolvedProvider.storageProvider);
    await this.syncLegacyAuthProvider(resolvedProvider.storageProvider, undefined);
  }

  async updateSettingsAuthCredential(provider: string, credential: AuthCredential): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authFile = await this.resolveAuthFileForWrite();
    const authStorage = AuthStorage.create(authFile);
    authStorage.set(resolvedProvider.storageProvider, credential);
    await this.syncLegacyAuthProvider(resolvedProvider.storageProvider, credential);
  }

  async loadSecretsStore(): Promise<void> {
    this.secrets = await this.readSecretsStore();

    for (const [name, value] of Object.entries(this.secrets)) {
      this.applySecretToProcessEnv(name, value);
    }
  }

  private resolveEnvValue(name: string): string | undefined {
    const secretValue = this.secrets[name];
    if (typeof secretValue === "string" && secretValue.trim().length > 0) {
      return secretValue;
    }

    const processValue = process.env[name];
    if (typeof processValue !== "string" || processValue.trim().length === 0) {
      return undefined;
    }

    return processValue;
  }

  private async readSecretsStore(): Promise<Record<string, string>> {
    return readSecretsStoreFromConfig(this.deps.config);
  }

  private async saveSecretsStore(): Promise<void> {
    const target = this.deps.config.paths.sharedSecretsFile;
    const tmp = `${target}.tmp`;
    const preservedSecrets = await readReservedSecretsForPreservationFromConfig(this.deps.config);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify({ ...preservedSecrets, ...this.secrets }, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
  }

  private async resolveAuthFileForRead(): Promise<string> {
    return resolveAuthFileForReadFromConfig(this.deps.config);
  }

  private async resolveAuthFileForWrite(): Promise<string> {
    const preferredPath = this.deps.config.paths.sharedAuthFile;
    await mkdir(dirname(preferredPath), { recursive: true });

    if (await this.pathExists(preferredPath)) {
      return preferredPath;
    }

    const legacyPath = this.deps.config.paths.authFile;

    for (const fallbackPath of [legacyPath]) {
      if (fallbackPath === preferredPath) {
        continue;
      }

      if (await copyFileIfMissing(fallbackPath, preferredPath)) {
        break;
      }
    }

    return preferredPath;
  }

  private async syncLegacyAuthProvider(storageProvider: string, credential: AuthCredential | undefined): Promise<void> {
    const legacyPath = this.deps.config.paths.authFile;
    const preferredPath = this.deps.config.paths.sharedAuthFile;
    if (legacyPath === preferredPath || !(await this.pathExists(legacyPath))) {
      return;
    }

    await mkdir(dirname(legacyPath), { recursive: true });

    const legacyAuthStorage = AuthStorage.create(legacyPath);
    if (credential) {
      legacyAuthStorage.set(storageProvider, credential);
      return;
    }

    legacyAuthStorage.remove(storageProvider);
  }

  private async pathExists(path: string): Promise<boolean> {
    return pathExists(path);
  }

  private async assertNoPooledCredentialConflict(storageProvider: string): Promise<void> {
    if (!POOLED_SETTINGS_AUTH_PROVIDERS.has(storageProvider)) {
      return;
    }

    const poolService = new CredentialPoolService({
      authDir: this.deps.config.paths.sharedAuthDir,
      authFile: this.deps.config.paths.sharedAuthFile,
    });
    const pool = await poolService.listPool(storageProvider);
    if (pool.credentials.length > 0) {
      throw new Error(API_KEY_POOL_CONFLICT_MESSAGE);
    }
  }

  private applySecretToProcessEnv(name: string, value: string): void {
    if (!this.originalProcessEnvByName.has(name)) {
      this.originalProcessEnvByName.set(name, process.env[name]);
    }

    process.env[name] = value;
  }

  private restoreProcessEnvForSecret(name: string): void {
    const original = this.originalProcessEnvByName.get(name);

    if (original === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = original;
  }
}

export interface CursorSdkApiKeyResolution {
  apiKey: string;
  source: Extract<ForgeProviderCredentialSource, "auth_file" | "secrets" | "env">;
}

export async function resolveCursorSdkApiKey(config: SwarmConfig): Promise<CursorSdkApiKeyResolution> {
  const [authFile, secrets] = await Promise.all([
    resolveAuthFileForReadFromConfig(config),
    readSecretsStoreFromConfig(config)
  ]);
  const authStorage = AuthStorage.create(authFile);
  const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find((entry) => entry.provider === "cursor-sdk");
  const credential = definition ? authStorage.get(definition.storageProvider) : undefined;
  const authToken = extractSettingsAuthProviderToken("cursor-sdk", credential);
  if (authToken) {
    return { apiKey: authToken, source: "auth_file" };
  }

  const secretValue = secrets.CURSOR_API_KEY;
  if (typeof secretValue === "string" && secretValue.trim().length > 0) {
    return { apiKey: secretValue.trim(), source: "secrets" };
  }

  const envValue = process.env.CURSOR_API_KEY;
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return { apiKey: envValue.trim(), source: "env" };
  }

  throw new Error("Cursor SDK API key not configured. Add CURSOR_API_KEY in Settings → Authentication.");
}

export async function getManagedModelProviderCredentialAvailability(
  config: SwarmConfig,
  options: { credentialPoolService?: CredentialPoolService } = {}
): Promise<Map<string, boolean>> {
  const summaries = await getManagedModelProviderCredentialSummaries(config, options);
  const availability = new Map<string, boolean>();

  for (const [provider, summary] of summaries) {
    if (provider === "openai-codex" && summary.centralBroker) {
      availability.set(provider, isCentralBrokerCredentialAvailable(summary));
      continue;
    }
    availability.set(provider, summary.configured);
  }

  // Native Claude SDK runtimes do not require Anthropic API credentials. Keep the provider
  // selectable even when managed auth is absent; runtime initialization handles missing SDK
  // binaries/dependencies separately with actionable errors.
  availability.set("claude-sdk", true);

  return availability;
}

export async function getManagedModelProviderCredentialSummaries(
  config: SwarmConfig,
  options: { credentialPoolService?: CredentialPoolService } = {}
): Promise<Map<string, ForgeProviderCredentialSummary>> {
  const [authFile, secrets, brokerSettings] = await Promise.all([
    resolveAuthFileForReadFromConfig(config),
    readSecretsStoreFromConfig(config),
    new OpenAIAuthSettingsService({ config }).getSettingsState(),
  ]);
  const authStorage = AuthStorage.create(authFile);
  const summaries = new Map<string, ForgeProviderCredentialSummary>();

  for (const [provider, envVars] of Object.entries(MANAGED_MODEL_PROVIDER_ENV_VARS)) {
    if (provider === "openai-codex" && brokerSettings.effectiveMode === "central_broker") {
      summaries.set(provider, buildCentralBrokerCredentialSummary(brokerSettings));
      continue;
    }
    const authTypes = new Set<ForgeProviderCredentialAuthType>();
    const sources = new Set<ForgeProviderCredentialSource>();

    const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find((entry) => entry.provider === provider);
    const credential = definition ? authStorage.get(definition.storageProvider) : undefined;
    if (extractSettingsAuthProviderToken(provider as SettingsAuthProviderName, credential)) {
      authTypes.add(resolveForgeCredentialAuthType(credential));
      sources.add("auth_file");
    }

    for (const name of envVars) {
      if (resolveStoredOrProcessEnvValue(secrets, name) !== undefined) {
        authTypes.add("api_key");
        sources.add(name in secrets ? "secrets" : "env");
      }
    }

    let pooled = false;
    const poolService = options.credentialPoolService;
    if (poolService && definition && POOLED_SETTINGS_AUTH_PROVIDERS.has(definition.storageProvider)) {
      try {
        const pool = await poolService.listPool(definition.storageProvider);
        for (const pooledCredential of pool.credentials) {
          if (pooledCredential.health !== "auth_error") {
            pooled = true;
            sources.add("pool");
            authTypes.add("oauth");
          }
        }
      } catch {
        // Pool inspection is best-effort for availability summaries.
      }
    }

    const summary: ForgeProviderCredentialSummary = {
      configured: authTypes.size > 0,
      authTypes: [...authTypes].sort(),
      sources: [...sources].sort(),
      ...(pooled ? { pooled: true } : {}),
    };
    summaries.set(provider, summary);
  }

  summaries.set("claude-sdk", {
    configured: true,
    authTypes: ["unknown"],
    sources: [],
  });

  return summaries;
}

function buildCentralBrokerCredentialSummary(
  brokerSettings: Awaited<ReturnType<OpenAIAuthSettingsService["getSettingsState"]>>
): ForgeProviderCredentialSummary {
  const counts = brokerSettings.broker.status?.accounts;
  const totalAccounts = counts
    ? counts.healthy + counts.cooldown + counts.auth_error + counts.disabled + (counts.draining ?? 0) + counts.unknown
    : undefined;
  const availableAccounts = counts ? counts.healthy : undefined;
  const configured = brokerSettings.broker.configured;
  const degraded = brokerSettings.broker.status?.degraded;
  return {
    configured,
    authTypes: configured ? ["oauth"] : [],
    sources: ["central_broker"],
    centralBroker: {
      configured,
      reachable: brokerSettings.broker.status ? brokerSettings.broker.status.ok || degraded !== "unreachable" : undefined,
      ...(degraded ? { degraded } : {}),
      ...(availableAccounts !== undefined ? { availableAccounts } : {}),
      ...(totalAccounts !== undefined ? { totalAccounts } : {}),
      ...(brokerSettings.broker.status?.message ? { detail: brokerSettings.broker.status.message } : {}),
    },
  };
}

function isCentralBrokerCredentialAvailable(summary: ForgeProviderCredentialSummary): boolean {
  if (!summary.configured) {
    return false;
  }
  const degraded = summary.centralBroker?.degraded;
  return degraded !== "invalid_bearer" && degraded !== "unreachable" && degraded !== "no_accounts" && degraded !== "token_shape_unverified";
}

async function readSecretsStoreFromConfig(config: SwarmConfig): Promise<Record<string, string>> {
  const raw = await readFirstSecretsStoreRawFromConfig(config);
  return raw ? parseSecretsStoreRaw(raw) : {};
}

async function readReservedSecretsForPreservationFromConfig(config: SwarmConfig): Promise<Record<string, string>> {
  const raw = await readFirstSecretsStoreRawFromConfig(config);
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const reserved: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    if (!RESERVED_NON_ENV_SECRET_KEYS.has(rawName) || typeof rawValue !== "string") {
      continue;
    }
    const normalizedValue = rawValue.trim();
    if (normalizedValue) {
      reserved[rawName] = normalizedValue;
    }
  }
  return reserved;
}

async function readFirstSecretsStoreRawFromConfig(config: SwarmConfig): Promise<string | undefined> {
  const preferredPath = config.paths.sharedSecretsFile;
  const legacyPath = config.paths.secretsFile;
  const candidatePaths = uniquePaths([preferredPath, legacyPath]);

  for (const candidatePath of candidatePaths) {
    try {
      return await readFile(candidatePath, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        continue;
      }

      throw error;
    }
  }

  return undefined;
}

async function resolveAuthFileForReadFromConfig(config: SwarmConfig): Promise<string> {
  const preferredPath = config.paths.sharedAuthFile;
  const legacyPath = config.paths.authFile;

  for (const candidatePath of uniquePaths([preferredPath, legacyPath])) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return preferredPath;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function resolveStoredOrProcessEnvValue(
  secrets: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const secretValue = secrets[name];
  if (typeof secretValue === "string" && secretValue.trim().length > 0) {
    return secretValue;
  }

  const processValue = process.env[name];
  if (typeof processValue !== "string" || processValue.trim().length === 0) {
    return undefined;
  }

  return processValue;
}

function parseSecretsStoreRaw(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(parsed)) {
    if (RESERVED_NON_ENV_SECRET_KEYS.has(rawName)) {
      continue;
    }

    const normalizedName = normalizeEnvVarName(rawName);
    if (!normalizedName) {
      continue;
    }

    if (typeof rawValue !== "string") {
      continue;
    }

    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      continue;
    }

    normalized[normalizedName] = normalizedValue;
  }

  return normalized;
}

function resolveSettingsAuthProvider(
  provider: string
): { provider: SettingsAuthProviderName; storageProvider: string } | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }

  const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find(
    (entry) => entry.provider === normalizedProvider
  );
  if (!definition) {
    return undefined;
  }

  return {
    provider: definition.provider,
    storageProvider: definition.storageProvider
  };
}

function resolveForgeCredentialAuthType(credential: AuthCredential | undefined): ForgeProviderCredentialAuthType {
  if (!credential) {
    return "unknown";
  }
  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }
  return "unknown";
}

function resolveAuthCredentialType(
  credential: AuthCredential | undefined
): SettingsAuthProvider["authType"] | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }

  return "unknown";
}

function extractSettingsAuthProviderToken(
  provider: SettingsAuthProviderName,
  credential: AuthCredential | undefined
): string | undefined {
  if (provider === "cursor-sdk") {
    return extractApiKeyCredentialToken(credential);
  }

  return extractAuthCredentialToken(credential);
}

function extractApiKeyCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object" || credential.type !== "api_key") {
    return undefined;
  }

  return normalizeAuthToken((credential as { key?: unknown }).key);
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maskSettingsAuthValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return SETTINGS_AUTH_MASK;
  }

  const suffix = trimmed.slice(-4);
  if (!suffix) {
    return SETTINGS_AUTH_MASK;
  }

  return `${SETTINGS_AUTH_MASK}${suffix}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

