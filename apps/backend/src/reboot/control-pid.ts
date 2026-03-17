import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
export const DAEMONIZED_ENV_VAR = "FORGE_DAEMONIZED";
export const LEGACY_DAEMONIZED_ENV_VAR = "MIDDLEMAN_DAEMONIZED";
export const RESTART_PARENT_PID_ENV_VAR = "FORGE_RESTART_PARENT_PID";
export const LEGACY_RESTART_PARENT_PID_ENV_VAR = "MIDDLEMAN_RESTART_PARENT_PID";

const CONTROL_PID_FILE_PREFIX = "swarm-prod-daemon-";
const CONTROL_PID_FILE_SUFFIX = ".pid";
const CONTROL_RESTART_FILE_SUFFIX = ".restart";

export function readDaemonizedEnv(): string | undefined {
  return process.env[DAEMONIZED_ENV_VAR] ?? process.env[LEGACY_DAEMONIZED_ENV_VAR];
}

export function readRestartParentPidEnv(): string | undefined {
  return process.env[RESTART_PARENT_PID_ENV_VAR] ?? process.env[LEGACY_RESTART_PARENT_PID_ENV_VAR];
}

export function setRestartParentPidEnv(value: string): void {
  process.env[RESTART_PARENT_PID_ENV_VAR] = value;
}

export function clearRestartParentPidEnv(): void {
  delete process.env[RESTART_PARENT_PID_ENV_VAR];
  delete process.env[LEGACY_RESTART_PARENT_PID_ENV_VAR];
}

export function getControlPidFilePath(repoRoot: string, port?: number): string {
  const controlHash = createControlPidHash(repoRoot, port);
  return join(tmpdir(), `${CONTROL_PID_FILE_PREFIX}${controlHash}${CONTROL_PID_FILE_SUFFIX}`);
}

export function getControlRestartFilePath(repoRoot: string, port?: number): string {
  const controlHash = createControlPidHash(repoRoot, port);
  return join(tmpdir(), `${CONTROL_PID_FILE_PREFIX}${controlHash}${CONTROL_RESTART_FILE_SUFFIX}`);
}

export function getRestartFilePathForPidFile(pidFile: string): string {
  return pidFile.endsWith(CONTROL_PID_FILE_SUFFIX)
    ? `${pidFile.slice(0, -CONTROL_PID_FILE_SUFFIX.length)}${CONTROL_RESTART_FILE_SUFFIX}`
    : `${pidFile}${CONTROL_RESTART_FILE_SUFFIX}`;
}

export async function readControlPidFromFile(pidFile: string): Promise<number | null> {
  let rawPid: string;
  try {
    rawPid = await readFile(pidFile, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }

  const pid = Number.parseInt(rawPid.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function createControlPidHash(repoRoot: string, port?: number): string {
  const normalizedPort = Number.isFinite(port) ? String(Math.trunc(port as number)) : "default";
  return createHash("sha1")
    .update(`${repoRoot}:${normalizedPort}`)
    .digest("hex")
    .slice(0, 10);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
