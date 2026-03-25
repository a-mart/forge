import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline/promises";

interface StartupMigrationConfig {
  now?: () => number;
  prompt?: (question: string) => Promise<boolean>;
  isDesktop?: boolean;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

const LOCKFILE_PREFIX = "forge-data-dir-migration-lock";

export async function checkDataDirMigration(config: StartupMigrationConfig = {}): Promise<void> {
  const logger = {
    info: config.logger?.info ?? ((message: string) => console.log(message)),
    warn: config.logger?.warn ?? ((message: string) => console.warn(message))
  };

  const isDesktop = config.isDesktop === true;

  if (process.env.FORGE_DATA_DIR || process.env.MIDDLEMAN_DATA_DIR) {
    return;
  }

  const { newPath, selectedLegacyPath } = resolveMigrationPaths();
  if (!selectedLegacyPath || existsSync(newPath)) {
    return;
  }

  const legacyPath = selectedLegacyPath;

  const daemonized =
    process.env.FORGE_DAEMONIZED === "1" ||
    process.env.MIDDLEMAN_DAEMONIZED === "1";

  if (!isDesktop && (!process.stdin.isTTY || !process.stdout.isTTY || daemonized)) {
    logger.warn(
      `[startup] Skipping interactive data-dir migration. Using legacy data dir: ${legacyPath}`
    );
    process.env.FORGE_DATA_DIR = legacyPath;
    return;
  }

  if (hasActiveLegacyDaemon(legacyPath)) {
    logger.warn(
      `[startup] Detected active daemon using legacy data dir ${legacyPath}. ` +
        `Using legacy path for this startup.`
    );
    process.env.FORGE_DATA_DIR = legacyPath;
    return;
  }

  const lockPath = join(tmpdir(), `${LOCKFILE_PREFIX}.lock`);
  let lockFd: number | null = null;

  try {
    lockFd = openSync(lockPath, "wx");

    if (existsSync(newPath)) {
      process.env.FORGE_DATA_DIR = newPath;
      return;
    }

    if (!existsSync(legacyPath)) {
      return;
    }

    const shouldMigrate = await askToMigrate({
      legacyPath,
      newPath,
      prompt: config.prompt,
      isDesktop,
      logger,
    });

    if (!shouldMigrate) {
      logger.info(`[startup] Keeping legacy data dir: ${legacyPath}`);
      process.env.FORGE_DATA_DIR = legacyPath;
      return;
    }

    try {
      renameSync(legacyPath, newPath);
      logger.info(`[startup] Data directory migrated to: ${newPath}`);
      process.env.FORGE_DATA_DIR = newPath;
      return;
    } catch (error) {
      const code = getErrorCode(error);

      if (code === "EXDEV") {
        logger.warn(
          `[startup] Could not migrate data dir across filesystems (${legacyPath} -> ${newPath}). ` +
            `Using legacy path for now.`
        );
        process.env.FORGE_DATA_DIR = legacyPath;
        return;
      }

      if (code === "EPERM" || code === "EBUSY") {
        logger.warn(
          `[startup] Data-dir migration blocked (${code}). Using legacy path: ${legacyPath}`
        );
        process.env.FORGE_DATA_DIR = legacyPath;
        return;
      }

      if (code === "EEXIST" || code === "ENOTEMPTY") {
        logger.warn(
          `[startup] New data dir already exists (${newPath}). Using it for startup.`
        );
        process.env.FORGE_DATA_DIR = newPath;
        return;
      }

      throw error;
    }
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "EEXIST") {
      logger.warn("[startup] Another process is handling data-dir migration lock. Using legacy path for now.");
      process.env.FORGE_DATA_DIR = legacyPath;
      return;
    }

    throw error;
  } finally {
    if (lockFd !== null) {
      closeSync(lockFd);

      try {
        unlinkSync(lockPath);
      } catch {
        // ignore lock cleanup failures
      }
    }
  }
}

async function askToMigrate(options: {
  legacyPath: string;
  newPath: string;
  prompt?: (question: string) => Promise<boolean>;
  isDesktop: boolean;
  logger: { info: (message: string) => void };
}): Promise<boolean> {
  if (options.isDesktop) {
    options.logger.info(
      `[startup] FORGE_DESKTOP enabled. Auto-applying migration from ${options.legacyPath} to ${options.newPath}.`
    );
    return true;
  }

  if (options.prompt) {
    return options.prompt(`Migrate data dir from ${options.legacyPath} to ${options.newPath}? [Y/n] `);
  }

  options.logger.info("┌───────────────────────────────────────────────────────────┐");
  options.logger.info("│ Forge data directory migration                            │");
  options.logger.info("├───────────────────────────────────────────────────────────┤");
  options.logger.info(`│ Legacy: ${options.legacyPath}`);
  options.logger.info(`│ New:    ${options.newPath}`);
  options.logger.info("│                                                           │");
  options.logger.info("│ Migrate now? [Y/n]                                        │");
  options.logger.info("└───────────────────────────────────────────────────────────┘");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("> ")).trim().toLowerCase();
    return answer.length === 0 || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function hasActiveLegacyDaemon(legacyDataDir: string): boolean {
  const pidCandidates = [
    join(legacyDataDir, "swarm", "prod-daemon.pid"),
    join(legacyDataDir, "swarm", "backend.pid"),
    join(legacyDataDir, "prod-daemon.pid")
  ];

  for (const candidate of pidCandidates) {
    try {
      const raw = readFileSync(candidate, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }

      process.kill(pid, 0);
      return true;
    } catch {
      // ignore
    }
  }

  return false;
}

function resolveMigrationPaths(): {
  newPath: string;
  legacyCandidates: string[];
  selectedLegacyPath: string | undefined;
} {
  if (process.platform !== "win32") {
    const legacyCandidates = [resolve(homedir(), ".middleman")];
    return {
      newPath: resolve(homedir(), ".forge"),
      legacyCandidates,
      selectedLegacyPath: legacyCandidates.find((candidate) => existsSync(candidate))
    };
  }

  const localAppDataBase = process.env.LOCALAPPDATA?.trim()
    ? resolve(process.env.LOCALAPPDATA)
    : resolve(homedir(), "AppData", "Local");

  // Keep this precedence aligned with config.ts fallback behavior on Windows:
  // prefer %LOCALAPPDATA%\middleman, then fall back to ~/.middleman.
  const legacyCandidates = [
    resolve(localAppDataBase, "middleman"),
    resolve(homedir(), ".middleman")
  ];

  return {
    newPath: resolve(localAppDataBase, "forge"),
    legacyCandidates,
    selectedLegacyPath: legacyCandidates.find((candidate) => existsSync(candidate))
  };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}
