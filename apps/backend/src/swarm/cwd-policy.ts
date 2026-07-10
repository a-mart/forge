import { lstat, mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";

const CWD_ERROR_MESSAGES = {
  REQUIRED: "Directory path must be a non-empty string.",
  NOT_FOUND: "Directory does not exist.",
  NOT_DIRECTORY: "Path is not a directory.",
  LIST_FAILED: "Unable to list directories for the requested path.",
  OUTSIDE_ROOT: "Directory is outside the configured workspace roots.",
  NO_ROOTS:
    "No usable workspace roots are configured. An admin must set FORGE_CWD_ALLOWLIST_ROOTS and mount a workspace root.",
  NAME_REQUIRED: "Folder name is required.",
  NAME_INVALID: "Folder name must be a single path segment without separators or reserved names.",
  ALREADY_EXISTS: "A file or folder with that name already exists.",
  CREATE_FAILED: "Unable to create the directory.",
  PERMISSION_DENIED: "Permission denied creating the directory.",
} as const;

export type DirectoryValidationErrorCode =
  | "DIRECTORY_REQUIRED"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_NOT_DIRECTORY"
  | "DIRECTORY_LIST_FAILED"
  | "DIRECTORY_OUTSIDE_ROOT"
  | "DIRECTORY_NO_ROOTS"
  | "DIRECTORY_NAME_REQUIRED"
  | "DIRECTORY_NAME_INVALID"
  | "DIRECTORY_ALREADY_EXISTS"
  | "DIRECTORY_CREATE_FAILED"
  | "DIRECTORY_PERMISSION_DENIED";

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
  /**
   * When true (collaboration-server / remote-build selection surfaces), paths
   * must resolve inside allowlistRoots. Local Builder keeps this false.
   */
  enforceAllowlist: boolean;
}

export interface DirectorySummary {
  name: string;
  path: string;
}

