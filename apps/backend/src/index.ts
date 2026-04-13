import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createConfig } from "./config.js";
import {
  RESTART_SIGNAL,
  clearRestartParentPidEnv,
  readDaemonizedEnv,
  readRestartParentPidEnv,
  setRestartParentPidEnv,
} from "./reboot/control-pid.js";
import { startServer, type StartedServer } from "./server.js";
import { readServerVersion } from "./stats/stats-git.js";
import { checkDataDirMigration } from "./startup-migration.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });

async function main(): Promise<void> {
  const isDesktop = parseBooleanEnv(process.env.FORGE_DESKTOP);

  await checkDataDirMigration({ isDesktop });

  const config = createConfig();
  if (!config.isDesktop && (!process.env.FORGE_APP_VERSION || process.env.FORGE_APP_VERSION.trim().length === 0)) {
    process.env.FORGE_APP_VERSION = await readServerVersion(config.paths.rootDir);
  }
  await waitForRestartParentToExit(config.isDesktop);

  const server = await startServer({
    config,
    onReady: ({ port }) => {
      if (config.isDesktop) {
        process.send?.({ type: "ready", port });
      }
    },
  });
  console.log(`Forge backend listening on ws://${server.host}:${server.port}`);

  registerProcessLifecycle(server, config.isDesktop);
}

function registerProcessLifecycle(server: StartedServer, isDesktop: boolean): void {
  let shuttingDown = false;
  let restarting = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down...`);
    await server.stop();
    if (!isDesktop) {
      process.exit(0);
    }
  };

  const restart = async (): Promise<void> => {
    if (isDesktop) {
      return;
    }

    if (restarting || shuttingDown) {
      return;
    }

    restarting = true;
    console.log(`[reboot] Received ${RESTART_SIGNAL}. Restarting backend...`);

    try {
      await server.stopListening();
      await spawnReplacementProcess();
      await server.stop();
      process.exit(0);
    } catch (error) {
      restarting = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reboot] Failed to restart current process: ${message}`);

      try {
        await server.startListening();
      } catch (restartError) {
        const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
        console.error(`[reboot] Failed to restore WebSocket server after restart failure: ${restartMessage}`);
      }
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (!isDesktop && process.platform !== "win32" && readDaemonizedEnv() !== "1") {
    process.on(RESTART_SIGNAL, () => {
      void restart();
    });
  }

  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      void shutdown("SIGBREAK");
    });
  }

  process.on("message", (message) => {
    if (
      message === "shutdown" ||
      (typeof message === "object" && message && (message as { type?: string }).type === "shutdown")
    ) {
      void shutdown("message:shutdown");
    }
  });
}

async function waitForRestartParentToExit(isDesktop: boolean): Promise<void> {
  if (isDesktop) {
    return;
  }

  const rawParentPid = readRestartParentPidEnv();
  if (typeof rawParentPid !== "string" || rawParentPid.trim().length === 0) {
    return;
  }

  clearRestartParentPidEnv();

  const parentPid = Number.parseInt(rawParentPid.trim(), 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (isErrorWithCode(error, "ESRCH")) {
        return;
      }

      throw error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function spawnReplacementProcess(): Promise<void> {
  const replacementArgs = [...process.execArgv, ...process.argv.slice(1)];
  const replacementEnv = {
    ...process.env,
  };
  setRestartParentPidEnv(`${process.pid}`);
  replacementEnv.FORGE_RESTART_PARENT_PID = `${process.pid}`;

  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(process.execPath, replacementArgs, {
      cwd: process.cwd(),
      env: replacementEnv,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      resolveSpawn();
    });
  });
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

void main().catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  ) {
    const config = createConfig();
    console.error(
      `Failed to start backend: ws://${config.host}:${config.port} is already in use. ` +
        `Stop the other process or run with FORGE_PORT=<port> (legacy MIDDLEMAN_PORT also works).`,
    );
  } else {
    console.error(error);
  }

  if (!parseBooleanEnv(process.env.FORGE_DESKTOP)) {
    process.exit(1);
  }
});
