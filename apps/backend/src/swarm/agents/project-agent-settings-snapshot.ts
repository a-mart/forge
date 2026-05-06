import type { PersistedProjectAgentConfig } from "@forge/protocol";
import { listProjectAgentReferenceDocs } from "../reference-docs.js";
import { ProjectAgentRegistry } from "./project-agent-registry.js";

export interface ProjectAgentSettingsSnapshot {
  config: PersistedProjectAgentConfig;
  systemPrompt: string | null;
  references: string[];
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
    const [references, record] = await Promise.all([
      listProjectAgentReferenceDocs(this.options.dataDir, scope.profileId, scope.handle),
      this.options.registry.readRecord(scope.profileId, scope.handle)
    ]);

    if (record) {
      return {
        config: record.config,
        systemPrompt: record.systemPrompt,
        references
      };
    }

    return {
      config: this.options.registry.buildFallbackConfig(scope, this.options.now?.()),
      systemPrompt: scope.descriptor.projectAgent.systemPrompt ?? null,
      references
    };
  }
}
