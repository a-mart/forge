import type {
  TerminalSettings,
  UpdateTerminalSettingsRequest,
} from "@forge/protocol";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getTerminalSettingsPath } from "../swarm/data-paths.js";
import { renameWithRetry } from "../swarm/retry-rename.js";

export interface PersistedTerminalSettings {
  defaultShell?: string;
}

interface TerminalSettingsFile {
  defaultShell?: string;
}

export class TerminalSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSettingsValidationError";
  }
}

export class TerminalSettingsService {
  private readonly settingsPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private persisted: PersistedTerminalSettings = createDefaultPersistedTerminalSettings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; env?: NodeJS.ProcessEnv }) {
    this.settingsPath = getTerminalSettingsPath(options.dataDir);
    this.env = options.env ?? process.env;
  }

  async load(): Promise<void> {
    this.persisted = await loadPersistedTerminalSettingsFromPath(this.settingsPath, (message) => {
      console.warn(`[terminal-settings] ${message}`);
    });
  }

  getPersistedSettings(): PersistedTerminalSettings {
    return {
      defaultShell: this.persisted.defaultShell,
    };
  }

  getSettings(): TerminalSettings {
    return buildEffectiveTerminalSettings(this.persisted, this.env);
  }

  async update(patch: UpdateTerminalSettingsRequest): Promise<TerminalSettings> {
    return this.withUpdateLock(async () => {
      const next: PersistedTerminalSettings = {
        defaultShell: Object.prototype.hasOwnProperty.call(patch, "defaultShell")
          ? normalizeOptionalShell(patch.defaultShell)
          : this.persisted.defaultShell,
      };

      await writeTerminalSettingsFile(this.settingsPath, next);
      this.persisted = next;
      return this.getSettings();
    });
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex;
    let release: (() => void) | undefined;
    this.updateMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function createDefaultPersistedTerminalSettings(): PersistedTerminalSettings {
  return {};
}

export function buildEffectiveTerminalSettings(
  persisted: PersistedTerminalSettings,
  env: NodeJS.ProcessEnv = process.env,
): TerminalSettings {
  const persistedDefaultShell = persisted.defaultShell?.trim();
  if (persistedDefaultShell) {
    return {
      defaultShell: persistedDefaultShell,
      persistedDefaultShell: persistedDefaultShell,
      source: "settings",
    };
  }

  const envDefaultShell = readTerminalDefaultShellFromEnv(env);
  if (envDefaultShell) {
    return {
      defaultShell: envDefaultShell,
      persistedDefaultShell: null,
      source: "env",
    };
  }

  return {
    defaultShell: null,
    persistedDefaultShell: null,
    source: "default",
  };
}

export function readTerminalDefaultShellFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.FORGE_TERMINAL_DEFAULT_SHELL ?? env.MIDDLEMAN_TERMINAL_DEFAULT_SHELL;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function loadPersistedTerminalSettingsFromPath(
  settingsPath: string,
  onWarning?: (message: string) => void,
): Promise<PersistedTerminalSettings> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeLoadedTerminalSettings(parsed);
  } catch (error) {
    if (!isEnoentError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      onWarning?.(`Failed to load settings from ${settingsPath}: ${message}`);
    }
    return createDefaultPersistedTerminalSettings();
  }
}

function normalizeLoadedTerminalSettings(value: unknown): PersistedTerminalSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultPersistedTerminalSettings();
  }

  const maybe = value as TerminalSettingsFile;
  return {
    defaultShell: typeof maybe.defaultShell === "string" && maybe.defaultShell.trim()
      ? maybe.defaultShell.trim()
      : undefined,
  };
}

function normalizeOptionalShell(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TerminalSettingsValidationError("defaultShell must be a string or null");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TerminalSettingsValidationError("defaultShell must be a non-empty string or null");
  }

  return trimmed;
}

async function writeTerminalSettingsFile(targetPath: string, settings: PersistedTerminalSettings): Promise<void> {
  const payload: TerminalSettingsFile = {};
  if (settings.defaultShell) {
    payload.defaultShell = settings.defaultShell;
  }

  const fileName = basename(targetPath);
  const tempPath = join(dirname(targetPath), `${fileName}.tmp`);

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameWithRetry(tempPath, targetPath, { retries: 8, baseDelayMs: 15 });
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT",
  );
}
