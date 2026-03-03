import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BaseConfigPersistence,
  buildIntegrationProfileId
} from "../base-config-persistence.js";
import {
  getLegacySharedIntegrationConfigPath,
  getSharedIntegrationConfigPath,
  isSharedIntegrationManagerId
} from "../shared-config.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import type { SlackIntegrationConfig, SlackIntegrationConfigPublic } from "./slack-types.js";

const SLACK_CONFIG_FILE_NAME = "slack.json";
const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME = "managers";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES = 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const SLACK_CONFIG_PERSISTENCE = new BaseConfigPersistence<SlackIntegrationConfig>({
  integrationName: "Slack",
  fileName: SLACK_CONFIG_FILE_NAME,
  createDefaultConfig: createDefaultSlackConfig,
  parseConfig: parseSlackConfig
});

export function getSlackConfigPath(dataDir: string, managerId: string): string {
  return SLACK_CONFIG_PERSISTENCE.getPath(dataDir, managerId);
}

function getLegacySlackConfigPath(dataDir: string, managerId: string): string {
  return resolve(
    dataDir,
    LEGACY_INTEGRATIONS_DIR_NAME,
    LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME,
    normalizeManagerId(managerId),
    SLACK_CONFIG_FILE_NAME
  );
}

export function getSharedSlackConfigPath(dataDir: string): string {
  return getSharedIntegrationConfigPath(dataDir, SLACK_CONFIG_FILE_NAME);
}

function getLegacySharedSlackConfigPath(dataDir: string): string {
  return getLegacySharedIntegrationConfigPath(dataDir, SLACK_CONFIG_FILE_NAME);
}

export function buildSlackProfileId(managerId: string): string {
  return buildIntegrationProfileId("slack", managerId);
}

export function createDefaultSlackConfig(managerId: string): SlackIntegrationConfig {
  return {
    profileId: buildSlackProfileId(managerId),
    enabled: false,
    mode: "socket",
    appToken: "",
    botToken: "",
    listen: {
      dm: true,
      channelIds: [],
      includePrivateChannels: false
    },
    response: {
      respondInThread: true,
      replyBroadcast: false,
      wakeWords: ["swarm", "bot"]
    },
    attachments: {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowImages: true,
      allowText: true,
      allowBinary: false
    }
  };
}

export async function loadSlackConfig(options: {
  dataDir: string;
  managerId: string;
}): Promise<SlackIntegrationConfig> {
  const managerId = normalizeManagerId(options.managerId);

  if (isSharedIntegrationManagerId(managerId)) {
    const sharedConfig = await loadSlackConfigWithLegacyFallback({
      primaryPath: getSharedSlackConfigPath(options.dataDir),
      legacyPath: getLegacySharedSlackConfigPath(options.dataDir)
    });
    return sharedConfig ?? createDefaultSlackConfig(managerId);
  }

  const managerConfig = await loadSlackConfigWithLegacyFallback({
    primaryPath: getSlackConfigPath(options.dataDir, managerId),
    legacyPath: getLegacySlackConfigPath(options.dataDir, managerId)
  });
  if (managerConfig) {
    return managerConfig;
  }

  const sharedConfig = await loadSlackConfigWithLegacyFallback({
    primaryPath: getSharedSlackConfigPath(options.dataDir),
    legacyPath: getLegacySharedSlackConfigPath(options.dataDir)
  });
  if (sharedConfig) {
    return {
      ...sharedConfig,
      profileId: buildSlackProfileId(managerId)
    };
  }

  return createDefaultSlackConfig(managerId);
}

export async function saveSlackConfig(options: {
  dataDir: string;
  managerId: string;
  config: SlackIntegrationConfig;
}): Promise<void> {
  const managerId = normalizeManagerId(options.managerId);

  if (isSharedIntegrationManagerId(managerId)) {
    await saveSlackConfigToPath(getSharedSlackConfigPath(options.dataDir), options.config);
    return;
  }

  await SLACK_CONFIG_PERSISTENCE.save({
    dataDir: options.dataDir,
    managerId,
    config: options.config
  });
}

