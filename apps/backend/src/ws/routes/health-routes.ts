import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCorsHeaders,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const REBOOT_ENDPOINT_PATH = "/api/reboot";
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";

export function createHealthRoutes(options: { resolveRepoRoot: () => string }): HttpRoute[] {
  const { resolveRepoRoot } = options;

  return [
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
          triggerRebootSignal(resolveRepoRoot());
        }, 25);
        rebootTimer.unref();
      }
    }
  ];
}

function triggerRebootSignal(repoRoot: string): void {
  try {
    const daemonPid = resolveProdDaemonPid(repoRoot);
    const targetPid = daemonPid ?? process.pid;

    process.kill(targetPid, RESTART_SIGNAL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
  }
}

function resolveProdDaemonPid(repoRoot: string): number | null {
  const pidFile = getProdDaemonPidFile(repoRoot);
  if (!existsSync(pidFile)) {
    return null;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      rmSync(pidFile, { force: true });
    }

    return null;
  }
}

function getProdDaemonPidFile(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);
}
