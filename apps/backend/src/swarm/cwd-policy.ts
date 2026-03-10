import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep, win32 } from "node:path";

const CWD_ERROR_MESSAGES = {
  REQUIRED: "Directory path must be a non-empty string.",
  NOT_FOUND: "Directory does not exist.",
  NOT_DIRECTORY: "Path is not a directory.",
  LIST_FAILED: "Unable to list directories for the requested path."
} as const;

export type DirectoryValidationErrorCode =
  | "DIRECTORY_REQUIRED"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_NOT_DIRECTORY"
  | "DIRECTORY_LIST_FAILED";

export class DirectoryValidationError extends Error {
  readonly code: DirectoryValidationErrorCode;

  constructor(code: DirectoryValidationErrorCode, message: string) {
    super(message);
    this.name = "DirectoryValidationError";
    this.code = code;
  }
}

export interface CwdPolicy {
  rootDir: string;
  allowlistRoots: string[];
}

export interface DirectorySummary {
  name: string;
  path: string;
}

export interface DirectoryListingResult {
  requestedPath?: string;
  resolvedPath: string;
  roots: string[];
  directories: DirectorySummary[];
}

export interface DirectoryValidationResult {
  requestedPath: string;
  roots: string[];
  valid: boolean;
  resolvedPath?: string;
  message?: string;
}

export function normalizeAllowlistRoots(roots: string[]): string[] {
  const normalized = new Set<string>();

  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;

    normalized.add(resolveToRealPath(resolve(trimmed)));
  }

  return Array.from(normalized).sort((a, b) => a.localeCompare(b));
}

export function resolveDirectoryPath(input: string, rootDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new DirectoryValidationError("DIRECTORY_REQUIRED", CWD_ERROR_MESSAGES.REQUIRED);
  }

  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  if (win32.isAbsolute(trimmed)) {
    return win32.normalize(trimmed);
  }

  return resolve(rootDir, trimmed);
}

export async function validateDirectoryPath(input: string, policy: CwdPolicy): Promise<string> {
  const resolved = resolveDirectoryPath(input, policy.rootDir);

  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new DirectoryValidationError("DIRECTORY_NOT_FOUND", CWD_ERROR_MESSAGES.NOT_FOUND);
  }

  if (!stats.isDirectory()) {
    throw new DirectoryValidationError("DIRECTORY_NOT_DIRECTORY", CWD_ERROR_MESSAGES.NOT_DIRECTORY);
  }

  return resolveToRealPath(resolved);
}

export async function listDirectories(
  requestedPath: string | undefined,
  policy: CwdPolicy
): Promise<DirectoryListingResult> {
  const baseInput = requestedPath?.trim().length ? requestedPath : policy.rootDir;
  const resolvedPath = await validateDirectoryPath(baseInput, policy);
  const roots: string[] = [];

  try {
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const directories: DirectorySummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidatePath = resolveToRealPath(resolve(resolvedPath, entry.name));
      directories.push({
        name: entry.name,
        path: candidatePath
      });
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    return {
      requestedPath,
      resolvedPath,
      roots,
      directories
    };
  } catch {
    throw new DirectoryValidationError("DIRECTORY_LIST_FAILED", CWD_ERROR_MESSAGES.LIST_FAILED);
  }
}

export async function validateDirectory(
  requestedPath: string,
  policy: CwdPolicy
): Promise<DirectoryValidationResult> {
  const roots: string[] = [];

  try {
    const resolvedPath = await validateDirectoryPath(requestedPath, policy);
    return {
      requestedPath,
      roots,
      valid: true,
      resolvedPath
    };
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      return {
        requestedPath,
        roots,
        valid: false,
        message: error.message
      };
    }

    return {
      requestedPath,
      roots,
      valid: false,
      message: CWD_ERROR_MESSAGES.NOT_FOUND
    };
  }
}

export function isPathWithinRoots(pathValue: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithinRoot(pathValue, root));
}

export function isPathWithinRoot(pathValue: string, rootPath: string): boolean {
  const normalizedPath = resolveToRealPath(pathValue);
  const normalizedRoot = resolveToRealPath(rootPath);

  if (normalizedPath === normalizedRoot) {
    return true;
  }

  return normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function resolveToRealPath(pathValue: string): string {
  try {
    return resolve(realpathSync(pathValue));
  } catch {
    return resolve(pathValue);
  }
}

export function toDirectoryName(pathValue: string): string {
  const normalized = resolve(pathValue);
  return basename(normalized);
}
