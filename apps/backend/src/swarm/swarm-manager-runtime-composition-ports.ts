import type { AgentDescriptor, ManagerProfile } from "./types.js";
import type { SessionAttentionRuntimeHooks } from "./session/session-attention-runtime.js";

/** Explicit live-map/durable descriptor mutation boundary used by runtime composition. */
export interface RuntimeCompositionDescriptorMutations {
  upsertDescriptor(descriptor: AgentDescriptor): void;
  deleteDescriptor(agentId: string): void;
  upsertProfile(profile: ManagerProfile): void;
  deleteProfile(profileId: string): void;
  patchDescriptor(
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor),
  ): Promise<AgentDescriptor>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>,
  ): Promise<AgentDescriptor | undefined>;
  transactionPatchDescriptor(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
    options?: { saveMode?: "rollback" | "best-effort"; onSaveError?: (error: unknown) => void },
  ): Promise<AgentDescriptor | undefined>;
  patchDescriptorInLiveMaps(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
  ): AgentDescriptor | undefined;
}

/** Attention callbacks are lazy-safe because runtime composition precedes attention binding. */
export type RuntimeCompositionAttentionHooks = SessionAttentionRuntimeHooks;
