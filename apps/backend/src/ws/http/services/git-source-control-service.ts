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
  isPathContainedInRoot,
  parseWorktreeListPorcelain,
  readPorcelainStatus,
  resolveCurrentBranch,
  resolveHeadSha,
  resolveMainWorktreeIdentity,
  resolveWorktreeIdentity,
  tryNormalizePathForComparison
} from "../../../versioning/git-source-control-helpers.js";
import type { GitSourceControlContext } from "../shared/route-helpers.js";
import { GitDiffService } from "./git-diff-service.js";

interface AgentCwdEntry {
  normalizedCwd: string;
  summary: GitWorktreeAgentSummary;
}

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
    const mainIdentity = await resolveMainWorktreeIdentity(parsedEntries);
    const repoRoot = mainIdentity?.path ?? context.baseCwd;
    const repoName = basename(repoRoot);
    const currentContextPath = await resolveContextPath(context);
    const agentEntries = await collectAgentEntries(swarmManager);

    const worktrees: GitWorktreeSummary[] = [];
    for (const entry of parsedEntries) {
      const identity = await resolveWorktreeIdentity(entry.path, {
        forceInaccessible: entry.isPrunable
      });
      const isStale = entry.isPrunable || !identity.accessible;

      if (isStale) {
        worktrees.push({
          id: identity.id,
          path: identity.path,
          repoRoot,
          branch: entry.branch,
          headSha: entry.headSha,
          isMainWorktree: mainIdentity?.id === identity.id,
          isCurrentContext: false,
          locked: entry.isLocked || undefined,
          prunable: true,
          dirty: false,
          dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
          activeAgents: []
        });
        continue;
      }

      const worktreeGit = new GitCli({ cwd: identity.path });
      const porcelain = await readPorcelainStatus(worktreeGit);
      const dirtySummary = await this.resolveDirtySummary(identity.path, porcelain);
      const branch = entry.branch ?? (await resolveCurrentBranch(worktreeGit));
      const headSha = entry.headSha ?? (await resolveHeadSha(worktreeGit));
      const activeAgents = findActiveAgentsForWorktree(agentEntries, identity.path);

      worktrees.push({
        id: identity.id,
        path: identity.path,
        repoRoot,
        branch,
        headSha,
        isMainWorktree: mainIdentity?.id === identity.id,
        isCurrentContext: identity.path === currentContextPath,
        locked: entry.isLocked || undefined,
        prunable: undefined,
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

async function resolveContextPath(context: GitSourceControlContext): Promise<string | null> {
  if (context.worktreePath) {
    const normalized = await tryNormalizePathForComparison(context.worktreePath);
    return normalized.path;
  }

  const normalized = await tryNormalizePathForComparison(context.cwd);
  return normalized.path;
}

async function collectAgentEntries(swarmManager: SwarmManager): Promise<AgentCwdEntry[]> {
  const entries: AgentCwdEntry[] = [];

  for (const descriptor of swarmManager.listAgents()) {
    if (!descriptor.cwd || descriptor.cwd.trim().length === 0) {
      continue;
    }

    const normalized = await tryNormalizePathForComparison(descriptor.cwd);
    if (!normalized.accessible) {
      continue;
    }

    const role = descriptor.role === "worker" ? "worker" : "manager";
    entries.push({
      normalizedCwd: normalized.path,
      summary: {
        agentId: descriptor.agentId,
        displayName: descriptor.displayName,
        role,
        status: descriptor.status
      }
    });
  }

  return entries;
}

function findActiveAgentsForWorktree(
  agentEntries: AgentCwdEntry[],
  worktreePath: string
): GitWorktreeAgentSummary[] {
  return agentEntries
    .filter((entry) => isPathContainedInRoot(entry.normalizedCwd, worktreePath))
    .map((entry) => entry.summary);
}

function toContextRef(context: GitSourceControlContext): GitSourceContextRef {
  return {
    repoTarget: context.repoTarget,
    worktreeId: context.worktreeId
  };
}
