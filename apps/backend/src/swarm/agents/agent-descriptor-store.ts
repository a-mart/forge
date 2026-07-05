import { readFile } from "node:fs/promises";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile } from "../types.js";
import { writeFileAtomic } from "../../utils/atomic-files.js";
import { decodeAgentsStoreFile, encodeAgentsStoreFile } from "./descriptor-store/descriptor-codec.js";
import {
  cloneDescriptorForPersistence,
  cloneDescriptorForPublic,
  cloneProfile
} from "./descriptor-store/descriptor-clone.js";

export interface AgentDescriptorStoreOptions {
  dataDir: string;
  storeFilePath: string;
  configuredManagerId?: string;
  logDebug?: (message: string, details?: unknown) => void;
  warn?: (message: string) => void;
}

export interface AgentDescriptorStoreLiveMaps {
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
}

export interface AgentDescriptorStoreTransactionOptions {
  saveMode?: "rollback" | "best-effort";
  onSaveError?: (error: unknown) => void;
}

export class AgentDescriptorStore {
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();

  constructor(private readonly options: AgentDescriptorStoreOptions) {}

  async load(): Promise<AgentsStoreFile> {
    try {
      const raw = await readFile(this.options.storeFilePath, "utf8");
      const decoded = decodeAgentsStoreFile(raw, {
        dataDir: this.options.dataDir,
        storeFilePath: this.options.storeFilePath,
        logDebug: this.options.logDebug,
        warn: this.options.warn
      }).store;
      this.replace(decoded);
      return this.snapshotForPersistence();
    } catch {
      this.replace({ agents: [], profiles: [] });
      return { agents: [], profiles: [] };
    }
  }

  replace(store: AgentsStoreFile): void {
    this.descriptors.clear();
    this.profiles.clear();

    for (const descriptor of store.agents) {
      this.descriptors.set(descriptor.agentId, cloneDescriptorForPersistence(descriptor));
    }

    for (const profile of store.profiles ?? []) {
      this.profiles.set(profile.profileId, cloneProfile(profile));
    }
  }

  replaceFromLiveMaps(liveMaps: AgentDescriptorStoreLiveMaps): void {
    this.replace({
      agents: Array.from(liveMaps.descriptors.values()),
      profiles: Array.from(liveMaps.profiles.values())
    });
  }

  syncToLiveMaps(liveMaps: AgentDescriptorStoreLiveMaps): void {
    const snapshot = this.snapshotForPersistence();
    replaceMapValues(liveMaps.descriptors, snapshot.agents, (descriptor) => descriptor.agentId);
    replaceMapValues(liveMaps.profiles, snapshot.profiles ?? [], (profile) => profile.profileId);
  }

  async save(): Promise<void> {
    const target = this.options.storeFilePath;
    await writeFileAtomic(target, encodeAgentsStoreFile(this.snapshotForPersistence()));
  }

  get(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    return descriptor ? cloneDescriptorForPublic(descriptor) : undefined;
  }

  getForPersistence(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    return descriptor ? cloneDescriptorForPersistence(descriptor) : undefined;
  }

