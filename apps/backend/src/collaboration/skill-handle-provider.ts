import { SkillMetadataService } from "../swarm/skills/skill-metadata-service.js";
import type { SwarmConfig } from "../swarm/types.js";

export interface CollaborationSkillHandleSource {
  getCollaborationGlobalSkillHandles?: () => Iterable<string>;
}

export type CollaborationSkillHandleProvider = () => Iterable<string> | undefined;

export async function createCollaborationSkillHandleProvider(options: {
  config: SwarmConfig;
  source?: CollaborationSkillHandleSource;
}): Promise<CollaborationSkillHandleProvider> {
  if (options.source?.getCollaborationGlobalSkillHandles) {
    return () => options.source?.getCollaborationGlobalSkillHandles?.();
  }

  const service = new SkillMetadataService({ config: options.config });
  await service.ensureSkillMetadataLoaded();
  return () => service.getSkillMetadata().map((skill) => skill.directoryName);
}
