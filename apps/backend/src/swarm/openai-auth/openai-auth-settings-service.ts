import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerSettingsState,
  OpenAIBrokerSettingsStatus,
  OpenAIBrokerTestResponse,
  OpenAICodexAuthMode,
  UpdateOpenAIBrokerSettingsRequest,
} from "@forge/protocol";
import type { SwarmConfig } from "../types.js";
import { renameWithRetry } from "../retry-rename.js";
import { OpenAIAuthBrokerClient, OpenAIAuthBrokerClientError } from "./openai-auth-broker-client.js";
import { maskOpenAIAuthBrokerSecret, redactOpenAIAuthBrokerText } from "./openai-auth-redaction.js";

export const OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY = "FORGE_OPENAI_AUTH_BROKER_TOKEN";
export const OPENAI_CODEX_AUTH_SOURCE_FILE_NAME = "openai-codex-auth-source.json";

interface OpenAICodexAuthSourceFileV1 {
  version: 1;
  mode: OpenAICodexAuthMode;
  broker?: {
    url: string;
    clientId: string;
    instanceId: string;
    instanceLabel?: string;
    userLabel?: string;
    timeoutMs: number;
    lastTestedAt?: string;
    lastStatus?: OpenAIBrokerSettingsStatus;
  };
  updatedAt: string;
}

interface ResolvedBrokerConfig {
  url?: string;
  token?: string;
  clientId: string;
  instanceId?: string;
  instanceLabel?: string;
  userLabel?: string;
  timeoutMs: number;
  status?: OpenAIBrokerSettingsStatus;
}

interface EffectiveSettings {
  file: OpenAICodexAuthSourceFileV1;
  mode: OpenAICodexAuthMode;
  effectiveMode: OpenAICodexAuthMode;
  source: "settings" | "env" | "default";
  envOverride: boolean;
  broker: ResolvedBrokerConfig;
}

export class OpenAIAuthBrokerSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIAuthBrokerSettingsValidationError";
  }
}

export class OpenAIAuthSettingsService {
  constructor(private readonly options: { config: SwarmConfig; now?: () => Date }) {}

