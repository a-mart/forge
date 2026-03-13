import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getSharedMobileDevicesPath,
  getSharedMobileNotificationPreferencesPath
} from "../swarm/data-paths.js";
import { renameWithRetry } from "../swarm/retry-rename.js";

const MOBILE_DEVICES_FILE_VERSION = 1;
const MOBILE_NOTIFICATION_PREFERENCES_VERSION = 1;
const MAX_DEVICE_NAME_LENGTH = 120;
const MAX_TOKEN_LENGTH = 4096;

export type MobilePlatform = "ios" | "android" | "unknown";

export interface MobilePushDevice {
  token: string;
  platform: MobilePlatform;
  deviceName: string;
  registeredAt: string;
  enabled: boolean;
  updatedAt?: string;
  disabledAt?: string;
  disabledReason?: string;
}

interface MobilePushDeviceRegistryFile {
  version: 1;
  updatedAt: string;
  devices: MobilePushDevice[];
}

export interface MobileNotificationPreferences {
  enabled: boolean;
  unreadMessages: boolean;
  agentStatusChanges: boolean;
  errors: boolean;
  suppressWhenActive: boolean;
  updatedAt: string | null;
}

interface MobileNotificationPreferencesFile {
  version: 1;
  preferences: MobileNotificationPreferences;
}

export interface MobileNotificationPreferencesPatch {
  enabled?: boolean;
  unreadMessages?: boolean;
  agentStatusChanges?: boolean;
  errors?: boolean;
  suppressWhenActive?: boolean;
}

export class MobilePushStore {
  private readonly devicesPath: string;
  private readonly preferencesPath: string;
  private readonly now: () => Date;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.devicesPath = getSharedMobileDevicesPath(options.dataDir);
    this.preferencesPath = getSharedMobileNotificationPreferencesPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async listDevices(): Promise<MobilePushDevice[]> {
    const registry = await this.loadDeviceRegistry();
    return registry.devices.map((device) => ({ ...device }));
  }

  async getEnabledDevices(): Promise<MobilePushDevice[]> {
    const devices = await this.listDevices();
    return devices.filter((device) => device.enabled);
  }

  async registerDevice(input: {
    token: unknown;
    platform: unknown;
    deviceName?: unknown;
    enabled?: unknown;
  }): Promise<MobilePushDevice> {
    const token = normalizePushToken(input.token);
    const platform = normalizePlatform(input.platform);
    const deviceName = normalizeDeviceName(input.deviceName);
    const enabled = normalizeOptionalBoolean(input.enabled, true, "enabled");

    return this.runExclusive(async () => {
      const nowIso = this.now().toISOString();
      const registry = await this.loadDeviceRegistry();
      const existingIndex = registry.devices.findIndex((device) => device.token === token);

      const nextDevice: MobilePushDevice = {
        token,
        platform,
        deviceName,
        registeredAt:
          existingIndex >= 0
            ? normalizeIsoForLoad(registry.devices[existingIndex]?.registeredAt) ?? nowIso
            : nowIso,
        enabled,
        updatedAt: nowIso,
        ...(enabled
          ? {}
          : {
              disabledAt: nowIso,
              disabledReason: "disabled_by_user"
            })
      };

      if (existingIndex >= 0) {
        registry.devices[existingIndex] = nextDevice;
      } else {
        registry.devices.push(nextDevice);
      }

      registry.updatedAt = nowIso;
      await writeJsonAtomic(this.devicesPath, registry);
      return { ...nextDevice };
    });
  }

  async unregisterDevice(tokenValue: unknown): Promise<boolean> {
    const token = normalizePushToken(tokenValue);

    return this.runExclusive(async () => {
      const registry = await this.loadDeviceRegistry();
      const initialLength = registry.devices.length;
      registry.devices = registry.devices.filter((device) => device.token !== token);

      if (registry.devices.length === initialLength) {
        return false;
      }

      registry.updatedAt = this.now().toISOString();
      await writeJsonAtomic(this.devicesPath, registry);
      return true;
    });
  }

