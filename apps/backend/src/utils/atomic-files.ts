import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renameWithRetry } from "../swarm/retry-rename.js";
import { isEnoentError } from "./fs-errors.js";

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const targetDirectory = dirname(filePath);
  const tempPath = createTempPath(filePath);

  await mkdir(targetDirectory, { recursive: true });
  await writeFile(tempPath, content, "utf8");
  await renameWithRetry(tempPath, filePath, { retries: 8, baseDelayMs: 15 });
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function readJsonFileIfExists<T = unknown>(filePath: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export async function updateJsonFileAtomic<T>(
  filePath: string,
  defaultValue: T,
  updater: (current: T) => T
): Promise<T> {
  const current = (await readJsonFileIfExists<T>(filePath)) ?? defaultValue;
  const next = updater(current);
  await writeJsonFileAtomic(filePath, next);
  return next;
}

function createTempPath(filePath: string): string {
  const randomSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return join(dirname(filePath), `${basename(filePath)}.${randomSuffix}.tmp`);
}
