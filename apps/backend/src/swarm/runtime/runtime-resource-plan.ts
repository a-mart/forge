import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionFactory, ResourceDiagnostic, Skill } from "@mariozechner/pi-coding-agent";
import {
  getProfilePiExtensionsDir,
  getProfilePiPromptsDir,
  getProfilePiSkillsDir,
  getProfilePiThemesDir,
} from "../data-paths.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { PiRuntimePromptPlan } from "./runtime-prompt-plan.js";

export interface RuntimeResourcePathsPlan {
  runtimeAgentDir: string;
  profileId: string;
  profilePiExtensionsDir: string;
  profilePiSkillsDir: string;
  profilePiPromptsDir: string;
  profilePiThemesDir: string;
}

export interface RuntimeMemoryResourcesPlan {
  memoryContextFile: { path: string; content: string };
  additionalSkillPaths: string[];
  skillMetadata: SkillMetadata[];
}

export interface PiResourceLoaderOptionsPlan {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths: string[];
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
  additionalThemePaths: string[];
  agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  extensionFactories: ExtensionFactory[];
  skillsOverride?: (current: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  systemPrompt?: string;
  appendSystemPromptOverride: (base: string[]) => string[];
}

export interface PlanPiResourceLoaderOptionsOptions {
  descriptor: AgentDescriptor;
  pathsPlan: RuntimeResourcePathsPlan;
  memoryResources: RuntimeMemoryResourcesPlan;
  promptPlan: PiRuntimePromptPlan;
  swarmContextFiles: Array<{ path: string; content: string }>;
  extensionFactories: ExtensionFactory[];
  isCollaborationRuntime: boolean;
  mergeRuntimeContextFiles: (
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ) => Array<{ path: string; content: string }>;
}

export type RuntimeEnvPlan = Record<string, string> & {
  SWARM_DATA_DIR: string;
  SWARM_MEMORY_FILE: string;
};

export function planRuntimeResourcePaths(options: {
  config: SwarmConfig;
  descriptor: AgentDescriptor;
}): RuntimeResourcePathsPlan {
  const { config, descriptor } = options;
  const runtimeAgentDir = descriptor.role === "manager" ? config.paths.managerAgentDir : config.paths.agentDir;
  const profileId = descriptor.profileId ?? descriptor.agentId;

  return {
    runtimeAgentDir,
    profileId,
    profilePiExtensionsDir: getProfilePiExtensionsDir(config.paths.dataDir, profileId),
    profilePiSkillsDir: getProfilePiSkillsDir(config.paths.dataDir, profileId),
    profilePiPromptsDir: getProfilePiPromptsDir(config.paths.dataDir, profileId),
    profilePiThemesDir: getProfilePiThemesDir(config.paths.dataDir, profileId),
  };
}

export function planPiResourceLoaderOptions(options: PlanPiResourceLoaderOptionsOptions): PiResourceLoaderOptionsPlan {
  const {
    descriptor,
    pathsPlan,
    memoryResources,
    promptPlan,
    swarmContextFiles,
    extensionFactories,
    isCollaborationRuntime,
    mergeRuntimeContextFiles,
  } = options;

  const additionalSkillPaths = [
    ...memoryResources.additionalSkillPaths,
    ...(!isCollaborationRuntime && dirHasFiles(pathsPlan.profilePiSkillsDir) ? [pathsPlan.profilePiSkillsDir] : []),
  ];
  const skillsOverride = isCollaborationRuntime
    ? buildCollaborationSkillsOverride(memoryResources.skillMetadata)
    : undefined;

  return {
    cwd: descriptor.cwd,
    agentDir: pathsPlan.runtimeAgentDir,
    additionalExtensionPaths: dirHasFiles(pathsPlan.profilePiExtensionsDir) ? [pathsPlan.profilePiExtensionsDir] : [],
    additionalSkillPaths,
    additionalPromptTemplatePaths: dirHasFiles(pathsPlan.profilePiPromptsDir) ? [pathsPlan.profilePiPromptsDir] : [],
    additionalThemePaths: dirHasFiles(pathsPlan.profilePiThemesDir) ? [pathsPlan.profilePiThemesDir] : [],
    agentsFilesOverride: (base) => ({
      agentsFiles: [
        ...mergeRuntimeContextFiles(base.agentsFiles, {
          memoryContextFile: memoryResources.memoryContextFile,
          swarmContextFiles,
        }),
        ...(promptPlan.startupRecoveryContextFile ? [promptPlan.startupRecoveryContextFile] : []),
      ],
    }),
    extensionFactories,
    ...(skillsOverride ? { skillsOverride } : {}),
    ...(promptPlan.systemPrompt !== undefined ? { systemPrompt: promptPlan.systemPrompt } : {}),
    appendSystemPromptOverride: promptPlan.appendSystemPromptOverride,
  };
}

export function planRuntimeEnv(options: {
  dataDir: string;
  memoryContextFile: { path: string; content: string };
}): RuntimeEnvPlan {
  return {
    SWARM_DATA_DIR: options.dataDir,
    SWARM_MEMORY_FILE: options.memoryContextFile.path,
  };
}

export function buildCollaborationSkillsOverride(skillMetadata: SkillMetadata[]) {
  const allowedByHandle = new Map<string, SkillMetadata[]>();
  for (const skill of skillMetadata) {
    const handle = normalizeSkillHandle(skill.directoryName);
    allowedByHandle.set(handle, [...(allowedByHandle.get(handle) ?? []), skill]);
  }

  return (current: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => ({
    skills: current.skills.filter((skill) => {
      const skillHandle = getPiSkillDirectoryHandle(skill);
      if (!skillHandle) {
        return false;
      }

      const allowedSkills = allowedByHandle.get(skillHandle) ?? [];
      return allowedSkills.some(
        (allowedSkill) =>
          skillPathMatches(skill.filePath, allowedSkill.path) || skillPathMatches(skill.baseDir, allowedSkill.rootPath)
      );
    }),
    diagnostics: current.diagnostics,
  });
}

function getPiSkillDirectoryHandle(skill: Skill): string | undefined {
  const candidates = [skill.baseDir, skill.filePath ? dirname(skill.filePath) : undefined];

  for (const candidate of candidates) {
    const handle = normalizeSkillHandle(basename(candidate ?? ""));
    if (handle.length > 0) {
      return handle;
    }
  }

  return undefined;
}

function normalizeSkillHandle(value: string): string {
  return value.trim().toLowerCase();
}

function skillPathMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }

  return resolve(actual) === resolve(expected);
}

function dirHasFiles(dirPath: string): boolean {
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}
