import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
// Atomic refers to the write operation (temp file + rename), not to concurrent access.
import { basename, dirname, join } from "node:path";
import { renameWithRetry } from "../swarm/retry-rename.js";
import { isEnoentError } from "./fs-errors.js";

interface AtomicWriteOptions {
  createParentDir?: boolean;
  mode?: number;
  /** Exclusive temp creation and fsync before replacement for recovery-critical state. */
  durable?: boolean;
  /** Revalidate a caller-owned storage boundary immediately before replacement. */
  beforeCommit?: () => Promise<void>;
}

interface AtomicJsonUpdateOptions extends AtomicWriteOptions {
  createIfMissing?: boolean;
}

export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array | AsyncIterable<string | Uint8Array>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const targetDirectory = dirname(filePath);
  const tempPath = createTempPath(filePath);

  if (options.createParentDir !== false) {
    await mkdir(targetDirectory, { recursive: true });
  }
  let ownsTemporary = false;
  try {
    if (options.durable) {
      const file = await open(tempPath, "wx", options.mode);
      ownsTemporary = true;
      try {
        if (typeof content === "string" || content instanceof Uint8Array) {
          await file.writeFile(content);
        } else {
          for await (const chunk of content) await file.writeFile(chunk);
        }
        await file.sync();
      } finally {
        await file.close();
      }
    } else {
      await writeFile(
        tempPath,
        content,
        typeof content === "string"
          ? { encoding: "utf8", ...(options.mode === undefined ? {} : { mode: options.mode }) }
          : options.mode === undefined ? undefined : { mode: options.mode },
      );
      ownsTemporary = true;
    }
    await options.beforeCommit?.();
    await renameWithRetry(tempPath, filePath, { retries: 8, baseDelayMs: 15 });
  } finally {
    if (options.durable && ownsTemporary) await unlink(tempPath).catch(error => { if (!isEnoentError(error)) throw error; });
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`, options);
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

/**
 * Read-modify-write a JSON file. The write itself is atomic (temp+rename),
 * but there is no per-file lock — concurrent callers may observe stale reads.
 * Safe for single-caller-at-a-time use (e.g., startup, settings save).
 * Do NOT use in hot paths with concurrent writers without external serialization.
 */
export async function updateJsonFileAtomic<T>(
  filePath: string,
  defaultValue: T,
  updater: (current: T) => T,
  options: AtomicJsonUpdateOptions = {}
): Promise<T> {
  const existing = await readJsonFileIfExists<T>(filePath);
  if (existing === undefined && options.createIfMissing === false) {
    return defaultValue;
  }
  const current = existing ?? defaultValue;
  const next = updater(current);
  await writeJsonFileAtomic(filePath, next, { createParentDir: options.createParentDir });
  return next;
}

function createTempPath(filePath: string): string {
  const randomSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return join(dirname(filePath), `${basename(filePath)}.${randomSuffix}.tmp`);
}

/**
 * Append a single JSON value as one line to a JSONL file, creating the parent
 * directory and the file itself if needed. Not atomic in the temp+rename sense
 * (an append is a single write syscall on POSIX for line-sized payloads, which
 * is the existing behavior this helper replaces); concurrent appenders from
 * multiple processes are not serialized.
 */
export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
