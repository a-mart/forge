import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SwarmConfig } from "./types.js";

export async function ensureCanonicalAuthFilePath(config: Pick<SwarmConfig, "paths">): Promise<string> {
  const preferredPath = config.paths.sharedAuthFile;
  await mkdir(dirname(preferredPath), { recursive: true });

  if (await pathExists(preferredPath)) {
    return preferredPath;
  }

  const legacyPath = config.paths.authFile;
  if (legacyPath !== preferredPath && (await pathExists(legacyPath))) {
    await copyFile(legacyPath, preferredPath);
  }

  return preferredPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