export async function hasSlackOverrideConfig(options: {
  dataDir: string;
  managerId: string;
}): Promise<boolean> {
  const managerId = normalizeManagerId(options.managerId);
  if (isSharedIntegrationManagerId(managerId)) {
    return false;
  }

  const primaryPath = getSlackConfigPath(options.dataDir, managerId);
  const primaryRaw = await readConfigText(primaryPath);
  if (isConfigTextMeaningful(primaryRaw)) {
    return true;
  }

  const legacyPath = getLegacySlackConfigPath(options.dataDir, managerId);
  if (legacyPath === primaryPath) {
    return false;
  }

  const legacyRaw = await readConfigText(legacyPath);
  return isConfigTextMeaningful(legacyRaw);
}

export function mergeSlackConfig(
  base: SlackIntegrationConfig,
  patch: unknown
): SlackIntegrationConfig {
  const root = asRecord(patch);
  const listen = asRecord(root.listen);
  const response = asRecord(root.response);
  const attachments = asRecord(root.attachments);

  return {
    profileId: normalizeProfileId(root.profileId, base.profileId),
    enabled: normalizeBoolean(root.enabled, base.enabled),
    mode: "socket",
    appToken: normalizeToken(root.appToken, base.appToken),
    botToken: normalizeToken(root.botToken, base.botToken),
    listen: {
      dm: normalizeBoolean(listen.dm, base.listen.dm),
      channelIds: normalizeStringArray(listen.channelIds, base.listen.channelIds),
      includePrivateChannels: normalizeBoolean(
        listen.includePrivateChannels,
        base.listen.includePrivateChannels
      )
    },
    response: {
      respondInThread: normalizeBoolean(response.respondInThread, base.response.respondInThread),
      replyBroadcast: normalizeBoolean(response.replyBroadcast, base.response.replyBroadcast),
      wakeWords: normalizeWakeWords(response.wakeWords, base.response.wakeWords)
    },
    attachments: {
      maxFileBytes: normalizeFileSize(attachments.maxFileBytes, base.attachments.maxFileBytes),
      allowImages: normalizeBoolean(attachments.allowImages, base.attachments.allowImages),
      allowText: normalizeBoolean(attachments.allowText, base.attachments.allowText),
      allowBinary: normalizeBoolean(attachments.allowBinary, base.attachments.allowBinary)
    }
  };
}

export function maskSlackConfig(config: SlackIntegrationConfig): SlackIntegrationConfigPublic {
  return {
    profileId: config.profileId,
    enabled: config.enabled,
    mode: config.mode,
    appToken: config.appToken ? maskToken(config.appToken) : null,
    botToken: config.botToken ? maskToken(config.botToken) : null,
    hasAppToken: config.appToken.trim().length > 0,
    hasBotToken: config.botToken.trim().length > 0,
    listen: {
      dm: config.listen.dm,
      channelIds: [...config.listen.channelIds],
      includePrivateChannels: config.listen.includePrivateChannels
    },
    response: {
      respondInThread: config.response.respondInThread,
      replyBroadcast: config.response.replyBroadcast,
      wakeWords: [...config.response.wakeWords]
    },
    attachments: {
      maxFileBytes: config.attachments.maxFileBytes,
      allowImages: config.attachments.allowImages,
      allowText: config.attachments.allowText,
      allowBinary: config.attachments.allowBinary
    }
  };
}

async function loadSlackConfigWithLegacyFallback(options: {
  primaryPath: string;
  legacyPath: string;
}): Promise<SlackIntegrationConfig | undefined> {
  const candidatePaths =
    options.primaryPath === options.legacyPath
      ? [options.primaryPath]
      : [options.primaryPath, options.legacyPath];

  for (const candidatePath of candidatePaths) {
    const loaded = await loadSlackConfigFromPath(candidatePath);
    if (loaded) {
      return loaded;
    }
  }

  return undefined;
}

