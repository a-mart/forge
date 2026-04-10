import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  PROJECT_AGENT_CAPABILITIES,
  type PersistedProjectAgentConfig,
  type ProjectAgentCapability
} from "@forge/protocol";
import {
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getProjectAgentsDir,
  sanitizePathSegment
} from "./data-paths.js";
import type { AgentDescriptor } from "../types.js";

export interface ProjectAgentOnDiskRecord {
  config: PersistedProjectAgentConfig;
  systemPrompt: string | null;
  dirPath: string;
}

interface ReconcileProjectAgentStorageResult {
  hydrated: string[];
  materialized: string[];
  orphansRemoved: string[];
}

export async function writeProjectAgentRecord(
  dataDir: string,
  profileId: string,
  config: PersistedProjectAgentConfig,
  systemPrompt: string | null
): Promise<void> {
  const dirPath = getProjectAgentDir(dataDir, profileId, config.handle);
  const promptPath = getProjectAgentPromptPath(dataDir, profileId, config.handle);
  const configPath = getProjectAgentConfigPath(dataDir, profileId, config.handle);
  const tempConfigPath = buildTempSiblingPath(configPath);

  await mkdir(dirPath, { recursive: true });

  if (systemPrompt === null) {
    await rm(promptPath, { force: true });
  } else {
    await writeFile(promptPath, systemPrompt, "utf8");
  }

  const normalizedCapabilities = normalizeProjectAgentCapabilities(config.capabilities);
  const { capabilities: _unusedCapabilities, ...baseConfig } = config;
  const persistedConfig: PersistedProjectAgentConfig = {
    ...baseConfig,
    ...(normalizedCapabilities.length > 0 ? { capabilities: normalizedCapabilities } : {})
  };

  await writeFile(tempConfigPath, `${JSON.stringify(persistedConfig, null, 2)}\n`, "utf8");
  await rename(tempConfigPath, configPath);
}

export async function renameProjectAgentRecord(
  dataDir: string,
  profileId: string,
  oldHandle: string,
  newHandle: string,
  config: PersistedProjectAgentConfig,
  systemPrompt: string | null
): Promise<void> {
  await writeProjectAgentRecord(dataDir, profileId, config, systemPrompt);

  if (oldHandle === newHandle) {
    return;
  }

  await deleteProjectAgentRecord(dataDir, profileId, oldHandle);
}

export async function deleteProjectAgentRecord(dataDir: string, profileId: string, handle: string): Promise<void> {
  const dirPath = getProjectAgentDir(dataDir, profileId, handle);
  await rm(dirPath, { recursive: true, force: true });
}

