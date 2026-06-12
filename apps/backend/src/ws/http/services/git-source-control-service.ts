import { basename } from "node:path";
import type {
  GitSourceContextRef,
  GitWorktreeAgentSummary,
  GitWorktreeListResult,
  GitWorktreeSummary
} from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { GitCli } from "../../../versioning/git-cli.js";
import {
  createWorktreeId,
  normalizePathForComparison,
  parseWorktreeListPorcelain,
  readPorcelainStatus,
  resolveCurrentBranch,
  resolveHeadSha,
  resolveRepoRoot
} from "../../../versioning/git-source-control-helpers.js";
import type { GitSourceControlContext } from "../shared/route-helpers.js";
import { GitDiffService } from "./git-diff-service.js";

export class GitSourceControlService {
  private readonly diffService = new GitDiffService();

  async listWorktrees(
    swarmManager: SwarmManager,
    context: GitSourceControlContext
  ): Promise<GitWorktreeListResult> {
    if (context.notInitialized) {
      return {
        worktrees: [],
        context: toContextRef(context),
        repoName: basename(context.cwd),
        repoRoot: context.cwd,
        repoKind: context.repoKind,
        repoLabel: context.repoLabel,
        notInitialized: true
      };
    }

    const baseGit = new GitCli({ cwd: context.baseCwd });
    const listResult = await baseGit.run(["worktree", "list", "--porcelain", "-z"], {
      allowFailure: true
    });
    if (listResult.exitCode !== 0) {
      throw new Error(listResult.stderr || listResult.stdout || "Failed to list git worktrees.");
    }

    const parsedEntries = parseWorktreeListPorcelain(listResult.stdout);
    const repoRoot = await resolveRepoRoot(baseGit);
    const repoName = basename(repoRoot);
    const currentContextPath = await resolveContextPath(context);
    const agentsByWorktreePath = await buildAgentIndex(swarmManager);

    const worktrees: GitWorktreeSummary[] = [];
    for (const entry of parsedEntries) {
      const normalizedPath = await normalizePathForComparison(entry.path);
      const worktreeId = createWorktreeId(normalizedPath);
      const worktreeGit = new GitCli({ cwd: normalizedPath });
      const porcelain = await readPorcelainStatus(worktreeGit);
      const dirtySummary = await this.resolveDirtySummary(normalizedPath, porcelain);
      const branch = entry.branch ?? (await resolveCurrentBranch(worktreeGit));
      const headSha = entry.headSha ?? (await resolveHeadSha(worktreeGit));
      const activeAgents = agentsByWorktreePath.get(normalizedPath) ?? [];

      worktrees.push({
        id: worktreeId,
        path: normalizedPath,
        repoRoot,
        branch,
        headSha,
        isMainWorktree: normalizedPath === repoRoot,
        isCurrentContext: normalizedPath === currentContextPath,
        locked: entry.isLocked || undefined,
        prunable: entry.isPrunable || undefined,
        dirty: porcelain.trim().length > 0,
        dirtySummary,
        activeAgents
      });
    }

    worktrees.sort((left, right) => {
      if (left.isMainWorktree !== right.isMainWorktree) {
        return left.isMainWorktree ? -1 : 1;
      }

      return left.path.localeCompare(right.path);
    });

    return {
      worktrees,
      context: toContextRef(context),
      repoName,
      repoRoot,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel
    };
  }

  private async resolveDirtySummary(
    cwd: string,
    porcelain: string
  ): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    if (porcelain.trim().length === 0) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }

    const status = await this.diffService.getStatus(cwd);
    return status.summary;
  }
}

async function resolveContextPath(context: GitSourceControlContext): Promise<string> {
  if (context.worktreePath) {
    return normalizePathForComparison(context.worktreePath);
  }

  return normalizePathForComparison(context.cwd);
}

async function buildAgentIndex(
  swarmManager: SwarmManager
): Promise<Map<string, GitWorktreeAgentSummary[]>> {
  const index = new Map<string, GitWorktreeAgentSummary[]>();

  for (const descriptor of swarmManager.listAgents()) {
    if (!descriptor.cwd || descriptor.cwd.trim().length === 0) {
      continue;
    }

    let normalizedCwd: string;
    try {
      normalizedCwd = await normalizePathForComparison(descriptor.cwd);
    } catch {
      continue;
    }

    const role = descriptor.role === "worker" ? "worker" : "manager";
    const summary: GitWorktreeAgentSummary = {
      agentId: descriptor.agentId,
      displayName: descriptor.displayName,
      role,
      status: descriptor.status
    };

    const existing = index.get(normalizedCwd) ?? [];
    existing.push(summary);
    index.set(normalizedCwd, existing);
  }

  return index;
}

function toContextRef(context: GitSourceControlContext): GitSourceContextRef {
  return {
    repoTarget: context.repoTarget,
    worktreeId: context.worktreeId
  };
}
