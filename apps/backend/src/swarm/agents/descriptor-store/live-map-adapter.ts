import { AgentDescriptorStore } from "../agent-descriptor-store.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile } from "../../types.js";

export interface DescriptorStoreAdapter {
  loadStore(): Promise<AgentsStoreFile>;
  saveStore(): Promise<void>;
  transactionDescriptors<T>(
    callback: (store: AgentDescriptorStore) => T | Promise<T>,
    options?: {
      saveMode?: "rollback" | "best-effort";
      onSaveError?: (error: unknown) => void;
    },
  ): Promise<T>;
  persistBestEffort(): Promise<void>;
  upsertDescriptor(descriptor: AgentDescriptor): Promise<void>;
  upsertDescriptorInLiveMaps(descriptor: AgentDescriptor): void;
  patchDescriptor(
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor),
  ): Promise<AgentDescriptor>;
  patchDescriptorInLiveMaps(
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor),
  ): AgentDescriptor | undefined;
  deleteDescriptor(agentId: string): Promise<boolean>;
  deleteDescriptorInLiveMaps(agentId: string): boolean;
  upsertProfile(profile: ManagerProfile): Promise<void>;
  upsertProfileInLiveMaps(profile: ManagerProfile): void;
  patchProfile(
    profileId: string,
    patch: Partial<ManagerProfile> | ((profile: ManagerProfile) => ManagerProfile),
  ): Promise<ManagerProfile>;
  deleteProfile(profileId: string): Promise<boolean>;
  deleteProfileInLiveMaps(profileId: string): boolean;
}

export interface CreateDescriptorStoreAdapterOptions {
  store: AgentDescriptorStore;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  logDebug(message: string, details?: unknown): void;
}

/**
 * Binds the durable descriptor store to the manager's live descriptor/profile maps.
 *
 * Transactional methods deliberately retain AgentDescriptorStore's rollback and
 * best-effort save policies. Live-map-only methods remain non-persisting seams for
 * callers that batch their own save boundary.
 */
export function createDescriptorStoreAdapter(
  options: CreateDescriptorStoreAdapterOptions,
): DescriptorStoreAdapter {
  const liveMaps = () => ({
    descriptors: options.descriptors,
    profiles: options.profiles,
  });
  const transactionDescriptors: DescriptorStoreAdapter["transactionDescriptors"] =
    (callback, transactionOptions) =>
      options.store.transactionWithLiveMaps(liveMaps(), callback, transactionOptions);

  return {
    loadStore: () => options.store.load(),
    saveStore: () => options.store.saveLiveMaps(liveMaps()),
    transactionDescriptors,
    persistBestEffort: () =>
      options.store.saveLiveMapsBestEffort(liveMaps(), (error) => {
        options.logDebug("descriptor-store:best-effort-save-failed", { error });
      }),
    upsertDescriptor: async (descriptor) => {
      await transactionDescriptors((store) => {
        store.upsertDescriptor(descriptor);
      });
    },
    upsertDescriptorInLiveMaps: (descriptor) => {
      options.descriptors.set(descriptor.agentId, descriptor);
    },
    patchDescriptor: (agentId, patch) =>
      transactionDescriptors((store) => store.patchDescriptor(agentId, patch)),
    patchDescriptorInLiveMaps: (agentId, patch) =>
      options.store.patchDescriptorInLiveMaps(liveMaps(), agentId, patch),
    deleteDescriptor: (agentId) =>
      transactionDescriptors((store) => store.deleteDescriptor(agentId)),
    deleteDescriptorInLiveMaps: (agentId) => options.descriptors.delete(agentId),
    upsertProfile: async (profile) => {
      await transactionDescriptors((store) => {
        store.upsertProfile(profile);
      });
    },
    upsertProfileInLiveMaps: (profile) => {
      options.profiles.set(profile.profileId, cloneManagerProfileForLiveMap(profile));
    },
    patchProfile: (profileId, patch) =>
      transactionDescriptors((store) => store.patchProfile(profileId, patch)),
    deleteProfile: (profileId) =>
      transactionDescriptors((store) => store.deleteProfile(profileId)),
    deleteProfileInLiveMaps: (profileId) => options.profiles.delete(profileId),
  };
}

function cloneManagerProfileForLiveMap(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: { ...profile.defaultModel },
  };
}
