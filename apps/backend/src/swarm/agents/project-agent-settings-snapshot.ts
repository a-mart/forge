import { isRepoProjectAgentSource, type PersistedProjectAgentConfig, type ProjectAgentConfigSourceSnapshot } from "@forge/protocol";
import { listProjectAgentReferenceDocs } from "../reference-docs.js";
import { ProjectAgentRegistry } from "./project-agent-registry.js";
import {
  buildRepoProjectAgentConfigFromDefinition,
  resolveRepoProjectAgentSource
} from "./repo-project-agent-source.js";

export interface ProjectAgentSettingsSnapshot {
  config: PersistedProjectAgentConfig;
  systemPrompt: string | null;
  references: string[];
  source?: ProjectAgentConfigSourceSnapshot;
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
      const resolution = await resolveRepoProjectAgentSource(scope);
      return {
        config: resolution.definition
          ? buildRepoProjectAgentConfigFromDefinition(scope, resolution.definition)
          : this.options.registry.buildFallbackConfig(scope, this.options.now?.()),
        systemPrompt: resolution.source.status === "valid" && resolution.definition ? resolution.definition.prompt : null,
        references: resolution.source.status === "valid" && resolution.definition
          ? resolution.definition.referenceDocs.map((doc) => doc.path)
          : [],
        source: resolution.source
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