async function loadSlackConfigFromPath(configPath: string): Promise<SlackIntegrationConfig | undefined> {
  const raw = await readConfigText(configPath);
  if (!isConfigTextMeaningful(raw)) {
    return undefined;
  }

  const parsed = parseConfigText(raw!, configPath);

  try {
    return parseSlackConfig(parsed);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid Slack config at ${configPath}: ${error.message}`);
    }

    throw error;
  }
}

async function saveSlackConfigToPath(configPath: string, config: SlackIntegrationConfig): Promise<void> {
  const tmpPath = `${configPath}.tmp`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmpPath, configPath);
}

async function readConfigText(configPath: string): Promise<string | undefined> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isConfigTextMeaningful(raw: string | undefined): boolean {
  if (typeof raw !== "string") {
    return false;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return !isEmptyObject(parsed);
  } catch {
    return true;
  }
}

function parseConfigText(raw: string, configPath: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Slack config JSON at ${configPath}`);
    }

    throw error;
  }
}

function isEmptyObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).length === 0;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseSlackConfig(value: unknown): SlackIntegrationConfig {
  const root = requireRecord(value, "Slack config must be an object");
  const listen = requireRecord(root.listen, "Slack config.listen must be an object");
  const response = requireRecord(root.response, "Slack config.response must be an object");
  const attachments = requireRecord(root.attachments, "Slack config.attachments must be an object");

  return {
    profileId: requireNonEmptyString(root.profileId, "Slack config.profileId must be a non-empty string"),
    enabled: requireBoolean(root.enabled, "Slack config.enabled must be a boolean"),
    mode: requireMode(root.mode),
    appToken: requireString(root.appToken, "Slack config.appToken must be a string"),
    botToken: requireString(root.botToken, "Slack config.botToken must be a string"),
    listen: {
      dm: requireBoolean(listen.dm, "Slack config.listen.dm must be a boolean"),
      channelIds: requireStringArray(
        listen.channelIds,
        "Slack config.listen.channelIds must be an array of strings"
      ),
      includePrivateChannels: requireBoolean(
        listen.includePrivateChannels,
        "Slack config.listen.includePrivateChannels must be a boolean"
      )
    },
    response: {
      respondInThread: requireBoolean(
        response.respondInThread,
        "Slack config.response.respondInThread must be a boolean"
      ),
      replyBroadcast: requireBoolean(
        response.replyBroadcast,
        "Slack config.response.replyBroadcast must be a boolean"
      ),
      wakeWords: normalizeWakeWords(
        requireStringArray(
          response.wakeWords,
          "Slack config.response.wakeWords must be an array of strings"
        ),
        []
      )
    },
    attachments: {
      maxFileBytes: normalizeFileSize(
        requireNumber(
          attachments.maxFileBytes,
          "Slack config.attachments.maxFileBytes must be a number"
        ),
        DEFAULT_MAX_FILE_BYTES
      ),
      allowImages: requireBoolean(
        attachments.allowImages,
        "Slack config.attachments.allowImages must be a boolean"
      ),
      allowText: requireBoolean(
        attachments.allowText,
        "Slack config.attachments.allowText must be a boolean"
      ),
      allowBinary: requireBoolean(
        attachments.allowBinary,
        "Slack config.attachments.allowBinary must be a boolean"
      )
    }
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeWakeWords(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const cleaned = entry.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

function normalizeFileSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_FILE_BYTES) {
    return MIN_FILE_BYTES;
  }

  if (rounded > MAX_FILE_BYTES) {
    return MAX_FILE_BYTES;
  }

  return rounded;
}

function normalizeToken(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function normalizeProfileId(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function maskToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "********";
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}******`;
  }

  return `${trimmed.slice(0, 5)}…${trimmed.slice(-3)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(message);
  }

  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value.trim();
}

function requireNonEmptyString(value: unknown, message: string): string {
  const parsed = requireString(value, message);
  if (!parsed) {
    throw new Error(message);
  }

  return parsed;
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(message);
  }

  return normalizeStringArray(value, []);
}

function requireMode(value: unknown): "socket" {
  if (value !== "socket") {
    throw new Error('Slack config.mode must be "socket"');
  }

  return value;
}
