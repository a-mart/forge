import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type {
  FileContentResult,
  FileCountResult,
  FileEditability,
  FileEntry,
  FileListResult,
  FileSaveConflictReason,
  FileSaveResponse,
  FileSearchResult,
  FileVersionToken,
} from "@forge/protocol";
import { isPathWithinRoots } from "../../../swarm/cwd-policy.js";
import { GitCli } from "../../../versioning/git-cli.js";

const BINARY_SNIFF_BYTES = 8 * 1024;
export const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_EDITABLE_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_FILE_SAVE_BYTES = 1 * 1024 * 1024;
export const MAX_FILE_SAVE_BODY_BYTES = Math.ceil(MAX_FILE_SAVE_BYTES * 2.25) + 64 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const NON_GIT_EXCLUDED_NAMES = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".DS_Store",
  "dist",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "Thumbs.db"
]);

export interface RepoMetadata {
  isGitRepo: boolean;
  repoName: string;
  branch: string | null;
}

interface RepoContext {
  isGitRepo: boolean;
  repoName: string;
  branch: string | null;
}

interface CurrentTextFileState {
  content: string;
  buffer: Buffer;
  stats: Awaited<ReturnType<typeof stat>>;
  version: FileVersionToken;
  editability: FileEditability;
}

export class FileBrowserService {
  private readonly saveQueues = new Map<string, Promise<void>>();

  async listDirectory(cwd: string, relativePath: string): Promise<FileListResult> {
    const normalizedCwd = resolve(cwd);
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const resolvedPath = await this.resolvePathWithinCwd(normalizedCwd, normalizedRelativePath);

    let directoryStats;
    try {
      directoryStats = await stat(resolvedPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error("Directory not found.");
      }

      if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        throw new Error("Directory is not readable.");
      }

      throw error;
    }

    if (!directoryStats.isDirectory()) {
      throw new Error("Requested path must be a directory.");
    }

    const repoContext = await this.getRepoContext(resolvedPath);

    let dirEntries;
    try {
      dirEntries = await readdir(resolvedPath, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        throw new Error("Directory is not readable.");
      }

      throw error;
    }

    const entries = (
      await Promise.all(
        dirEntries.map((entry) => this.toDirectoryEntry({
          entry,
          cwd: normalizedCwd,
          parentDir: resolvedPath,
          isGitRepo: repoContext.isGitRepo
        }))
      )
    ).filter((entry): entry is FileEntry => entry !== null);

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

    const base: FileListResult = {
      cwd: normalizedCwd,
      path: normalizedRelativePath,
      entries
    };

    if (normalizedRelativePath.length === 0) {
      return {
        ...base,
        isGitRepo: repoContext.isGitRepo,
        repoName: repoContext.repoName,
        branch: repoContext.branch
      };
    }

