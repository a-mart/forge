import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import { getProjectResourceSettingsPath } from "./data-paths.js";

export type ProjectExecutableTrustState = "trusted" | "blocked";

export interface ProjectResourceSettingsOverride {
  forgeDir: string;
  updatedAt: string;
}

export interface ProjectResourceSettingsTrustRecord {
  state: ProjectExecutableTrustState;
  updatedAt: string;
  label: string;
}

export interface ProjectResourceSettingsDismissedPrompt {
  signature: string;
  dismissedAt: string;
}

export interface ProjectResourceSettingsData {
  version: 1;
  overrides: Record<string, ProjectResourceSettingsOverride>;
  executableTrust: Record<string, ProjectResourceSettingsTrustRecord>;
  dismissedExecutablePrompts: Record<string, ProjectResourceSettingsDismissedPrompt>;
}

export class ProjectResourceSettingsStore {
  constructor(
    private readonly dataDir: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async load(): Promise<ProjectResourceSettingsData> {
    try {
      return normalizeSettings(JSON.parse(await readFile(this.path, "utf-8")));
    } catch (error) {
      if (isEnoentError(error) || error instanceof SyntaxError) {
        return createDefaultSettings();
      }
      throw error;
    }
  }

  async getOverride(workspaceKey: string): Promise<ProjectResourceSettingsOverride | undefined> {
    const settings = await this.load();
    return settings.overrides[workspaceKey];
  }

  async setOverride(workspaceKey: string, forgeDir: string | null): Promise<ProjectResourceSettingsData> {
    const settings = await this.load();
    if (forgeDir === null) {
      delete settings.overrides[workspaceKey];
    } else {
      settings.overrides[workspaceKey] = { forgeDir, updatedAt: this.now() };
    }
    await this.save(settings);
    return settings;
  }

  async getTrust(key: string): Promise<ProjectResourceSettingsTrustRecord | undefined> {
    const settings = await this.load();
    return settings.executableTrust[normalizeProjectResourceKey(key)];
  }

  async getDismissedExecutablePrompt(key: string): Promise<ProjectResourceSettingsDismissedPrompt | undefined> {
    const settings = await this.load();
    return settings.dismissedExecutablePrompts[normalizeProjectResourceKey(key)];
  }

  async setTrust(
    key: string,
    action: "trust" | "block" | "reset",
    label = "forge"
  ): Promise<ProjectResourceSettingsData> {
    const settings = await this.load();
    const normalizedKey = normalizeProjectResourceKey(key);
    delete settings.dismissedExecutablePrompts[normalizedKey];
    if (action === "reset") {
      delete settings.executableTrust[normalizedKey];
    } else {
      settings.executableTrust[normalizedKey] = {
        state: action === "trust" ? "trusted" : "blocked",
        updatedAt: this.now(),
        label
      };
    }
    await this.save(settings);
    return settings;
  }

  async dismissExecutablePrompt(key: string, signature: string): Promise<ProjectResourceSettingsData> {
    const settings = await this.load();
    settings.dismissedExecutablePrompts[normalizeProjectResourceKey(key)] = { signature, dismissedAt: this.now() };
    await this.save(settings);
    return settings;
  }

  async save(settings: ProjectResourceSettingsData): Promise<void> {
    const normalized = normalizeSettings(settings);
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    await rename(tempPath, this.path);
  }

  private get path(): string {
    return getProjectResourceSettingsPath(this.dataDir);
  }
}

export function normalizeProjectResourceKey(key: string): string {
  const normalized = normalize(resolve(key));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createDefaultSettings(): ProjectResourceSettingsData {
  return {
    version: 1,
    overrides: {},
    executableTrust: {},
    dismissedExecutablePrompts: {}
  };
}

function normalizeSettings(value: unknown): ProjectResourceSettingsData {
  if (!value || typeof value !== "object") {
    return createDefaultSettings();
  }
  const candidate = value as Partial<ProjectResourceSettingsData>;
  return {
    version: 1,
    overrides: isRecord(candidate.overrides) ? normalizeOverrideRecords(candidate.overrides) : {},
    executableTrust: isRecord(candidate.executableTrust) ? normalizeTrustRecords(candidate.executableTrust) : {},
    dismissedExecutablePrompts: isRecord(candidate.dismissedExecutablePrompts)
      ? normalizeDismissedPromptRecords(candidate.dismissedExecutablePrompts)
      : {}
  };
}

function normalizeOverrideRecords(records: Record<string, unknown>): Record<string, ProjectResourceSettingsOverride> {
  const normalized: Record<string, ProjectResourceSettingsOverride> = {};
  for (const [key, record] of Object.entries(records)) {
    if (!isRecord(record) || typeof record.forgeDir !== "string" || typeof record.updatedAt !== "string") {
      continue;
    }
    normalized[key] = { forgeDir: record.forgeDir, updatedAt: record.updatedAt };
  }
  return normalized;
}

function normalizeTrustRecords(records: Record<string, unknown>): Record<string, ProjectResourceSettingsTrustRecord> {
  const normalized: Record<string, ProjectResourceSettingsTrustRecord> = {};
  for (const [key, record] of Object.entries(records)) {
    if (!isRecord(record) || (record.state !== "trusted" && record.state !== "blocked")) {
      continue;
    }
    normalized[normalizeProjectResourceKey(key)] = {
      state: record.state,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
      label: typeof record.label === "string" && record.label.trim().length > 0 ? record.label : "forge"
    };
  }
  return normalized;
}

function normalizeDismissedPromptRecords(
  records: Record<string, unknown>
): Record<string, ProjectResourceSettingsDismissedPrompt> {
  const normalized: Record<string, ProjectResourceSettingsDismissedPrompt> = {};
  for (const [key, record] of Object.entries(records)) {
    if (!isRecord(record) || typeof record.signature !== "string" || typeof record.dismissedAt !== "string") {
      continue;
    }
    normalized[normalizeProjectResourceKey(key)] = { signature: record.signature, dismissedAt: record.dismissedAt };
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