  async getSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return { settings: await this.getSettingsState() };
  }

  async getSettingsState(): Promise<OpenAIBrokerSettingsState> {
    const effective = await this.resolveEffectiveSettings();
    return toSettingsState(effective);
  }

  async getEffectiveMode(): Promise<OpenAICodexAuthMode> {
    return (await this.resolveEffectiveSettings()).effectiveMode;
  }

  async updateSettings(request: UpdateOpenAIBrokerSettingsRequest): Promise<OpenAIBrokerSettingsResponse> {
    const current = await this.resolveEffectiveSettings();
    if (current.envOverride) {
      throw new OpenAIAuthBrokerSettingsValidationError(
        "OpenAI/Codex broker auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Settings."
      );
    }

    const mode = normalizeMode(request.mode);
    const currentToken = await this.readBrokerToken();
    const tokenPatch = normalizeOptionalString(request.broker?.token);
    const clearToken = request.broker?.clearToken === true;
    const nextToken = clearToken ? undefined : tokenPatch ?? currentToken;
    const existingBroker = current.file.broker;
    const nextBroker = buildNextBrokerConfig({
      existingBroker,
      patch: request.broker,
      token: nextToken,
      now: this.now(),
    });

    if (mode === "central_broker") {
      if (!nextBroker?.url || !nextToken) {
        throw new OpenAIAuthBrokerSettingsValidationError(
          "OpenAI/Codex broker URL and token are required before enabling broker mode."
        );
      }

      if (request.testBeforeEnable) {
        const status = await this.testResolvedBroker({
          url: nextBroker.url,
          token: nextToken,
          clientId: nextBroker.clientId,
          instanceId: nextBroker.instanceId,
          instanceLabel: nextBroker.instanceLabel,
          userLabel: nextBroker.userLabel,
          timeoutMs: nextBroker.timeoutMs,
        });
        if (!status.ok) {
          throw new OpenAIAuthBrokerSettingsValidationError(
            status.message ?? "OpenAI/Codex broker test failed. Broker mode was not enabled."
          );
        }
        nextBroker.lastTestedAt = status.checkedAt;
        nextBroker.lastStatus = status;
      }
    }

    const nextFile: OpenAICodexAuthSourceFileV1 = {
      version: 1,
      mode,
      ...(nextBroker?.url ? { broker: nextBroker } : {}),
      updatedAt: this.now().toISOString(),
    };

    if (clearToken || tokenPatch !== undefined) {
      await this.writeBrokerToken(nextToken);
    }
    await this.writeConfigFile(nextFile);
    return this.getSettings();
  }

  async disableBroker(): Promise<OpenAIBrokerSettingsResponse> {
    const current = await this.resolveEffectiveSettings();
    if (current.envOverride) {
      throw new OpenAIAuthBrokerSettingsValidationError(
        "OpenAI/Codex broker auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Settings."
      );
    }

    const file: OpenAICodexAuthSourceFileV1 = {
      ...current.file,
      mode: "local",
      updatedAt: this.now().toISOString(),
    };
    await this.writeConfigFile(file);
    return this.getSettings();
  }

  async clearBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    const current = await this.resolveEffectiveSettings();
    if (current.envOverride) {
      throw new OpenAIAuthBrokerSettingsValidationError(
        "OpenAI/Codex broker auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Settings."
      );
    }

    await this.writeBrokerToken(undefined);
    await this.removeConfigFile();
    return this.getSettings();
  }

  async testSettings(request?: Partial<UpdateOpenAIBrokerSettingsRequest>): Promise<OpenAIBrokerTestResponse> {
    const current = await this.resolveEffectiveSettings();
    const currentToken = await this.readBrokerToken();
    const tokenPatch = normalizeOptionalString(request?.broker?.token);
    const clearToken = request?.broker?.clearToken === true;
    const token = current.envOverride ? current.broker.token : (clearToken ? undefined : tokenPatch ?? currentToken);
    const broker = current.envOverride
      ? current.broker
      : buildNextBrokerConfig({
          existingBroker: current.file.broker,
          patch: request?.broker,
          token,
          now: this.now(),
        });

    if (!broker?.url || !token) {
      return { ok: false, error: "OpenAI/Codex broker URL and token are required before testing." };
    }

    const status = await this.testResolvedBroker({
      url: broker.url,
      token,
      clientId: broker.clientId,
      instanceId: broker.instanceId,
      instanceLabel: broker.instanceLabel,
      userLabel: broker.userLabel,
      timeoutMs: broker.timeoutMs,
    });
    if (!request?.broker) {
      await this.cacheStatus(status);
    }
    return status.ok ? { ok: true, status } : { ok: false, status, error: status.message };
  }

  async resolveEffectiveSettings(): Promise<EffectiveSettings> {
    const [file, savedToken] = await Promise.all([this.readConfigFile(), this.readBrokerToken()]);
    const envMode = normalizeEnvMode(process.env.FORGE_OPENAI_CODEX_AUTH_MODE);
    if (envMode) {
      const envBroker = resolveEnvBrokerConfig(file, savedToken);
      return {
        file,
        mode: file.mode,
        effectiveMode: envMode,
        source: "env",
        envOverride: true,
        broker: envBroker,
      };
    }

    const broker = resolveSettingsBrokerConfig(file, savedToken);
    return {
      file,
      mode: file.mode,
      effectiveMode: file.mode,
      source: file.broker || file.mode !== "local" ? "settings" : "default",
      envOverride: false,
      broker,
    };
  }

  getConfigFilePath(): string {
    return join(this.options.config.paths.sharedAuthDir, OPENAI_CODEX_AUTH_SOURCE_FILE_NAME);
  }

  private async testResolvedBroker(broker: ResolvedBrokerConfig & { token: string }): Promise<OpenAIBrokerSettingsStatus> {
    try {
      const client = new OpenAIAuthBrokerClient({
        baseUrl: broker.url ?? "",
        bearerToken: broker.token,
        timeoutMs: broker.timeoutMs,
        now: this.now,
      });
      return await client.getStatus();
    } catch (error) {
      return {
        ok: false,
        degraded: error instanceof OpenAIAuthBrokerClientError && isKnownBrokerStatusReason(error.code)
          ? error.code
          : "unreachable",
        message: redactOpenAIAuthBrokerText(error),
        checkedAt: this.now().toISOString(),
      };
    }
  }

  private async cacheStatus(status: OpenAIBrokerSettingsStatus): Promise<void> {
    const current = await this.resolveEffectiveSettings();
    if (current.envOverride || !current.file.broker) {
      return;
    }

    await this.writeConfigFile({
      ...current.file,
      broker: {
        ...current.file.broker,
        lastTestedAt: status.checkedAt,
        lastStatus: status,
      },
      updatedAt: this.now().toISOString(),
    });
  }

  private async readConfigFile(): Promise<OpenAICodexAuthSourceFileV1> {
    let raw: string;
    try {
      raw = await readFile(this.getConfigFilePath(), "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return defaultConfigFile(this.now());
      }
      throw error;
    }

    return parseConfigFile(raw, this.now());
  }

  private async writeConfigFile(file: OpenAICodexAuthSourceFileV1): Promise<void> {
    const target = this.getConfigFilePath();
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
  }

  private async removeConfigFile(): Promise<void> {
    await rm(this.getConfigFilePath(), { force: true });
  }

  private async readBrokerToken(): Promise<string | undefined> {
    const secrets = await this.readSecretsStore();
    return normalizeOptionalString(secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]);
  }

  private async writeBrokerToken(token: string | undefined): Promise<void> {
    const secrets = await this.readSecretsStore();
    if (token) {
      secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY] = token;
    } else {
      delete secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY];
    }
    await this.writeSecretsStore(secrets);
  }

  private async readSecretsStore(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.options.config.paths.sharedSecretsFile, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return {};
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      );
    } catch {
      return {};
    }
  }

  private async writeSecretsStore(secrets: Record<string, string>): Promise<void> {
    const target = this.options.config.paths.sharedSecretsFile;
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
  }

  private now = (): Date => this.options.now?.() ?? new Date();
}

