import { isRepoProjectAgentSource, type PersistedProjectAgentConfig, type ProjectAgentSourceProblem, type ProjectAgentSourceStatus } from "@forge/protocol";
import { listProjectAgentReferenceDocs } from "../reference-docs.js";
import { ProjectAgentRegistry } from "./project-agent-registry.js";

export interface ProjectAgentSettingsSnapshot {
  config: PersistedProjectAgentConfig;
  systemPrompt: string | null;
  references: string[];
  source?: {
    type: "repo";
    status: ProjectAgentSourceStatus;
    problems: ProjectAgentSourceProblem[];
    workspaceKey: string;
    forgeDirRealpath: string;
    definitionId: string;
    activatedAt: string;
  };
}

export interface ProjectAgentSettingsSnapshotReaderOptions {
  dataDir: string;
  registry: ProjectAgentRegistry;
  now?: () => string;
}

export class ProjectAgentSettingsSnapshotReader {
  constructor(private readonly options: ProjectAgentSettingsSnapshotReaderOptions) {}

  async read(agentId: string): Promise<ProjectAgentSettingsSnapshot> {
    const scope = this.options.registry.assertReferenceScope(agentId);
    if (isRepoProjectAgentSource(scope.descriptor.projectAgent.source)) {
      return {
        config: this.options.registry.buildFallbackConfig(scope, this.options.now?.()),
        systemPrompt: null,
        references: [],
        source: {
          type: "repo",
          status: "unavailable",
          problems: [
            {
              code: "repo_project_agent_resolver_pending",
              message: "Repository project-agent source resolution is not available yet."
            }
          ],
          workspaceKey: scope.descriptor.projectAgent.source.workspaceKey,
          forgeDirRealpath: scope.descriptor.projectAgent.source.forgeDirRealpath,
          definitionId: scope.descriptor.projectAgent.source.definitionId,
          activatedAt: scope.descriptor.projectAgent.source.activatedAt
        }
      };
    }

    const record = await this.options.registry.readRecord(scope.profileId, scope.handle);

    if (record?.config.agentId === agentId) {
      const references = await listProjectAgentReferenceDocs(this.options.dataDir, scope.profileId, scope.handle);
      return {
        config: record.config,
        systemPrompt: record.systemPrompt,
        references
      };
    }

    return {
      config: this.options.registry.buildFallbackConfig(scope, this.options.now?.()),
      systemPrompt: scope.descriptor.projectAgent.systemPrompt ?? null,
      references: []
    };
  }
}
