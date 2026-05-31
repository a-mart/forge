import { basename, resolve } from "node:path";
import {
  PROJECT_AGENT_CAPABILITIES,
  isRepoProjectAgentSource,
  type PersistedProjectAgentConfig,
  type ProjectAgentCapability
} from "@forge/protocol";
import {
  deleteProjectAgentRecordByDirPath,
  normalizeProjectAgentRecordDirectory,
  readProjectAgentRecord,
  scanProjectAgentRecords,
  writeProjectAgentRecord,
  type ProjectAgentOnDiskRecord
} from "../storage/project-agent-storage.js";
import { getProjectAgentDir, sanitizePathSegment } from "../storage/data-paths.js";
import type { AgentDescriptor } from "../types.js";

export interface ProjectAgentDirectoryEntry {
  agentId: string;
  displayName: string;
  handle: string;
  whenToUse: string;
  capabilities?: ProjectAgentCapability[];
  origin?: "local" | "external";
  sourceProjectName?: string;
}

export interface ListProjectAgentsOptions {
  excludeAgentId?: string;
}

export type ProjectAgentDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
  projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
};

export interface ProjectAgentRegistryOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
}

export interface ProjectAgentReferenceScope {
  descriptor: ProjectAgentDescriptor;
  profileId: string;
  handle: string;
}

export interface ProjectAgentMirrorReconcileResult {
  hydrated: string[];
  materialized: string[];
  orphansRemoved: string[];
}

export function getProjectAgentPublicName(descriptor: AgentDescriptor): string {
  const sessionLabel = descriptor.sessionLabel?.trim();
  if (sessionLabel) {
    return sessionLabel;
  }

  const displayName = descriptor.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  return descriptor.agentId;
}

