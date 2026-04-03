import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyFileIfMissing } from "./copy-file-if-missing.js";
import { getSharedDir, getSharedStateDir } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";

const SHARED_CONFIG_MIGRATION_SENTINEL = ".shared-config-migration-done";

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

const DIR_MIGRATIONS: Array<[oldRelative: string, newRelative: string]> = [
  ["integrations", "config/integrations"],
];

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
