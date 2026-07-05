import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoentError, isErrnoCode } from "../../utils/fs-errors.js";

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
    if (isErrnoCode(error, "EEXIST")) {
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

