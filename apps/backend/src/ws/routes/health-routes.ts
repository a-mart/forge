import { rm, writeFile } from "node:fs/promises";
import {
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
  resolveControlPidFile: () => string;
  allowReboot?: boolean;
}): HttpRoute[] {
  const { resolveControlPidFile, allowReboot = true } = options;

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

        if (!allowReboot) {
          sendJson(response, 503, {
            ok: false,
            error: "Reboot disabled in desktop mode."
          });
          return;
        }

        applyCorsHeaders(request, response, "POST, OPTIONS");
        sendJson(response, 200, { ok: true });

        const rebootTimer = setTimeout(() => {
          void triggerRebootSignal({
            controlPidFile: resolveControlPidFile()
          });
        }, 25);
        rebootTimer.unref();
      }
    }
  ];
}

async function triggerRebootSignal(options: {
  controlPidFile: string;
}): Promise<void> {
  const { controlPidFile } = options;

  try {
    const daemonTarget = await resolveProdDaemonTarget(controlPidFile);

    if (process.platform === "win32") {
      await writeFile(getRestartFilePathForPidFile(daemonTarget.pidFile), `${Date.now()}\n`, "utf8");
      return;
    }

    process.kill(daemonTarget.pid, RESTART_SIGNAL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
  }
}

async function resolveProdDaemonTarget(
  controlPidFile: string
): Promise<{ pid: number; pidFile: string }> {
  const primaryPid = await readRunningPidFromFile(controlPidFile);
  if (primaryPid !== null) {
    return {
      pid: primaryPid,
      pidFile: controlPidFile
    };
  }

  throw new Error("No control PID file found for this instance");
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
