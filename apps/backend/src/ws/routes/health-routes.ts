import { rm, writeFile } from "node:fs/promises";
import {
  findCandidateControlPidFiles,
  getControlRestartFilePath,
  getRestartFilePathForPidFile,
  readControlPidFromFile,
  RESTART_SIGNAL
} from "../../reboot/control-pid.js";
import { isPidAlive } from "../../swarm/platform.js";
import {
  applyCorsHeaders,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const HEALTH_ENDPOINT_PATH = "/api/health";
const REBOOT_ENDPOINT_PATH = "/api/reboot";

export function createHealthRoutes(options: {
  resolveRepoRoot: () => string;
  resolveControlPidFile: () => string;
}): HttpRoute[] {
  const { resolveRepoRoot, resolveControlPidFile } = options;

  return [
    {
      methods: "GET",
      matches: (pathname) => pathname === HEALTH_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          version: "1.0.0",
          timestamp: Date.now()
        });
      }
    },
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => pathname === REBOOT_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, "POST, OPTIONS");
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, "POST, OPTIONS");
          response.setHeader("Allow", "POST, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, "POST, OPTIONS");
        sendJson(response, 200, { ok: true });

        const rebootTimer = setTimeout(() => {
          void triggerRebootSignal({
            repoRoot: resolveRepoRoot(),
            controlPidFile: resolveControlPidFile()
          });
        }, 25);
        rebootTimer.unref();
      }
    }
  ];
}

async function triggerRebootSignal(options: {
  repoRoot: string;
  controlPidFile: string;
}): Promise<void> {
  const { repoRoot, controlPidFile } = options;

  try {
    const daemonTarget = await resolveProdDaemonTarget(controlPidFile);

    if (process.platform === "win32") {
      if (!daemonTarget) {
        console.warn("[reboot] No prod-daemon found; restart file written but may not be consumed.");
      }

      const restartFile = daemonTarget
        ? getRestartFilePathForPidFile(daemonTarget.pidFile)
        : getControlRestartFilePath(repoRoot);
      await writeFile(restartFile, `${Date.now()}\n`, "utf8");
      return;
    }

    const targetPid = daemonTarget?.pid ?? process.pid;
    process.kill(targetPid, RESTART_SIGNAL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
  }
}

async function resolveProdDaemonTarget(
  controlPidFile: string
): Promise<{ pid: number; pidFile: string } | null> {
  const primaryPid = await readRunningPidFromFile(controlPidFile);
  if (primaryPid !== null) {
    return {
      pid: primaryPid,
      pidFile: controlPidFile
    };
  }

  const candidatePidFiles = await findCandidateControlPidFiles();
  for (const candidatePidFile of candidatePidFiles) {
    if (candidatePidFile === controlPidFile) {
      continue;
    }

    const pid = await readRunningPidFromFile(candidatePidFile);
    if (pid !== null) {
      return {
        pid,
        pidFile: candidatePidFile
      };
    }
  }

  return null;
}

async function readRunningPidFromFile(pidFile: string): Promise<number | null> {
  const pid = await readControlPidFromFile(pidFile);
  if (pid === null) {
    return null;
  }

  try {
    if (isPidAlive(pid)) {
      return pid;
    }

    await rm(pidFile, { force: true });
    return null;
  } catch {
    await rm(pidFile, { force: true });
    return null;
  }
}
