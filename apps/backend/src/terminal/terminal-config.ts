import type { PersistedTerminalSettings } from "./terminal-settings-service.js";
import { loadPersistedTerminalSettingsFromPath, readTerminalDefaultShellFromEnv } from "./terminal-settings-service.js";
import { getTerminalSettingsPath } from "../swarm/data-paths.js";

export interface TerminalRuntimeConfig {
  enabled: boolean;
  maxTerminalsPerManager: number;
  defaultCols: number;
  defaultRows: number;
  scrollbackLines: number;
  outputBatchIntervalMs: number;
  snapshotIntervalMs: number;
  journalMaxBytes: number;
  shutdownSnapshotTimeoutMs: number;
  restoreStartupConcurrency: number;
  wsTicketTtlMs: number;
  wsMaxBufferedAmountBytes: number;
  defaultShell?: string;
}

const DEFAULTS: TerminalRuntimeConfig = {
  enabled: true,
  maxTerminalsPerManager: 10,
  defaultCols: 120,
  defaultRows: 30,
  scrollbackLines: 5000,
  outputBatchIntervalMs: 16,
  snapshotIntervalMs: 30_000,
  journalMaxBytes: 1_048_576,
  shutdownSnapshotTimeoutMs: 8_000,
  restoreStartupConcurrency: 4,
  wsTicketTtlMs: 60_000,
  wsMaxBufferedAmountBytes: 1_048_576,
};

export async function readTerminalRuntimeConfig(options: {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  persistedSettings?: PersistedTerminalSettings;
} = {}): Promise<TerminalRuntimeConfig> {
  const env = options.env ?? process.env;
  const persistedSettings = options.persistedSettings ?? await readPersistedTerminalSettings(options.dataDir);

  return {
    enabled: readBooleanEnv(env, "TERMINAL_ENABLED", DEFAULTS.enabled),
    maxTerminalsPerManager: readIntegerEnv(env, "TERMINAL_MAX_PER_SESSION", DEFAULTS.maxTerminalsPerManager, 1),
    defaultCols: readIntegerEnv(env, "TERMINAL_DEFAULT_COLS", DEFAULTS.defaultCols, 20),
    defaultRows: readIntegerEnv(env, "TERMINAL_DEFAULT_ROWS", DEFAULTS.defaultRows, 5),
    scrollbackLines: readIntegerEnv(env, "TERMINAL_SCROLLBACK_LINES", DEFAULTS.scrollbackLines, 100),
    outputBatchIntervalMs: readIntegerEnv(env, "TERMINAL_OUTPUT_BATCH_MS", DEFAULTS.outputBatchIntervalMs, 1),
    snapshotIntervalMs: readIntegerEnv(env, "TERMINAL_SNAPSHOT_INTERVAL_MS", DEFAULTS.snapshotIntervalMs, 1_000),
    journalMaxBytes: readIntegerEnv(env, "TERMINAL_JOURNAL_MAX_BYTES", DEFAULTS.journalMaxBytes, 1_024),
    shutdownSnapshotTimeoutMs: readIntegerEnv(
      env,
      "TERMINAL_SHUTDOWN_SNAPSHOT_TIMEOUT_MS",
      DEFAULTS.shutdownSnapshotTimeoutMs,
      100,
    ),
    restoreStartupConcurrency: readIntegerEnv(
      env,
      "TERMINAL_RESTORE_STARTUP_CONCURRENCY",
      DEFAULTS.restoreStartupConcurrency,
      1,
    ),
    wsTicketTtlMs: readIntegerEnv(env, "TERMINAL_WS_TICKET_TTL_MS", DEFAULTS.wsTicketTtlMs, 1_000),
    wsMaxBufferedAmountBytes: readIntegerEnv(
      env,
      "TERMINAL_WS_MAX_BUFFERED_AMOUNT_BYTES",
      DEFAULTS.wsMaxBufferedAmountBytes,
      1_024,
    ),
    defaultShell: persistedSettings.defaultShell ?? readTerminalDefaultShellFromEnv(env),
  };
}

async function readPersistedTerminalSettings(dataDir: string | undefined): Promise<PersistedTerminalSettings> {
  if (!dataDir) {
    return {};
  }

  return loadPersistedTerminalSettingsFromPath(getTerminalSettingsPath(dataDir), (message) => {
    console.warn(`[terminal-config] ${message}`);
  });
}

function readStringEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  const value = env[`FORGE_${suffix}`] ?? env[`MIDDLEMAN_${suffix}`];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, suffix: string, fallback: boolean): boolean {
  const value = readStringEnv(env, suffix);
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  console.warn(`[terminal-config] Ignoring invalid ${suffix} value: ${value}`);
  return fallback;
}

function readIntegerEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
  fallback: number,
  min: number,
): number {
  const value = readStringEnv(env, suffix);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(`[terminal-config] Ignoring invalid ${suffix} value: ${value}`);
    return fallback;
  }

  return parsed;
}
