import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { readPromptFile, writePromptFile } from "./asset-root-storage.js";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    await writePromptFile(promptPath, systemPrompt);
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

export async function deleteProjectAgentRecordByDirPath(
  dataDir: string,
  profileId: string,
  dirPath: string
): Promise<void> {
  const targetDir = assertProjectAgentDirPathInProfile(dataDir, profileId, dirPath, "delete");
  await rm(targetDir, { recursive: true, force: true });
}

export async function normalizeProjectAgentRecordDirectory(
  dataDir: string,
  profileId: string,
  record: ProjectAgentOnDiskRecord
): Promise<ProjectAgentOnDiskRecord> {
  const sourceDir = assertProjectAgentDirPathInProfile(dataDir, profileId, record.dirPath, "move");
  const canonicalDir = resolve(getProjectAgentDir(dataDir, profileId, record.config.handle));

  if (sourceDir === canonicalDir) {
    return record;
  }

  try {
    await access(canonicalDir);
    throw new Error(`Refusing to move project-agent directory onto existing canonical directory: ${canonicalDir}`);
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(canonicalDir), { recursive: true });
  await rename(sourceDir, canonicalDir);

  return {
    ...record,
    dirPath: canonicalDir
  };
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
    systemPrompt = await readPromptFile(promptPath);
  } catch (error) {
    console.warn(`[swarm] project-agent-storage:failed_to_read_prompt path=${promptPath} error=${errorToMessage(error)}`);
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
  const { ProjectAgentRegistry } = await import("../agents/project-agent-registry.js");
  return new ProjectAgentRegistry({ dataDir, descriptors }).reconcileProfile(profileId);
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

export function normalizeProjectAgentCapabilities(value: unknown): ProjectAgentCapability[] {
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

function assertProjectAgentDirPathInProfile(
  dataDir: string,
  profileId: string,
  dirPath: string,
  operation: string
): string {
  const projectAgentsDir = resolve(getProjectAgentsDir(dataDir, profileId));
  const targetDir = resolve(dirPath);
  const relativeTarget = relative(projectAgentsDir, targetDir);

  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Refusing to ${operation} project-agent directory outside profile scope: ${dirPath}`);
  }

  return targetDir;
}

function buildTempSiblingPath(targetPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  return join(dirname(targetPath), `${basename(targetPath)}.${suffix}`);
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
