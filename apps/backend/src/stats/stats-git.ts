import { writeFileAtomic } from "../utils/atomic-files.js";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getSharedStatsGitCacheDir } from "../swarm/storage/data-paths.js";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodeStats } from "@forge/protocol";

const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const UNKNOWN_APP_VERSION = "unknown";
const VERSION_FILE_NAME = "version.json";
const execFileAsync = promisify(execFileCallback);

export async function computeCodeStats(repoPaths: string[], rangeStartMs: number, dataDir?: string): Promise<CodeStats> {
  if (repoPaths.length === 0) {
    return {
      linesAdded: 0,
      linesDeleted: 0,
      commits: 0,
      repos: 0,
    };
  }

  const sinceIso = new Date(rangeStartMs).toISOString();
  let linesAdded = 0;
  let linesDeleted = 0;
  let commits = 0;
  let repos = 0;

  for (const repoPath of repoPaths) {
    try {
      if (!(await isGitRepo(repoPath))) {
        continue;
      }

      const author = await getRepoAuthor(repoPath);
      if (!author) {
        continue;
      }

      const head = (await runGitCommand(repoPath, ["rev-parse", "HEAD"])).trim();
      const result = await cachedRepoStats(repoPath, author, sinceIso, head, dataDir);
      const parsedNumstat = result;
      const commitCount = result.commits;
      linesAdded += result.linesAdded;
      linesDeleted += result.linesDeleted;
      commits += result.commits;

      if (commitCount > 0 || parsedNumstat.linesAdded > 0 || parsedNumstat.linesDeleted > 0) {
        repos += 1;
      }
    } catch {
      // skip repositories where git commands fail
    }
  }

  return {
    linesAdded,
    linesDeleted,
    commits,
    repos,
  };
}

export async function readServerVersion(rootDir: string): Promise<string> {
  const envVersion = process.env.FORGE_APP_VERSION;
  if (typeof envVersion === "string" && envVersion.trim().length > 0) {
    return envVersion.trim();
  }

  try {
    const versionFilePath = join(rootDir, VERSION_FILE_NAME);
    const raw = await readFile(versionFilePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : UNKNOWN_APP_VERSION;
  } catch {
    return UNKNOWN_APP_VERSION;
  }
}

export function collectManagerRepoPaths(
  agents: Array<{ role?: string; status?: string; cwd?: string }>
): string[] {
  const uniquePaths = new Set<string>();

  for (const agent of agents) {
    if (agent.role !== "manager" || typeof agent.cwd !== "string") {
      continue;
    }

    const cwd = agent.cwd.trim();
    if (cwd.length === 0) {
      continue;
    }

    uniquePaths.add(resolve(cwd));
  }

  return Array.from(uniquePaths.values());
}

function parseNumstatTotals(output: string): { linesAdded: number; linesDeleted: number } {
  let linesAdded = 0;
  let linesDeleted = 0;

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const additionsRaw = parts[0]?.trim() ?? "";
    const deletionsRaw = parts[1]?.trim() ?? "";
    if (additionsRaw === "-" || deletionsRaw === "-") {
      continue;
    }

    const additions = Number.parseInt(additionsRaw, 10);
    const deletions = Number.parseInt(deletionsRaw, 10);

    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      continue;
    }

    linesAdded += additions;
    linesDeleted += deletions;
  }

  return { linesAdded, linesDeleted };
}

async function getRepoAuthor(repoPath: string): Promise<string | null> {
  const email = await getGitConfigValue(repoPath, "user.email");
  if (email) {
    return email;
  }

  return getGitConfigValue(repoPath, "user.name");
}

async function getGitConfigValue(repoPath: string, key: string): Promise<string | null> {
  try {
    const output = await runGitCommand(repoPath, ["config", "--get", key]);
    const value = output.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const output = await runGitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

interface RepoStats { linesAdded: number; linesDeleted: number; commits: number }
const gitComputations = new Map<string, Promise<RepoStats>>();

async function cachedRepoStats(repoPath: string, author: string, sinceIso: string, head: string, dataDir?: string): Promise<RepoStats> {
  const identity = JSON.stringify([resolve(repoPath), author, sinceIso]);
  const key = JSON.stringify([dataDir, identity, head]);
  const existing = gitComputations.get(key);
  if (existing) return existing;
  const computation = (async () => {
    const dir = dataDir ? getSharedStatsGitCacheDir(dataDir) : null;
    const path = dir ? join(dir, `${createHash("sha256").update(identity).digest("hex")}.json`) : null;
    if (path) {
      try {
        const cached = JSON.parse(await readFile(path, "utf8"));
        if (cached.version === 1 && cached.head === head && cached.identity === identity
          && [cached.result?.linesAdded, cached.result?.linesDeleted, cached.result?.commits]
            .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return cached.result as RepoStats;
      } catch { /* Derived cache is optional. */ }
    }
    // One traversal returns both numstat totals and commit count.
    const output = await runGitCommand(repoPath, ["log", head, `--author=${author}`, `--since=${sinceIso}`, "--numstat", "--format=commit:%H"]);
    const result = { ...parseNumstatTotals(output), commits: output.split(/\r?\n/u).filter((line) => /^commit:[0-9a-f]+$/.test(line)).length };
    if (path && dir) {
      await writeFileAtomic(path, JSON.stringify({ version: 1, identity, head, result }), { mode: 0o600 }).catch(() => undefined);
    }
    return result;
  })().finally(() => gitComputations.delete(key));
  gitComputations.set(key, computation);
  return computation;
}

async function runGitCommand(repoPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    windowsHide: true,
  });

  return typeof result.stdout === "string" ? result.stdout : `${result.stdout ?? ""}`;
}