    return base;
  }

  async getFileCount(cwd: string): Promise<FileCountResult> {
    const metadata = await this.getRepoMetadata(cwd);
    if (!metadata.isGitRepo) {
      return { count: 0, method: "none" };
    }

    const output = await this.listGitVisibleFiles(resolve(cwd));
    return {
      count: splitGitFileLines(output).length,
      method: "git"
    };
  }

  async searchFiles(cwd: string, query: string, limit: number): Promise<FileSearchResult> {
    const metadata = await this.getRepoMetadata(cwd);
    if (!metadata.isGitRepo) {
      return { results: [], totalMatches: 0, unavailable: true };
    }

    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return { results: [], totalMatches: 0 };
    }

    const output = await this.listGitVisibleFiles(resolve(cwd));
    const candidates = splitGitFileLines(output);
    const matches = candidates.filter((line) => line.toLowerCase().includes(normalizedQuery));

    return {
      results: matches.slice(0, limit).map((pathValue) => ({ path: pathValue, type: "file" })),
      totalMatches: matches.length
    };
  }

  async getFileContent(cwd: string, relativePath: string): Promise<FileContentResult> {
    const normalizedCwd = resolve(cwd);
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    if (!normalizedRelativePath) {
      throw new Error("path must be a non-empty string.");
    }

    const resolvedPath = await this.resolvePathWithinCwd(normalizedCwd, normalizedRelativePath);

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error("File not found.");
      }

      throw error;
    }

    if (!fileStats.isFile()) {
      throw new Error("Requested path must point to a file.");
    }

    if (fileStats.size > MAX_FILE_CONTENT_BYTES) {
      throw new Error(`File too large (${fileStats.size} bytes). Exceeds ${MAX_FILE_CONTENT_BYTES} byte limit.`);
    }

    const contentBuffer = await readFile(resolvedPath);
    const editability = getFileEditability(
      { size: Number(fileStats.size), isFile: () => fileStats.isFile() },
      contentBuffer
    );

    if (isLikelyBinary(contentBuffer)) {
      return {
        content: null,
        binary: true,
        size: contentBuffer.byteLength,
        editability
      };
    }

    let content: string;
    try {
      content = decodeUtf8Strict(contentBuffer);
    } catch {
      return {
        content: contentBuffer.toString("utf8"),
        binary: false,
        size: contentBuffer.byteLength,
        lines: contentBuffer.length === 0 ? 0 : contentBuffer.toString("utf8").split(/\r?\n/).length,
        editability
      };
    }

    const version = computeFileVersion(contentBuffer, toFileStatNumbers(fileStats));
    return {
      content,
      binary: false,
      size: contentBuffer.byteLength,
      lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      encoding: "utf8",
      version,
      editability
    };
  }

  async saveFileContent(options: {
    cwd: string;
    relativePath: string;
    content: string;
    baseVersion: FileVersionToken;
    overwrite: boolean;
    onSaved?: (saved: { resolvedPath: string }) => Promise<void> | void;
  }): Promise<FileSaveResponse> {
    const normalizedCwd = resolve(options.cwd);
    const normalizedRelativePath = normalizeRelativePath(options.relativePath);
    if (!normalizedRelativePath) {
      throw new Error("path must be a non-empty string.");
    }

    const contentBytes = Buffer.byteLength(options.content, "utf8");
    if (contentBytes > MAX_FILE_SAVE_BYTES) {
      throw new Error(`Save content exceeds ${MAX_FILE_SAVE_BYTES} byte limit.`);
    }

    const resolvedPath = await this.resolvePathWithinCwd(normalizedCwd, normalizedRelativePath);
    return this.withSaveLock(resolvedPath, async () => {
      let fileStats;
      try {
        fileStats = await stat(resolvedPath);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
          return conflictResponse("deleted");
        }

        rethrowPermissionDenied(error, "read");
      }

      if (!fileStats.isFile()) {
        return conflictResponse("not_file");
      }

      const currentSize = Number(fileStats.size);
      if (currentSize > MAX_EDITABLE_FILE_BYTES) {
        return conflictResponse("too_large", undefined, currentSize);
      }

      let currentState: CurrentTextFileState;
      try {
        currentState = await this.buildTextFileState(resolvedPath, fileStats);
      } catch (error) {
        rethrowPermissionDenied(error, "read");
      }

      if (!options.overwrite && currentState.version.sha256 !== options.baseVersion.sha256) {
        return conflictResponse("modified", currentState.version, Number(currentState.stats.size));
      }

      if (!currentState.editability.editable) {
        const reason = currentState.editability.reason ?? "binary";
        return conflictResponse(
          mapEditabilityReasonToConflict(reason),
          currentState.version,
          Number(currentState.stats.size)
        );
      }

      try {
        await writeFile(resolvedPath, options.content, "utf8");
      } catch (error) {
        rethrowPermissionDenied(error, "write");
      }

      const savedBuffer = Buffer.from(options.content, "utf8");
      let savedStats;
      try {
        savedStats = await stat(resolvedPath);
      } catch (error) {
        rethrowPermissionDenied(error, "read");
      }
      const savedVersion = computeFileVersion(savedBuffer, toFileStatNumbers(savedStats));
      const lines = options.content.length === 0 ? 0 : options.content.split(/\r?\n/).length;

      try {
        await options.onSaved?.({ resolvedPath });
      } catch {
        // Side-effect failures after a successful write must not fail the save response.
      }

      return {
        success: true,
        version: savedVersion,
        size: Number(savedStats.size),
        lines,
        bytesWritten: contentBytes
      };
    });
  }

  async getRepoMetadata(cwd: string): Promise<RepoMetadata> {
    const context = await this.getRepoContext(cwd);
    return {
      isGitRepo: context.isGitRepo,
      repoName: context.repoName,
      branch: context.branch
    };
  }

  private async buildTextFileState(
    resolvedPath: string,
    fileStats: Awaited<ReturnType<typeof stat>>
  ): Promise<CurrentTextFileState> {
    const currentSize = Number(fileStats.size);
    if (currentSize > MAX_EDITABLE_FILE_BYTES) {
      throw new Error("Current file exceeds editable byte cap.");
    }

    const contentBuffer = await readFile(resolvedPath);
    const editability = getFileEditability(
      { size: Number(fileStats.size), isFile: () => fileStats.isFile() },
      contentBuffer
    );
    const statNumbers = toFileStatNumbers(fileStats);

    if (!editability.editable) {
      return {
        content: "",
        buffer: contentBuffer,
        stats: fileStats,
        version: computeFileVersion(contentBuffer, statNumbers),
        editability
      };
    }

    let content: string;
    try {
      content = decodeUtf8Strict(contentBuffer);
    } catch {
      return {
        content: "",
        buffer: contentBuffer,
        stats: fileStats,
        version: computeFileVersion(contentBuffer, statNumbers),
        editability
      };
    }

    return {
      content,
      buffer: contentBuffer,
      stats: fileStats,
      version: computeFileVersion(contentBuffer, statNumbers),
      editability
    };
  }

  private async withSaveLock<T>(resolvedPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.saveQueues.get(resolvedPath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const chain = previous.then(() => gate);
    this.saveQueues.set(resolvedPath, chain);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.saveQueues.get(resolvedPath) === chain) {
        this.saveQueues.delete(resolvedPath);
      }
    }
  }

  private async getRepoContext(cwd: string): Promise<RepoContext> {
    const normalizedCwd = resolve(cwd);
    const git = new GitCli({ cwd: normalizedCwd });
    const topLevelResult = await git.run(["rev-parse", "--show-toplevel"], { allowFailure: true });

    if (topLevelResult.exitCode !== 0) {
      return {
        isGitRepo: false,
        repoName: basename(normalizedCwd),
        branch: null
      };
    }

    const repoRoot = resolve(topLevelResult.stdout.trim());
    const branchResult = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    const branchRaw = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    const branch = branchRaw.length > 0 && branchRaw !== "HEAD" ? branchRaw : null;

    return {
      isGitRepo: true,
      repoName: basename(repoRoot),
      branch
    };
  }

  private async resolvePathWithinCwd(cwd: string, relativePath: string): Promise<string> {
    const normalizedCwd = resolve(await realpath(cwd).catch(() => cwd));
    const requested = relativePath.length > 0 ? relativePath : ".";
    const resolved = resolve(normalizedCwd, requested);

    let existingAncestor = resolved;
    while (true) {
      try {
        await stat(existingAncestor);
        break;
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }

        const parentPath = dirname(existingAncestor);
        if (parentPath === existingAncestor) {
          break;
        }

        existingAncestor = parentPath;
      }
    }

    const isWithin = await isPathWithinRoots(existingAncestor, [normalizedCwd]);
    if (!isWithin) {
      throw new Error("Path is outside CWD.");
    }

    try {
      const realResolved = await realpath(resolved);
      const isRealWithin = await isPathWithinRoots(realResolved, [normalizedCwd]);
      if (!isRealWithin) {
        throw new Error("Path is outside CWD.");
      }

      return realResolved;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return resolved;
      }

      throw error;
    }
  }

  private async toDirectoryEntry(options: {
    entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
    cwd: string;
    parentDir: string;
    isGitRepo: boolean;
  }): Promise<FileEntry | null> {
    const { entry, cwd, parentDir, isGitRepo } = options;
    const name = entry.name;

    if (name === ".git") {
      return null;
    }

    if (!isGitRepo && isExcludedForNonGit(name)) {
      return null;
    }

    const absolutePath = resolve(parentDir, name);

    if (entry.isSymbolicLink()) {
      return await this.resolveSymlinkEntry(absolutePath, name, cwd);
    }

    if (entry.isDirectory()) {
      return { name, type: "directory" };
    }

    if (entry.isFile()) {
      try {
        const fileStats = await stat(absolutePath);
        if (!fileStats.isFile()) {
          return null;
        }

        return {
          name,
          type: "file",
          size: fileStats.size,
          extension: toFileExtension(name)
        };
      } catch (error) {
        if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM") || isErrorCode(error, "ENOENT")) {
          return null;
        }

        throw error;
      }
    }

    return null;
  }

  private async resolveSymlinkEntry(absolutePath: string, name: string, cwd: string): Promise<FileEntry | null> {
    let targetStats;
    try {
      targetStats = await stat(absolutePath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        return null;
      }

      throw error;
    }

    if (targetStats.isDirectory()) {
      let resolvedTarget;
      try {
        resolvedTarget = await realpath(absolutePath);
      } catch {
        return null;
      }

      const isWithin = await isPathWithinRoots(resolvedTarget, [cwd]);
      if (!isWithin) {
        return null;
      }

      return { name, type: "directory" };
    }

    if (!targetStats.isFile()) {
      return null;
    }

    let resolvedFileTarget;
    try {
      resolvedFileTarget = await realpath(absolutePath);
    } catch {
      return null;
    }

    const isFileWithin = await isPathWithinRoots(resolvedFileTarget, [cwd]);
    if (!isFileWithin) {
      return null;
    }

    return {
      name,
      type: "file",
      size: targetStats.size,
      extension: toFileExtension(name)
    };
  }

  private async listGitVisibleFiles(cwd: string): Promise<string> {
    const git = new GitCli({ cwd: resolve(cwd) });
    const result = await git.run(["ls-files", "--cached", "--others", "--exclude-standard"]);
    return result.stdout;
  }
}

