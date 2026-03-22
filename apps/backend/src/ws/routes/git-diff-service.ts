import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { GitCli } from "../../versioning/git-cli.js";

const MAX_DIFF_FILE_BYTES = 1 * 1024 * 1024;
const MAX_STATUS_FILES = 500;
const MAX_LOG_LIMIT = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;

export type GitFileStatusKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";

export interface GitFileStatus {
  path: string;
  status: GitFileStatusKind;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

export interface GitStatusResult {
  files: GitFileStatus[];
  branch: string;
  summary: { filesChanged: number; insertions: number; deletions: number };
  truncated?: boolean;
  totalFiles?: number;
}

export interface GitDiffResult {
  oldContent: string;
  newContent: string;
  binary?: true;
  truncated?: true;
  reason?: "file_too_large";
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

export interface GitLogResult {
  commits: GitLogEntry[];
  hasMore: boolean;
}

export interface GitCommitDetail {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: GitFileStatus[];
}

export class GitDiffService {
  async getStatus(cwd: string): Promise<GitStatusResult> {
    const git = this.createGit(cwd);
    const [branchResult, statusResult, numstatResult] = await Promise.all([
      git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true }),
      git.run(["status", "--porcelain=v1", "--untracked-files=all"]),
      git.run(["diff", "--numstat", "HEAD", "--"], { allowFailure: true })
    ]);

    const files = parsePorcelainStatus(statusResult.stdout);
    const numstatByPath =
      numstatResult.exitCode === 0
        ? parseNumstatByPath(numstatResult.stdout)
        : new Map<string, { additions: number; deletions: number }>();

    const merged = files.map((file) => {
      const stats = numstatByPath.get(file.path);
      return {
        ...file,
        additions: stats?.additions,
        deletions: stats?.deletions
      } satisfies GitFileStatus;
    });

    const summary = merged.reduce(
      (acc, file) => {
        acc.filesChanged += 1;
        acc.insertions += file.additions ?? 0;
        acc.deletions += file.deletions ?? 0;
        return acc;
      },
      { filesChanged: 0, insertions: 0, deletions: 0 }
    );

    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "HEAD";

    if (merged.length > MAX_STATUS_FILES) {
      return {
        files: merged.slice(0, MAX_STATUS_FILES),
        branch,
        summary,
        truncated: true,
        totalFiles: merged.length
      };
    }

    return {
      files: merged,
      branch,
      summary
    };
  }

  async getFileDiff(cwd: string, file: string): Promise<GitDiffResult> {
    const safePath = this.resolveSafeRepoPath(cwd, file);
    const git = this.createGit(cwd);

    const oldResult = await git.run(["show", `HEAD:${safePath}`], { allowFailure: true });
    const newResult = await readUtf8FileAllowMissing(resolve(cwd, safePath));

    if (oldResult.exitCode !== 0 && !newResult.exists) {
      throw new Error(`File not found: ${safePath}`);
    }

    const oldContent = oldResult.exitCode === 0 ? oldResult.stdout : "";
    const newContent = newResult.exists ? newResult.content : "";

    if (isBinaryString(oldContent) || (newResult.exists && isBinaryBuffer(newResult.buffer))) {
      return {
        oldContent: "",
        newContent: "",
        binary: true
      };
    }

    if (Buffer.byteLength(oldContent, "utf8") > MAX_DIFF_FILE_BYTES || Buffer.byteLength(newContent, "utf8") > MAX_DIFF_FILE_BYTES) {
      return {
        oldContent: "",
        newContent: "",
        truncated: true,
        reason: "file_too_large"
      };
    }

    return {
      oldContent,
      newContent
    };
  }

  async getUntrackedFileContent(cwd: string, file: string): Promise<string> {
    const safePath = this.resolveSafeRepoPath(cwd, file);
    const result = await readUtf8FileAllowMissing(resolve(cwd, safePath));
    if (!result.exists) {
      throw new Error(`File not found: ${safePath}`);
    }

    if (isBinaryBuffer(result.buffer)) {
      throw new Error("binary_file");
    }

    if (result.buffer.byteLength > MAX_DIFF_FILE_BYTES) {
      throw new Error("file_too_large");
    }

    return result.content;
  }

