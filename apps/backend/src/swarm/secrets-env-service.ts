import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { copyFileIfMissing } from "./copy-file-if-missing.js";
import { normalizeEnvVarName, type ParsedSkillEnvDeclaration } from "./skill-frontmatter.js";
import { renameWithRetry } from "./retry-rename.js";
import type {
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SkillEnvRequirement,
  SwarmConfig
} from "./types.js";

const SETTINGS_ENV_MASK = "********";
const SETTINGS_AUTH_MASK = "********";

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
  }
];

const MANAGED_MODEL_PROVIDER_ENV_VARS: Record<SettingsAuthProviderName, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"]
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

  constructor(private readonly deps: SecretsEnvServiceDependencies) {}

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

    if (!requirements.some((requirement) => requirement.name === "CODEX_API_KEY")) {
      const codexApiKey = this.resolveEnvValue("CODEX_API_KEY");
      requirements.push({
        name: "CODEX_API_KEY",
        description: "API key used by the codex-app runtime when no existing Codex login session is available.",
        required: false,
        helpUrl: "https://platform.openai.com/api-keys",
        skillName: "codex-app-runtime",
        isSet: typeof codexApiKey === "string" && codexApiKey.trim().length > 0,
        maskedValue: codexApiKey ? SETTINGS_ENV_MASK : undefined
      });
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
      const resolvedToken = extractAuthCredentialToken(credential);

      return {
        provider: definition.provider,
        configured: typeof resolvedToken === "string" && resolvedToken.length > 0,
        authType: resolveAuthCredentialType(credential),
        maskedValue: resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    const authFile = await this.resolveAuthFileForWrite();
    const authStorage = AuthStorage.create(authFile);

    for (const [rawProvider, rawValue] of entries) {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

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

    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, "utf8");
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

    const oldSharedPath = join(this.deps.config.paths.sharedDir, "auth", "auth.json");
    const legacyPath = this.deps.config.paths.authFile;

    for (const fallbackPath of [oldSharedPath, legacyPath]) {
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

export async function getManagedModelProviderCredentialAvailability(
  config: SwarmConfig
): Promise<Map<string, boolean>> {
  const [configuredAuthProviders, secrets] = await Promise.all([
    readConfiguredSettingsAuthProviders(config),
    readSecretsStoreFromConfig(config)
  ]);

  const availability = new Map<string, boolean>();

  for (const [provider, envVars] of Object.entries(MANAGED_MODEL_PROVIDER_ENV_VARS)) {
    const hasStoredEnv = envVars.some((name) => resolveStoredOrProcessEnvValue(secrets, name) !== undefined);
    const hasStoredAuth = configuredAuthProviders.has(provider as SettingsAuthProviderName);
    availability.set(provider, hasStoredEnv || hasStoredAuth);
  }

  return availability;
}

export async function readConfiguredSettingsAuthProviders(
  config: SwarmConfig
): Promise<Set<SettingsAuthProviderName>> {
  const authFile = await resolveAuthFileForReadFromConfig(config);
  const authStorage = AuthStorage.create(authFile);
  const configuredProviders = new Set<SettingsAuthProviderName>();

  for (const definition of SETTINGS_AUTH_PROVIDER_DEFINITIONS) {
    const credential = authStorage.get(definition.storageProvider);
    const resolvedToken = extractAuthCredentialToken(credential);
    if (typeof resolvedToken === "string" && resolvedToken.length > 0) {
      configuredProviders.add(definition.provider);
    }
  }

  return configuredProviders;
}

async function readSecretsStoreFromConfig(config: SwarmConfig): Promise<Record<string, string>> {
  const preferredPath = config.paths.sharedSecretsFile;
  const oldSharedPath = join(config.paths.sharedDir, "secrets.json");
  const legacyPath = config.paths.secretsFile;
  const candidatePaths = uniquePaths([preferredPath, oldSharedPath, legacyPath]);

  for (const candidatePath of candidatePaths) {
    let raw: string;

    try {
      raw = await readFile(candidatePath, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        continue;
      }

      throw error;
    }

    return parseSecretsStoreRaw(raw);
  }

  return {};
}

async function resolveAuthFileForReadFromConfig(config: SwarmConfig): Promise<string> {
  const preferredPath = config.paths.sharedAuthFile;
  const oldSharedPath = join(config.paths.sharedDir, "auth", "auth.json");
  const legacyPath = config.paths.authFile;

  for (const candidatePath of uniquePaths([preferredPath, oldSharedPath, legacyPath])) {
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

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
