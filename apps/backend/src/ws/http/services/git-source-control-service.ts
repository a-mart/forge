import { basename } from "node:path";
import type {
  GitBranchKind,
  GitBranchListResult,
  GitBranchSummary,
  GitCreateBranchRequest,
  GitFetchRequest,
  GitFetchResult,
  GitMutationPreflight,
  GitMutationResult,
  GitPreflightIssue,
  GitPullFfOnlyRequest,
  GitPullResult,
  GitSourceContextRef,
  GitSwitchBranchRequest,
  GitWorktreeAgentSummary,
  GitWorktreeListResult,
  GitWorktreeSummary
} from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { GitCli } from "../../../versioning/git-cli.js";
import {
  collectBranchesCheckedOutInOtherWorktrees,
  computeStatusHash,
  detectInProgressGitOperation,
  hasUnmergedPorcelain,
  isBlockingAgentStatus,
  isDirtyPorcelain,
  isPathContainedInRoot,
  listRemoteNames,
  parseWorktreeListPorcelain,
  readPorcelainStatus,
  resolveAheadBehind,
  resolveCurrentBranch,
  resolveGitDirectory,
  resolveHeadSha,
  resolveMainWorktreeIdentity,
  resolveUpstream,
  resolveWorktreeIdentity,
  tryNormalizePathForComparison,
  validateBranchName
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

  async listBranches(
    _swarmManager: SwarmManager,
    context: GitSourceControlContext
  ): Promise<GitBranchListResult> {
    if (context.notInitialized) {
      return {
        branches: [],
        remotes: [],
        currentBranch: null,
        currentHead: null,
        statusHash: null,
        context: toContextRef(context),
        repoName: basename(context.cwd),
        repoRoot: context.cwd,
        repoKind: context.repoKind,
        repoLabel: context.repoLabel,
        notInitialized: true
      };
    }

    const git = new GitCli({ cwd: context.cwd });
    const baseGit = new GitCli({ cwd: context.baseCwd });
    const porcelain = await readPorcelainStatus(git);
    const currentBranch = await resolveCurrentBranch(git);
    const currentHead = await resolveHeadSha(git);
    const statusHash = computeStatusHash(porcelain);
    const checkedOutElsewhere = await collectBranchesCheckedOutInOtherWorktrees(
      baseGit,
      context.cwd
    );
    const remotes = await listRemoteNames(baseGit);
    const mainIdentity = await resolveMainWorktreeIdentity(
      parseWorktreeListPorcelain(
        (
          await baseGit.run(["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
        ).stdout
      )
    );
    const repoRoot = mainIdentity?.path ?? context.baseCwd;
    const repoName = basename(repoRoot);

    const refResult = await git.run(
      [
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)",
        "refs/heads",
        "refs/remotes"
      ],
      { allowFailure: true }
    );
    if (refResult.exitCode !== 0) {
      throw new Error(refResult.stderr || refResult.stdout || "Failed to list git branches.");
    }

    const branches: GitBranchSummary[] = [];
    for (const line of refResult.stdout.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }

      const [name, headSha, upstream, headMarker] = line.split("\0");
      if (!name) {
        continue;
      }

      const isRemote = name.includes("/") && remotes.some((remote) => name.startsWith(`${remote}/`));
      const kind: GitBranchKind = headMarker === "*" ? "current" : isRemote ? "remote" : "local";
      const summary: GitBranchSummary = {
        name,
        kind,
        headSha: headSha || null,
        upstream: upstream || null
      };

      if (kind === "current" && upstream) {
        const aheadBehind = await resolveAheadBehind(git, upstream);
        if (aheadBehind) {
          summary.ahead = aheadBehind.ahead;
          summary.behind = aheadBehind.behind;
        }
      }

      if (!isRemote && checkedOutElsewhere.has(name)) {
        summary.isCheckedOutInAnotherWorktree = true;
      }

      branches.push(summary);
    }

    branches.sort((left, right) => {
      if (left.kind === "current") {
        return -1;
      }
      if (right.kind === "current") {
        return 1;
      }
      if (left.kind !== right.kind) {
        return left.kind === "local" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

    return {
      branches,
      remotes,
      currentBranch,
      currentHead,
      statusHash,
      context: toContextRef(context),
      repoName,
      repoRoot,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel
    };
  }

  async buildMutationPreflight(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    options: {
      action: "fetch" | "switch-branch" | "create-branch" | "pull-ff-only";
      targetBranch?: string;
      remote?: string;
    }
  ): Promise<GitMutationPreflight> {
    const issues: GitPreflightIssue[] = [];

    if (context.notInitialized) {
      return {
        allowed: false,
        issues: [
          {
            code: "not_initialized",
            message: "Initialize the repository before running git actions.",
            severity: "block"
          }
        ],
        currentBranch: null,
        currentHead: null,
        statusHash: null
      };
    }

    if (context.repoKind === "versioning") {
      return {
        allowed: false,
        issues: [
          {
            code: "versioning_blocked",
            message: "Git mutations are not enabled for the Cortex versioning repository.",
            severity: "block"
          }
        ],
        currentBranch: null,
        currentHead: null,
        statusHash: null
      };
    }

    const git = new GitCli({ cwd: context.cwd });
    const baseGit = new GitCli({ cwd: context.baseCwd });
    const porcelain = await readPorcelainStatus(git);
    const currentBranch = await resolveCurrentBranch(git);
    const currentHead = await resolveHeadSha(git);
    const statusHash = computeStatusHash(porcelain);
    const agentEntries = await collectAgentEntries(swarmManager);
    const activeAgents = findActiveAgentsForWorktree(agentEntries, context.cwd);

    if (isDirtyPorcelain(porcelain) && options.action !== "fetch") {
      issues.push({
        code: "dirty_worktree",
        message:
          "The worktree has uncommitted changes. Commit, stash, or discard them in a terminal before switching branches or pulling.",
        severity: "block"
      });
    }

    if (hasUnmergedPorcelain(porcelain)) {
      issues.push({
        code: "unmerged_conflicts",
        message: "Unresolved merge conflicts must be resolved before this action can continue.",
        severity: "block"
      });
    }

    const gitDir = await resolveGitDirectory(git, context.cwd);
    if (gitDir) {
      const inProgress = detectInProgressGitOperation(gitDir);
      if (inProgress.inProgress) {
        issues.push({
          code: "git_operation_in_progress",
          message: `A ${inProgress.kind} operation is already in progress.`,
          severity: "block"
        });
      }
    }

    const streamingAgents = activeAgents.filter((agent) => isBlockingAgentStatus(agent.status));
    if (streamingAgents.length > 0) {
      issues.push({
        code: "streaming_agents",
        message: `Stop active agents in this worktree before continuing (${streamingAgents.map((agent) => agent.displayName).join(", ")}).`,
        severity: "block"
      });
    }

    const idleAgents = activeAgents.filter((agent) => !isBlockingAgentStatus(agent.status));
    if (
      idleAgents.length > 0 &&
      (options.action === "switch-branch" ||
        options.action === "create-branch" ||
        options.action === "pull-ff-only")
    ) {
      issues.push({
        code: "idle_agents_attached",
        message: `Idle sessions are attached to this worktree (${idleAgents.map((agent) => agent.displayName).join(", ")}).`,
        severity: "warn"
      });
    }

    if (options.action === "switch-branch" && options.targetBranch) {
      const checkedOutElsewhere = await collectBranchesCheckedOutInOtherWorktrees(
        baseGit,
        context.cwd
      );
      if (checkedOutElsewhere.has(options.targetBranch)) {
        issues.push({
          code: "branch_checked_out_elsewhere",
          message: `Branch "${options.targetBranch}" is already checked out in ${checkedOutElsewhere.get(options.targetBranch)}.`,
          severity: "block"
        });
      }
    }

    if (options.action === "pull-ff-only") {
      const upstream = await resolveUpstream(git);
      if (!upstream) {
        issues.push({
          code: "missing_upstream",
          message: "The current branch has no upstream configured for a fast-forward pull.",
          severity: "block"
        });
      } else if (options.remote && upstream.remote !== options.remote) {
        issues.push({
          code: "remote_mismatch",
          message: `Current upstream is ${upstream.ref}, not ${options.remote}.`,
          severity: "block"
        });
      }
    }

    if (options.remote) {
      const remotes = await listRemoteNames(baseGit);
      if (!remotes.includes(options.remote)) {
        issues.push({
          code: "unknown_remote",
          message: `Remote "${options.remote}" was not found. Available remotes: ${remotes.join(", ") || "none"}.`,
          severity: "block"
        });
      }
    }

    return {
      allowed: issues.every((issue) => issue.severity !== "block"),
      issues,
      currentBranch,
      currentHead,
      statusHash
    };
  }

  async fetchOrigin(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    request: GitFetchRequest
  ): Promise<GitFetchResult> {
    const remote = request.remote?.trim() || "origin";
    const preflight = await this.validateMutationRequest(
      swarmManager,
      context,
      request,
      { action: "fetch", remote }
    );
    if (!preflight.allowed) {
      return this.createBlockedMutationResult(context, preflight, remote);
    }

    const git = new GitCli({ cwd: context.cwd });
    const fetchResult = await git.run(["fetch", remote], { allowFailure: true, timeoutMs: 120_000 });
    if (fetchResult.exitCode !== 0) {
      return this.createFailedMutationResult(context, fetchResult.stderr || fetchResult.stdout, remote);
    }

    return this.createSuccessfulMutationResult(context, git, {
      remote,
      warnings: preflight.issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message)
    });
  }

  async switchBranch(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    request: GitSwitchBranchRequest
  ): Promise<GitMutationResult> {
    const branch = request.branch.trim();
    if (branch.length === 0) {
      throw new Error("branch must be a non-empty string.");
    }

    const git = new GitCli({ cwd: context.cwd });
    if (!(await validateBranchName(git, branch))) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    const preflight = await this.validateMutationRequest(swarmManager, context, request, {
      action: "switch-branch",
      targetBranch: branch
    });
    if (!preflight.allowed) {
      return this.createBlockedMutationResult(context, preflight);
    }

    const branchExists = await this.branchExists(git, branch);
    if (!branchExists) {
      return {
        ...(await this.buildMutationMetadata(context, git)),
        success: false,
        context: toContextRef(context),
        currentBranch: preflight.currentBranch,
        currentHead: preflight.currentHead,
        warnings: [],
        errors: [`Branch "${branch}" does not exist. Create it first.`],
        statusSummary: await this.readStatusSummary(context.cwd),
        invalidateCaches: false
      };
    }

    const switchResult = await git.run(["switch", branch], { allowFailure: true });
    if (switchResult.exitCode !== 0) {
      return this.createFailedMutationResult(context, switchResult.stderr || switchResult.stdout);
    }

    return this.createSuccessfulMutationResult(context, git, {
      warnings: preflight.issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message)
    });
  }

  async createBranch(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    request: GitCreateBranchRequest
  ): Promise<GitMutationResult> {
    const branch = request.branch.trim();
    if (branch.length === 0) {
      throw new Error("branch must be a non-empty string.");
    }

    const git = new GitCli({ cwd: context.cwd });
    if (!(await validateBranchName(git, branch))) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    const preflight = await this.validateMutationRequest(swarmManager, context, request, {
      action: "create-branch",
      targetBranch: branch
    });
    if (!preflight.allowed) {
      return this.createBlockedMutationResult(context, preflight);
    }

    if (await this.branchExists(git, branch)) {
      return {
        ...(await this.buildMutationMetadata(context, git)),
        success: false,
        context: toContextRef(context),
        currentBranch: preflight.currentBranch,
        currentHead: preflight.currentHead,
        warnings: [],
        errors: [`Branch "${branch}" already exists.`],
        statusSummary: await this.readStatusSummary(context.cwd),
        invalidateCaches: false
      };
    }

    const startPoint = request.startPoint?.trim();
    const createArgs = startPoint ? ["switch", "-c", branch, startPoint] : ["switch", "-c", branch];
    const createResult = await git.run(createArgs, { allowFailure: true });
    if (createResult.exitCode !== 0) {
      return this.createFailedMutationResult(context, createResult.stderr || createResult.stdout);
    }

    return this.createSuccessfulMutationResult(context, git, {
      warnings: preflight.issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message)
    });
  }

  async pullFfOnly(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    request: GitPullFfOnlyRequest
  ): Promise<GitPullResult> {
    const remote = request.remote?.trim() || "origin";
    const preflight = await this.validateMutationRequest(swarmManager, context, request, {
      action: "pull-ff-only",
      remote
    });
    if (!preflight.allowed) {
      const blocked = this.createBlockedMutationResult(context, preflight, remote);
      return {
        ...blocked,
        remote,
        upstream: "",
        fastForward: false
      };
    }

    const git = new GitCli({ cwd: context.cwd });
    const upstream = await resolveUpstream(git);
    if (!upstream) {
      const blocked = this.createBlockedMutationResult(context, {
        ...preflight,
        allowed: false,
        issues: [
          ...preflight.issues,
          {
            code: "missing_upstream",
            message: "The current branch has no upstream configured for a fast-forward pull.",
            severity: "block"
          }
        ]
      }, remote);
      return {
        ...blocked,
        remote,
        upstream: "",
        fastForward: false
      };
    }

    const fetchResult = await git.run(["fetch", remote], { allowFailure: true, timeoutMs: 120_000 });
    if (fetchResult.exitCode !== 0) {
      const failed = this.createFailedMutationResult(
        context,
        fetchResult.stderr || fetchResult.stdout,
        remote
      );
      return {
        ...failed,
        remote,
        upstream: upstream.ref,
        fastForward: false
      };
    }

    const mergeResult = await git.run(["merge", "--ff-only", "@{u}"], { allowFailure: true });
    if (mergeResult.exitCode !== 0) {
      const failed = this.createFailedMutationResult(
        context,
        mergeResult.stderr || mergeResult.stdout,
        remote
      );
      return {
        ...failed,
        remote,
        upstream: upstream.ref,
        fastForward: false
      };
    }

    const success = await this.createSuccessfulMutationResult(context, git, {
      remote,
      warnings: preflight.issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message)
    });

    return {
      ...success,
      remote,
      upstream: upstream.ref,
      fastForward: true
    };
  }

  private async validateMutationRequest(
    swarmManager: SwarmManager,
    context: GitSourceControlContext,
    request: { expectedHead: string; expectedStatusHash: string },
    options: Parameters<GitSourceControlService["buildMutationPreflight"]>[2]
  ): Promise<GitMutationPreflight> {
    const preflight = await this.buildMutationPreflight(swarmManager, context, options);
    const staleIssues = this.collectStaleStateIssues(preflight, request);
    if (staleIssues.length === 0) {
      return preflight;
    }

    return {
      ...preflight,
      allowed: false,
      issues: [...preflight.issues, ...staleIssues]
    };
  }

  private collectStaleStateIssues(
    preflight: GitMutationPreflight,
    request: { expectedHead: string; expectedStatusHash: string }
  ): GitPreflightIssue[] {
    const issues: GitPreflightIssue[] = [];

    if (
      preflight.currentHead &&
      request.expectedHead.trim().length > 0 &&
      preflight.currentHead !== request.expectedHead.trim()
    ) {
      issues.push({
        code: "stale_head",
        message: "Repository HEAD changed since you opened this confirmation. Refresh and try again.",
        severity: "block"
      });
    }

    if (
      preflight.statusHash &&
      request.expectedStatusHash.trim().length > 0 &&
      preflight.statusHash !== request.expectedStatusHash.trim()
    ) {
      issues.push({
        code: "stale_status",
        message:
          "Working tree status changed since you opened this confirmation. Refresh and try again.",
        severity: "block"
      });
    }

    return issues;
  }

  private async branchExists(git: GitCli, branch: string): Promise<boolean> {
    const result = await git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFailure: true
    });
    return result.exitCode === 0;
  }

  private async buildMutationMetadata(
    context: GitSourceControlContext,
    _git: GitCli
  ): Promise<Pick<GitMutationResult, "repoName" | "repoRoot" | "repoKind" | "repoLabel">> {
    const baseGit = new GitCli({ cwd: context.baseCwd });
    const mainIdentity = await resolveMainWorktreeIdentity(
      parseWorktreeListPorcelain(
        (
          await baseGit.run(["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
        ).stdout
      )
    );
    const repoRoot = mainIdentity?.path ?? context.baseCwd;

    return {
      repoName: basename(repoRoot),
      repoRoot,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel
    };
  }

  private createBlockedMutationResult(
    context: GitSourceControlContext,
    preflight: GitMutationPreflight,
    remote?: string
  ): GitFetchResult {
    return {
      repoName: basename(context.cwd),
      repoRoot: context.cwd,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel,
      success: false,
      context: toContextRef(context),
      currentBranch: preflight.currentBranch,
      currentHead: preflight.currentHead,
      warnings: preflight.issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message),
      errors: preflight.issues
        .filter((issue) => issue.severity === "block")
        .map((issue) => issue.message),
      statusSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      invalidateCaches: false,
      remote: remote ?? "origin"
    };
  }

  private createFailedMutationResult(
    context: GitSourceControlContext,
    message: string,
    remote?: string
  ): GitFetchResult {
    return {
      repoName: basename(context.cwd),
      repoRoot: context.cwd,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel,
      success: false,
      context: toContextRef(context),
      currentBranch: null,
      currentHead: null,
      warnings: [],
      errors: [message.trim() || "Git command failed."],
      statusSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      invalidateCaches: false,
      remote: remote ?? "origin"
    };
  }

  private async createSuccessfulMutationResult(
    context: GitSourceControlContext,
    git: GitCli,
    options: { remote?: string; warnings?: string[] } = {}
  ): Promise<GitFetchResult> {
    const metadata = await this.buildMutationMetadata(context, git);

    return {
      ...metadata,
      success: true,
      context: toContextRef(context),
      currentBranch: await resolveCurrentBranch(git),
      currentHead: await resolveHeadSha(git),
      warnings: options.warnings ?? [],
      errors: [],
      statusSummary: await this.readStatusSummary(context.cwd),
      invalidateCaches: true,
      remote: options.remote ?? "origin"
    };
  }

  private async readStatusSummary(
    cwd: string
  ): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    const porcelain = await readPorcelainStatus(new GitCli({ cwd }));
    if (!isDirtyPorcelain(porcelain)) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }

    const status = await this.diffService.getStatus(cwd);
    return status.summary;
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