export async function readProjectAgentRecord(
  dataDir: string,
  profileId: string,
  handle: string
): Promise<ProjectAgentOnDiskRecord | null> {
  const dirPath = getProjectAgentDir(dataDir, profileId, handle);
  const configPath = getProjectAgentConfigPath(dataDir, profileId, handle);
  const promptPath = getProjectAgentPromptPath(dataDir, profileId, handle);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    console.warn(`[swarm] project-agent-storage:failed_to_read_config path=${configPath} error=${errorToMessage(error)}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    console.warn(`[swarm] project-agent-storage:invalid_config path=${configPath} reason=parse_error error=${errorToMessage(error)}`);
    return null;
  }

  const config = coercePersistedProjectAgentConfig(parsed);
  if (!config) {
    console.warn(`[swarm] project-agent-storage:invalid_config path=${configPath} reason=validation_failed`);
    return null;
  }

  let systemPrompt: string | null = null;
  try {
    systemPrompt = await readFile(promptPath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      console.warn(`[swarm] project-agent-storage:failed_to_read_prompt path=${promptPath} error=${errorToMessage(error)}`);
    }
  }

  return {
    config,
    systemPrompt,
    dirPath
  };
}

export async function scanProjectAgentRecords(
  dataDir: string,
  profileId: string
): Promise<ProjectAgentOnDiskRecord[]> {
  const projectAgentsDir = getProjectAgentsDir(dataDir, profileId);

  let entries;
  try {
    entries = await readdir(projectAgentsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }

  const records: ProjectAgentOnDiskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const record = await readProjectAgentRecord(dataDir, profileId, entry.name);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

export async function reconcileProjectAgentStorage(
  dataDir: string,
  profileId: string,
  descriptors: Map<string, AgentDescriptor>
): Promise<ReconcileProjectAgentStorageResult> {
  const result: ReconcileProjectAgentStorageResult = {
    hydrated: [],
    materialized: [],
    orphansRemoved: []
  };

  const profileDescriptors = Array.from(descriptors.values()).filter(
    (descriptor): descriptor is AgentDescriptor & { role: "manager" } =>
      descriptor.role === "manager" && descriptor.profileId === profileId
  );
  const descriptorsByAgentId = new Map(profileDescriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  const scannedRecords = await scanProjectAgentRecords(dataDir, profileId);
  const dedupedRecords = await resolveDuplicateRecords(profileId, scannedRecords);
  const survivingRecords: ProjectAgentOnDiskRecord[] = [];

  for (const record of dedupedRecords) {
    const descriptor = descriptorsByAgentId.get(record.config.agentId);
    if (!descriptor) {
      console.info(
        `[swarm] project-agent-storage:remove_orphan profile=${profileId} agentId=${record.config.agentId} handle=${record.config.handle}`
      );
      await rm(record.dirPath, { recursive: true, force: true });
      result.orphansRemoved.push(record.config.handle);
      continue;
    }

    survivingRecords.push(record);

    if (hydrateDescriptorFromRecord(descriptor, record)) {
      result.hydrated.push(descriptor.agentId);
    }
  }

  const recordsByAgentId = new Map(survivingRecords.map((record) => [record.config.agentId, record]));
  const recordsByHandle = new Map(survivingRecords.map((record) => [record.config.handle, record]));

  for (const descriptor of profileDescriptors) {
    if (!descriptor.projectAgent) {
      continue;
    }

    if (!isNonEmptyString(descriptor.projectAgent.handle) || !isNonEmptyString(descriptor.projectAgent.whenToUse)) {
      console.warn(
        `[swarm] project-agent-storage:skip_materialize_invalid_descriptor profile=${profileId} agentId=${descriptor.agentId}`
      );
      continue;
    }

    if (recordsByAgentId.has(descriptor.agentId)) {
      continue;
    }

    const handleCollision = recordsByHandle.get(descriptor.projectAgent.handle);
    if (handleCollision && handleCollision.config.agentId !== descriptor.agentId) {
      console.warn(
        `[swarm] project-agent-storage:skip_materialize_handle_collision profile=${profileId} agentId=${descriptor.agentId} handle=${descriptor.projectAgent.handle} existingAgentId=${handleCollision.config.agentId}`
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
      dataDir,
      profileId,
      config,
      descriptor.projectAgent.systemPrompt === undefined ? null : descriptor.projectAgent.systemPrompt
    );
    console.info(
      `[swarm] project-agent-storage:materialized profile=${profileId} agentId=${descriptor.agentId} handle=${config.handle}`
    );
    result.materialized.push(descriptor.agentId);
  }

  return result;
}

function coercePersistedProjectAgentConfig(value: unknown): PersistedProjectAgentConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.version !== 1) {
    return null;
  }

  if (!isNonEmptyString(value.agentId) || !isNonEmptyString(value.handle) || !isNonEmptyString(value.whenToUse)) {
    return null;
  }

  let normalizedHandle: string;
  try {
    normalizedHandle = sanitizePathSegment(value.handle);
  } catch {
    return null;
  }

  if (!isNonEmptyString(value.promotedAt) || !isNonEmptyString(value.updatedAt)) {
    return null;
  }

  if (value.creatorSessionId !== undefined && typeof value.creatorSessionId !== "string") {
    return null;
  }

  if (value.capabilities !== undefined && !Array.isArray(value.capabilities)) {
    return null;
  }

  const capabilities = normalizeProjectAgentCapabilities(value.capabilities);

  return {
    version: 1,
    agentId: value.agentId,
    handle: normalizedHandle,
    whenToUse: value.whenToUse,
    ...(typeof value.creatorSessionId === "string" ? { creatorSessionId: value.creatorSessionId } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    promotedAt: value.promotedAt,
    updatedAt: value.updatedAt
  };
}

async function resolveDuplicateRecords(
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
        `[swarm] project-agent-storage:remove_duplicate profile=${profileId} agentId=${duplicate.config.agentId} handle=${duplicate.config.handle} keptHandle=${winner.config.handle}`
      );
      await rm(duplicate.dirPath, { recursive: true, force: true });
    }
  }

  return deduped;
}

function compareRecordsByUpdatedAtDesc(left: ProjectAgentOnDiskRecord, right: ProjectAgentOnDiskRecord): number {
  const updatedAtDiff = parseTimestamp(right.config.updatedAt) - parseTimestamp(left.config.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return left.config.handle.localeCompare(right.config.handle);
}

function hydrateDescriptorFromRecord(descriptor: AgentDescriptor, record: ProjectAgentOnDiskRecord): boolean {
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

function buildTempSiblingPath(targetPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  return join(dirname(targetPath), `${basename(targetPath)}.${suffix}`);
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
