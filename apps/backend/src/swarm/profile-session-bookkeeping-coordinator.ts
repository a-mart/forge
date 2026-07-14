import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDirectory } from "./agent-directory.js";
import type { DescriptorStoreAdapter } from "./agents/descriptor-store/live-map-adapter.js";
import { getSessionDir } from "./data-paths.js";
import { isEnoentError, isRecord } from "./swarm-manager-utils.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

export interface SessionRenameHistoryEntry {
  from: string;
  to: string;
  renamedAt: string;
}

export interface ProfileSessionBookkeepingCoordinatorOptions {
  dataDir: string;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  directory: Pick<
    AgentDirectory,
    "assertProfileNotArchived" | "materializeProfileSortOrder" | "prepareProfileReorder"
  >;
  persistence: Pick<
    DescriptorStoreAdapter,
    "patchProfile" | "saveStore" | "upsertProfileInLiveMaps"
  >;
  now(): string;
  notifySharedTargetsChanged(agentId: string): Promise<void>;
  emitAgentsSnapshot(): void;
  emitProfilesSnapshot(): void;
}

/** Owns durable profile ordering/naming and per-session rename audit history. */
export class ProfileSessionBookkeepingCoordinator {
  constructor(private readonly options: ProfileSessionBookkeepingCoordinatorOptions) {}

  async renameProfile(profileId: string, displayName: string): Promise<void> {
    const profile = this.options.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    const sharedProjectAgentIds = Array.from(this.options.descriptors.values())
      .filter(
        (descriptor) =>
          descriptor.role === "manager" &&
          descriptor.profileId === profileId &&
          descriptor.projectAgent,
      )
      .map((descriptor) => descriptor.agentId);

    this.options.directory.assertProfileNotArchived(profileId);
    const normalizedName = displayName.trim();
    if (!normalizedName) {
      throw new Error("Profile display name must be non-empty");
    }

    await this.options.persistence.patchProfile(profileId, {
      displayName: normalizedName,
      updatedAt: this.options.now(),
    });
    if (sharedProjectAgentIds.length > 0) {
      await Promise.all(
        sharedProjectAgentIds.map((agentId) =>
          this.options.notifySharedTargetsChanged(agentId),
        ),
      );
    }

    this.options.emitProfilesSnapshot();
    this.options.emitAgentsSnapshot();
  }

  materializeProfileSortOrder(): void {
    for (const assignment of this.options.directory.materializeProfileSortOrder() ?? []) {
      const profile = this.options.profiles.get(assignment.profileId);
      if (!profile) {
        continue;
      }

      profile.sortOrder = assignment.sortOrder;
      this.options.persistence.upsertProfileInLiveMaps(profile);
    }
  }

  async reorderProfiles(profileIds: readonly string[]): Promise<void> {
    for (const assignment of this.options.directory.prepareProfileReorder(profileIds)) {
      const profile = this.options.profiles.get(assignment.profileId);
      if (!profile) {
        continue;
      }

      profile.sortOrder = assignment.sortOrder;
      this.options.persistence.upsertProfileInLiveMaps(profile);
    }

    await this.options.persistence.saveStore();
    this.options.emitProfilesSnapshot();
  }

  async appendSessionRenameHistoryEntry(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    entry: SessionRenameHistoryEntry,
  ): Promise<void> {
    const sessionDir = getSessionDir(
      this.options.dataDir,
      descriptor.profileId,
      descriptor.agentId,
    );
    const historyPath = join(sessionDir, "rename-history.json");
    const entries: SessionRenameHistoryEntry[] = [];

    try {
      const existing = await readFile(historyPath, "utf8");
      const parsed = JSON.parse(existing) as unknown;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isSessionRenameHistoryEntry(item)) {
            entries.push(item);
          }
        }
      } else if (existing.trim().length > 0) {
        throw new Error(`Invalid rename history format for session ${descriptor.agentId}`);
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    entries.push(entry);

    await mkdir(sessionDir, { recursive: true });
    await writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  }
}

function isSessionRenameHistoryEntry(value: unknown): value is SessionRenameHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.renamedAt === "string"
  );
}