export interface DirectoryListingResult {
  requestedPath?: string;
  resolvedPath: string;
  /** Parent directory for navigation, or null at an allowlist root / roots view. */
  parentPath?: string | null;
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

export interface CreateDirectoryResult {
  parentPath: string;
  name: string;
  path: string;
  roots: string[];
}

/**
 * Parse `FORGE_CWD_ALLOWLIST_ROOTS`.
 *
 * Delimiters (cross-platform):
 * - `;` always separates entries (safe on Windows drive letters and POSIX)
 * - newlines always separate entries
 * - `:` also separates entries on non-Windows hosts only (POSIX PATH-style)
 *
 * Empty entries are dropped. Paths are trimmed but not required to exist yet —
 * callers resolve usable roots separately.
 */
export function parseCwdAllowlistRootsEnv(value: string | undefined, platform = process.platform): string[] {
  if (!value?.trim()) {
    return [];
  }

  const delimiterPattern = platform === "win32" ? /[;\n]+/g : /[:;\n]+/g;
  return value
    .split(delimiterPattern)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeAllowlistRoots(roots: string[]): string[] {
  const normalized = new Set<string>();

  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;

    normalized.add(resolve(trimmed));
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

export async function resolveUsableAllowlistRoots(roots: string[]): Promise<string[]> {
  const usable: string[] = [];

  for (const root of normalizeAllowlistRoots(roots)) {
    try {
      const stats = await stat(root);
      if (!stats.isDirectory()) {
        continue;
      }
      usable.push(await resolveToRealPath(root));
    } catch {
      // Skip missing / unreadable configured roots; fail-closed happens when none remain.
    }
  }

  return Array.from(new Set(usable)).sort((a, b) => a.localeCompare(b));
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

  const realPath = await resolveToRealPath(resolved);

  if (policy.enforceAllowlist) {
    await assertPathWithinEnforcedRoots(realPath, policy.allowlistRoots);
  }

  return realPath;
}

export async function listDirectories(
  requestedPath: string | undefined,
  policy: CwdPolicy
): Promise<DirectoryListingResult> {
  if (policy.enforceAllowlist) {
    const roots = await resolveUsableAllowlistRoots(policy.allowlistRoots);
    if (roots.length === 0) {
      throw new DirectoryValidationError("DIRECTORY_NO_ROOTS", CWD_ERROR_MESSAGES.NO_ROOTS);
    }

    const trimmed = requestedPath?.trim();
    if (!trimmed) {
      return {
        requestedPath,
        resolvedPath: roots[0],
        parentPath: null,
        roots,
        directories: roots.map((root) => ({
          name: basename(root) || root,
          path: root,
        })),
      };
    }

    const resolvedPath = await validateDirectoryPath(trimmed, { ...policy, allowlistRoots: roots });
    const directories = await listChildDirectoriesWithinRoots(resolvedPath, roots);
    return {
      requestedPath,
      resolvedPath,
      parentPath: resolveParentPathWithinRoots(resolvedPath, roots),
      roots,
      directories,
    };
  }

  const baseInput = requestedPath?.trim().length ? requestedPath : policy.rootDir;
  const resolvedPath = await validateDirectoryPath(baseInput, policy);

  try {
    const directories = await listChildDirectoriesUnrestricted(resolvedPath);
    return {
      requestedPath,
      resolvedPath,
      parentPath: dirname(resolvedPath) === resolvedPath ? null : dirname(resolvedPath),
      roots: [],
      directories,
    };
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      throw error;
    }
    throw new DirectoryValidationError("DIRECTORY_LIST_FAILED", CWD_ERROR_MESSAGES.LIST_FAILED);
  }
}

export async function validateDirectory(
  requestedPath: string,
  policy: CwdPolicy
): Promise<DirectoryValidationResult> {
  const roots = policy.enforceAllowlist
    ? await resolveUsableAllowlistRoots(policy.allowlistRoots)
    : [];

  if (policy.enforceAllowlist && roots.length === 0) {
    return {
      requestedPath,
      roots,
      valid: false,
      message: CWD_ERROR_MESSAGES.NO_ROOTS,
    };
  }

  try {
    const resolvedPath = await validateDirectoryPath(requestedPath, {
      ...policy,
      allowlistRoots: policy.enforceAllowlist ? roots : policy.allowlistRoots,
    });
    return {
      requestedPath,
      roots,
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      return {
        requestedPath,
        roots,
        valid: false,
        message: error.message,
      };
    }

    return {
      requestedPath,
      roots,
      valid: false,
      message: CWD_ERROR_MESSAGES.NOT_FOUND,
    };
  }
}

export interface CreateDirectoryOptions {
  /**
   * Test-only seam invoked after the final pre-mkdir parent revalidation and
   * immediately before mkdir, so tests can simulate a winning TOCTOU race.
   * Production callers omit this.
   */
  beforeMkdir?: () => void | Promise<void>;
}

export async function createDirectory(
  parentPath: string,
  name: string,
  policy: CwdPolicy,
  options?: CreateDirectoryOptions,
): Promise<CreateDirectoryResult> {
  const folderName = validateSingleFolderName(name);
  const roots = policy.enforceAllowlist
    ? await resolveUsableAllowlistRoots(policy.allowlistRoots)
    : [];

  if (policy.enforceAllowlist && roots.length === 0) {
    throw new DirectoryValidationError("DIRECTORY_NO_ROOTS", CWD_ERROR_MESSAGES.NO_ROOTS);
  }

  const resolvedParent = await validateDirectoryPath(parentPath, {
    ...policy,
    allowlistRoots: policy.enforceAllowlist ? roots : policy.allowlistRoots,
  });
  const capturedParent = await captureParentIdentity(resolvedParent);

  const targetPath = join(resolvedParent, folderName);

  // Reject if the joined path escapes the parent via unexpected normalization.
  if (dirname(targetPath) !== resolvedParent) {
    throw new DirectoryValidationError("DIRECTORY_NAME_INVALID", CWD_ERROR_MESSAGES.NAME_INVALID);
  }

  try {
    const existing = await stat(targetPath);
    if (existing) {
      throw new DirectoryValidationError("DIRECTORY_ALREADY_EXISTS", CWD_ERROR_MESSAGES.ALREADY_EXISTS);
    }
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      throw error;
    }
    // ENOENT is expected for a new folder.
  }

  // Final TOCTOU gate immediately before mkdir.
  await assertParentUnchanged(resolvedParent, capturedParent, {
    enforceAllowlist: policy.enforceAllowlist,
    roots,
  });

  // Adversarial test seam: mutate parent after the final check (winning race).
  await options?.beforeMkdir?.();

  try {
    await mkdir(targetPath, { recursive: false });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "EEXIST") {
      throw new DirectoryValidationError("DIRECTORY_ALREADY_EXISTS", CWD_ERROR_MESSAGES.ALREADY_EXISTS);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new DirectoryValidationError("DIRECTORY_PERMISSION_DENIED", CWD_ERROR_MESSAGES.PERMISSION_DENIED);
    }
    throw new DirectoryValidationError("DIRECTORY_CREATE_FAILED", CWD_ERROR_MESSAGES.CREATE_FAILED);
  }

