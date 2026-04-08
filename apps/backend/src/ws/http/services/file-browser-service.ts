import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import type {
  FileContentResult,
  FileCountResult,
  FileEntry,
  FileListResult,
  FileSearchResult,
} from "@forge/protocol";
import { isPathWithinRoots } from "../../../swarm/cwd-policy.js";
import { GitCli } from "../../../versioning/git-cli.js";

const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB cap
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
  repoRoot?: string;
}

export class FileBrowserService {
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

    const names = dirEntries.map((entry) => entry.name);
    const ignoredNames = repoContext.isGitRepo && repoContext.repoRoot
      ? await this.getGitIgnoredNames(repoContext.repoRoot, resolvedPath, names)
      : new Set<string>();

    const entries = (
      await Promise.all(
        dirEntries.map((entry) => this.toDirectoryEntry({
          entry,
          cwd: normalizedCwd,
          parentDir: resolvedPath,
          isGitRepo: repoContext.isGitRepo,
          ignoredNames
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
    const sample = contentBuffer.subarray(0, Math.min(contentBuffer.length, BINARY_SNIFF_BYTES));
    if (sample.includes(0)) {
      return {
        content: null,
        binary: true,
        size: contentBuffer.byteLength
      };
    }

    const content = contentBuffer.toString("utf8");
    return {
      content,
      binary: false,
      size: contentBuffer.byteLength,
      lines: content.length === 0 ? 0 : content.split(/\r?\n/).length
    };
  }

  async getRepoMetadata(cwd: string): Promise<RepoMetadata> {
    const context = await this.getRepoContext(cwd);
    return {
      isGitRepo: context.isGitRepo,
      repoName: context.repoName,
      branch: context.branch
    };
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
      repoRoot,
      repoName: basename(repoRoot),
      branch
    };
  }

  private async resolvePathWithinCwd(cwd: string, relativePath: string): Promise<string> {
    const requested = relativePath.length > 0 ? relativePath : ".";
    const resolved = resolve(cwd, requested);
    const isWithin = await isPathWithinRoots(resolved, [cwd]);
    if (!isWithin) {
      throw new Error("Path is outside CWD.");
    }

    return resolved;
  }

  private async getGitIgnoredNames(repoRoot: string, parentDir: string, names: string[]): Promise<Set<string>> {
    const candidates = names.filter((name) => name !== ".git");
    if (candidates.length === 0) {
      return new Set<string>();
    }

    const repoRelativeByName = new Map<string, string>();
    for (const name of candidates) {
      const absolutePath = resolve(parentDir, name);
      const repoRelative = relative(repoRoot, absolutePath).replace(/\\/g, "/");
      if (!repoRelative || repoRelative.startsWith("..") || repoRelative === ".") {
        continue;
      }

      repoRelativeByName.set(name, repoRelative);
    }

    if (repoRelativeByName.size === 0) {
      return new Set<string>();
    }

    const ignoredPaths = await runGitCheckIgnore(repoRoot, Array.from(repoRelativeByName.values()));
    const ignoredNames = new Set<string>();

    for (const [name, repoRelative] of repoRelativeByName.entries()) {
      if (ignoredPaths.has(repoRelative)) {
        ignoredNames.add(name);
      }
    }

    return ignoredNames;
  }

  private async toDirectoryEntry(options: {
    entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
    cwd: string;
    parentDir: string;
    isGitRepo: boolean;
    ignoredNames: Set<string>;
  }): Promise<FileEntry | null> {
    const { entry, cwd, parentDir, isGitRepo, ignoredNames } = options;
    const name = entry.name;

    if (name === ".git") {
      return null;
    }

    if (isGitRepo) {
      if (ignoredNames.has(name)) {
        return null;
      }
    } else if (isExcludedForNonGit(name)) {
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

    // Verify symlinked file targets stay within CWD (mirrors directory check above)
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

function normalizeRelativePath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed || trimmed === ".") {
    return "";
  }

  return trimmed.replace(/^[.][\\/]/, "").replace(/\\/g, "/").replace(/\/+$/, "");
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

async function runGitCheckIgnore(repoRoot: string, paths: string[]): Promise<Set<string>> {
  const child = spawn("git", ["check-ignore", "-z", "--stdin"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });

  // Use NUL-delimited input to safely handle filenames with whitespace/newlines
  child.stdin.setDefaultEncoding("utf8");
  child.stdin.write(paths.join("\0"));
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await waitForChildProcessClose(child);

  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`git check-ignore failed (${exitCode}): ${stderr.trim() || "unknown error"}`);
  }

  const stdoutBuffer = Buffer.concat(stdoutChunks);
  if (stdoutBuffer.length === 0) {
    return new Set<string>();
  }

  const stdoutStr = stdoutBuffer.toString("utf8");
  // NUL-delimited output: split on \0 and filter empty segments
  return new Set(
    stdoutStr
      .split("\0")
      .filter((segment) => segment.length > 0)
  );
}

async function waitForChildProcessClose(child: ReturnType<typeof spawn>): Promise<number> {
  const closePromise = once(child, "close") as Promise<[number | null]>;
  const errorPromise = once(child, "error") as Promise<[Error]>;

  const winner = await Promise.race([
    closePromise.then(([code]) => ({ kind: "close" as const, code })),
    errorPromise.then(([error]) => ({ kind: "error" as const, error }))
  ]);

  if (winner.kind === "error") {
    throw winner.error;
  }

  return winner.code ?? 1;
}
