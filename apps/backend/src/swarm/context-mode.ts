import {
  DEFAULT_CONTEXT_MODE,
  isCompactionProviderSupported,
  isContextMode,
  isSystemProfile,
  resolveContextMode,
  type ContextMode,
  type SessionContextModeSnapshot,
} from "@forge/protocol";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";

export const FRESH_CONTEXT_UNSUPPORTED_COLLAB =
  "Fresh windows are not supported for Collaboration sessions.";
export const FRESH_CONTEXT_UNSUPPORTED_SPECIAL_PURPOSE =
  "Fresh windows are only supported for ordinary Builder manager compaction runtimes.";
export const FRESH_CONTEXT_UNSUPPORTED_PLUGIN =
  "Fresh windows are not supported for plugin workers.";
export const FRESH_CONTEXT_UNSUPPORTED_EXTERNAL_THREAD =
  "Fresh windows are not supported for external-thread runtimes.";
export const FRESH_CONTEXT_UNSUPPORTED_CORTEX =
  "Fresh windows are not supported for Cortex sessions.";
export const FRESH_CONTEXT_UNSUPPORTED_SYSTEM_PROFILE =
  "Fresh windows are not supported for system-managed profiles.";
export const FRESH_CONTEXT_UNSUPPORTED_CURSOR_SDK =
  "Fresh windows are not supported for Cursor SDK runtimes.";
export const FRESH_CONTEXT_UNSUPPORTED_NON_PI =
  "Fresh windows are currently limited to Pi-backed Builder manager compaction runtimes.";
export const FRESH_CONTEXT_UNSUPPORTED_PROVIDER =
  "Fresh windows are only supported for existing Pi-backed compaction providers.";
export const FRESH_CONTEXT_UNSUPPORTED_WORKER =
  "Workers inherit the owning manager context mode; fresh windows apply at the manager runtime.";
export const CONTEXT_MODE_WORKER_WRITE_ERROR =
  "Context mode can only be updated on manager sessions.";

export class ContextModeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextModeValidationError";
  }
}

export function requireContextMode(value: unknown, fieldName: string): ContextMode {
  if (!isContextMode(value)) {
    throw new ContextModeValidationError(`${fieldName} must be "summary" or "fresh"`);
  }
  return value;
}

export function parseSessionContextModeWrite(value: unknown): ContextMode | null {
  if (value === null) {
    return null;
  }
  return requireContextMode(value, "mode");
}

export function resolveEffectiveContextMode(
  projectDefault: ContextMode | undefined,
  sessionOverride: ContextMode | undefined,
): ContextMode {
  return resolveContextMode(projectDefault, sessionOverride);
}

export function resolveOwningManagerId(descriptor: AgentDescriptor): string {
  return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
}

export function evaluateFreshContextSupport(options: {
  manager: Pick<
    AgentDescriptor,
    | "role"
    | "agentId"
    | "profileId"
    | "sessionSurface"
    | "sessionPurpose"
    | "internalWorkerKind"
    | "externalThread"
    | "archetypeId"
    | "model"
    | "collab"
  >;
  profile?: Pick<ManagerProfile, "profileId" | "profileType">;
  runtime?: Pick<SwarmAgentRuntime, "runtimeType">;
}): { freshSupported: boolean; unsupportedReason?: string } {
  const { manager, profile, runtime } = options;
  if (manager.role !== "manager") {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_WORKER };
  }
  if (manager.sessionSurface === "collab" || manager.collab) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_COLLAB };
  }
  if (manager.sessionPurpose !== undefined) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_SPECIAL_PURPOSE };
  }
  if (manager.internalWorkerKind === "codex_plugin") {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_PLUGIN };
  }
  if (manager.externalThread) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_EXTERNAL_THREAD };
  }
  if (
    normalizeArchetypeId(manager.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
    || manager.profileId === CORTEX_PROFILE_ID
    || manager.agentId === CORTEX_PROFILE_ID
  ) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_CORTEX };
  }
  if (profile && (isSystemProfile(profile) || profile.profileId === CORTEX_PROFILE_ID)) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_SYSTEM_PROFILE };
  }
  if (runtime?.runtimeType === "cursor-sdk" || manager.model.provider === "cursor-sdk") {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_CURSOR_SDK };
  }
  if (runtime && runtime.runtimeType !== "pi") {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_NON_PI };
  }
  if (!isCompactionProviderSupported(manager.model.provider)) {
    return { freshSupported: false, unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_PROVIDER };
  }
  return { freshSupported: true };
}

export function buildSessionContextModeSnapshot(options: {
  sessionAgentId: string;
  profile: Pick<ManagerProfile, "profileId" | "profileType" | "defaultContextMode">;
  manager: Pick<
    AgentDescriptor,
    | "agentId"
    | "profileId"
    | "contextModeOverride"
    | "role"
    | "sessionSurface"
    | "sessionPurpose"
    | "internalWorkerKind"
    | "externalThread"
    | "archetypeId"
    | "model"
    | "collab"
  >;
  runtime?: Pick<SwarmAgentRuntime, "runtimeType">;
}): SessionContextModeSnapshot {
  const projectDefault = options.profile.defaultContextMode ?? DEFAULT_CONTEXT_MODE;
  const sessionOverride = options.manager.contextModeOverride;
  const support = evaluateFreshContextSupport({
    manager: options.manager,
    profile: options.profile,
    runtime: options.runtime,
  });
  const snapshot: SessionContextModeSnapshot = {
    sessionAgentId: options.sessionAgentId,
    profileId: options.profile.profileId,
    projectDefault,
    effectiveMode: resolveEffectiveContextMode(options.profile.defaultContextMode, sessionOverride),
    freshSupported: support.freshSupported,
  };
  if (sessionOverride !== undefined) {
    snapshot.sessionOverride = sessionOverride;
  }
  if (support.unsupportedReason) {
    snapshot.unsupportedReason = support.unsupportedReason;
  }
  return snapshot;
}
