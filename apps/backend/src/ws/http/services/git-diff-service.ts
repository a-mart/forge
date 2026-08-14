import { readFile, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type {
  GitCommitDetail,
  GitDiffResult,
  GitFileHistoryStats,
  GitFileLogResult,
  GitFileSectionProvenanceEntry,
  GitFileSectionProvenanceResult,
  GitFileStatus,
  GitLogEntry,
  GitLogRef,
  GitLogResult,
  GitRepoKind,
  GitStatusResult
} from "@forge/protocol";
import { GitCli } from "../../../versioning/git-cli.js";
import { parseVersioningCommitMetadata } from "../../../versioning/versioning-commit-metadata.js";
import { resolveTrackedVersionedPathReference } from "../../../versioning/versioned-paths.js";

const MAX_DIFF_FILE_BYTES = 1 * 1024 * 1024;
const MAX_STATUS_FILES = 500;
const MAX_LOG_LIMIT = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_SECTION_PROVENANCE_SECTIONS = 20;
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";
const HEADING_PATTERN = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/u;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/u;

interface GitStatusContext {
  repoKind: GitRepoKind;
  repoLabel: string;
  notInitialized?: boolean;
}

interface MarkdownHeadingSection {
  heading: string;
  level: number;
  lineStart: number;
  lineEnd: number;
}

interface GitFileSectionProvenanceOptions {
  notInitialized?: boolean;
}

interface GitFileLogOptions {
  includeStats?: boolean;
}

interface ReadGitLogEntriesOptions {
  includeFilesChanged?: boolean;
}

export class GitDiffService {
  private readonly fileHistoryStatsCache = new Map<string, GitFileHistoryStats>();
  async getStatus(cwd: string, context?: GitStatusContext): Promise<GitStatusResult> {
    const repoKind = context?.repoKind ?? "workspace";
    const repoLabel = context?.repoLabel ?? "Workspace";

    if (context?.notInitialized) {
      return createEmptyStatusResult(cwd, repoKind, repoLabel);
    }

    const git = this.createGit(cwd);
    const [branchResult, statusResult, numstatResult, repoRoot, repoName] = await Promise.all([
      git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true }),
      git.run(["status", "--porcelain=v1", "--untracked-files=all"]),
      git.run(["diff", "--numstat", "HEAD", "--"], { allowFailure: true }),
      this.getRepoRoot(cwd),
      this.getRepoName(cwd)
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
        repoName,
        repoRoot,
        repoKind,
        repoLabel,
        truncated: true,
        totalFiles: merged.length
      };
    }

    return {
      files: merged,
      branch,
      summary,
      repoName,
      repoRoot,
      repoKind,
      repoLabel
    };
  }

  async getFileDiff(cwd: string, file: string): Promise<GitDiffResult> {
    const safePath = this.resolveSafeRepoPath(cwd, file);
    const git = this.createGit(cwd);

    const oldResult = await git.run(["show", `HEAD:${safePath}`], { allowFailure: true });
    const newResult = await readWorkingTreeUtf8WithinRoot(cwd, safePath);

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
    const result = await readWorkingTreeUtf8WithinRoot(cwd, safePath);
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
    const commits = await this.readGitLogEntries(cwd, boundedLimit + 1, boundedOffset);
    const hasMore = commits.length > boundedLimit;
    const page = commits.slice(0, boundedLimit);

    return {
      commits: await this.attachLogDecorations(cwd, page),
      hasMore
    };
  }

  async getFileLog(
    cwd: string,
    file: string,
    limit: number,
    offset: number,
    options?: GitFileLogOptions
  ): Promise<GitFileLogResult> {
    const normalized = resolveTrackedVersionedPathReference(cwd, file);
    if (!normalized) {
      throw new Error("file must resolve to a tracked versioning path.");
    }

    const boundedLimit = Math.min(Math.max(limit, 1), MAX_LOG_LIMIT);
    const boundedOffset = Math.max(offset, 0);
    const shouldIncludeStats = options?.includeStats === true || boundedOffset === 0;
    const allCommits = await this.readGitLogEntries(cwd, undefined, undefined, normalized.gitPath, true, {
      includeFilesChanged: false
    });
    const selectedBaseCommits = allCommits.slice(boundedOffset, boundedOffset + boundedLimit + 1);
    const statsCacheKey = this.buildFileHistoryStatsCacheKey(cwd, normalized.gitPath);

    let stats = this.fileHistoryStatsCache.get(statsCacheKey) ?? createEmptyGitFileHistoryStats();
    if (shouldIncludeStats) {
      stats = computeGitFileHistoryStats(allCommits);
      this.fileHistoryStatsCache.set(statsCacheKey, stats);
    }

    const page = await this.attachFilesChangedCounts(cwd, selectedBaseCommits.slice(0, boundedLimit));

    return {
      file: normalized.gitPath,
      commits: await this.attachLogDecorations(cwd, page),
      stats,
      hasMore: selectedBaseCommits.length > boundedLimit
    };
  }

  async getFileSectionProvenance(
    cwd: string,
    file: string,
    options?: GitFileSectionProvenanceOptions
  ): Promise<GitFileSectionProvenanceResult> {
    const normalized = resolveTrackedVersionedPathReference(cwd, file);
    if (!normalized) {
      throw new Error("file must resolve to a tracked versioning path.");
    }

    const fileResult = await readWorkingTreeUtf8WithinRoot(cwd, normalized.gitPath);
    if (!fileResult.exists) {
      throw new Error(`File not found: ${normalized.gitPath}`);
    }

    const sections = parseMarkdownHeadingSections(fileResult.content).slice(0, MAX_SECTION_PROVENANCE_SECTIONS);
    const baseSections = sections.map((section) => createEmptySectionProvenance(section));

    if (options?.notInitialized || sections.length === 0) {
      return {
        file: normalized.gitPath,
        sections: baseSections,
        notInitialized: options?.notInitialized ? true : undefined
      };
    }

    const git = this.createGit(cwd);
    const provenancedSections: GitFileSectionProvenanceEntry[] = [];

    // v1 intentionally resolves sections one git process at a time because `git log -L`
    // is relatively expensive and Cortex files are usually small. Cap the section count
    // to avoid pathological markdown files from spawning an unbounded number of processes.
    for (const section of sections) {
      provenancedSections.push(
        await this.resolveSectionProvenance(git, normalized.gitPath, section)
      );
    }

    return {
      file: normalized.gitPath,
      sections: provenancedSections
    };
  }

  async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
    const git = this.createGit(cwd);
    const format = `%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;
    const [detailResult, numstatResult] = await Promise.all([
      git.run([
        "show",
        "--name-status",
        `--format=${format}`,
        sha
      ]),
      git.run(["show", "--numstat", "--format=", sha])
    ]);

    const recordSeparatorIndex = detailResult.stdout.indexOf(RECORD_SEPARATOR);
    if (recordSeparatorIndex === -1) {
      throw new Error(`Commit not found: ${sha}`);
    }

    const headerRecord = detailResult.stdout.slice(0, recordSeparatorIndex);
    const fileSection = detailResult.stdout.slice(recordSeparatorIndex + RECORD_SEPARATOR.length);
    const [resolvedSha, author, date, message = "", ...bodyParts] = headerRecord.split(FIELD_SEPARATOR);
    const body = bodyParts.join(FIELD_SEPARATOR);

    if (!resolvedSha?.trim()) {
      throw new Error(`Commit not found: ${sha}`);
    }

    const numstatByPath = parseNumstatByPath(numstatResult.stdout);
    const files = parseCommitFiles(fileSection).map((file) => {
      const stats = numstatByPath.get(file.path);
      return {
        ...file,
        additions: stats?.additions,
        deletions: stats?.deletions
      } satisfies GitFileStatus;
    });

    return {
      sha: resolvedSha,
      message: message.trim(),
      author: author ?? "",
      date: date ?? "",
      files,
      metadata: parseVersioningCommitMetadata(body)
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
    const topLevel = await this.getRepoRoot(cwd);
    const normalized = topLevel.replace(/[\\/]+$/, "");
    const name = basename(normalized);
    return name || normalized;
  }

  private async getRepoRoot(cwd: string): Promise<string> {
    const git = this.createGit(cwd);
    const result = await git.run(["rev-parse", "--show-toplevel"]);
    return result.stdout.trim();
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

  private async readGitLogEntries(
    cwd: string,
    limit?: number,
    offset?: number,
    file?: string,
    follow = false,
    options?: ReadGitLogEntriesOptions
  ): Promise<GitLogEntry[]> {
    const git = this.createGit(cwd);
    const format = `%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;
    const args = ["log", `--format=${format}`];

    if (follow && file) {
      args.push("--follow");
    }

    if (typeof offset === "number" && offset > 0) {
      args.push(`--skip=${offset}`);
    }

    if (typeof limit === "number") {
      args.push("-n", String(limit));
    }

    if (file) {
      args.push("--", file);
    }

    const result = await git.run(args);
    const records = parseGitFormatRecords(result.stdout);
    const parsedBase = records.map((record) => {
      const [sha, shortSha, parentsRaw, author, date, message = "", ...bodyParts] = record.split(FIELD_SEPARATOR);
      const body = bodyParts.join(FIELD_SEPARATOR);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        parents: parseParentShas(parentsRaw),
        author: author ?? "",
        date: date ?? "",
        message: message.trim(),
        metadata: parseVersioningCommitMetadata(body)
      };
    });

    if (options?.includeFilesChanged === false) {
      return parsedBase.map((entry) => ({
        ...entry,
        filesChanged: 0
      }));
    }

    return this.attachFilesChangedCounts(cwd, parsedBase);
  }

  private async attachLogDecorations(cwd: string, entries: GitLogEntry[]): Promise<GitLogEntry[]> {
    if (entries.length === 0) {
      return entries;
    }

    const refsBySha = await this.collectLogRefsBySha(cwd);
    return entries.map((entry) => {
      const refs = refsBySha.get(entry.sha);
      return refs && refs.length > 0 ? { ...entry, refs } : entry;
    });
  }

  private async collectLogRefsBySha(cwd: string): Promise<Map<string, GitLogRef[]>> {
    const git = this.createGit(cwd);
    const [refResult, headResult, branchResult] = await Promise.all([
      git.run(
        [
          "for-each-ref",
          "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(HEAD)",
          "refs/heads",
          "refs/remotes",
          "refs/tags"
        ],
        { allowFailure: true }
      ),
      git.run(["rev-parse", "HEAD"], { allowFailure: true }),
      git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
    ]);

    const refsBySha = new Map<string, GitLogRef[]>();
    if (refResult.exitCode === 0) {
      for (const line of refResult.stdout.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }

        const [objectName, peeledObjectName, refname, headMarker] = line.split("\0");
        const parsed = parseLogRef(refname, headMarker === "*");
        const sha = peeledObjectName || objectName;
        if (!sha || !parsed) {
          continue;
        }

        const existing = refsBySha.get(sha) ?? [];
        existing.push(parsed);
        refsBySha.set(sha, existing);
      }
    }

    const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : "";
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    if (headSha && (currentBranch.length === 0 || currentBranch === "HEAD")) {
      const existing = refsBySha.get(headSha) ?? [];
      if (!existing.some((ref) => ref.kind === "current")) {
        existing.unshift({ name: "HEAD", kind: "current" });
        refsBySha.set(headSha, existing);
      }
    }

    for (const [sha, refs] of refsBySha) {
      refsBySha.set(sha, sortLogRefs(refs));
    }

    return refsBySha;
  }

  private attachFilesChangedCounts(
    cwd: string,
    entries: Array<Omit<GitLogEntry, "filesChanged"> & { filesChanged?: number }>
  ): Promise<GitLogEntry[]> {
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        filesChanged: await this.countFilesChangedInCommit(cwd, entry.sha)
      }))
    );
  }

  private buildFileHistoryStatsCacheKey(cwd: string, file: string): string {
    return `${resolve(cwd)}::${file}`;
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

  private async resolveSectionProvenance(
    git: GitCli,
    file: string,
    section: MarkdownHeadingSection
  ): Promise<GitFileSectionProvenanceEntry> {
    const format = `%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;
    const result = await git.run(
      [
        "log",
        "-n",
        "1",
        "-L",
        `${section.lineStart},${section.lineEnd}:${file}`,
        `--format=${format}`
      ],
      { allowFailure: true }
    );

    if (result.exitCode !== 0) {
      return createEmptySectionProvenance(section);
    }

    const record = parseGitFormatRecords(result.stdout)[0];
    if (!record) {
      return createEmptySectionProvenance(section);
    }

    const [sha, modifiedAt, summary = "", ...bodyParts] = record.split(FIELD_SEPARATOR);
    const metadata = parseVersioningCommitMetadata(bodyParts.join(FIELD_SEPARATOR));

    return {
      heading: section.heading,
      level: section.level,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      lastModifiedSha: sha?.trim() || null,
      lastModifiedAt: modifiedAt?.trim() || null,
      lastModifiedSummary: summary.trim() || null,
      reviewRunId: metadata?.reviewRunId ?? null
    };
  }
}

function parseGitFormatRecords(output: string): string[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0);
}

function parseCommitFiles(output: string): GitFileStatus[] {
  const files: GitFileStatus[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const rawStatus = parts[0] ?? "";
    const status = mapStatusCode(rawStatus.charAt(0));

    if (status === "renamed" || status === "copied") {
      const oldPath = parts[1] ?? "";
      const newPath = parts[2] ?? oldPath;
      files.push({ path: newPath, oldPath, status });
      continue;
    }

    files.push({ path: parts[1] ?? "", status });
  }

  return files;
}

function createEmptyStatusResult(cwd: string, repoKind: GitRepoKind, repoLabel: string): GitStatusResult {
  const repoRoot = resolve(cwd);
  return {
    files: [],
    branch: "HEAD",
    summary: { filesChanged: 0, insertions: 0, deletions: 0 },
    repoName: basename(repoRoot) || repoRoot,
    repoRoot,
    repoKind,
    repoLabel,
    notInitialized: true
  };
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

function mapStatusCode(code: string): GitFileStatus["status"] {
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

function createEmptyGitFileHistoryStats(): GitFileHistoryStats {
  return {
    totalEdits: 0,
    lastModifiedAt: null,
    editsToday: 0,
    editsThisWeek: 0
  };
}

function computeGitFileHistoryStats(commits: GitLogEntry[]): GitFileHistoryStats {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  let editsToday = 0;
  let editsThisWeek = 0;
  for (const commit of commits) {
    const timestamp = Date.parse(commit.date);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (timestamp >= dayAgo) {
      editsToday += 1;
    }
    if (timestamp >= weekAgo) {
      editsThisWeek += 1;
    }
  }

  return {
    totalEdits: commits.length,
    lastModifiedAt: commits[0]?.date ?? null,
    editsToday,
    editsThisWeek
  };
}

function parseMarkdownHeadingSections(content: string): MarkdownHeadingSection[] {
  const lines = splitMarkdownLines(content);
  const headings: Array<{ heading: string; level: number; lineNumber: number }> = [];

  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let inHtmlComment = false;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine ?? "";

    if (inFence) {
      if (isFenceClose(line, fenceChar, fenceLength)) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }

    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1]?.[0] ?? "";
      fenceLength = fenceMatch[1]?.length ?? 0;
      continue;
    }

    if (inHtmlComment) {
      if (line.includes("-->")) {
        inHtmlComment = false;
      }
      continue;
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith("<!--")) {
      if (!trimmedStart.includes("-->")) {
        inHtmlComment = true;
      }
      continue;
    }

    const match = line.match(HEADING_PATTERN);
    if (!match) {
      continue;
    }

    const heading = normalizeHeadingText(match[2] ?? "");
    if (!heading) {
      continue;
    }

    headings.push({
      heading,
      level: match[1]?.length ?? 1,
      lineNumber
    });
  }

  return headings.map((heading, index) => ({
    heading: heading.heading,
    level: heading.level,
    lineStart: heading.lineNumber,
    lineEnd: (headings[index + 1]?.lineNumber ?? lines.length + 1) - 1
  }));
}

function createEmptySectionProvenance(section: MarkdownHeadingSection): GitFileSectionProvenanceEntry {
  return {
    heading: section.heading,
    level: section.level,
    lineStart: section.lineStart,
    lineEnd: section.lineEnd,
    lastModifiedSha: null,
    lastModifiedAt: null,
    lastModifiedSummary: null,
    reviewRunId: null
  };
}

function splitMarkdownLines(content: string): string[] {
  return content.replace(/\r\n?/gu, "\n").split("\n");
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/\s+#+\s*$/u, "")
    .replace(/<!--.*?-->/gu, "")
    .trim();
}

function isFenceClose(line: string, fenceChar: string, fenceLength: number): boolean {
  if (!fenceChar || fenceLength === 0) {
    return false;
  }

  const closePattern = new RegExp(`^\\s*${escapeRegExp(fenceChar)}{${fenceLength},}\\s*$`, "u");
  return closePattern.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readWorkingTreeUtf8WithinRoot(
  cwd: string,
  relativePath: string
): Promise<{ exists: boolean; content: string; buffer: Buffer }> {
  const absoluteRoot = resolve(cwd);
  const absolutePath = resolve(absoluteRoot, relativePath);

  // resolveSafeRepoPath only validates lexically. Resolve symlinks before reading and
  // confirm the real target stays inside the repository root, so a symlink created or
  // committed inside the repo cannot redirect a working-tree read outside it.
  let realTargetPath: string;
  try {
    realTargetPath = await realpath(absolutePath);
  } catch (error) {
    if (isEnoentError(error)) {
      return { exists: false, content: "", buffer: Buffer.alloc(0) };
    }
    throw error;
  }

  const realRoot = await realpath(absoluteRoot);
  const realRootWithSep = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realTargetPath !== realRoot && !realTargetPath.startsWith(realRootWithSep)) {
    throw new Error("File path is outside repository root.");
  }

  return readUtf8FileAllowMissing(realTargetPath);
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

function parseParentShas(rawParents: string | undefined): string[] {
  if (!rawParents) {
    return [];
  }

  return rawParents
    .split(/\s+/)
    .map((sha) => sha.trim())
    .filter((sha) => sha.length > 0);
}

function parseLogRef(refname: string | undefined, isHead: boolean): GitLogRef | null {
  if (!refname) {
    return null;
  }

  if (refname.startsWith("refs/heads/")) {
    const name = refname.slice("refs/heads/".length);
    if (!name) {
      return null;
    }
    return { name, kind: isHead ? "current" : "local" };
  }

  if (refname.startsWith("refs/remotes/")) {
    const name = refname.slice("refs/remotes/".length);
    if (!name || name.endsWith("/HEAD")) {
      return null;
    }
    return { name, kind: "remote" };
  }

  if (refname.startsWith("refs/tags/")) {
    const name = refname.slice("refs/tags/".length);
    if (!name) {
      return null;
    }
    return { name, kind: "tag" };
  }

  return null;
}

function sortLogRefs(refs: GitLogRef[]): GitLogRef[] {
  const rank: Record<GitLogRef["kind"], number> = {
    current: 0,
    local: 1,
    remote: 2,
    tag: 3
  };

  return [...refs].sort((left, right) => {
    if (left.kind !== right.kind) {
      return rank[left.kind] - rank[right.kind];
    }
    return left.name.localeCompare(right.name);
  });
}
