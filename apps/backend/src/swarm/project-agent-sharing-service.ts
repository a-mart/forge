import { randomUUID } from "node:crypto";
import { isSystemProfile, type ManagerProfile, type ProjectAgentExternalDirectoryEntry, type ProjectAgentShareGrantInfo, type ProjectAgentSharingSnapshot } from "@forge/protocol";
import { COLLABORATION_PROFILE_ID } from "../collaboration/constants.js";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/atomic-files.js";
import { slugifySessionName } from "./swarm-manager-utils.js";
import { getProjectAgentSharingStorePath } from "./storage/data-paths.js";
import type { AgentDescriptor } from "./types.js";

const CORTEX_PROFILE_ID = "cortex";
const STORE_VERSION = 1 as const;

const METADATA_MAX = {
  displayName: 80,
  sourceProjectName: 80,
  alias: 96,
  whenToUse: 280,
} as const;

const SHARE_NAMESPACE_MAX_LENGTH = 32;

export interface ProjectAgentShareGrant {
  grantId: string;
  sourceProfileId: string;
  sourceAgentId: string;
  sourceHandle: string;
  targetProfileId: string;
  targetNamespace: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgentShareContact {
  grantId: string;
  targetProfileId: string;
  targetSessionAgentId: string;
  firstContactAt: string;
  lastContactAt: string;
}

interface ProjectAgentSharingStoreV1 {
  version: typeof STORE_VERSION;
  grants: ProjectAgentShareGrant[];
  contacts: ProjectAgentShareContact[];
}

export interface ProjectAgentSharingServiceDependencies {
  dataDir: string;
  now: () => string;
  getProfiles: () => ManagerProfile[];
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  getDescriptors: () => Iterable<AgentDescriptor>;
  logDebug?: (message: string, details?: Record<string, unknown>) => void;
}

export interface ReplaceSharingTargetsResult {
  snapshot: ProjectAgentSharingSnapshot;
  addedTargetProfileIds: string[];
  removedTargetProfileIds: string[];
}

export function sanitizeProjectAgentPromptMetadata(
  value: string,
  options: { maxLength: number },
): string {
  let sanitized = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/`/g, "'")
    .replace(/[[\]()<>]/g, "");

  if (sanitized.length > options.maxLength) {
    sanitized = sanitized.slice(0, options.maxLength);
  }

  return sanitized;
}

export function slugifyShareNamespace(displayName: string): string {
  const slug = slugifySessionName(displayName);
  if (!slug) {
    return "";
  }
  return slug.slice(0, SHARE_NAMESPACE_MAX_LENGTH).replace(/-+$/g, "");
}

export function deriveProjectAgentShareNamespace(options: {
  sourceProfileDisplayName: string;
  sourceProfileId: string;
  sourceHandle: string;
  existingExternalAliases: readonly string[];
}): string {
  const base =
    slugifyShareNamespace(options.sourceProfileDisplayName) ||
    slugifyShareNamespace(options.sourceProfileId) ||
    "project";

  const candidates = [
    base.slice(0, SHARE_NAMESPACE_MAX_LENGTH),
    `${base.slice(0, Math.max(1, SHARE_NAMESPACE_MAX_LENGTH - 7))}-${options.sourceProfileId.slice(-6).replace(/[^a-z0-9]/g, "") || "p"}`.slice(
      0,
      SHARE_NAMESPACE_MAX_LENGTH,
    ),
  ];

  for (const namespace of candidates) {
    const externalHandle = `${namespace}/${options.sourceHandle}`;
    if (!options.existingExternalAliases.includes(externalHandle)) {
      return namespace;
    }
  }

  throw new Error(
    `Unable to derive a unique share alias for project agent @${options.sourceHandle}`,
  );
}

function emptyStore(): ProjectAgentSharingStoreV1 {
  return { version: STORE_VERSION, grants: [], contacts: [] };
}

function isLiveProjectAgentDescriptor(descriptor: AgentDescriptor | undefined): descriptor is AgentDescriptor & {
  projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
} {
  return (
    descriptor !== undefined &&
    descriptor.role === "manager" &&
    descriptor.projectAgent !== undefined &&
    !descriptor.archivedAt &&
    typeof descriptor.projectAgent.handle === "string" &&
    descriptor.projectAgent.handle.length > 0
  );
}

function isEligibleShareTargetProfile(
  profile: ManagerProfile,
  sourceProfileId: string,
): boolean {
  if (profile.profileId === sourceProfileId) {
    return false;
  }
  if (isSystemProfile(profile)) {
    return false;
  }
  if (profile.profileId === CORTEX_PROFILE_ID || profile.profileId === COLLABORATION_PROFILE_ID) {
    return false;
  }
  if (profile.archivedAt) {
    return false;
  }
  return true;
}

function isProfileArchived(profile: ManagerProfile | undefined): boolean {
  return Boolean(profile?.archivedAt);
}

function isSourceArchived(
  descriptor: AgentDescriptor | undefined,
  profile: ManagerProfile | undefined,
): boolean {
  return Boolean(descriptor?.archivedAt || isProfileArchived(profile));
}

export class ProjectAgentSharingService {
  private store: ProjectAgentSharingStoreV1 | null = null;

  constructor(private readonly deps: ProjectAgentSharingServiceDependencies) {}

  async ensureLoaded(): Promise<void> {
    if (this.store !== null) {
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    const filePath = getProjectAgentSharingStorePath(this.deps.dataDir);
    const parsed = await readJsonFileIfExists<unknown>(filePath);
    if (parsed === undefined) {
      this.store = emptyStore();
      return;
    }

    try {
      this.store = sanitizeStore(parsed);
    } catch (error) {
      this.deps.logDebug?.("project-agent-sharing:corrupt-store", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.store = emptyStore();
    }
  }

  async save(): Promise<void> {
    await this.ensureLoaded();
    const filePath = getProjectAgentSharingStorePath(this.deps.dataDir);
    await writeJsonFileAtomic(filePath, this.store);
  }

  async reconcile(): Promise<boolean> {
    await this.ensureLoaded();
    const profiles = new Map(this.deps.getProfiles().map((profile) => [profile.profileId, profile]));
    const descriptors = new Map<string, AgentDescriptor>();
    for (const descriptor of this.deps.getDescriptors()) {
      descriptors.set(descriptor.agentId, descriptor);
    }

    const nextGrants: ProjectAgentShareGrant[] = [];
    let changed = false;

    for (const grant of this.store!.grants) {
      const sourceProfile = profiles.get(grant.sourceProfileId);
      const targetProfile = profiles.get(grant.targetProfileId);
      const sourceDescriptor = descriptors.get(grant.sourceAgentId);

      if (!sourceProfile || !targetProfile || !sourceDescriptor) {
        changed = true;
        continue;
      }

      if (!isLiveProjectAgentDescriptor(sourceDescriptor)) {
        changed = true;
        continue;
      }

      if (sourceDescriptor.projectAgent.handle !== grant.sourceHandle) {
        changed = true;
        continue;
      }

      nextGrants.push(grant);
    }

    const grantIds = new Set(nextGrants.map((grant) => grant.grantId));
    const nextContacts = this.store!.contacts.filter((contact) => {
      if (!grantIds.has(contact.grantId)) {
        changed = true;
        return false;
      }
      if (!descriptors.has(contact.targetSessionAgentId)) {
        changed = true;
        return false;
      }
      return true;
    });

    if (changed) {
      this.store = { version: STORE_VERSION, grants: nextGrants, contacts: nextContacts };
      await this.save();
    }

    return changed;
  }

  async getSharingSnapshot(sourceAgentId: string): Promise<ProjectAgentSharingSnapshot> {
    await this.ensureLoaded();
    const sourceDescriptor = this.deps.getDescriptor(sourceAgentId);
    this.assertMutableSourceProjectAgent(sourceDescriptor);

    const sourceProfileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const profiles = new Map(this.deps.getProfiles().map((profile) => [profile.profileId, profile]));
    const activeGrantTargetIds = new Set(
      this.store!.grants
        .filter((grant) => grant.sourceAgentId === sourceAgentId)
        .map((grant) => grant.targetProfileId),
    );

    const grants = this.store!.grants
      .filter((grant) => grant.sourceAgentId === sourceAgentId)
      .map((grant) => this.toGrantInfo(grant, profiles));

    const eligibleTargets = this.deps
      .getProfiles()
      .filter((profile) => isEligibleShareTargetProfile(profile, sourceProfileId))
      .map((profile) => ({
        profileId: profile.profileId,
        displayName: sanitizeProjectAgentPromptMetadata(profile.displayName, {
          maxLength: METADATA_MAX.displayName,
        }),
        alreadyShared: activeGrantTargetIds.has(profile.profileId),
        namespacePreview: deriveProjectAgentShareNamespace({
          sourceProfileDisplayName: profiles.get(sourceProfileId)?.displayName ?? sourceProfileId,
          sourceProfileId,
          sourceHandle: sourceDescriptor.projectAgent!.handle,
          existingExternalAliases: this.listExternalAliasesForTarget(profile.profileId, sourceAgentId),
        }),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    return { agentId: sourceAgentId, grants, eligibleTargets };
  }

  async replaceSharingTargets(
    sourceAgentId: string,
    targetProfileIds: readonly string[],
  ): Promise<ReplaceSharingTargetsResult> {
    await this.ensureLoaded();

    const sourceDescriptor = this.deps.getDescriptor(sourceAgentId);
    this.assertMutableSourceProjectAgent(sourceDescriptor);

    const sourceProfileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const sourceHandle = sourceDescriptor.projectAgent!.handle;
    const profiles = new Map(this.deps.getProfiles().map((profile) => [profile.profileId, profile]));
    const normalizedTargetIds = [...new Set(targetProfileIds.map((profileId) => profileId.trim()).filter(Boolean))];

    for (const targetProfileId of normalizedTargetIds) {
      const targetProfile = profiles.get(targetProfileId);
      if (!targetProfile || !isEligibleShareTargetProfile(targetProfile, sourceProfileId)) {
        throw new Error(`Target profile is not eligible for sharing: ${targetProfileId}`);
      }
    }

    const existingForSource = this.store!.grants.filter((grant) => grant.sourceAgentId === sourceAgentId);
    const existingTargetIds = new Set(existingForSource.map((grant) => grant.targetProfileId));
    const desiredTargetIds = new Set(normalizedTargetIds);

    const addedTargetProfileIds = normalizedTargetIds.filter((profileId) => !existingTargetIds.has(profileId));
    const removedTargetProfileIds = [...existingTargetIds].filter((profileId) => !desiredTargetIds.has(profileId));

    const retainedGrants = this.store!.grants.filter(
      (grant) => grant.sourceAgentId !== sourceAgentId || desiredTargetIds.has(grant.targetProfileId),
    );

    const now = this.deps.now();
    const newGrants: ProjectAgentShareGrant[] = [];

    for (const targetProfileId of addedTargetProfileIds) {
      const targetNamespace = deriveProjectAgentShareNamespace({
        sourceProfileDisplayName: profiles.get(sourceProfileId)?.displayName ?? sourceProfileId,
        sourceProfileId,
        sourceHandle,
        existingExternalAliases: this.listExternalAliasesForTarget(targetProfileId),
      });

      newGrants.push({
        grantId: randomUUID(),
        sourceProfileId,
        sourceAgentId,
        sourceHandle,
        targetProfileId,
        targetNamespace,
        createdAt: now,
        updatedAt: now,
      });
    }

    const removedGrantIds = new Set(
      existingForSource
        .filter((grant) => removedTargetProfileIds.includes(grant.targetProfileId))
        .map((grant) => grant.grantId),
    );

    this.store = {
      version: STORE_VERSION,
      grants: [...retainedGrants, ...newGrants],
      contacts: this.store!.contacts.filter((contact) => !removedGrantIds.has(contact.grantId)),
    };

    await this.save();

    const snapshot = await this.getSharingSnapshot(sourceAgentId);
    return { snapshot, addedTargetProfileIds, removedTargetProfileIds };
  }

  getExternalDirectoryEntries(targetProfileId: string): ProjectAgentExternalDirectoryEntry[] {
    if (this.store === null) {
      return [];
    }

    const profiles = new Map(this.deps.getProfiles().map((profile) => [profile.profileId, profile]));
    const entries: ProjectAgentExternalDirectoryEntry[] = [];

    for (const grant of this.store.grants) {
      if (grant.targetProfileId !== targetProfileId) {
        continue;
      }

      const sourceDescriptor = this.deps.getDescriptor(grant.sourceAgentId);
      const sourceProfile = profiles.get(grant.sourceProfileId);
      const targetProfile = profiles.get(grant.targetProfileId);

      if (
        !isLiveProjectAgentDescriptor(sourceDescriptor) ||
        isSourceArchived(sourceDescriptor, sourceProfile) ||
        isProfileArchived(targetProfile)
      ) {
        continue;
      }

      const externalHandle = `${grant.targetNamespace}/${grant.sourceHandle}`;
      entries.push({
        agentId: grant.sourceAgentId,
        handle: sanitizeProjectAgentPromptMetadata(externalHandle, { maxLength: METADATA_MAX.alias }),
        displayName: sanitizeProjectAgentPromptMetadata(
          sourceDescriptor.sessionLabel ?? sourceDescriptor.displayName ?? grant.sourceHandle,
          { maxLength: METADATA_MAX.displayName },
        ),
        whenToUse: sanitizeProjectAgentPromptMetadata(sourceDescriptor.projectAgent.whenToUse, {
          maxLength: METADATA_MAX.whenToUse,
        }),
        sourceProjectName: sanitizeProjectAgentPromptMetadata(sourceProfile?.displayName ?? grant.sourceProfileId, {
          maxLength: METADATA_MAX.sourceProjectName,
        }),
        origin: "external",
      });
    }

    return entries.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  listGrantsForSourceAgent(sourceAgentId: string): ProjectAgentShareGrant[] {
    if (this.store === null) {
      return [];
    }
    return this.store.grants.filter((grant) => grant.sourceAgentId === sourceAgentId);
  }

  private assertMutableSourceProjectAgent(descriptor: AgentDescriptor | undefined): asserts descriptor is AgentDescriptor & {
    projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
  } {
    if (!isLiveProjectAgentDescriptor(descriptor)) {
      throw new Error("Source session is not an active project agent");
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.deps.getProfiles().find((candidate) => candidate.profileId === profileId);
    if (!profile || isSystemProfile(profile)) {
      throw new Error("Project agent sharing is not available for system profiles");
    }
    if (profileId === CORTEX_PROFILE_ID || profileId === COLLABORATION_PROFILE_ID) {
      throw new Error("Project agent sharing is not available for this profile");
    }
    if (descriptor.sessionSurface === "collab") {
      throw new Error("Project agent sharing is not available for collaboration sessions");
    }
    if (isProfileArchived(profile)) {
      throw new Error("Archived projects cannot be used until restored.");
    }
  }

  private listExternalAliasesForTarget(targetProfileId: string, excludeSourceAgentId?: string): string[] {
    if (this.store === null) {
      return [];
    }

    return this.store.grants
      .filter(
        (grant) =>
          grant.targetProfileId === targetProfileId &&
          (excludeSourceAgentId === undefined || grant.sourceAgentId !== excludeSourceAgentId),
      )
      .map((grant) => `${grant.targetNamespace}/${grant.sourceHandle}`);
  }

  private toGrantInfo(
    grant: ProjectAgentShareGrant,
    profiles: Map<string, ManagerProfile>,
  ): ProjectAgentShareGrantInfo {
    const sourceProfile = profiles.get(grant.sourceProfileId);
    const targetProfile = profiles.get(grant.targetProfileId);
    const sourceDescriptor = this.deps.getDescriptor(grant.sourceAgentId);
    const externalHandle = `${grant.targetNamespace}/${grant.sourceHandle}`;

    let blockedReason: ProjectAgentShareGrantInfo["blockedReason"];
    if (isProfileArchived(targetProfile)) {
      blockedReason = "target_archived";
    } else if (isSourceArchived(sourceDescriptor, sourceProfile)) {
      blockedReason = "source_archived";
    }

    return {
      grantId: grant.grantId,
      sourceProfileId: grant.sourceProfileId,
      sourceAgentId: grant.sourceAgentId,
      sourceHandle: grant.sourceHandle,
      sourceProjectName: sanitizeProjectAgentPromptMetadata(sourceProfile?.displayName ?? grant.sourceProfileId, {
        maxLength: METADATA_MAX.sourceProjectName,
      }),
      targetProfileId: grant.targetProfileId,
      targetProjectName: sanitizeProjectAgentPromptMetadata(targetProfile?.displayName ?? grant.targetProfileId, {
        maxLength: METADATA_MAX.displayName,
      }),
      targetNamespace: grant.targetNamespace,
      externalHandle: sanitizeProjectAgentPromptMetadata(externalHandle, { maxLength: METADATA_MAX.alias }),
      ...(blockedReason ? { blockedReason } : {}),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    };
  }
}

function sanitizeStore(parsed: unknown): ProjectAgentSharingStoreV1 {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid project agent sharing store");
  }

  const version = (parsed as { version?: unknown }).version;
  if (version !== STORE_VERSION) {
    throw new Error(`Unsupported project agent sharing store version: ${String(version)}`);
  }

  const grantsRaw = (parsed as { grants?: unknown }).grants;
  const contactsRaw = (parsed as { contacts?: unknown }).contacts;
  if (!Array.isArray(grantsRaw) || !Array.isArray(contactsRaw)) {
    throw new Error("Invalid project agent sharing store shape");
  }

  const grants: ProjectAgentShareGrant[] = [];
  for (const entry of grantsRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const grant = entry as Partial<ProjectAgentShareGrant>;
    if (
      typeof grant.grantId !== "string" ||
      typeof grant.sourceProfileId !== "string" ||
      typeof grant.sourceAgentId !== "string" ||
      typeof grant.sourceHandle !== "string" ||
      typeof grant.targetProfileId !== "string" ||
      typeof grant.targetNamespace !== "string" ||
      typeof grant.createdAt !== "string" ||
      typeof grant.updatedAt !== "string"
    ) {
      continue;
    }
    grants.push({
      grantId: grant.grantId,
      sourceProfileId: grant.sourceProfileId,
      sourceAgentId: grant.sourceAgentId,
      sourceHandle: grant.sourceHandle,
      targetProfileId: grant.targetProfileId,
      targetNamespace: grant.targetNamespace,
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    });
  }

  const grantIds = new Set(grants.map((grant) => grant.grantId));
  const contacts: ProjectAgentShareContact[] = [];
  for (const entry of contactsRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const contact = entry as Partial<ProjectAgentShareContact>;
    if (
      typeof contact.grantId !== "string" ||
      typeof contact.targetProfileId !== "string" ||
      typeof contact.targetSessionAgentId !== "string" ||
      typeof contact.firstContactAt !== "string" ||
      typeof contact.lastContactAt !== "string" ||
      !grantIds.has(contact.grantId)
    ) {
      continue;
    }
    contacts.push({
      grantId: contact.grantId,
      targetProfileId: contact.targetProfileId,
      targetSessionAgentId: contact.targetSessionAgentId,
      firstContactAt: contact.firstContactAt,
      lastContactAt: contact.lastContactAt,
    });
  }

  return { version: STORE_VERSION, grants, contacts };
}
