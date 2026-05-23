import { isRepoProjectAgentSource, type PersistedProjectAgentConfig, type ProjectAgentCapability } from "@forge/protocol";
import { normalizeProjectAgentCapabilities } from "../storage/project-agent-storage.js";
import type { AgentDescriptor } from "../types.js";
import { getProjectAgentPublicName, normalizeProjectAgentHandle } from "./project-agent-registry.js";
import { normalizeProjectAgentInlineText } from "./project-agents.js";

export interface ProjectAgentMutationFlags {
  directoryChanged: boolean;
  promptChanged: boolean;
  referenceChanged: boolean;
  descriptorChanged: boolean;
  recordChanged: boolean;
}

export type ProjectAgentConfigWritePlan =
  | {
      kind: "write";
      profileId: string;
      handle: string;
      config: PersistedProjectAgentConfig;
      systemPrompt: string | null;
    }
  | {
      kind: "delete";
      profileId: string;
      handle: string;
    }
  | {
      kind: "none";
    };

export interface ProjectAgentPromotionMutationPlan {
  flags: ProjectAgentMutationFlags;
  nextProjectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null;
  configPlan: ProjectAgentConfigWritePlan;
}

export interface ProjectAgentPromotionInput {
  whenToUse: string;
  systemPrompt?: string;
  handle?: string;
  capabilities?: ProjectAgentCapability[];
}

export interface BuildProjectAgentInfoInput {
  descriptor: AgentDescriptor & { role: "manager"; profileId: string };
  whenToUse: string;
  systemPrompt?: string;
  handle?: string;
  capabilities?: ProjectAgentCapability[];
}

export interface ProjectAgentRecordContext {
  profileId: string;
  promotedAt: string;
  updatedAt: string;
}

export function createEmptyProjectAgentMutationFlags(): ProjectAgentMutationFlags {
  return {
    directoryChanged: false,
    promptChanged: false,
    referenceChanged: false,
    descriptorChanged: false,
    recordChanged: false
  };
}

export function normalizeProjectAgentHandleForMutation(handle: string): string {
  return normalizeProjectAgentHandle(handle);
}

export function assertProjectAgentHandleMutationAllowed(
  previousProjectAgent: AgentDescriptor["projectAgent"] | undefined,
  nextHandle: string | undefined
): void {
  if (previousProjectAgent && nextHandle && nextHandle !== previousProjectAgent.handle) {
    throw new Error("Cannot change project agent handle after promotion. Demote and re-promote to change the handle.");
  }
}

export function normalizeProjectAgentWhenToUseForMutation(whenToUse: string): string {
  const trimmedWhenToUse = normalizeProjectAgentInlineText(whenToUse);
  if (!trimmedWhenToUse) {
    throw new Error('Project agent "When to use" must be non-empty');
  }
  if (trimmedWhenToUse.length > 280) {
    throw new Error('Project agent "When to use" must be 280 characters or fewer');
  }
  return trimmedWhenToUse;
}