  async getLog(cwd: string, limit: number, offset: number): Promise<GitLogResult> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_LOG_LIMIT);
    const boundedOffset = Math.max(offset, 0);
    const git = this.createGit(cwd);
    const fieldSeparator = "\x1f";
    const format = `%H${fieldSeparator}%h${fieldSeparator}%an${fieldSeparator}%aI${fieldSeparator}%s`;

    const result = await git.run([
      "log",
      `--format=${format}`,
      `--skip=${boundedOffset}`,
      "-n",
      String(boundedLimit + 1)
    ]);

    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const hasMore = rows.length > boundedLimit;
    const selectedRows = rows.slice(0, boundedLimit);

    const parsedBase = selectedRows.map((line) => {
      const [sha, shortSha, author, date, ...messageParts] = line.split(fieldSeparator);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        author: author ?? "",
        date: date ?? "",
        message: messageParts.join(fieldSeparator).trim()
      };
    });

    const commits = await Promise.all(
      parsedBase.map(async (entry) => ({
        ...entry,
        filesChanged: await this.countFilesChangedInCommit(cwd, entry.sha)
      }))
    );

    return {
      commits,
      hasMore
    };
  }

  async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
    const git = this.createGit(cwd);
    const fieldSeparator = "\x1f";
    const detailResult = await git.run([
      "show",
      "--name-status",
      "--format=%H%x1f%an%x1f%aI%x1f%s",
      sha
    ]);

    const lines = detailResult.stdout.split(/\r?\n/);
    const metadataLine = lines.find((line) => line.trim().length > 0);

    if (!metadataLine) {
      throw new Error(`Commit not found: ${sha}`);
    }

    const [resolvedSha, author, date, ...messageParts] = metadataLine.split(fieldSeparator);
    const files: GitFileStatus[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === metadataLine.trim()) {
        continue;
      }

      const parts = trimmed.split("\t");
      if (parts.length < 2) {
        continue;
      }

      const rawStatus = parts[0] ?? "";
      const statusCode = rawStatus.charAt(0);
      const status = mapStatusCode(statusCode);

      if (status === "renamed" || status === "copied") {
        const oldPath = parts[1] ?? "";
        const newPath = parts[2] ?? oldPath;
        files.push({ path: newPath, oldPath, status });
      } else {
        files.push({ path: parts[1] ?? "", status });
      }
    }

    return {
      sha: resolvedSha ?? sha,
      message: messageParts.join(fieldSeparator).trim(),
      author: author ?? "",
      date: date ?? "",
      files
    };
  }

  async getCommitFileDiff(cwd: string, sha: string, file: string): Promise<GitDiffResult> {
    const safePath = this.resolveSafeRepoPath(cwd, file);
    const git = this.createGit(cwd);
    const hasParent = await this.commitHasParent(cwd, sha);

    const oldResult = hasParent
      ? await git.run(["show", `${sha}~1:${safePath}`], { allowFailure: true })
      : { stdout: "", stderr: "", exitCode: 1 };
    const newResult = await git.run(["show", `${sha}:${safePath}`], { allowFailure: true });

    if (oldResult.exitCode !== 0 && newResult.exitCode !== 0) {
      throw new Error(`File not found in commit: ${safePath}`);
    }

    const oldContent = oldResult.exitCode === 0 ? oldResult.stdout : "";
    const newContent = newResult.exitCode === 0 ? newResult.stdout : "";

    if (isBinaryString(oldContent) || isBinaryString(newContent)) {
      return {
        oldContent: "",
        newContent: "",
        binary: true
      };
    }

    if (Buffer.byteLength(oldContent, "utf8") > MAX_DIFF_FILE_BYTES || Buffer.byteLength(newContent, "utf8") > MAX_DIFF_FILE_BYTES) {
      return {
        oldContent: "",
        newContent: "",
        truncated: true,
        reason: "file_too_large"
      };
    }

    return {
      oldContent,
      newContent
    };
  }

  async getBranch(cwd: string): Promise<string> {
    const git = this.createGit(cwd);
    const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : "HEAD";
  }

  async getRepoName(cwd: string): Promise<string> {
    const git = this.createGit(cwd);
    const result = await git.run(["rev-parse", "--show-toplevel"]);
    const topLevel = result.stdout.trim();
    const normalized = topLevel.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/);
    return parts[parts.length - 1] ?? normalized;
  }

  private createGit(cwd: string): GitCli {
    return new GitCli({ cwd });
  }

  private resolveSafeRepoPath(cwd: string, file: string): string {
    const trimmed = file.trim();
    if (!trimmed) {
      throw new Error("file must be a non-empty string.");
    }

    const absoluteCwd = resolve(cwd);
    const absoluteFile = resolve(absoluteCwd, trimmed);
    const rootWithSep = absoluteCwd.endsWith(sep) ? absoluteCwd : `${absoluteCwd}${sep}`;

    if (absoluteFile !== absoluteCwd && !absoluteFile.startsWith(rootWithSep)) {
      throw new Error("File path is outside repository root.");
    }

    return trimmed.replace(/\\/g, "/");
  }

  private async countFilesChangedInCommit(cwd: string, sha: string): Promise<number> {
    if (!sha) {
      return 0;
    }

    const git = this.createGit(cwd);
    const result = await git.run(["show", "--name-only", "--format=", sha], { allowFailure: true });
    if (result.exitCode !== 0) {
      return 0;
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  private async commitHasParent(cwd: string, sha: string): Promise<boolean> {
    const git = this.createGit(cwd);
    const result = await git.run(["rev-list", "--parents", "-n", "1", sha], { allowFailure: true });
    if (result.exitCode !== 0) {
      return false;
    }

    const parts = result.stdout.trim().split(/\s+/).filter((part) => part.length > 0);
    return parts.length > 1;
  }
}

function parsePorcelainStatus(output: string): GitFileStatus[] {
  const statuses: GitFileStatus[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    if (!line || line.length < 3) {
      continue;
    }

    const xy = line.slice(0, 2);
    const payload = line.slice(3).trim();

    if (!payload) {
      continue;
    }

    if (xy === "??") {
      statuses.push({ path: payload, status: "untracked" });
      continue;
    }

    if (xy === "!!") {
      continue;
    }

    const status = mapStatusCode((xy[1] && xy[1] !== " " ? xy[1] : xy[0]) ?? "M");
    if ((status === "renamed" || status === "copied") && payload.includes(" -> ")) {
      const [oldPath, newPath] = payload.split(" -> ");
      statuses.push({ path: (newPath ?? payload).trim(), oldPath: oldPath?.trim(), status });
      continue;
    }

    statuses.push({ path: payload, status });
  }

  return statuses;
}

function parseNumstatByPath(output: string): Map<string, { additions: number; deletions: number }> {
  const byPath = new Map<string, { additions: number; deletions: number }>();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const additions = Number.parseInt(parts[0] ?? "0", 10);
    const deletions = Number.parseInt(parts[1] ?? "0", 10);
    const rawPath = parts.slice(2).join("\t");
    const path = normalizeNumstatPath(rawPath);

    byPath.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0
    });
  }

  return byPath;
}

function normalizeNumstatPath(rawPath: string): string {
  const renamedWithBraces = /^(.*)\{(.+) => (.+)\}(.*)$/u.exec(rawPath);
  if (renamedWithBraces) {
    const [, prefix, , renamedTo, suffix] = renamedWithBraces;
    return `${prefix}${renamedTo}${suffix}`;
  }

  if (rawPath.includes(" => ")) {
    const split = rawPath.split(" => ");
    return split[split.length - 1] ?? rawPath;
  }

  return rawPath;
}

function mapStatusCode(code: string): GitFileStatusKind {
  switch (code.toUpperCase()) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "?":
      return "untracked";
    case "M":
    default:
      return "modified";
  }
}

async function readUtf8FileAllowMissing(path: string): Promise<{ exists: boolean; content: string; buffer: Buffer }> {
  try {
    const buffer = await readFile(path);
    return {
      exists: true,
      content: buffer.toString("utf8"),
      buffer
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return {
        exists: false,
        content: "",
        buffer: Buffer.alloc(0)
      };
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

function isBinaryBuffer(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, BINARY_SNIFF_BYTES));
  return sample.includes(0);
}

function isBinaryString(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_BYTES).includes("\u0000");
}