function defaultConfigFile(now: Date): OpenAICodexAuthSourceFileV1 {
  return { version: 1, mode: "local", updatedAt: now.toISOString() };
}

function parseConfigFile(raw: string, now: Date): OpenAICodexAuthSourceFileV1 {
  try {
    const parsed = JSON.parse(raw) as Partial<OpenAICodexAuthSourceFileV1>;
    const mode = normalizeMode(parsed.mode);
    const broker = normalizeBrokerFileConfig(parsed.broker);
    return {
      version: 1,
      mode,
      ...(broker ? { broker } : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
    };
  } catch {
    return defaultConfigFile(now);
  }
}

function normalizeBrokerFileConfig(value: unknown): OpenAICodexAuthSourceFileV1["broker"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const url = normalizeUrl(record.url);
  if (!url) {
    return undefined;
  }
  return {
    url,
    clientId: normalizeOptionalString(record.clientId) ?? "forge",
    instanceId: normalizeOptionalString(record.instanceId) ?? randomUUID(),
    ...(normalizeOptionalString(record.instanceLabel) ? { instanceLabel: normalizeOptionalString(record.instanceLabel) } : {}),
    ...(normalizeOptionalString(record.userLabel) ? { userLabel: normalizeOptionalString(record.userLabel) } : {}),
    timeoutMs: normalizeTimeoutMs(record.timeoutMs),
    ...(normalizeOptionalString(record.lastTestedAt) ? { lastTestedAt: normalizeOptionalString(record.lastTestedAt) } : {}),
    ...(isOpenAIBrokerSettingsStatus(record.lastStatus) ? { lastStatus: record.lastStatus } : {}),
  };
}

function buildNextBrokerConfig(options: {
  existingBroker: OpenAICodexAuthSourceFileV1["broker"] | undefined;
  patch: UpdateOpenAIBrokerSettingsRequest["broker"] | undefined;
  token: string | undefined;
  now: Date;
}): OpenAICodexAuthSourceFileV1["broker"] {
  const existing = options.existingBroker;
  const url = normalizeUrl(options.patch?.url) ?? existing?.url;
  if (!url) {
    return undefined;
  }
  return {
    url,
    clientId: normalizeOptionalString(options.patch?.clientId) ?? existing?.clientId ?? "forge",
    instanceId: existing?.instanceId ?? normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID) ?? randomUUID(),
    instanceLabel: normalizeOptionalString(options.patch?.instanceLabel) ?? existing?.instanceLabel ?? hostname(),
    ...(normalizeOptionalString(options.patch?.userLabel) ?? existing?.userLabel
      ? { userLabel: normalizeOptionalString(options.patch?.userLabel) ?? existing?.userLabel }
      : {}),
    timeoutMs: normalizeTimeoutMs(options.patch?.timeoutMs ?? existing?.timeoutMs),
    ...(existing?.lastTestedAt ? { lastTestedAt: existing.lastTestedAt } : {}),
    ...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
  };
}

