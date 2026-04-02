import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function copyFileIfMissing(sourcePath: string, targetPath: string): Promise<boolean> {
  if (!(await pathExists(sourcePath))) {
    return false;
  }

  if (await pathExists(targetPath)) {
    return true;
  }

  await mkdir(dirname(targetPath), { recursive: true });

  try {
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (isEexistError(error)) {
      return true;
    }

    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
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

function isEexistError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
