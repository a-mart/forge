import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentDescriptor, GitRepoKind, GitRepoTarget } from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { resolveWorktreeContextPath } from "../../../versioning/git-source-control-helpers.js";
import { resolveEffectiveAgentWorkspaceCwd } from "../../ws-file-access.js";

export interface GitRepoContext {
  cwd: string;
  repoTarget: GitRepoTarget;
  repoKind: GitRepoKind;
  repoLabel: string;
  notInitialized?: boolean;
}

export interface GitSourceControlContext extends GitRepoContext {
  baseCwd: string;
  worktreeId?: string;
  worktreePath?: string;
}

export async function resolveReadOnlyGitContext(
  swarmManager: SwarmManager,
  agentId: string,
  repoTarget: GitRepoTarget = "workspace",
  worktreeId?: string
): Promise<GitSourceControlContext> {
  const normalizedWorktreeId = worktreeId?.trim();

  if (normalizedWorktreeId) {
    if (repoTarget === "versioning") {
      throw new Error("worktreeId is not supported for repoTarget=versioning.");
    }

    return resolveGitSourceControlContext(swarmManager, agentId, repoTarget, normalizedWorktreeId);
  }

  const baseContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
  return {
    ...baseContext,
    baseCwd: baseContext.cwd
  };
}

export async function resolveGitSourceControlContext(
  swarmManager: SwarmManager,
  agentId: string,
  repoTarget: GitRepoTarget = "workspace",
  worktreeId?: string
): Promise<GitSourceControlContext> {
  const baseContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);

  if (!worktreeId || worktreeId.trim().length === 0) {
    return {
      ...baseContext,
      baseCwd: baseContext.cwd
    };
  }

  if (baseContext.notInitialized) {
    throw new Error("Cannot resolve worktree context before the repository is initialized.");
  }

  const normalizedWorktreeId = worktreeId.trim();
  const worktreePath = await resolveWorktreeContextPath(baseContext.cwd, normalizedWorktreeId);

  return {
    ...baseContext,
    baseCwd: baseContext.cwd,
    cwd: worktreePath,
    worktreeId: normalizedWorktreeId,
    worktreePath
  };
}

export function resolveCwdFromAgent(swarmManager: SwarmManager, agentId: string): string {
  return resolveEffectiveAgentWorkspaceCwd(swarmManager, agentId);
}

export function isCortexSession(swarmManager: SwarmManager, agentId: string): boolean {
  return isCortexDescriptor(resolveSessionDescriptor(swarmManager, agentId));
}

export function resolveGitRepoContext(
  swarmManager: SwarmManager,
  agentId: string,
  repoTarget: GitRepoTarget = "workspace"
): GitRepoContext {
  if (repoTarget === "versioning") {
    if (!isCortexSession(swarmManager, agentId)) {
      throw new Error("Forbidden: versioning repo is only available to Cortex sessions.");
    }

    const dataDir = swarmManager.getConfig().paths.dataDir;
    return {
      cwd: dataDir,
      repoTarget,
      repoKind: "versioning",
      repoLabel: "Cortex Knowledge",
      notInitialized: !existsSync(join(dataDir, ".git"))
    };
  }

  return {
    cwd: resolveCwdFromAgent(swarmManager, agentId),
    repoTarget: "workspace",
    repoKind: "workspace",
    repoLabel: "Workspace"
  };
}

function requireAgentDescriptor(swarmManager: SwarmManager, agentId: string): AgentDescriptor {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  return descriptor;
}

function resolveSessionDescriptor(swarmManager: SwarmManager, agentId: string): AgentDescriptor {
  const descriptor = requireAgentDescriptor(swarmManager, agentId);

  if (descriptor.role === "worker") {
    return requireAgentDescriptor(swarmManager, descriptor.managerId);
  }

  return descriptor;
}

function isCortexDescriptor(descriptor: AgentDescriptor): boolean {
  return descriptor.profileId === "cortex" || descriptor.sessionPurpose === "cortex_review";
}