function resolveSettingsBrokerConfig(file: OpenAICodexAuthSourceFileV1, token: string | undefined): ResolvedBrokerConfig {
  const broker = file.broker;
  return {
    url: broker?.url,
    token,
    clientId: broker?.clientId ?? "forge",
    instanceId: broker?.instanceId,
    instanceLabel: broker?.instanceLabel,
    userLabel: broker?.userLabel,
    timeoutMs: broker?.timeoutMs ?? 10_000,
    status: broker?.lastStatus,
  };
}

function resolveEnvBrokerConfig(file: OpenAICodexAuthSourceFileV1, savedToken: string | undefined): ResolvedBrokerConfig {
  const settingsBroker = resolveSettingsBrokerConfig(file, savedToken);
  return {
    ...settingsBroker,
    url: normalizeUrl(process.env.FORGE_OPENAI_AUTH_BROKER_URL) ?? settingsBroker.url,
    token: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN) ?? settingsBroker.token,
    clientId: "forge",
    instanceId: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID) ?? settingsBroker.instanceId,
    instanceLabel: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL) ?? settingsBroker.instanceLabel,
    timeoutMs: normalizeTimeoutMs(process.env.FORGE_OPENAI_AUTH_BROKER_TIMEOUT_MS ?? settingsBroker.timeoutMs),
  };
}

function toSettingsState(effective: EffectiveSettings): OpenAIBrokerSettingsState {
  const hasToken = typeof effective.broker.token === "string" && effective.broker.token.length > 0;
  const configured = Boolean(effective.broker.url && hasToken);
  return {
    mode: effective.mode,
    effectiveMode: effective.effectiveMode,
    source: effective.source,
    envOverride: effective.envOverride,
    broker: {
      configured,
      ...(effective.broker.url ? { url: effective.broker.url } : {}),
      hasToken,
      ...(hasToken ? { tokenMasked: maskOpenAIAuthBrokerSecret(effective.broker.token) } : {}),
      clientId: effective.broker.clientId,
      ...(effective.broker.instanceId ? { instanceId: effective.broker.instanceId } : {}),
      ...(effective.broker.instanceLabel ? { instanceLabel: effective.broker.instanceLabel } : {}),
      ...(effective.broker.userLabel ? { userLabel: effective.broker.userLabel } : {}),
      timeoutMs: effective.broker.timeoutMs,
      ...(effective.broker.status ? { status: effective.broker.status } : {}),
    },
  };
}

function normalizeEnvMode(value: unknown): OpenAICodexAuthMode | undefined {
  if (value === "local" || value === "central_broker") {
    return value;
  }
  return undefined;
}

function normalizeMode(value: unknown): OpenAICodexAuthMode {
  if (value === "central_broker") {
    return "central_broker";
  }
  return "local";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeTimeoutMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Number(value);
    return normalizeTimeoutMs(parsed);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10_000;
  }
  return Math.max(1_000, Math.min(60_000, Math.trunc(value)));
}

function isOpenAIBrokerSettingsStatus(value: unknown): value is OpenAIBrokerSettingsStatus {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<OpenAIBrokerSettingsStatus>;
  return typeof record.ok === "boolean" && typeof record.checkedAt === "string";
}

function isKnownBrokerStatusReason(value: string): value is NonNullable<OpenAIBrokerSettingsStatus["degraded"]> {
  return [
    "unreachable",
    "invalid_bearer",
    "no_accounts",
    "all_cooldown",
    "auth_errors",
    "usage_unavailable",
    "token_shape_unverified",
  ].includes(value);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
