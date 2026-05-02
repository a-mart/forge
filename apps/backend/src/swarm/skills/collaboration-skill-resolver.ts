import {
  COLLABORATION_ALWAYS_ON_SKILL_HANDLES,
  findMissingCollaborationSkillHandles,
  normalizeCollaborationOptionalSkillHandles,
  normalizeCollaborationSkillHandle,
  parseCollaborationSkillHandlesJson,
} from "../../collaboration/skill-selection.js";
import type { SkillMetadata, SkillMetadataService } from "./skill-metadata-service.js";

export interface CollaborationResolvedSkillRoster {
  mode: "all" | "custom";
  skills: SkillMetadata[];
  savedSelectedOptionalHandles: string[];
  resolvedOptionalHandles: string[];
  alwaysOnHandles: string[];
  missingHandles?: string[];
}

export async function resolveCollaborationSkillRoster(options: {
  selectionJson: string | null | undefined;
  skillMetadataService: Pick<SkillMetadataService, "ensureSkillMetadataLoaded" | "getSkillMetadata">;
}): Promise<CollaborationResolvedSkillRoster> {
  await options.skillMetadataService.ensureSkillMetadataLoaded();

  const allSkills = options.skillMetadataService.getSkillMetadata();
  const alwaysOnHandleSet = new Set(COLLABORATION_ALWAYS_ON_SKILL_HANDLES.map(normalizeCollaborationSkillHandle));
  const alwaysOnSkills = allSkills.filter((skill) => alwaysOnHandleSet.has(skillHandle(skill)));
  const optionalSkills = allSkills.filter((skill) => !alwaysOnHandleSet.has(skillHandle(skill)));
  const optionalSkillByHandle = new Map(optionalSkills.map((skill) => [skillHandle(skill), skill] as const));
  const parsedSavedHandles = parseCollaborationSkillHandlesJson(options.selectionJson);

  if (parsedSavedHandles === null) {
    return {
      mode: "all",
      skills: [...alwaysOnSkills, ...optionalSkills],
      savedSelectedOptionalHandles: [],
      resolvedOptionalHandles: optionalSkills.map(skillHandle),
      alwaysOnHandles: [...COLLABORATION_ALWAYS_ON_SKILL_HANDLES],
    };
  }

  const savedHandles = normalizeCollaborationOptionalSkillHandles(parsedSavedHandles);
  const resolvedOptionalSkills = savedHandles
    .map((handle) => optionalSkillByHandle.get(normalizeCollaborationSkillHandle(handle)))
    .filter((skill): skill is SkillMetadata => Boolean(skill));
  const resolvedOptionalHandles = resolvedOptionalSkills.map(skillHandle);
  const missingHandles = findMissingCollaborationSkillHandles(savedHandles, optionalSkillByHandle.keys());

  return {
    mode: "custom",
    skills: [...alwaysOnSkills, ...resolvedOptionalSkills],
    savedSelectedOptionalHandles: savedHandles,
    resolvedOptionalHandles,
    alwaysOnHandles: [...COLLABORATION_ALWAYS_ON_SKILL_HANDLES],
    ...(missingHandles ? { missingHandles } : {}),
  };
}

function skillHandle(skill: SkillMetadata): string {
  return normalizeCollaborationSkillHandle(skill.directoryName);
}
