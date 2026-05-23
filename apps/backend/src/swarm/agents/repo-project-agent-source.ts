import { join } from "node:path";
import {
  type PersistedProjectAgentConfig,
  type ProjectAgentConfigSourceSnapshot,
  type ProjectAgentSourceProblem,
  type RepoProjectAgentSourceIdentity
} from "@forge/protocol";
import {
  scanRepoProjectAgentDefinitions,
  type ParsedRepoProjectAgentDefinition
} from "../repo-project-agent-definitions.js";
import { ProjectResourceSettingsStore } from "../project-resource-settings.js";
import { ProjectWorkspaceResolver } from "../project-workspace-resolver.js";
import type { ProjectAgentReferenceScope } from "./project-agent-registry.js";

export interface RepoProjectAgentSourceResolution {
  definition?: ParsedRepoProjectAgentDefinition;
  source: ProjectAgentConfigSourceSnapshot;
}

export async function resolveRepoProjectAgentSource(
  scope: ProjectAgentReferenceScope,
  options?: { dataDir?: string }
): Promise<RepoProjectAgentSourceResolution> {
  const source = scope.descriptor.projectAgent.source;
  if (!source || source.type !== "repo") {
    throw new Error(`Project agent ${scope.descriptor.agentId} is not repository-managed`);
  }

  const currentWorkspace = options?.dataDir
    ? await resolveCurrentWorkspaceSource(scope, options.dataDir, source)
    : undefined;
  if (currentWorkspace) {
    return { source: currentWorkspace };
  }

  const rootDir = join(source.forgeDirRealpath, "project-agents");
  const inventory = await scanRepoProjectAgentDefinitions(rootDir);
  const item = inventory.items.find((candidate) => candidate.definitionId === source.definitionId);
  const definition = inventory.definitions.find((candidate) => candidate.definitionId === source.definitionId);
  const problems: ProjectAgentSourceProblem[] = [];

  if (!inventory.exists) {
    problems.push({
      code: "repo_project_agents_missing",
      message: `Repository project-agent definitions directory is missing: ${rootDir}`,
      path: "project-agents"
    });
    return { source: buildSourceSnapshot(source, "missing", problems) };
  }

  if (inventory.problems?.length) {
    return { source: buildSourceSnapshot(source, "unavailable", inventory.problems) };
  }

  if (!item) {
    problems.push({
      code: "repo_project_agent_definition_missing",
      message: `Repository project-agent definition not found: ${source.definitionId}`,
      path: source.definitionId
    });
    return { source: buildSourceSnapshot(source, "missing", problems) };
  }

  if (!definition || item.status !== "valid") {
    return { source: buildSourceSnapshot(source, item.status === "conflict" ? "conflict" : "invalid", item.problems) };
  }

  const duplicateHandleDefinitions = inventory.definitions.filter(
    (candidate) => candidate.config.handle === definition.config.handle
  );
  if (duplicateHandleDefinitions.length > 1) {
    problems.push({
      code: "repo_project_agent_handle_conflict",
      message: `Repository project-agent handle "${definition.config.handle}" is used by multiple definitions: ${duplicateHandleDefinitions.map((candidate) => candidate.definitionId).join(", ")}.`,
      path: source.definitionId
    });
  }

  if (definition.config.handle !== scope.handle) {
    problems.push({
      code: "repo_project_agent_handle_mismatch",
      message: `Repository project-agent definition handle "${definition.config.handle}" does not match the activated handle "${scope.handle}".`,
      path: join(source.definitionId, "config.json")
    });
  }

  if (problems.length > 0) {
    return { definition, source: buildSourceSnapshot(source, "conflict", problems) };
  }

  return { definition, source: buildSourceSnapshot(source, "valid", []) };
}

export function buildRepoProjectAgentConfigFromDefinition(
  scope: ProjectAgentReferenceScope,
  definition: ParsedRepoProjectAgentDefinition
): PersistedProjectAgentConfig {
  return {
    version: 1,
    agentId: scope.descriptor.agentId,
    handle: definition.config.handle,
    whenToUse: definition.config.whenToUse,
    ...(scope.descriptor.projectAgent.creatorSessionId !== undefined
      ? { creatorSessionId: scope.descriptor.projectAgent.creatorSessionId }
      : {}),
    ...(definition.config.capabilities !== undefined ? { capabilities: definition.config.capabilities } : {}),
    promotedAt: scope.descriptor.createdAt,
    updatedAt: scope.descriptor.projectAgent.source?.type === "repo"
      ? scope.descriptor.projectAgent.source.activatedAt
      : scope.descriptor.updatedAt
  };
}

export function assertRepoProjectAgentSourceAvailable(resolution: RepoProjectAgentSourceResolution): ParsedRepoProjectAgentDefinition {
  if (resolution.source.status !== "valid" || !resolution.definition) {
    const details = resolution.source.problems
      .map((problem) => `${problem.code}: ${problem.message}`)
      .join("; ");
    throw new Error(
      `Repository project-agent source ${resolution.source.definitionId} is ${resolution.source.status}${details ? `: ${details}` : "."}`
    );
  }

  return resolution.definition;
}

async function resolveCurrentWorkspaceSource(
  scope: ProjectAgentReferenceScope,
  dataDir: string,
  source: RepoProjectAgentSourceIdentity
): Promise<ProjectAgentConfigSourceSnapshot | undefined> {
  const resolver = new ProjectWorkspaceResolver({
    dataDir,
    settingsStore: new ProjectResourceSettingsStore(dataDir)
  });
  const resolution = await resolver.resolve({
    profileId: scope.profileId,
    sessionAgentId: scope.descriptor.agentId,
    cwd: scope.descriptor.cwd
  });

  const problems: ProjectAgentSourceProblem[] = [];
  if (resolution.warning) {
    problems.push({
      code: "repo_project_agent_workspace_unavailable",
      message: resolution.warning
    });
  }
  if (resolution.workspaceKey !== source.workspaceKey) {
    problems.push({
      code: "repo_project_agent_workspace_key_mismatch",
      message: `Current workspace ${resolution.workspaceKey} does not match activated workspace ${source.workspaceKey}.`
    });
  }
  if (resolution.effectiveForgeDirRealpath !== source.forgeDirRealpath) {
    problems.push({
      code: "repo_project_agent_forge_dir_mismatch",
      message: `Current .forge directory ${resolution.effectiveForgeDirRealpath ?? "<none>"} does not match activated .forge directory ${source.forgeDirRealpath}.`,
      path: "project-agents"
    });
  }

  return problems.length > 0 ? buildSourceSnapshot(source, "wrong_workspace", problems) : undefined;
}

function buildSourceSnapshot(
  source: RepoProjectAgentSourceIdentity,
  status: ProjectAgentConfigSourceSnapshot["status"],
  problems: ProjectAgentSourceProblem[]
): ProjectAgentConfigSourceSnapshot {
  return {
    type: "repo",
    status,
    problems,
    workspaceKey: source.workspaceKey,
    forgeDirRealpath: source.forgeDirRealpath,
    definitionId: source.definitionId,
    activatedAt: source.activatedAt
  };
}