  async disableDevice(tokenValue: unknown, reason = "DeviceNotRegistered"): Promise<boolean> {
    const token = normalizePushToken(tokenValue);

    return this.runExclusive(async () => {
      const registry = await this.loadDeviceRegistry();
      const device = registry.devices.find((entry) => entry.token === token);
      if (!device) {
        return false;
      }

      if (!device.enabled && device.disabledReason === reason) {
        return false;
      }

      const nowIso = this.now().toISOString();
      device.enabled = false;
      device.updatedAt = nowIso;
      device.disabledAt = nowIso;
      device.disabledReason = reason;
      registry.updatedAt = nowIso;
      await writeJsonAtomic(this.devicesPath, registry);
      return true;
    });
  }

  async getPreferences(): Promise<MobileNotificationPreferences> {
    const file = await this.loadPreferencesFile();
    return { ...file.preferences };
  }

  async updatePreferences(patch: MobileNotificationPreferencesPatch): Promise<MobileNotificationPreferences> {
    validatePreferencesPatch(patch);

    return this.runExclusive(async () => {
      const file = await this.loadPreferencesFile();
      const nowIso = this.now().toISOString();

      const nextPreferences: MobileNotificationPreferences = {
        enabled:
          patch.enabled === undefined ? file.preferences.enabled : normalizeBoolean(patch.enabled, "enabled"),
        unreadMessages:
          patch.unreadMessages === undefined
            ? file.preferences.unreadMessages
            : normalizeBoolean(patch.unreadMessages, "unreadMessages"),
        agentStatusChanges:
          patch.agentStatusChanges === undefined
            ? file.preferences.agentStatusChanges
            : normalizeBoolean(patch.agentStatusChanges, "agentStatusChanges"),
        errors: patch.errors === undefined ? file.preferences.errors : normalizeBoolean(patch.errors, "errors"),
        suppressWhenActive:
          patch.suppressWhenActive === undefined
            ? file.preferences.suppressWhenActive
            : normalizeBoolean(patch.suppressWhenActive, "suppressWhenActive"),
        updatedAt: nowIso
      };

      const nextFile: MobileNotificationPreferencesFile = {
        version: MOBILE_NOTIFICATION_PREFERENCES_VERSION,
        preferences: nextPreferences
      };

      await writeJsonAtomic(this.preferencesPath, nextFile);
      return { ...nextPreferences };
    });
  }

  private async loadDeviceRegistry(): Promise<MobilePushDeviceRegistryFile> {
    try {
      const raw = await readFile(this.devicesPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeRegistryFileForLoad(parsed);
    } catch (error) {
      if (isEnoentError(error)) {
        return createDefaultRegistryFile(this.now().toISOString());
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${this.devicesPath}`);
      }

      throw error;
    }
  }

  private async loadPreferencesFile(): Promise<MobileNotificationPreferencesFile> {
    try {
      const raw = await readFile(this.preferencesPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizePreferencesFileForLoad(parsed);
    } catch (error) {
      if (isEnoentError(error)) {
        return createDefaultPreferencesFile();
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${this.preferencesPath}`);
      }

      throw error;
    }
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function createDefaultRegistryFile(nowIso: string): MobilePushDeviceRegistryFile {
  return {
    version: MOBILE_DEVICES_FILE_VERSION,
    updatedAt: nowIso,
    devices: []
  };
}

function createDefaultPreferencesFile(): MobileNotificationPreferencesFile {
  return {
    version: MOBILE_NOTIFICATION_PREFERENCES_VERSION,
    preferences: {
      enabled: true,
      unreadMessages: true,
      agentStatusChanges: true,
      errors: true,
      suppressWhenActive: true,
      updatedAt: null
    }
  };
}

function normalizeRegistryFileForLoad(value: unknown): MobilePushDeviceRegistryFile {
  const nowIso = new Date().toISOString();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultRegistryFile(nowIso);
  }

  const maybe = value as Partial<MobilePushDeviceRegistryFile>;
  const devices = Array.isArray(maybe.devices)
    ? maybe.devices.map((device) => normalizeDeviceForLoad(device)).filter((device): device is MobilePushDevice => device !== null)
    : [];

  return {
    version: MOBILE_DEVICES_FILE_VERSION,
    updatedAt: normalizeIsoForLoad(maybe.updatedAt) ?? nowIso,
    devices
  };
}

function normalizePreferencesFileForLoad(value: unknown): MobileNotificationPreferencesFile {
  const defaults = createDefaultPreferencesFile();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const maybe = value as Partial<MobileNotificationPreferencesFile>;
  const candidate = maybe.preferences;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return defaults;
  }

