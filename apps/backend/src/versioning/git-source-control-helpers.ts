import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { GitCli } from "./git-cli.js";

const RECORD_SEPARATOR = "\0";

export interface ParsedWorktreeEntry {
  path: string;
  headSha: string | null;
  branch: string | null;
  isBare: boolean;
  isLocked: boolean;
  lockReason?: string;
  isPrunable: boolean;
  prunableReason?: string;
}

export interface WorktreeIdentity {
  id: string;
  path: string;
  accessible: boolean;
}

export function createWorktreeId(stablePathKey: string): string {
  return createHash("sha256").update(stablePathKey).digest("hex").slice(0, 16);
}

export function resolveStableWorktreePathKey(reportedPath: string): string {
  return resolve(reportedPath);
}

export async function normalizePathForComparison(path: string): Promise<string> {
  return realpath(resolve(path));
}

export async function tryNormalizePathForComparison(
  path: string
): Promise<{ path: string; accessible: true } | { path: string; accessible: false }> {
  try {
    return {
      path: await normalizePathForComparison(path),
      accessible: true
    };
  } catch {
    return {
      path: resolveStableWorktreePathKey(path),
      accessible: false
    };
  }
}

export async function resolveWorktreeIdentity(
  reportedPath: string,
  options?: { forceInaccessible?: boolean }
): Promise<WorktreeIdentity> {
  if (options?.forceInaccessible) {
    const path = resolveStableWorktreePathKey(reportedPath);
    return {
      id: createWorktreeId(path),
      path,
      accessible: false
    };
  }

  const normalized = await tryNormalizePathForComparison(reportedPath);
  return {
    id: createWorktreeId(normalized.path),
    path: normalized.path,
    accessible: normalized.accessible
  };
}

export function isPathContainedInRoot(childPath: string, rootPath: string): boolean {
  if (childPath === rootPath) {
    return true;
  }

  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return childPath.startsWith(prefix);
}

export async function resolveMainWorktreeIdentity(
  entries: ParsedWorktreeEntry[]
): Promise<WorktreeIdentity | null> {
  const firstEntry = entries[0];
  if (!firstEntry) {
    return null;
  }

  return resolveWorktreeIdentity(firstEntry.path, {
    forceInaccessible: firstEntry.isPrunable
  });
}

export async function resolveHeadSha(git: GitCli): Promise<string | null> {
  const result = await git.run(["rev-parse", "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

export async function resolveCurrentBranch(git: GitCli): Promise<string | null> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) {
    return null;
  }

  const branch = result.stdout.trim();
  return branch.length > 0 && branch !== "HEAD" ? branch : null;
}

export interface GitUpstreamRef {
  remote: string;
  branch: string;
  ref: string;
}

export async function resolveUpstream(git: GitCli): Promise<GitUpstreamRef | null> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowFailure: true
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const ref = result.stdout.trim();
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }

  return {
    remote: ref.slice(0, slashIndex),
    branch: ref.slice(slashIndex + 1),
    ref
  };
}

export async function resolveAheadBehind(
  git: GitCli,
  upstreamRef: string
): Promise<{ ahead: number; behind: number } | null> {
  const result = await git.run(["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`], {
    allowFailure: true
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }

  return { ahead, behind };
}

export function computeStatusHash(porcelain: string): string {
  return createHash("sha256").update(porcelain).digest("hex").slice(0, 16);
}

export function isDirtyPorcelain(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

const UNMERGED_PORCELAIN_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function hasUnmergedPorcelain(porcelain: string): boolean {
  return porcelain.split("\n").some((line) => {
    if (line.length < 2) {
      return false;
    }

    const status = line.slice(0, 2);
    return UNMERGED_PORCELAIN_STATUSES.has(status) || status.includes("U");
  });
}

export async function hasUnmergedConflicts(git: GitCli): Promise<boolean> {
  const diffResult = await git.run(["diff", "--name-only", "--diff-filter=U"], {
    allowFailure: true
  });
  if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
    return true;
  }

  const porcelain = await readPorcelainStatus(git);
  return hasUnmergedPorcelain(porcelain);
}

const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidGitRemoteNameShape(remote: string): boolean {
  const trimmed = remote.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.startsWith("-")) {
    return false;
  }

  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    return false;
  }

  return GIT_REMOTE_NAME_PATTERN.test(trimmed);
}

export function isOptionLikeGitRef(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.startsWith("-");
}

export async function verifyResolvableGitRef(git: GitCli, ref: string): Promise<boolean> {
  if (isOptionLikeGitRef(ref)) {
    return false;
  }

  const result = await git.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    allowFailure: true
  });
  return result.exitCode === 0;
}