  require(agentId: string): AgentDescriptor {
    const descriptor = this.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown agent descriptor: ${agentId}`);
    }
    return descriptor;
  }

  query(predicate: (descriptor: AgentDescriptor) => boolean): AgentDescriptor[] {
    return this.sortedDescriptorsForPersistence()
      .filter(predicate)
      .map(cloneDescriptorForPublic);
  }

  snapshot(): AgentsStoreFile {
    return {
      agents: this.sortedDescriptorsForPersistence().map(cloneDescriptorForPublic),
      profiles: this.sortedProfiles().map(cloneProfile)
    };
  }

  snapshotForPersistence(): AgentsStoreFile {
    return {
      agents: this.sortedDescriptorsForPersistence().map(cloneDescriptorForPersistence),
      profiles: this.sortedProfiles().map(cloneProfile)
    };
  }

  upsertDescriptor(descriptor: AgentDescriptor): void {
    this.descriptors.set(descriptor.agentId, cloneDescriptorForPersistence(descriptor));
  }

  patchDescriptor(agentId: string, patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor)): AgentDescriptor {
    const current = this.descriptors.get(agentId);
    if (!current) {
      throw new Error(`Unknown agent descriptor: ${agentId}`);
    }

    const next = typeof patch === "function"
      ? patch(cloneDescriptorForPersistence(current))
      : { ...cloneDescriptorForPersistence(current), ...patch, agentId };
    this.upsertDescriptor(next);
    return cloneDescriptorForPublic(next);
  }

  patchDescriptorInLiveMaps(
    liveMaps: AgentDescriptorStoreLiveMaps,
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor)
  ): AgentDescriptor | undefined {
    if (!liveMaps.descriptors.has(agentId)) {
      return undefined;
    }

    this.replaceFromLiveMaps(liveMaps);
    const updated = this.patchDescriptor(agentId, patch);
    const persisted = this.getForPersistence(agentId);
    if (persisted) {
      liveMaps.descriptors.set(agentId, persisted);
    }
    return updated;
  }

  deleteDescriptor(agentId: string): boolean {
    return this.descriptors.delete(agentId);
  }

  getProfile(profileId: string): ManagerProfile | undefined {
    const profile = this.profiles.get(profileId);
    return profile ? cloneProfile(profile) : undefined;
  }

  upsertProfile(profile: ManagerProfile): void {
    this.profiles.set(profile.profileId, cloneProfile(profile));
  }

  patchProfile(profileId: string, patch: Partial<ManagerProfile> | ((profile: ManagerProfile) => ManagerProfile)): ManagerProfile {
    const current = this.profiles.get(profileId);
    if (!current) {
      throw new Error(`Unknown manager profile: ${profileId}`);
    }

    const next = typeof patch === "function" ? patch(cloneProfile(current)) : { ...cloneProfile(current), ...patch, profileId };
    this.upsertProfile(next);
    return cloneProfile(next);
  }

  deleteProfile(profileId: string): boolean {
    return this.profiles.delete(profileId);
  }

  async transaction<T>(callback: (store: this) => T | Promise<T>): Promise<T> {
    const before = this.snapshotForPersistence();
    try {
      const result = await callback(this);
      await this.save();
      return result;
    } catch (error) {
      this.replace(before);
      throw error;
    }
  }

  async transactionWithLiveMaps<T>(
    liveMaps: AgentDescriptorStoreLiveMaps,
    callback: (store: this) => T | Promise<T>,
    options: AgentDescriptorStoreTransactionOptions = {}
  ): Promise<T> {
    const saveMode = options.saveMode ?? "rollback";
    this.replaceFromLiveMaps(liveMaps);
    const before = this.snapshotForPersistence();

    try {
      const result = await callback(this);
      this.syncToLiveMaps(liveMaps);
      try {
        await this.save();
      } catch (error) {
        this.notifySaveError(error, options.onSaveError);
        if (saveMode === "best-effort") {
          return result;
        }
        this.replace(before);
        this.syncToLiveMaps(liveMaps);
        throw error;
      }
      return result;
    } catch (error) {
      this.replace(before);
      this.syncToLiveMaps(liveMaps);
      throw error;
    }
  }

  async saveLiveMaps(liveMaps: AgentDescriptorStoreLiveMaps): Promise<void> {
    this.replaceFromLiveMaps(liveMaps);
    await this.save();
  }

  async saveLiveMapsBestEffort(
    liveMaps: AgentDescriptorStoreLiveMaps,
    onSaveError?: (error: unknown) => void
  ): Promise<void> {
    this.replaceFromLiveMaps(liveMaps);
    try {
      await this.save();
    } catch (error) {
      this.notifySaveError(error, onSaveError);
    }
  }

  private notifySaveError(error: unknown, onSaveError?: (error: unknown) => void): void {
    try {
      onSaveError?.(error);
    } catch (callbackError) {
      this.options.logDebug?.("agent-descriptor-store:on-save-error-callback-failed", { error: callbackError });
    }
  }

  private sortedDescriptorsForPersistence(): AgentDescriptor[] {
    const configuredManagerId = this.options.configuredManagerId;
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  private sortedProfiles(): ManagerProfile[] {
    const configuredManagerId = this.options.configuredManagerId;
    return Array.from(this.profiles.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.profileId === configuredManagerId) return -1;
        if (b.profileId === configuredManagerId) return 1;
      }

      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.profileId.localeCompare(b.profileId);
    });
  }
}

function replaceMapValues<T>(target: Map<string, T>, values: T[], keyOf: (value: T) => string): void {
  target.clear();
  for (const value of values) {
    target.set(keyOf(value), value);
  }
}