  const raw = candidate as Partial<MobileNotificationPreferences>;
  return {
    version: MOBILE_NOTIFICATION_PREFERENCES_VERSION,
    preferences: {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.preferences.enabled,
      unreadMessages:
        typeof raw.unreadMessages === "boolean"
          ? raw.unreadMessages
          : defaults.preferences.unreadMessages,
      agentStatusChanges:
        typeof raw.agentStatusChanges === "boolean"
          ? raw.agentStatusChanges
          : defaults.preferences.agentStatusChanges,
      errors: typeof raw.errors === "boolean" ? raw.errors : defaults.preferences.errors,
      suppressWhenActive:
        typeof raw.suppressWhenActive === "boolean"
          ? raw.suppressWhenActive
          : defaults.preferences.suppressWhenActive,
      updatedAt: normalizeIsoForLoad(raw.updatedAt)
    }
  };
}

function normalizeDeviceForLoad(value: unknown): MobilePushDevice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Partial<MobilePushDevice>;
  const token = normalizePushTokenForLoad(raw.token);
  if (!token) {
    return null;
  }

  const platform = normalizePlatformForLoad(raw.platform);
  const nowIso = new Date().toISOString();

  return {
    token,
    platform,
    deviceName: normalizeDeviceNameForLoad(raw.deviceName),
    registeredAt: normalizeIsoForLoad(raw.registeredAt) ?? nowIso,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    updatedAt: normalizeIsoForLoad(raw.updatedAt) ?? undefined,
    disabledAt: normalizeIsoForLoad(raw.disabledAt) ?? undefined,
    disabledReason: normalizeOptionalStringForLoad(raw.disabledReason)
  };
}

function normalizePushToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("token must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("token must be a non-empty string");
  }

  if (trimmed.length > MAX_TOKEN_LENGTH) {
    throw new Error(`token must not exceed ${MAX_TOKEN_LENGTH} characters`);
  }

  return trimmed;
}

function normalizePushTokenForLoad(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  return trimmed;
}

function normalizePlatform(value: unknown): MobilePlatform {
  if (typeof value !== "string") {
    throw new Error("platform must be a string");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ios" || normalized === "android") {
    return normalized;
  }

  if (normalized === "unknown" || normalized === "web") {
    return "unknown";
  }

  throw new Error("platform must be one of: ios, android, unknown");
}

function normalizePlatformForLoad(value: unknown): MobilePlatform {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ios" || normalized === "android") {
    return normalized;
  }

  return "unknown";
}

function normalizeDeviceName(value: unknown): string {
  if (value === undefined || value === null) {
    return "Forge device";
  }

  if (typeof value !== "string") {
    throw new Error("deviceName must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Forge device";
  }

  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    throw new Error(`deviceName must not exceed ${MAX_DEVICE_NAME_LENGTH} characters`);
  }

  return trimmed;
}

function normalizeDeviceNameForLoad(value: unknown): string {
  if (typeof value !== "string") {
    return "Forge device";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "Forge device";
  }

  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    return trimmed.slice(0, MAX_DEVICE_NAME_LENGTH);
  }

  return trimmed;
}

function normalizeIsoForLoad(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function normalizeOptionalBoolean(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  return normalizeBoolean(value, fieldName);
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function normalizeOptionalStringForLoad(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validatePreferencesPatch(patch: MobileNotificationPreferencesPatch): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Request body must be a JSON object");
  }

  const knownKeys: Array<keyof MobileNotificationPreferencesPatch> = [
    "enabled",
    "unreadMessages",
    "agentStatusChanges",
    "errors",
    "suppressWhenActive"
  ];

  // Ignore unknown fields for forward/backward compatibility (for example, legacy payloads
  // that include nested preference objects).
  for (const key of knownKeys) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }

    if (typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