  try {
    const createdPath = await resolveToRealPath(targetPath);
    if (policy.enforceAllowlist) {
      await assertPathWithinEnforcedRoots(createdPath, roots);
    }

    // Parent must still be the same identity after creation.
    await assertParentUnchanged(resolvedParent, capturedParent, {
      enforceAllowlist: policy.enforceAllowlist,
      roots,
    });

    return {
      parentPath: resolvedParent,
      name: folderName,
      path: createdPath,
      roots,
    };
  } catch (error) {
    await bestEffortRemoveCreatedEmptyDirectory(targetPath);
    throw error;
  }
}

interface CapturedParentIdentity {
  realPath: string;
  dev: number | bigint;
  ino: number | bigint;
}

async function captureParentIdentity(parentRealPath: string): Promise<CapturedParentIdentity> {
  let st;
  try {
    st = await lstat(parentRealPath);
  } catch {
    throw new DirectoryValidationError("DIRECTORY_NOT_FOUND", CWD_ERROR_MESSAGES.NOT_FOUND);
  }

  if (st.isSymbolicLink()) {
    throw new DirectoryValidationError("DIRECTORY_OUTSIDE_ROOT", CWD_ERROR_MESSAGES.OUTSIDE_ROOT);
  }
  if (!st.isDirectory()) {
    throw new DirectoryValidationError("DIRECTORY_NOT_DIRECTORY", CWD_ERROR_MESSAGES.NOT_DIRECTORY);
  }

  return {
    realPath: resolve(parentRealPath),
    dev: st.dev,
    ino: st.ino,
  };
}

async function assertParentUnchanged(
  parentPath: string,
  captured: CapturedParentIdentity,
  options: { enforceAllowlist: boolean; roots: string[] },
): Promise<void> {
  let st;
  try {
    st = await lstat(parentPath);
  } catch {
    throw new DirectoryValidationError("DIRECTORY_NOT_FOUND", CWD_ERROR_MESSAGES.NOT_FOUND);
  }

  if (st.isSymbolicLink()) {
    throw new DirectoryValidationError("DIRECTORY_OUTSIDE_ROOT", CWD_ERROR_MESSAGES.OUTSIDE_ROOT);
  }
  if (!st.isDirectory()) {
    throw new DirectoryValidationError("DIRECTORY_NOT_DIRECTORY", CWD_ERROR_MESSAGES.NOT_DIRECTORY);
  }
  if (st.dev !== captured.dev || st.ino !== captured.ino) {
    throw new DirectoryValidationError("DIRECTORY_OUTSIDE_ROOT", CWD_ERROR_MESSAGES.OUTSIDE_ROOT);
  }

  const realPath = await resolveToRealPath(parentPath);
  if (realPath !== captured.realPath) {
    throw new DirectoryValidationError("DIRECTORY_OUTSIDE_ROOT", CWD_ERROR_MESSAGES.OUTSIDE_ROOT);
  }

  if (options.enforceAllowlist) {
    await assertPathWithinEnforcedRoots(realPath, options.roots);
  }
}

async function bestEffortRemoveCreatedEmptyDirectory(pathValue: string): Promise<void> {
  try {
    const st = await lstat(pathValue);
    // Only remove a non-symlink directory we just created; never follow links or recurse.
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return;
    }
    await rmdir(pathValue);
  } catch {
    // Best-effort cleanup only.
  }
}

