import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OpenAIBrokerInviteRedeemResponse,
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerSettingsState,
  OpenAIBrokerSettingsStatus,
  OpenAIBrokerTestResponse,
  OpenAICodexAuthMode,
  RedeemOpenAIBrokerInviteRequest,
  UpdateOpenAIBrokerSettingsRequest,
} from "@forge/protocol";
import type { SwarmConfig } from "../types.js";
import { renameWithRetry } from "../retry-rename.js";
import { OpenAIAuthBrokerClient, OpenAIAuthBrokerClientError } from "./openai-auth-broker-client.js";
import { parseOpenAIAuthBrokerInvite } from "./openai-auth-broker-invite.js";
import { maskOpenAIAuthBrokerSecret, redactOpenAIAuthBrokerText } from "./openai-auth-redaction.js";

export const OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY = "forge.openaiAuthBrokerToken";
export const LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY = "FORGE_OPENAI_AUTH_BROKER_TOKEN";
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
        "OpenAI/Codex auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Forge Auth broker settings."
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
          "Forge Auth broker URL and token are required before enabling broker mode for OpenAI/Codex."
        );
      }

      if (request.testBeforeEnable || current.file.mode !== "central_broker" || didBrokerConnectionChange({
        existingBroker,
        nextBroker,
        currentToken,
        nextToken,
      })) {
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
            status.message ?? "Forge Auth broker test failed. Broker mode was not enabled."
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
        "OpenAI/Codex auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Forge Auth broker settings."
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
        "OpenAI/Codex auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before changing Forge Auth broker settings."
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
      return { ok: false, error: "Forge Auth broker URL and token are required before testing OpenAI/Codex auth." };
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
    if (!request?.broker || doesBrokerTestPatchMatchPersistedSettings({
      current,
      requestBroker: request.broker,
      resolvedBroker: broker,
      resolvedToken: token,
      currentToken,
    })) {
      await this.cacheStatus(status);
    }
    return status.ok ? { ok: true, status } : { ok: false, status, error: status.message };
  }

  async redeemInvite(request: RedeemOpenAIBrokerInviteRequest): Promise<OpenAIBrokerInviteRedeemResponse> {
    const current = await this.resolveEffectiveSettings();
    if (current.envOverride) {
      throw new OpenAIAuthBrokerSettingsValidationError(
        "OpenAI/Codex auth is controlled by environment variables. Remove the FORGE_OPENAI_CODEX_AUTH_MODE override before redeeming a Forge Auth broker invite."
      );
    }

    const invite = parseOpenAIAuthBrokerInvite(request.invite);
    const nextBroker = buildNextBrokerConfig({
      existingBroker: current.file.broker,
      patch: { url: invite.brokerUrl },
      token: undefined,
      now: this.now(),
    });
    if (!nextBroker?.url || !nextBroker.instanceId) {
      throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker invite could not resolve a stable install identity.");
    }

    const redeemed = await redeemOpenAIAuthBrokerInvite({
      invite,
      broker: nextBroker,
      timeoutMs: nextBroker.timeoutMs,
      now: this.now,
    });

    const inviteRedactionSecrets = [invite.secret];
    const status = await this.testResolvedBroker({
      url: nextBroker.url,
      token: redeemed.token,
      clientId: nextBroker.clientId,
      instanceId: nextBroker.instanceId,
      instanceLabel: nextBroker.instanceLabel,
      userLabel: nextBroker.userLabel,
      timeoutMs: nextBroker.timeoutMs,
    }, inviteRedactionSecrets);

    const nextFile: OpenAICodexAuthSourceFileV1 = {
      version: 1,
      mode: "central_broker",
      broker: {
        ...nextBroker,
        ...(redeemed.userLabel && !nextBroker.userLabel ? { userLabel: redeemed.userLabel } : {}),
        lastTestedAt: status.checkedAt,
        lastStatus: redactBrokerStatus(status, [redeemed.token, ...inviteRedactionSecrets]),
      },
      updatedAt: this.now().toISOString(),
    };

    await this.writeBrokerToken(redeemed.token);
    await this.writeConfigFile(nextFile);
    return this.getSettings();
  }

  async resolveEffectiveSettings(): Promise<EffectiveSettings> {
    const [file, savedToken] = await Promise.all([this.readConfigFile(), this.readBrokerToken()]);
    const envMode = normalizeEnvMode(process.env.FORGE_OPENAI_CODEX_AUTH_MODE);
    if (envMode) {
      const envBroker = resolveEnvBrokerConfig();
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
    const sharedAuthDir = this.options.config.paths.sharedAuthDir ?? dirname(this.options.config.paths.sharedAuthFile);
    return join(sharedAuthDir, OPENAI_CODEX_AUTH_SOURCE_FILE_NAME);
  }

  private async testResolvedBroker(
    broker: ResolvedBrokerConfig & { token: string },
    redactionSecrets: readonly (string | undefined)[] = []
  ): Promise<OpenAIBrokerSettingsStatus> {
    const exactRedactionSecrets = [broker.token, ...redactionSecrets];
    try {
      const client = new OpenAIAuthBrokerClient({
        baseUrl: broker.url ?? "",
        bearerToken: broker.token,
        timeoutMs: broker.timeoutMs,
        now: this.now,
        redactionSecrets,
      });
      const status = await client.getStatus();
      return redactBrokerStatus(status, exactRedactionSecrets) ?? status;
    } catch (error) {
      return {
        ok: false,
        degraded: error instanceof OpenAIAuthBrokerClientError && isKnownBrokerStatusReason(error.code)
          ? error.code
          : "unreachable",
        message: redactOpenAIAuthBrokerText(error, exactRedactionSecrets),
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
        lastStatus: redactBrokerStatus(status, [current.broker.token]),
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
    return normalizeOptionalString(secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY])
      ?? normalizeOptionalString(secrets[LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]);
  }

  private async writeBrokerToken(token: string | undefined): Promise<void> {
    const secrets = await this.readSecretsStore();
    if (token) {
      secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY] = token;
    } else {
      delete secrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY];
    }
    delete secrets[LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY];
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

async function redeemOpenAIAuthBrokerInvite(options: {
  invite: { brokerUrl: string; inviteId: string; secret: string };
  broker: NonNullable<OpenAICodexAuthSourceFileV1["broker"]>;
  timeoutMs: number;
  now: () => Date;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; userLabel?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeTimeoutMs(options.timeoutMs));
  try {
    const response = await (options.fetchImpl ?? fetch)(new URL("/v1/invites/redeem", `${options.invite.brokerUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        inviteId: options.invite.inviteId,
        secret: options.invite.secret,
        install: {
          installId: options.broker.instanceId,
          clientId: options.broker.clientId,
          instanceId: options.broker.instanceId,
          ...(options.broker.instanceLabel ? { instanceLabel: options.broker.instanceLabel } : {}),
          forgeVersion: process.env.FORGE_APP_VERSION ?? "dev",
        },
      }),
    });

    const text = await response.text();
    const payload = text ? parseJson(text) : null;
    if (!response.ok) {
      const brokerError = normalizeBrokerError(payload);
      throw new OpenAIAuthBrokerSettingsValidationError(
        redactOpenAIAuthBrokerText(`Forge Auth broker invite redeem failed: ${brokerError.message}`, [options.invite.secret])
      );
    }

    return normalizeInviteRedeemPayload(payload);
  } catch (error) {
    if (error instanceof OpenAIAuthBrokerSettingsValidationError) {
      throw error;
    }
    const message = error instanceof Error && error.name === "AbortError"
      ? "Forge Auth broker invite redeem timed out."
      : `Forge Auth broker invite redeem failed: ${redactOpenAIAuthBrokerText(error, [options.invite.secret])}`;
    throw new OpenAIAuthBrokerSettingsValidationError(message);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeInviteRedeemPayload(payload: unknown): { token: string; userLabel?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker invite redeem response was invalid.");
  }
  const record = payload as Record<string, unknown>;
  const token = normalizeOptionalString(record.token);
  if (!token) {
    throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker invite redeem response did not include a broker token.");
  }

  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  if (!scopes.includes("lease") || !scopes.includes("read")) {
    throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker invite token does not include the required read and lease scopes.");
  }

  if (Array.isArray(record.grants)) {
    for (const grant of record.grants) {
      if (grant && typeof grant === "object" && (grant as { provider?: unknown }).provider !== "openai-codex") {
        throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker invite returned an unsupported provider grant.");
      }
    }
  }

  const user = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : undefined;
  const userLabel = normalizeOptionalString(user?.email) ?? normalizeOptionalString(user?.name);
  return {
    token,
    ...(userLabel ? { userLabel } : {}),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeBrokerError(payload: unknown): { code: string; message: string } {
  if (!payload || typeof payload !== "object") {
    return { code: "broker_request_failed", message: "Unexpected broker response." };
  }
  const record = payload as { error?: unknown; message?: unknown; code?: unknown };
  return {
    code: typeof record.code === "string" && record.code.trim() ? record.code.trim() : "broker_request_failed",
    message: typeof record.error === "string" && record.error.trim()
      ? record.error.trim()
      : typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : "Unexpected broker response.",
  };
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
  const patchUrl = normalizeUrlPatch(options.patch?.url);
  const url = patchUrl ?? existing?.url;
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
    status: redactBrokerStatus(broker?.lastStatus, [token]),
  };
}

function doesBrokerTestPatchMatchPersistedSettings({
  current,
  requestBroker,
  resolvedBroker,
  resolvedToken,
  currentToken,
}: {
  current: EffectiveSettings;
  requestBroker: UpdateOpenAIBrokerSettingsRequest["broker"];
  resolvedBroker: ResolvedBrokerConfig;
  resolvedToken: string;
  currentToken?: string;
}): boolean {
  if (current.envOverride || !current.file.broker || !resolvedBroker.url || !resolvedBroker.instanceId || !requestBroker) {
    return false;
  }

  const tokenPatch = normalizeOptionalString(requestBroker.token);
  if (requestBroker.clearToken === true || (tokenPatch !== undefined && tokenPatch !== currentToken)) {
    return false;
  }

  return !didBrokerConnectionChange({
    existingBroker: current.file.broker,
    nextBroker: {
      url: resolvedBroker.url,
      clientId: resolvedBroker.clientId,
      instanceId: resolvedBroker.instanceId,
      ...(resolvedBroker.instanceLabel ? { instanceLabel: resolvedBroker.instanceLabel } : {}),
      ...(resolvedBroker.userLabel ? { userLabel: resolvedBroker.userLabel } : {}),
      timeoutMs: resolvedBroker.timeoutMs,
    },
    currentToken,
    nextToken: resolvedToken,
  });
}

function didBrokerConnectionChange(options: {
  existingBroker: OpenAICodexAuthSourceFileV1["broker"] | undefined;
  nextBroker: OpenAICodexAuthSourceFileV1["broker"];
  currentToken: string | undefined;
  nextToken: string | undefined;
}): boolean {
  const { existingBroker, nextBroker, currentToken, nextToken } = options;
  if (!existingBroker) {
    return true;
  }
  return existingBroker.url !== nextBroker?.url
    || existingBroker.clientId !== nextBroker?.clientId
    || existingBroker.instanceId !== nextBroker?.instanceId
    || existingBroker.instanceLabel !== nextBroker?.instanceLabel
    || existingBroker.userLabel !== nextBroker?.userLabel
    || existingBroker.timeoutMs !== nextBroker?.timeoutMs
    || currentToken !== nextToken;
}

function resolveEnvBrokerConfig(): ResolvedBrokerConfig {
  return {
    url: normalizeUrl(process.env.FORGE_OPENAI_AUTH_BROKER_URL),
    token: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN),
    clientId: "forge",
    instanceId: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID),
    instanceLabel: normalizeOptionalString(process.env.FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL),
    timeoutMs: normalizeTimeoutMs(process.env.FORGE_OPENAI_AUTH_BROKER_TIMEOUT_MS),
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

function normalizeUrlPatch(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  const normalized = normalizeUrl(trimmed);
  if (!normalized) {
    throw new OpenAIAuthBrokerSettingsValidationError("Forge Auth broker URL must be a valid http(s) URL.");
  }
  return normalized;
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

function redactBrokerStatus(
  status: OpenAIBrokerSettingsStatus | undefined,
  exactSecrets: readonly (string | undefined)[]
): OpenAIBrokerSettingsStatus | undefined {
  if (!status) {
    return undefined;
  }
  return {
    ...status,
    ...(status.message ? { message: redactOpenAIAuthBrokerText(status.message, exactSecrets) } : {}),
  };
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
