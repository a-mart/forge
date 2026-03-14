import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
export const DAEMONIZED_ENV_VAR = "MIDDLEMAN_DAEMONIZED";
export const RESTART_PARENT_PID_ENV_VAR = "MIDDLEMAN_RESTART_PARENT_PID";

const CONTROL_PID_FILE_PREFIX = "swarm-prod-daemon-";
const CONTROL_PID_FILE_SUFFIX = ".pid";
const CONTROL_RESTART_FILE_SUFFIX = ".restart";

export function getControlPidFilePath(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `${CONTROL_PID_FILE_PREFIX}${repoHash}${CONTROL_PID_FILE_SUFFIX}`);
}

export function getControlRestartFilePath(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `${CONTROL_PID_FILE_PREFIX}${repoHash}${CONTROL_RESTART_FILE_SUFFIX}`);
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

export async function findCandidateControlPidFiles(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.startsWith(CONTROL_PID_FILE_PREFIX) && entry.endsWith(CONTROL_PID_FILE_SUFFIX))
    .sort()
    .map((entry) => join(tmpdir(), entry));
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