export function validateSingleFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new DirectoryValidationError("DIRECTORY_NAME_REQUIRED", CWD_ERROR_MESSAGES.NAME_REQUIRED);
  }

  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes(sep)
  ) {
    throw new DirectoryValidationError("DIRECTORY_NAME_INVALID", CWD_ERROR_MESSAGES.NAME_INVALID);
  }

  // Windows-reserved device names and trailing dots/spaces are unsafe as folder names.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed) || /[. ]$/.test(trimmed)) {
    throw new DirectoryValidationError("DIRECTORY_NAME_INVALID", CWD_ERROR_MESSAGES.NAME_INVALID);
  }

  return trimmed;
}

export async function isPathWithinRoots(pathValue: string, roots: string[]): Promise<boolean> {
  const normalizedPath = await resolveToRealPath(pathValue);
  const normalizedRoots = await Promise.all(roots.map((root) => resolveToRealPath(root)));

  return normalizedRoots.some((normalizedRoot) => isNormalizedPathWithinRoot(normalizedPath, normalizedRoot));
}

function isNormalizedPathWithinRoot(normalizedPath: string, normalizedRoot: string): boolean {
  if (normalizedPath === normalizedRoot) {
    return true;
  }

  return normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

async function assertPathWithinEnforcedRoots(realPath: string, roots: string[]): Promise<void> {
  if (roots.length === 0) {
    throw new DirectoryValidationError("DIRECTORY_NO_ROOTS", CWD_ERROR_MESSAGES.NO_ROOTS);
  }

  const normalizedRoots = await Promise.all(roots.map((root) => resolveToRealPath(root)));
  const allowed = normalizedRoots.some((root) => isNormalizedPathWithinRoot(realPath, root));
  if (!allowed) {
    throw new DirectoryValidationError("DIRECTORY_OUTSIDE_ROOT", CWD_ERROR_MESSAGES.OUTSIDE_ROOT);
  }
}

function resolveParentPathWithinRoots(resolvedPath: string, roots: string[]): string | null {
  if (roots.includes(resolvedPath)) {
    return null;
  }

  const parent = dirname(resolvedPath);
  if (parent === resolvedPath) {
    return null;
  }

  const within = roots.some((root) => isNormalizedPathWithinRoot(parent, root));
  return within ? parent : null;
}

async function listChildDirectoriesWithinRoots(
  resolvedPath: string,
  roots: string[]
): Promise<DirectorySummary[]> {
  try {
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const directories = (
      await Promise.all(
        entries.map(async (entry): Promise<DirectorySummary | null> => {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) {
            return null;
          }

          const candidate = resolve(resolvedPath, entry.name);
          let realChild: string;
          try {
            const stats = await stat(candidate);
            if (!stats.isDirectory()) {
              return null;
            }
            realChild = await resolveToRealPath(candidate);
          } catch {
            return null;
          }

          if (!(await isPathWithinRoots(realChild, roots))) {
            return null;
          }

          return {
            name: entry.name,
            path: realChild,
          };
        })
      )
    ).filter((entry): entry is DirectorySummary => entry !== null);

    directories.sort((a, b) => a.name.localeCompare(b.name));
    return directories;
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      throw error;
    }
    throw new DirectoryValidationError("DIRECTORY_LIST_FAILED", CWD_ERROR_MESSAGES.LIST_FAILED);
  }
}

async function listChildDirectoriesUnrestricted(resolvedPath: string): Promise<DirectorySummary[]> {
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const directories = (
    await Promise.all(
      entries.map(async (entry): Promise<DirectorySummary | null> => {
        if (!entry.isDirectory()) {
          return null;
        }

        return {
          name: entry.name,
          path: await resolveToRealPath(resolve(resolvedPath, entry.name)),
        };
      })
    )
  ).filter((entry): entry is DirectorySummary => entry !== null);

  directories.sort((a, b) => a.name.localeCompare(b.name));
  return directories;
}

async function resolveToRealPath(pathValue: string): Promise<string> {
  try {
    return resolve(await realpath(pathValue));
  } catch {
    return resolve(pathValue);
  }
}