export function computeFileVersion(buffer: Buffer, stats: { size: number; mtimeMs: number }): FileVersionToken {
  return {
    kind: "sha256-stat-v1",
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

export function decodeUtf8Strict(buffer: Buffer): string {
  return UTF8_DECODER.decode(buffer);
}

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
  if (sample.includes(0)) {
    return true;
  }

  let suspiciousChars = 0;
  for (const code of sample) {
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if (!isAllowedControl && (code < 32 || code === 255)) {
      suspiciousChars += 1;
    }
  }

  return suspiciousChars > 0 && suspiciousChars / sample.length > 0.12;
}

export function getFileEditability(
  stats: { size: number; isFile(): boolean },
  buffer: Buffer
): FileEditability {
  const base: FileEditability = {
    editable: false,
    maxEditableBytes: MAX_EDITABLE_FILE_BYTES
  };

  if (!stats.isFile()) {
    return { ...base, reason: "not_file" };
  }

  if (isLikelyBinary(buffer)) {
    return { ...base, reason: "binary" };
  }

  if (stats.size > MAX_EDITABLE_FILE_BYTES) {
    return { ...base, reason: "too_large" };
  }

  try {
    decodeUtf8Strict(buffer);
  } catch {
    return { ...base, reason: "unsupported_encoding" };
  }

  return {
    editable: true,
    maxEditableBytes: MAX_EDITABLE_FILE_BYTES
  };
}

function toFileStatNumbers(stats: { size: number | bigint; mtimeMs: number | bigint }): {
  size: number;
  mtimeMs: number;
} {
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs)
  };
}