export function normalizeProjectAgentHandle(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const RESERVED_PROJECT_AGENT_HANDLE = "codex";

export function isReservedProjectAgentHandle(handle: string): boolean {
  return normalizeProjectAgentHandle(handle) === RESERVED_PROJECT_AGENT_HANDLE;
}

export function getReservedProjectAgentHandleError(handle: string): string {
  return `Project agent handle "${handle}" is reserved for Codex @mention routing. Choose a different handle and try again.`;
}

export function getProjectAgentHandleCollisionError(handle: string): string {
  return `Project agent handle "${handle}" is already in use in this profile. Choose a different handle and try again.`;
}

export function listProjectAgents(
  descriptors: Iterable<AgentDescriptor>,
  profileId: string,
  options?: ListProjectAgentsOptions
): ProjectAgentDescriptor[] {
  return ProjectAgentRegistry.fromIterable({ dataDir: "", descriptors }).list(profileId, options);
}

export function findProjectAgentByHandle(
  descriptors: Iterable<AgentDescriptor>,
  profileId: string,
  handle: string
): ProjectAgentDescriptor | undefined {
  return ProjectAgentRegistry.fromIterable({ dataDir: "", descriptors }).findByHandle(profileId, handle);
}

export class ProjectAgentRegistry {
  static fromIterable(options: { dataDir: string; descriptors: Iterable<AgentDescriptor> }): ProjectAgentRegistry {
    return new ProjectAgentRegistry({
      dataDir: options.dataDir,
      descriptors: buildDescriptorMap(options.descriptors)
    });
  }

  constructor(private readonly options: ProjectAgentRegistryOptions) {}

  list(profileId: string, options?: ListProjectAgentsOptions): ProjectAgentDescriptor[] {
    return Array.from(this.options.descriptors.values())
      .filter((descriptor): descriptor is ProjectAgentDescriptor =>
        this.isProjectAgentDescriptor(descriptor, profileId, options)
      )
      .sort((left, right) => {
        const nameCompare = getProjectAgentPublicName(left).localeCompare(getProjectAgentPublicName(right));
        if (nameCompare !== 0) {
          return nameCompare;
        }

        return left.agentId.localeCompare(right.agentId);
      });
  }

  listDirectoryEntries(profileId: string, options?: ListProjectAgentsOptions): ProjectAgentDirectoryEntry[] {
    return this.list(profileId, options).map((descriptor) => ({
      agentId: descriptor.agentId,
      displayName: getProjectAgentPublicName(descriptor),
      handle: normalizeProjectAgentHandle(descriptor.projectAgent.handle),
      whenToUse: descriptor.projectAgent.whenToUse,
      ...(descriptor.projectAgent.capabilities !== undefined ? { capabilities: descriptor.projectAgent.capabilities } : {})
    }));
  }

  findByHandle(profileId: string, handle: string): ProjectAgentDescriptor | undefined {
    const normalizedHandle = normalizeProjectAgentHandle(handle);
    if (!normalizedHandle) {
      return undefined;
    }

    return this.list(profileId).find(
      (descriptor) => normalizeProjectAgentHandle(descriptor.projectAgent.handle) === normalizedHandle
    );
  }

  getHandleCollisionError(handle: string): string {
    return getProjectAgentHandleCollisionError(handle);
  }

  async readRecord(profileId: string, handle: string): Promise<ProjectAgentOnDiskRecord | null> {
    return readProjectAgentRecord(this.options.dataDir, profileId, handle);
  }

  async scanRecords(profileId: string): Promise<ProjectAgentOnDiskRecord[]> {
    return scanProjectAgentRecords(this.options.dataDir, profileId);
  }

  async hasOnDiskCollision(profileId: string, handle: string, ownerAgentId?: string): Promise<boolean> {
    const record = await this.readRecord(profileId, handle);
    return Boolean(record && record.config.agentId !== ownerAgentId);
  }

  assertReferenceScope(agentId: string): ProjectAgentReferenceScope {
    const descriptor = this.options.descriptors.get(agentId);
    const handle = descriptor?.projectAgent?.handle?.trim();
    if (!descriptor?.projectAgent || !handle || descriptor.role !== "manager") {
      throw new Error(`Agent ${agentId} is not a project agent`);
    }

    let safeHandle: string;
    try {
      safeHandle = sanitizePathSegment(handle);
    } catch (error) {
      throw new Error(
        `Project agent ${agentId} has an invalid handle: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (descriptor.projectAgent.whenToUse.trim().length === 0) {
      throw new Error(`Agent ${agentId} is not a project agent`);
    }

    return {
      descriptor: descriptor as ProjectAgentDescriptor,
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle: safeHandle
    };
  }

  async assertOwnedReferenceScope(agentId: string): Promise<ProjectAgentReferenceScope> {
    const scope = this.assertReferenceScope(agentId);
    if (isRepoProjectAgentDescriptor(scope.descriptor)) {
      throw new Error(`Project agent ${agentId} is repository-managed; local reference documents are read-only`);
    }

    const record = await this.readRecord(scope.profileId, scope.handle);
    if (record && record.config.agentId !== agentId) {
      throw new Error(
        `Project agent ${agentId} handle ${scope.handle} is owned on disk by ${record.config.agentId}; refusing to access another agent's data`
      );
    }

    return scope;
  }

  buildFallbackConfig(scope: ProjectAgentReferenceScope, now = new Date().toISOString()): PersistedProjectAgentConfig {
    return {
      version: 1,
      agentId: scope.descriptor.agentId,
      handle: scope.handle,
      whenToUse: scope.descriptor.projectAgent.whenToUse,
      ...(scope.descriptor.projectAgent.creatorSessionId !== undefined
        ? { creatorSessionId: scope.descriptor.projectAgent.creatorSessionId }
        : {}),
      ...(scope.descriptor.projectAgent.capabilities !== undefined
        ? { capabilities: normalizeProjectAgentCapabilities(scope.descriptor.projectAgent.capabilities) }
        : {}),
      promotedAt: scope.descriptor.createdAt ?? now,
      updatedAt: now
    };
  }

  async reconcileProfile(profileId: string): Promise<ProjectAgentMirrorReconcileResult> {
    const result: ProjectAgentMirrorReconcileResult = {
      hydrated: [],
      materialized: [],
      orphansRemoved: []
    };

    const profileDescriptors = Array.from(this.options.descriptors.values()).filter(
      (descriptor): descriptor is AgentDescriptor & { role: "manager" } =>
        descriptor.role === "manager" && descriptor.profileId === profileId
    );
    const descriptorsByAgentId = new Map(profileDescriptors.map((descriptor) => [descriptor.agentId, descriptor]));

    const scannedRecords = await this.scanRecords(profileId);
    const collisionFilteredRecords = await this.filterCollidingDriftRecords(profileId, scannedRecords);
    const dedupedRecords = await this.resolveDuplicateRecords(profileId, collisionFilteredRecords);
    const survivingRecords: ProjectAgentOnDiskRecord[] = [];

    for (const record of dedupedRecords) {
      const descriptor = descriptorsByAgentId.get(record.config.agentId);
      if (descriptor?.projectAgent && isRepoProjectAgentDescriptor(descriptor)) {
        console.info(
          `[swarm] project-agent-registry:skip_hydrate_repo_source profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} dirPath=${record.dirPath}`
        );
        continue;
      }

      if (!descriptor) {
        console.info(
          `[swarm] project-agent-registry:remove_orphan profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} dirPath=${record.dirPath}`
        );
        await deleteProjectAgentRecordByDirPath(this.options.dataDir, profileId, record.dirPath);
        result.orphansRemoved.push(record.config.handle);
        continue;
      }

      const normalizedRecord = await this.normalizeRecordDirectory(profileId, record);
      if (!normalizedRecord) {
        continue;
      }

      survivingRecords.push(normalizedRecord);

      if (hydrateDescriptorFromRecord(descriptor, normalizedRecord)) {
        result.hydrated.push(descriptor.agentId);
      }
    }

    const recordsByAgentId = new Map(survivingRecords.map((record) => [record.config.agentId, record]));
    const recordsByHandle = new Map(survivingRecords.map((record) => [record.config.handle, record]));

    for (const descriptor of profileDescriptors) {
      if (!descriptor.projectAgent) {
        continue;
      }

      if (isRepoProjectAgentDescriptor(descriptor)) {
        console.info(
          `[swarm] project-agent-registry:skip_materialize_repo_source profile=${profileId} agentId=${descriptor.agentId} handle=${descriptor.projectAgent.handle}`
        );
        continue;
      }

      if (!isNonEmptyString(descriptor.projectAgent.handle) || !isNonEmptyString(descriptor.projectAgent.whenToUse)) {
        console.warn(
          `[swarm] project-agent-registry:skip_materialize_invalid_descriptor profile=${profileId} agentId=${descriptor.agentId}`
        );
        continue;
      }

      if (recordsByAgentId.has(descriptor.agentId)) {
        continue;
      }

      const handleCollision = recordsByHandle.get(descriptor.projectAgent.handle);
      if (handleCollision && handleCollision.config.agentId !== descriptor.agentId) {
        console.warn(
          `[swarm] project-agent-registry:skip_materialize_handle_collision profile=${profileId} agentId=${descriptor.agentId} handle=${descriptor.projectAgent.handle} existingAgentId=${handleCollision.config.agentId}`
        );
        continue;
      }

      const config: PersistedProjectAgentConfig = {
        version: 1,
        agentId: descriptor.agentId,
        handle: descriptor.projectAgent.handle,
        whenToUse: descriptor.projectAgent.whenToUse,
        ...(descriptor.projectAgent.creatorSessionId ? { creatorSessionId: descriptor.projectAgent.creatorSessionId } : {}),
        ...(normalizeProjectAgentCapabilities(descriptor.projectAgent.capabilities).length > 0
          ? { capabilities: normalizeProjectAgentCapabilities(descriptor.projectAgent.capabilities) }
          : {}),
        promotedAt: descriptor.createdAt,
        updatedAt: new Date().toISOString()
      };

      await writeProjectAgentRecord(
        this.options.dataDir,
        profileId,
        config,
        descriptor.projectAgent.systemPrompt === undefined ? null : descriptor.projectAgent.systemPrompt
      );
      console.info(
        `[swarm] project-agent-registry:materialized profile=${profileId} agentId=${descriptor.agentId} handle=${config.handle}`
      );
      result.materialized.push(descriptor.agentId);
    }

    return result;
  }

  private async normalizeRecordDirectory(
    profileId: string,
    record: ProjectAgentOnDiskRecord
  ): Promise<ProjectAgentOnDiskRecord | null> {
    const sourceDir = resolve(record.dirPath);
    const canonicalDir = resolve(getProjectAgentDir(this.options.dataDir, profileId, record.config.handle));
    if (sourceDir !== canonicalDir) {
      const canonicalRecord = await this.readRecord(profileId, record.config.handle);
      if (canonicalRecord && canonicalRecord.config.agentId !== record.config.agentId) {
        console.warn(
          `[swarm] project-agent-registry:remove_colliding_drift profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} dirPath=${record.dirPath} canonicalAgentId=${canonicalRecord.config.agentId}`
        );
        await deleteProjectAgentRecordByDirPath(this.options.dataDir, profileId, record.dirPath);
        return null;
      }
    }

    try {
      const normalizedRecord = await normalizeProjectAgentRecordDirectory(this.options.dataDir, profileId, record);
      if (normalizedRecord.dirPath !== record.dirPath) {
        console.info(
          `[swarm] project-agent-registry:normalize_dir profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} oldDirPath=${record.dirPath} newDirPath=${normalizedRecord.dirPath}`
        );
      }
      return normalizedRecord;
    } catch (error) {
      console.warn(
        `[swarm] project-agent-registry:normalize_dir_failed profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} dirPath=${record.dirPath} error=${error instanceof Error ? error.message : String(error)}`
      );
      return record;
    }
  }

  private async filterCollidingDriftRecords(
    profileId: string,
    records: ProjectAgentOnDiskRecord[]
  ): Promise<ProjectAgentOnDiskRecord[]> {
    const filteredRecords: ProjectAgentOnDiskRecord[] = [];
    for (const record of records) {
      const sourceDir = resolve(record.dirPath);
      const canonicalDir = resolve(getProjectAgentDir(this.options.dataDir, profileId, record.config.handle));
      if (sourceDir !== canonicalDir) {
        const canonicalRecord = await this.readRecord(profileId, record.config.handle);
        if (canonicalRecord && canonicalRecord.config.agentId !== record.config.agentId) {
          this.repairDescriptorHandleFromCollidingDrift(profileId, record, canonicalRecord.config.agentId);
          console.warn(
            `[swarm] project-agent-registry:remove_colliding_drift profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle} dirPath=${record.dirPath} canonicalAgentId=${canonicalRecord.config.agentId}`
          );
          await deleteProjectAgentRecordByDirPath(this.options.dataDir, profileId, record.dirPath);
          continue;
        }
      }

      filteredRecords.push(record);
    }

    return filteredRecords;
  }

  private repairDescriptorHandleFromCollidingDrift(
    profileId: string,
    record: ProjectAgentOnDiskRecord,
    canonicalAgentId: string
  ): void {
    const descriptor = this.options.descriptors.get(record.config.agentId);
    if (descriptor?.role !== "manager" || descriptor.profileId !== profileId || !descriptor.projectAgent) {
      return;
    }

    if (descriptor.projectAgent.handle !== record.config.handle) {
      return;
    }

    const recoveredHandle = basename(record.dirPath);
    let normalizedRecoveredHandle: string;
    try {
      normalizedRecoveredHandle = sanitizePathSegment(recoveredHandle);
    } catch {
      return;
    }

    if (!isNonEmptyString(normalizedRecoveredHandle) || normalizedRecoveredHandle === record.config.handle) {
      return;
    }

    descriptor.projectAgent = {
      ...descriptor.projectAgent,
      handle: normalizedRecoveredHandle
    };
    console.warn(
      `[swarm] project-agent-registry:repair_descriptor_handle_from_colliding_drift profile=${profileId} agentId=${descriptor.agentId} oldHandle=${record.config.handle} recoveredHandle=${normalizedRecoveredHandle} canonicalAgentId=${canonicalAgentId}`
    );
  }

  private async resolveDuplicateRecords(
    profileId: string,
    records: ProjectAgentOnDiskRecord[]
  ): Promise<ProjectAgentOnDiskRecord[]> {
    const grouped = new Map<string, ProjectAgentOnDiskRecord[]>();
    for (const record of records) {
      const existing = grouped.get(record.config.agentId);
      if (existing) {
        existing.push(record);
      } else {
        grouped.set(record.config.agentId, [record]);
      }
    }

    const deduped: ProjectAgentOnDiskRecord[] = [];
    for (const group of grouped.values()) {
      if (group.length === 1) {
        deduped.push(group[0]!);
        continue;
      }

      const sorted = [...group].sort(compareRecordsByUpdatedAtDesc);
      const winner = sorted[0]!;
      deduped.push(winner);

      for (const duplicate of sorted.slice(1)) {
        console.info(
          `[swarm] project-agent-registry:remove_duplicate profile=${profileId} agentId=${duplicate.config.agentId} handle=${duplicate.config.handle} keptHandle=${winner.config.handle} dirPath=${duplicate.dirPath}`
        );
        await deleteProjectAgentRecordByDirPath(this.options.dataDir, profileId, duplicate.dirPath);
      }
    }

    return deduped;
  }

  private isProjectAgentDescriptor(
    descriptor: AgentDescriptor,
    profileId: string,
    options?: ListProjectAgentsOptions
  ): descriptor is ProjectAgentDescriptor {
    return (
      descriptor.role === "manager" &&
      descriptor.profileId === profileId &&
      descriptor.agentId !== options?.excludeAgentId &&
      !descriptor.archivedAt &&
      typeof descriptor.projectAgent?.handle === "string" &&
      descriptor.projectAgent.handle.trim().length > 0 &&
      typeof descriptor.projectAgent?.whenToUse === "string" &&
      descriptor.projectAgent.whenToUse.trim().length > 0
    );
  }
}

function buildDescriptorMap(descriptors: Iterable<AgentDescriptor>): Map<string, AgentDescriptor> {
  return new Map(Array.from(descriptors, (descriptor) => [descriptor.agentId, descriptor]));
}

function compareRecordsByUpdatedAtDesc(left: ProjectAgentOnDiskRecord, right: ProjectAgentOnDiskRecord): number {
  const updatedAtDiff = parseTimestamp(right.config.updatedAt) - parseTimestamp(left.config.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return left.config.handle.localeCompare(right.config.handle);
}

function hydrateDescriptorFromRecord(descriptor: AgentDescriptor, record: ProjectAgentOnDiskRecord): boolean {
  if (isRepoProjectAgentDescriptor(descriptor)) {
    return false;
  }

  const previous = descriptor.projectAgent;
  const nextHandle = previous?.handle === record.config.handle ? previous.handle : record.config.handle;
  const nextProjectAgent: NonNullable<AgentDescriptor["projectAgent"]> = {
    handle: nextHandle,
    whenToUse: record.config.whenToUse,
    ...(record.systemPrompt !== null ? { systemPrompt: record.systemPrompt } : {}),
    ...(record.config.creatorSessionId !== undefined ? { creatorSessionId: record.config.creatorSessionId } : {}),
    ...(record.config.capabilities !== undefined ? { capabilities: record.config.capabilities } : {})
  };

  const changed =
    previous?.handle !== nextProjectAgent.handle ||
    previous?.whenToUse !== nextProjectAgent.whenToUse ||
    previous?.systemPrompt !== nextProjectAgent.systemPrompt ||
    previous?.creatorSessionId !== nextProjectAgent.creatorSessionId ||
    !areCapabilitiesEqual(previous?.capabilities, nextProjectAgent.capabilities);

  descriptor.projectAgent = nextProjectAgent;
  return changed;
}

function isRepoProjectAgentDescriptor(
  descriptor: AgentDescriptor
): descriptor is AgentDescriptor & { projectAgent: NonNullable<AgentDescriptor["projectAgent"]> } {
  return isRepoProjectAgentSource(descriptor.projectAgent?.source);
}

function normalizeProjectAgentCapabilities(value: unknown): ProjectAgentCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const validCapabilities = new Set(PROJECT_AGENT_CAPABILITIES);
  return Array.from(
    new Set(
      value.filter(
        (capability): capability is ProjectAgentCapability =>
          typeof capability === "string" && validCapabilities.has(capability as ProjectAgentCapability)
      )
    )
  ).sort((left, right) => PROJECT_AGENT_CAPABILITIES.indexOf(left) - PROJECT_AGENT_CAPABILITIES.indexOf(right));
}

function areCapabilitiesEqual(
  left: ProjectAgentCapability[] | undefined,
  right: ProjectAgentCapability[] | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((capability, index) => capability === right[index]);
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
