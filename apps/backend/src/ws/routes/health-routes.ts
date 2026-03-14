import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../../swarm/platform.js";
import {
  applyCorsHeaders,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const HEALTH_ENDPOINT_PATH = "/api/health";
const REBOOT_ENDPOINT_PATH = "/api/reboot";
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";

export function createHealthRoutes(options: { resolveRepoRoot: () => string }): HttpRoute[] {
  const { resolveRepoRoot } = options;

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
          void triggerRebootSignal(resolveRepoRoot());
        }, 25);
        rebootTimer.unref();
      }
    }
  ];
}

async function triggerRebootSignal(repoRoot: string): Promise<void> {
  try {
    const daemonPid = await resolveProdDaemonPid(repoRoot);

    if (process.platform === "win32") {
      if (!daemonPid) {
        console.warn("[reboot] No prod-daemon found; restart file written but may not be consumed.");
      }
      void writeFile(getProdDaemonRestartFile(repoRoot), `${Date.now()}\n`, "utf8");
      return;
    }

    const targetPid = daemonPid ?? process.pid;
    process.kill(targetPid, RESTART_SIGNAL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
  }
}

async function resolveProdDaemonPid(repoRoot: string): Promise<number | null> {
  const pidFile = getProdDaemonPidFile(repoRoot);

  let pidContents: string;
  try {
    pidContents = await readFile(pidFile, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  const pid = Number.parseInt(pidContents.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
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

function getProdDaemonPidFile(repoRoot: string): string {
  return `${getProdDaemonFilePrefix(repoRoot)}.pid`;
}

function getProdDaemonRestartFile(repoRoot: string): string {
  return `${getProdDaemonFilePrefix(repoRoot)}.restart`;
}

function getProdDaemonFilePrefix(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${repoHash}`);
}