export function buildProjectAgentInfoForMutation(input: BuildProjectAgentInfoInput): NonNullable<AgentDescriptor["projectAgent"]> {
  const handle = normalizeProjectAgentHandle(input.handle ?? input.descriptor.projectAgent?.handle ?? getProjectAgentPublicName(input.descriptor));
  if (!handle) {
    throw new Error(
      "Project agent handle must contain at least one letter, number, or dash. Provide an explicit handle or use a session name with at least one letter, number, or dash."
    );
  }

  const whenToUse = normalizeProjectAgentWhenToUseForMutation(input.whenToUse);
  const previous = input.descriptor.projectAgent;
  const systemPrompt = input.systemPrompt !== undefined ? input.systemPrompt.trim() : previous?.systemPrompt;
  const capabilities = normalizeProjectAgentCapabilities(input.capabilities ?? previous?.capabilities);

  return {
    handle,
    whenToUse,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(previous?.creatorSessionId !== undefined ? { creatorSessionId: previous.creatorSessionId } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(previous?.source !== undefined ? { source: previous.source } : {})
  };
}

export function buildProjectAgentPersistedConfig(
  descriptor: AgentDescriptor,
  projectAgent: NonNullable<AgentDescriptor["projectAgent"]>,
  context: ProjectAgentRecordContext
): PersistedProjectAgentConfig {
  const capabilities = normalizeProjectAgentCapabilities(projectAgent.capabilities);
  return {
    version: 1,
    agentId: descriptor.agentId,
    handle: projectAgent.handle,
    whenToUse: projectAgent.whenToUse,
    ...(projectAgent.creatorSessionId !== undefined ? { creatorSessionId: projectAgent.creatorSessionId } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    promotedAt: context.promotedAt,
    updatedAt: context.updatedAt
  };
}

export function planSetSessionProjectAgentMutation(input: {
  descriptor: AgentDescriptor & { role: "manager"; profileId: string };
  projectAgent: ProjectAgentPromotionInput | null;
  updatedAt: string;
}): ProjectAgentPromotionMutationPlan {
  const previousProjectAgent = input.descriptor.projectAgent;
  if (isRepoProjectAgentSource(previousProjectAgent?.source)) {
    throw new Error("Repository-managed project agents are read-only until repository source editing is available.");
  }
  if (!input.projectAgent) {
    return {
      flags: {
        ...createEmptyProjectAgentMutationFlags(),
        directoryChanged: Boolean(previousProjectAgent),
        descriptorChanged: Boolean(previousProjectAgent),
        recordChanged: Boolean(previousProjectAgent)
      },
      nextProjectAgent: null,
      configPlan: previousProjectAgent?.handle
        ? { kind: "delete", profileId: input.descriptor.profileId, handle: previousProjectAgent.handle }
        : { kind: "none" }
    };
  }

  const nextHandle = input.projectAgent.handle !== undefined ? normalizeProjectAgentHandle(input.projectAgent.handle) : undefined;
  assertProjectAgentHandleMutationAllowed(previousProjectAgent, nextHandle);

  const nextProjectAgent = buildProjectAgentInfoForMutation({
    descriptor: input.descriptor,
    whenToUse: input.projectAgent.whenToUse,
    systemPrompt: input.projectAgent.systemPrompt,
    handle: input.projectAgent.handle ?? previousProjectAgent?.handle,
    capabilities: input.projectAgent.capabilities ?? previousProjectAgent?.capabilities
  });
  const previousCapabilities = normalizeProjectAgentCapabilities(previousProjectAgent?.capabilities);
  const nextCapabilities = normalizeProjectAgentCapabilities(nextProjectAgent.capabilities);
  const directoryChanged =
    !previousProjectAgent ||
    previousProjectAgent.handle !== nextProjectAgent.handle ||
    previousProjectAgent.whenToUse !== nextProjectAgent.whenToUse ||
    !areStringArraysEqual(previousCapabilities, nextCapabilities);
  const promptChanged = previousProjectAgent?.systemPrompt !== nextProjectAgent.systemPrompt;
  const descriptorChanged =
    directoryChanged ||
    promptChanged ||
    previousProjectAgent?.creatorSessionId !== nextProjectAgent.creatorSessionId;

  return {
    flags: {
      directoryChanged,
      promptChanged,
      referenceChanged: false,
      descriptorChanged,
      recordChanged: descriptorChanged
    },
    nextProjectAgent,
    configPlan: {
      kind: "write",
      profileId: input.descriptor.profileId,
      handle: nextProjectAgent.handle,
      config: buildProjectAgentPersistedConfig(input.descriptor, nextProjectAgent, {
        profileId: input.descriptor.profileId,
        promotedAt: input.descriptor.createdAt,
        updatedAt: input.updatedAt
      }),
      systemPrompt: nextProjectAgent.systemPrompt ?? null
    }
  };
}

export interface ProjectAgentReferenceWriteMutationResult {
  flags: ProjectAgentMutationFlags;
  changed: boolean;
  fileName: string;
  content: string;
}

export function normalizeProjectAgentReferenceContentForMutation(content: string): string {
  const trimmed = content.trimEnd();
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

export function planProjectAgentReferenceWriteMutation(input: {
  fileName: string;
  content: string;
  existingContent: string | null;
}): ProjectAgentReferenceWriteMutationResult {
  const normalizedContent = normalizeProjectAgentReferenceContentForMutation(input.content);
  const changed = input.existingContent !== normalizedContent;
  return {
    flags: {
      ...createEmptyProjectAgentMutationFlags(),
      referenceChanged: changed
    },
    changed,
    fileName: input.fileName,
    content: input.content
  };
}

export function planProjectAgentReferenceDeleteMutation(input: {
  fileName: string;
  existingContent: string | null;
}): { flags: ProjectAgentMutationFlags; changed: boolean; fileName: string } {
  const changed = input.existingContent !== null;
  return {
    flags: {
      ...createEmptyProjectAgentMutationFlags(),
      referenceChanged: changed
    },
    changed,
    fileName: input.fileName
  };
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