export function parseWorktreeListPorcelain(output: string): ParsedWorktreeEntry[] {
  if (output.length === 0) {
    return [];
  }

  const records = output.split(RECORD_SEPARATOR).filter((record) => record.length > 0);
  const entries: ParsedWorktreeEntry[] = [];

  for (let index = 0; index < records.length; ) {
    const header = records[index];
    if (!header?.startsWith("worktree ")) {
      index += 1;
      continue;
    }

    const entry: ParsedWorktreeEntry = {
      path: header.slice("worktree ".length),
      headSha: null,
      branch: null,
      isBare: false,
      isLocked: false,
      isPrunable: false
    };

    index += 1;
    while (index < records.length && !records[index]?.startsWith("worktree ")) {
      const line = records[index] ?? "";
      if (line.startsWith("HEAD ")) {
        entry.headSha = line.slice("HEAD ".length) || null;
      } else if (line.startsWith("branch ")) {
        entry.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "") || null;
      } else if (line === "bare") {
        entry.isBare = true;
      } else if (line.startsWith("locked")) {
        entry.isLocked = true;
        entry.lockReason = line.length > "locked".length ? line.slice("locked".length + 1) : undefined;
      } else if (line.startsWith("prunable")) {
        entry.isPrunable = true;
        entry.prunableReason =
          line.length > "prunable".length ? line.slice("prunable".length + 1) : undefined;
      }

      index += 1;
    }

    entries.push(entry);
  }

  return entries;
}

export async function readPorcelainStatus(git: GitCli): Promise<string> {
  const result = await git.run(["status", "--porcelain=v1", "--untracked-files=all"], {
    allowFailure: true
  });
  if (result.exitCode !== 0) {
    return "";
  }

  return result.stdout;
}

export async function resolveWorktreePathById(
  git: GitCli,
  worktreeId: string
): Promise<string | null> {
  const listResult = await git.run(["worktree", "list", "--porcelain", "-z"], {
    allowFailure: true
  });
  if (listResult.exitCode !== 0) {
    return null;
  }

  for (const entry of parseWorktreeListPorcelain(listResult.stdout)) {
    const identity = await resolveWorktreeIdentity(entry.path, {
      forceInaccessible: entry.isPrunable
    });
    if (identity.id !== worktreeId) {
      continue;
    }

    if (!identity.accessible || entry.isPrunable) {
      return null;
    }

    return identity.path;
  }

  return null;
}

export async function resolveWorktreeContextPath(
  baseCwd: string,
  worktreeId: string
): Promise<string> {
  const git = new GitCli({ cwd: baseCwd });
  const path = await resolveWorktreePathById(git, worktreeId);
  if (!path) {
    throw new Error("Unknown or invalid worktreeId.");
  }

  return path;
}

export type GitInProgressOperationKind = "merge" | "rebase" | "cherry-pick";

export async function resolveGitDirectory(git: GitCli, cwd: string): Promise<string | null> {
  const result = await git.run(["rev-parse", "--git-dir"], { allowFailure: true });
  if (result.exitCode !== 0) {
    return null;
  }

  const gitDir = result.stdout.trim();
  if (gitDir.length === 0) {
    return null;
  }

  return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
}

export function detectInProgressGitOperation(
  gitDir: string
): { inProgress: true; kind: GitInProgressOperationKind } | { inProgress: false } {
  if (existsSync(resolve(gitDir, "MERGE_HEAD"))) {
    return { inProgress: true, kind: "merge" };
  }

  if (existsSync(resolve(gitDir, "rebase-merge")) || existsSync(resolve(gitDir, "rebase-apply"))) {
    return { inProgress: true, kind: "rebase" };
  }

  if (existsSync(resolve(gitDir, "CHERRY_PICK_HEAD"))) {
    return { inProgress: true, kind: "cherry-pick" };
  }

  return { inProgress: false };
}

export async function validateBranchName(git: GitCli, branchName: string): Promise<boolean> {
  const trimmed = branchName.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const result = await git.run(["check-ref-format", "--branch", trimmed], { allowFailure: true });
  return result.exitCode === 0;
}

export async function listRemoteNames(git: GitCli): Promise<string[]> {
  const result = await git.run(["remote"], { allowFailure: true });
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export async function collectBranchesCheckedOutInOtherWorktrees(
  baseGit: GitCli,
  currentWorktreePath: string
): Promise<Map<string, string>> {
  const listResult = await baseGit.run(["worktree", "list", "--porcelain", "-z"], {
    allowFailure: true
  });
  if (listResult.exitCode !== 0) {
    return new Map();
  }

  const currentNormalized = await tryNormalizePathForComparison(currentWorktreePath);
  const checkedOutElsewhere = new Map<string, string>();

  for (const entry of parseWorktreeListPorcelain(listResult.stdout)) {
    if (!entry.branch || entry.isPrunable) {
      continue;
    }

    const identity = await resolveWorktreeIdentity(entry.path, {
      forceInaccessible: entry.isPrunable
    });
    if (!identity.accessible) {
      continue;
    }

    if (identity.path === currentNormalized.path) {
      continue;
    }

    checkedOutElsewhere.set(entry.branch, identity.path);
  }

  return checkedOutElsewhere;
}

export function isBlockingAgentStatus(status: string): boolean {
  return status === "streaming";
}
