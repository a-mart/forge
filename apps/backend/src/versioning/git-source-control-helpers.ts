import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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

export function createWorktreeId(normalizedPath: string): string {
  return createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
}

export async function normalizePathForComparison(path: string): Promise<string> {
  return realpath(resolve(path));
}

export async function resolveRepoRoot(git: GitCli): Promise<string> {
  const result = await git.run(["rev-parse", "--show-toplevel"]);
  return normalizePathForComparison(result.stdout.trim());
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

export function hasUnmergedPorcelain(porcelain: string): boolean {
  return porcelain.split("\n").some((line) => {
    if (line.length < 2) {
      return false;
    }

    return line[0] === "U" || line[1] === "U";
  });
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
    const normalizedPath = await normalizePathForComparison(entry.path);
    if (createWorktreeId(normalizedPath) === worktreeId) {
      return normalizedPath;
    }
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
