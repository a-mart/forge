import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyFileIfMissing } from "./copy-file-if-missing.js";
import { getSharedDir, getSharedStateDir } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";

const SHARED_CONFIG_MIGRATION_SENTINEL = ".shared-config-migration-done";
const SHARED_CONFIG_CLEANUP_SENTINEL = ".shared-config-cleanup-done";

const FILE_MIGRATIONS: Array<[oldRelative: string, newRelative: string]> = [
  ["auth/auth.json", "config/auth/auth.json"],
  ["secrets.json", "config/secrets.json"],
  ["model-overrides.json", "config/model-overrides.json"],
  ["cortex-auto-review.json", "config/cortex-auto-review.json"],
  ["playwright-dashboard.json", "config/playwright-dashboard.json"],
  ["mobile-notification-prefs.json", "config/mobile-notification-prefs.json"],
  ["terminal-settings.json", "config/terminal-settings.json"],
  ["slash-commands.json", "config/slash-commands.json"],
  ["telemetry.json", "config/telemetry.json"],
  ["stats-cache.json", "cache/stats-cache.json"],
  ["provider-usage-cache.json", "cache/provider-usage-cache.json"],
  ["provider-usage-history.jsonl", "cache/provider-usage-history.jsonl"],
  ["mobile-devices.json", "state/mobile-devices.json"],
  [".compaction-count-backfill-v2-done", "state/.compaction-count-backfill-v2-done"],
];

const DIR_MIGRATIONS: Array<[oldRelative: string, newRelative: string]> = [["integrations", "config/integrations"]];

const VERIFIED_FILE_CLEANUPS: Array<[oldRelative: string, newRelative: string]> = [
  ["auth/auth.json", "config/auth/auth.json"],
  ["secrets.json", "config/secrets.json"],
  ["model-overrides.json", "config/model-overrides.json"],
  ["cortex-auto-review.json", "config/cortex-auto-review.json"],
  ["mobile-notification-prefs.json", "config/mobile-notification-prefs.json"],
  ["playwright-dashboard.json", "config/playwright-dashboard.json"],
  ["slash-commands.json", "config/slash-commands.json"],
  ["terminal-settings.json", "config/terminal-settings.json"],
  ["telemetry.json", "config/telemetry.json"],
  ["mobile-devices.json", "state/mobile-devices.json"],
  [".compaction-count-backfill-v2-done", "state/.compaction-count-backfill-v2-done"],
  ["provider-usage-cache.json", "cache/provider-usage-cache.json"],
  ["provider-usage-history.jsonl", "cache/provider-usage-history.jsonl"],
];

const EMPTY_DIR_CLEANUPS = ["auth", "integrations", "generated"];

export async function migrateSharedConfigLayout(dataDir: string): Promise<void> {
  const sharedDir = getSharedDir(dataDir);
  const sentinelPath = join(getSharedStateDir(dataDir), SHARED_CONFIG_MIGRATION_SENTINEL);

  try {
    await stat(sentinelPath);
    return;
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  for (const [oldRelative, newRelative] of FILE_MIGRATIONS) {
    await copyFileIfMissing(join(sharedDir, oldRelative), join(sharedDir, newRelative));
  }

  for (const [oldRelative, newRelative] of DIR_MIGRATIONS) {
    await copyDirectoryIfExists(join(sharedDir, oldRelative), join(sharedDir, newRelative));
  }

  await writeTextAtomic(sentinelPath, `${new Date().toISOString()}\n`);
}

export async function cleanupOldSharedConfigPaths(dataDir: string): Promise<void> {
  const sharedDir = getSharedDir(dataDir);
  const sharedStateDir = getSharedStateDir(dataDir);
  const migrationSentinelPath = join(sharedStateDir, SHARED_CONFIG_MIGRATION_SENTINEL);
  const cleanupSentinelPath = join(sharedStateDir, SHARED_CONFIG_CLEANUP_SENTINEL);

  const cleanupAlreadyDone = await safePathExists(cleanupSentinelPath, "cleanup sentinel");
  if (cleanupAlreadyDone !== false) {
    return;
  }

  const migrationComplete = await safePathExists(migrationSentinelPath, "migration sentinel");
  if (migrationComplete !== true) {
    return;
  }

  for (const [oldRelative, newRelative] of VERIFIED_FILE_CLEANUPS) {
    await deleteOldFileIfMigrated(join(sharedDir, oldRelative), join(sharedDir, newRelative));
  }

  await cleanupMigratedDirectory(join(sharedDir, "integrations"), join(sharedDir, "config", "integrations"));
  await deletePathIfExists(join(sharedDir, "stats-cache.json"), "stale cache file");
  await deleteDirectoryRecursivelyIfExists(join(sharedDir, "generated"), "stale generated cache directory");

  for (const directoryRelative of EMPTY_DIR_CLEANUPS) {
    await removeDirectoryIfEmpty(join(sharedDir, directoryRelative));
  }

  try {
    await writeTextAtomic(cleanupSentinelPath, `${new Date().toISOString()}\n`);
  } catch (error) {
    logCleanupWarning(`failed to write cleanup sentinel at ${cleanupSentinelPath}`, error);
  }
}

async function copyDirectoryIfExists(sourceDir: string, targetDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }

  await mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryIfExists(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFileIfMissing(sourcePath, targetPath);
    }
  }
}

async function cleanupMigratedDirectory(oldDir: string, newDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(oldDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    logCleanupWarning(`failed to read old directory ${oldDir}`, error);
    return;
  }

  for (const entry of entries) {
    const oldPath = join(oldDir, entry.name);
    const newPath = join(newDir, entry.name);

    if (entry.isDirectory()) {
      await cleanupMigratedDirectory(oldPath, newPath);
      await removeDirectoryIfEmpty(oldPath);
      continue;
    }

    if (entry.isFile()) {
      await deleteOldFileIfMigrated(oldPath, newPath);
    }
  }

  await removeDirectoryIfEmpty(oldDir);
}

async function deleteOldFileIfMigrated(oldPath: string, newPath: string): Promise<void> {
  const migrated = await safeVerifiedFileExists(newPath);
  if (!migrated) {
    return;
  }

  await deletePathIfExists(oldPath, "old migrated file");
}

async function deleteDirectoryRecursivelyIfExists(path: string, label: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    logCleanupWarning(`failed to delete ${label} at ${path}`, error);
  }
}

async function deletePathIfExists(path: string, label: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    logCleanupWarning(`failed to delete ${label} at ${path}`, error);
  }
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (isEnoentError(error) || isDirectoryNotEmptyError(error)) {
      return;
    }

    logCleanupWarning(`failed to remove empty directory ${path}`, error);
  }
}

async function safePathExists(path: string, label: string): Promise<boolean | undefined> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    logCleanupWarning(`failed to check ${label} at ${path}`, error);
    return undefined;
  }
}

async function safeVerifiedFileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    logCleanupWarning(`failed to verify migrated file at ${path}`, error);
    return false;
  }
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, content, "utf8");
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

function isDirectoryNotEmptyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "ENOTEMPTY" || (error as { code?: string }).code === "EEXIST")
  );
}

function logCleanupWarning(message: string, error: unknown): void {
  const details = error instanceof Error ? error.message : String(error);
  console.warn(`[shared-config-cleanup] ${message}: ${details}`);
}