export function isPermissionDeniedError(error: unknown): boolean {
  return isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM");
}

export function rethrowPermissionDenied(error: unknown, action: "read" | "write"): never {
  if (isPermissionDeniedError(error)) {
    throw new Error(action === "write" ? "File is not writable." : "File is not readable.");
  }

  throw error instanceof Error ? error : new Error(String(error));
}

function conflictResponse(
  reason: FileSaveConflictReason,
  currentVersion?: FileVersionToken,
  currentSize?: number
): FileSaveResponse {
  return {
    success: false,
    conflict: true,
    reason,
    ...(currentVersion ? { currentVersion } : {}),
    ...(typeof currentSize === "number" ? { currentSize } : {})
  };
}

function mapEditabilityReasonToConflict(
  reason: NonNullable<FileEditability["reason"]>
): FileSaveConflictReason {
  switch (reason) {
    case "binary":
      return "binary";
    case "too_large":
      return "too_large";
    case "unsupported_encoding":
      return "unsupported_encoding";
    case "not_file":
      return "not_file";
    default:
      return "binary";
  }
}

function normalizeRelativePath(pathValue: string): string {
  if (pathValue.length === 0 || pathValue === ".") {
    return "";
  }

  return pathValue.replace(/^[.][\\/]/, "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function normalizeRelativePathForTest(pathValue: string): string {
  return normalizeRelativePath(pathValue);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function splitGitFileLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isExcludedForNonGit(name: string): boolean {
  if (NON_GIT_EXCLUDED_NAMES.has(name)) {
    return true;
  }

  if (name.endsWith(".pyc")) {
    return true;
  }

  return false;
}

function toFileExtension(name: string): string | undefined {
  const extension = extname(name);
  if (!extension || extension.length <= 1) {
    return undefined;
  }

  return extension.slice(1).toLowerCase();
}

