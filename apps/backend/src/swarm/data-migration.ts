import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getLegacyAgentMemoryPath,
  getLegacyAuthFilePath,
  getLegacySecretsFilePath,
  getLegacySessionFilePath,
  getProfileDir,
  getProfileIntegrationsDir,
  getProfileMemoryPath,
  getProfileScheduleFilePath,
  getSessionFilePath,
  getSessionMemoryPath,
  getSessionsDir,
  getSharedDir,
  getWorkerSessionFilePath
} from "./data-paths.js";
import { rebuildSessionMeta } from "./session-manifest.js";
import { renameWithRetry } from "./retry-rename.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

const MIGRATION_SENTINEL_FILE = ".migration-v1-done";
const DEFAULT_FALLBACK_PROFILE_ID = "default";
const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_SHARED_INTEGRATIONS_DIR_NAME = "shared";
const LEGACY_MANAGER_INTEGRATIONS_DIR_NAME = "managers";
const LEGACY_SCHEDULES_DIR_NAME = "schedules";
const LEGACY_SESSIONS_DIR_NAME = "sessions";
const LEGACY_MEMORY_DIR_NAME = "memory";
const LEGACY_AUTH_DIR_NAME = "auth";
const LEGACY_SECRETS_FILE_NAME = "secrets.json";
const SESSION_AGENT_ID_PATTERN = /^(.*?)--s\d+.*$/;

const DEFAULT_FILE_OPS: DataMigrationFileOps = {
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  copyFile: (sourcePath, destinationPath, mode) => fs.copyFile(sourcePath, destinationPath, mode)
};

interface DataMigrationConfig {
  dataDir: string;
  agentsStoreFile: string;
}

interface DataMigrationLogger {
  debug?: (message: string, details?: unknown) => void;
  info?: (message: string, details?: unknown) => void;
  warn?: (message: string, details?: unknown) => void;
}

interface DataMigrationResult {
  migrated: boolean;
  updatedAgents: AgentDescriptor[];
}

interface DataMigrationFileOps {
  link: (existingPath: string, newPath: string) => Promise<void>;
  copyFile: (sourcePath: string, destinationPath: string, mode?: number) => Promise<void>;
}

interface DataMigrationOptions {
  fileOps?: DataMigrationFileOps;
}

interface ParsedSchedulePayload {
  payload: Record<string, unknown>;
  schedules: unknown[];
}

export async function migrateDataDirectory(
  config: DataMigrationConfig,
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
  logger: DataMigrationLogger = {},
  options: DataMigrationOptions = {}
): Promise<DataMigrationResult> {
  const fileOps = options.fileOps ?? DEFAULT_FILE_OPS;
  const sentinelPath = join(config.dataDir, MIGRATION_SENTINEL_FILE);

  if (await pathExists(sentinelPath)) {
    log(logger, "debug", "migration:skip_sentinel_exists", { sentinelPath });
    return {
      migrated: false,
      updatedAgents: agents.map((descriptor) => ({ ...descriptor, model: { ...descriptor.model } }))
    };
  }

  log(
    logger,
    "warn",
    `[migration] Starting data directory migration. Ensure you have a backup of ${config.dataDir} before proceeding.`
  );

  const managerDescriptors = agents.filter(isManagerDescriptor);
  const workerDescriptors = agents.filter((descriptor): descriptor is AgentDescriptor & { role: "worker" } => {
    return descriptor.role === "worker";
  });

  const { managerProfileBySessionId, profileIds } = buildManagerProfileLookup(managerDescriptors, profiles);

  for (const workerDescriptor of workerDescriptors) {
    const profileId = resolveWorkerProfileId(workerDescriptor, managerProfileBySessionId, profileIds);
    profileIds.add(profileId);
  }

  for (const profileId of profileIds) {
    await ensureProfileDirectories(config.dataDir, profileId);
  }

  await migrateManagerMemoryFiles(config.dataDir, managerDescriptors, managerProfileBySessionId, logger);
  await migrateManagerSessionFiles(config.dataDir, managerDescriptors, managerProfileBySessionId, logger, fileOps);
  await migrateWorkerSessionFiles(
    config.dataDir,
    workerDescriptors,
    managerProfileBySessionId,
    profileIds,
    logger,
    fileOps
  );

  await migrateSchedules(config.dataDir, profileIds, managerProfileBySessionId, logger);
  await migrateAuthAndSecrets(config.dataDir, logger);
  await migrateIntegrationConfigs(config.dataDir, profileIds, logger);

  const updatedAgents = rewriteAgentSessionPaths(
    config.dataDir,
    agents,
    managerProfileBySessionId,
    profileIds,
    logger
  );

  await writeJsonAtomic(config.agentsStoreFile, {
    agents: updatedAgents,
    profiles
  });

  await rebuildSessionMeta({
    dataDir: config.dataDir,
    agentsStoreFile: config.agentsStoreFile,
    descriptors: updatedAgents
  });

  await cleanupLegacyFlatPaths(config.dataDir, logger);

  await writeTextAtomic(sentinelPath, `${new Date().toISOString()}\n`);

  log(logger, "info", "migration:complete", {
    sentinelPath,
    migratedManagers: managerDescriptors.length,
    migratedWorkers: workerDescriptors.length,
    profiles: Array.from(profileIds)
  });

  return {
    migrated: true,
    updatedAgents
  };
}

async function ensureProfileDirectories(dataDir: string, profileId: string): Promise<void> {
  const profileDir = getProfileDir(dataDir, profileId);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(getSessionsDir(dataDir, profileId), { recursive: true });
  await fs.mkdir(dirname(getProfileScheduleFilePath(dataDir, profileId)), { recursive: true });
  await fs.mkdir(getProfileIntegrationsDir(dataDir, profileId), { recursive: true });
}

function buildManagerProfileLookup(
  managerDescriptors: Array<AgentDescriptor & { role: "manager" }>,
  profiles: ManagerProfile[]
): {
  managerProfileBySessionId: Map<string, string>;
  profileIds: Set<string>;
} {
  const managerProfileBySessionId = new Map<string, string>();
  const profileIds = new Set<string>();

  for (const profile of profiles) {
    const normalizedProfileId = normalizeOptionalString(profile.profileId);
    if (normalizedProfileId) {
      profileIds.add(normalizedProfileId);
    }
  }

  for (const managerDescriptor of managerDescriptors) {
    const explicitProfileId = normalizeOptionalString(managerDescriptor.profileId);
    if (!explicitProfileId) {
      continue;
    }

    const derivedProfileId = deriveProfileIdFromSessionAgentId(managerDescriptor.agentId);
    const normalizedProfileId =
      explicitProfileId === managerDescriptor.agentId && derivedProfileId ? derivedProfileId : explicitProfileId;

    managerProfileBySessionId.set(managerDescriptor.agentId, normalizedProfileId);
    profileIds.add(normalizedProfileId);
  }

  for (const managerDescriptor of managerDescriptors) {
    if (managerProfileBySessionId.has(managerDescriptor.agentId)) {
      continue;
    }

    if (profileIds.has(managerDescriptor.agentId)) {
      managerProfileBySessionId.set(managerDescriptor.agentId, managerDescriptor.agentId);
      continue;
    }

    const derivedProfileId = deriveProfileIdFromSessionAgentId(managerDescriptor.agentId);
    if (derivedProfileId) {
      managerProfileBySessionId.set(managerDescriptor.agentId, derivedProfileId);
      profileIds.add(derivedProfileId);
      continue;
    }

    managerProfileBySessionId.set(managerDescriptor.agentId, managerDescriptor.agentId);
    profileIds.add(managerDescriptor.agentId);
  }

  return {
    managerProfileBySessionId,
    profileIds
  };
}

async function migrateManagerMemoryFiles(
  dataDir: string,
  managerDescriptors: Array<AgentDescriptor & { role: "manager" }>,
  managerProfileBySessionId: Map<string, string>,
  logger: DataMigrationLogger
): Promise<void> {
  for (const managerDescriptor of managerDescriptors) {
    const profileId = managerProfileBySessionId.get(managerDescriptor.agentId) ?? resolveManagerProfileId(managerDescriptor);
    const isRootSession = managerDescriptor.agentId === profileId;

    let sourcePath: string;
    let targetPath: string;

    try {
      sourcePath = getLegacyAgentMemoryPath(dataDir, managerDescriptor.agentId);
      targetPath = isRootSession
        ? getProfileMemoryPath(dataDir, profileId)
        : getSessionMemoryPath(dataDir, profileId, managerDescriptor.agentId);
    } catch (error) {
      log(logger, "warn", "migration:manager_memory_path_error", {
        managerId: managerDescriptor.agentId,
        message: errorToMessage(error)
      });
      continue;
    }

    await copyFileIfMissing(sourcePath, targetPath);
  }
}

async function migrateManagerSessionFiles(
  dataDir: string,
  managerDescriptors: Array<AgentDescriptor & { role: "manager" }>,
  managerProfileBySessionId: Map<string, string>,
  logger: DataMigrationLogger,
  fileOps: DataMigrationFileOps
): Promise<void> {
  for (const managerDescriptor of managerDescriptors) {
    const profileId = managerProfileBySessionId.get(managerDescriptor.agentId) ?? resolveManagerProfileId(managerDescriptor);

    let sourcePath: string;
    let targetPath: string;

    try {
      sourcePath = getLegacySessionFilePath(dataDir, managerDescriptor.agentId);
      targetPath = getSessionFilePath(dataDir, profileId, managerDescriptor.agentId);
    } catch (error) {
      log(logger, "warn", "migration:manager_session_path_error", {
        managerId: managerDescriptor.agentId,
        message: errorToMessage(error)
      });
      continue;
    }

    await hardlinkOrCopyFileIfMissing(sourcePath, targetPath, logger, fileOps);
  }
}

async function migrateWorkerSessionFiles(
  dataDir: string,
  workerDescriptors: Array<AgentDescriptor & { role: "worker" }>,
  managerProfileBySessionId: Map<string, string>,
  profileIds: Set<string>,
  logger: DataMigrationLogger,
  fileOps: DataMigrationFileOps
): Promise<void> {
  for (const workerDescriptor of workerDescriptors) {
    const ownerSessionId = workerDescriptor.managerId;
    const profileId = resolveWorkerProfileId(workerDescriptor, managerProfileBySessionId, profileIds);

    let sourcePath: string;
    let targetPath: string;

    try {
      sourcePath = getLegacySessionFilePath(dataDir, workerDescriptor.agentId);
      targetPath = getWorkerSessionFilePath(dataDir, profileId, ownerSessionId, workerDescriptor.agentId);
    } catch (error) {
      log(logger, "warn", "migration:worker_session_path_error", {
        workerId: workerDescriptor.agentId,
        ownerSessionId,
        message: errorToMessage(error)
      });
      continue;
    }

    await hardlinkOrCopyFileIfMissing(sourcePath, targetPath, logger, fileOps);
  }
}

async function migrateSchedules(
  dataDir: string,
  profileIds: Set<string>,
  managerProfileBySessionId: Map<string, string>,
  logger: DataMigrationLogger
): Promise<void> {
  const legacySchedulesDir = join(dataDir, LEGACY_SCHEDULES_DIR_NAME);

  for (const profileId of profileIds) {
    const sourcePath = join(legacySchedulesDir, `${profileId}.json`);
    const targetPath = getProfileScheduleFilePath(dataDir, profileId);
    await copyFileIfMissing(sourcePath, targetPath);
  }

  if (!(await pathExists(legacySchedulesDir))) {
    return;
  }

  const entries = await fs.readdir(legacySchedulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const managerId = entry.name.slice(0, -5);
    const profileId = resolveScheduleProfileId(managerId, managerProfileBySessionId);

    if (!profileId || profileId === managerId) {
      continue;
    }

    const sourcePath = join(legacySchedulesDir, entry.name);
    const targetPath = getProfileScheduleFilePath(dataDir, profileId);
    await mergeScheduleFileIntoProfileSchedule(sourcePath, targetPath, managerId, logger);
  }
}

function resolveScheduleProfileId(managerId: string, managerProfileBySessionId: Map<string, string>): string {
  const mappedProfileId = managerProfileBySessionId.get(managerId);
  if (mappedProfileId) {
    return mappedProfileId;
  }

  return deriveProfileIdFromSessionAgentId(managerId) ?? managerId;
}

async function mergeScheduleFileIntoProfileSchedule(
  sourcePath: string,
  targetPath: string,
  sourceSessionId: string,
  logger: DataMigrationLogger
): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }

  const sourcePayload = await readSchedulePayload(sourcePath, logger);
  if (!sourcePayload) {
    return;
  }

  const normalizedSourceSchedules = stampLegacyImportedSchedules(sourcePayload.schedules, sourceSessionId);

  if (!(await pathExists(targetPath))) {
    await writeJsonAtomic(targetPath, {
      ...sourcePayload.payload,
      schedules: normalizedSourceSchedules
    });
    return;
  }

  const targetPayload = await readSchedulePayload(targetPath, logger);
  if (!targetPayload) {
    return;
  }

  const mergedSchedules = mergeSchedules(targetPayload.schedules, normalizedSourceSchedules);
  if (mergedSchedules.length === targetPayload.schedules.length) {
    return;
  }

  await writeJsonAtomic(targetPath, {
    ...targetPayload.payload,
    schedules: mergedSchedules
  });
}

async function readSchedulePayload(path: string, logger: DataMigrationLogger): Promise<ParsedSchedulePayload | undefined> {
  let raw: string;

  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    log(logger, "warn", "migration:schedule_parse_error", {
      path,
      message: errorToMessage(error)
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    return {
      payload: {},
      schedules: []
    };
  }

  const schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
  return {
    payload: parsed,
    schedules
  };
}

function mergeSchedules(base: unknown[], incoming: unknown[]): unknown[] {
  const merged = [...base];
  const seen = new Set<string>();

  for (const schedule of base) {
    seen.add(scheduleIdentity(schedule));
  }

  for (const schedule of incoming) {
    const identity = scheduleIdentity(schedule);
    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    merged.push(schedule);
  }

  return merged;
}

function stampLegacyImportedSchedules(schedules: unknown[], sourceSessionId: string): unknown[] {
  const shouldStampSessionId = Boolean(deriveProfileIdFromSessionAgentId(sourceSessionId));
  if (!shouldStampSessionId) {
    return schedules;
  }

  return schedules.map((schedule) => {
    if (!isRecord(schedule)) {
      return schedule;
    }

    const existingSessionId = normalizeOptionalString(schedule.sessionId);
    if (existingSessionId) {
      return schedule;
    }

    return {
      ...schedule,
      sessionId: sourceSessionId
    };
  });
}

function scheduleIdentity(value: unknown): string {
  if (isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0) {
    return `id:${value.id.trim()}`;
  }

  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `string:${String(value)}`;
  }
}

async function migrateAuthAndSecrets(dataDir: string, _logger: DataMigrationLogger): Promise<void> {
  const legacySharedAuthFilePath = join(getSharedDir(dataDir), "auth", "auth.json");
  const legacySharedSecretsFilePath = join(getSharedDir(dataDir), "secrets.json");

  await copyFileIfMissing(getLegacyAuthFilePath(dataDir), legacySharedAuthFilePath);
  await copyFileIfMissing(getLegacySecretsFilePath(dataDir), legacySharedSecretsFilePath);
}

async function migrateIntegrationConfigs(
  dataDir: string,
  profileIds: Set<string>,
  _logger: DataMigrationLogger
): Promise<void> {
  const legacyIntegrationsDir = join(dataDir, LEGACY_INTEGRATIONS_DIR_NAME);
  const legacySharedIntegrationsDir = join(legacyIntegrationsDir, LEGACY_SHARED_INTEGRATIONS_DIR_NAME);
  const legacyManagerIntegrationsDir = join(legacyIntegrationsDir, LEGACY_MANAGER_INTEGRATIONS_DIR_NAME);

  const legacySharedIntegrationsDirPath = join(getSharedDir(dataDir), "integrations");

  await copyDirectoryIfExists(legacySharedIntegrationsDir, legacySharedIntegrationsDirPath);

  for (const profileId of profileIds) {
    const sourceDir = join(legacyManagerIntegrationsDir, profileId);
    const targetDir = getProfileIntegrationsDir(dataDir, profileId);
    await copyDirectoryIfExists(sourceDir, targetDir);
  }
}

async function cleanupLegacyFlatPaths(dataDir: string, logger: DataMigrationLogger): Promise<void> {
  const legacyDirectories = [
    join(dataDir, LEGACY_SESSIONS_DIR_NAME),
    join(dataDir, LEGACY_MEMORY_DIR_NAME),
    join(dataDir, LEGACY_SCHEDULES_DIR_NAME),
    join(dataDir, LEGACY_AUTH_DIR_NAME),
    join(dataDir, LEGACY_INTEGRATIONS_DIR_NAME)
  ];

  for (const directoryPath of legacyDirectories) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: true });
      log(logger, "info", "migration:legacy_path_removed", {
        path: directoryPath,
        type: "directory"
      });
    } catch (error) {
      log(logger, "warn", "migration:legacy_path_remove_error", {
        path: directoryPath,
        type: "directory",
        message: errorToMessage(error)
      });
    }
  }

  const legacySecretsPath = join(dataDir, LEGACY_SECRETS_FILE_NAME);

  try {
    await fs.rm(legacySecretsPath, { force: true });
    log(logger, "info", "migration:legacy_path_removed", {
      path: legacySecretsPath,
      type: "file"
    });
  } catch (error) {
    log(logger, "warn", "migration:legacy_path_remove_error", {
      path: legacySecretsPath,
      type: "file",
      message: errorToMessage(error)
    });
  }
}

function rewriteAgentSessionPaths(
  dataDir: string,
  agents: AgentDescriptor[],
  managerProfileBySessionId: Map<string, string>,
  profileIds: Set<string>,
  logger: DataMigrationLogger
): AgentDescriptor[] {
  return agents.map((descriptor) => {
    if (descriptor.role === "manager") {
      const profileId = managerProfileBySessionId.get(descriptor.agentId) ?? resolveManagerProfileId(descriptor);

      try {
        return {
          ...descriptor,
          model: { ...descriptor.model },
          profileId,
          sessionFile: getSessionFilePath(dataDir, profileId, descriptor.agentId)
        };
      } catch (error) {
        log(logger, "warn", "migration:manager_sessionfile_rewrite_error", {
          agentId: descriptor.agentId,
          message: errorToMessage(error)
        });

        return {
          ...descriptor,
          model: { ...descriptor.model },
          profileId
        };
      }
    }

    const resolvedProfileId = resolveWorkerProfileId(descriptor, managerProfileBySessionId, profileIds);

    try {
      return {
        ...descriptor,
        model: { ...descriptor.model },
        profileId: resolvedProfileId,
        sessionFile: getWorkerSessionFilePath(dataDir, resolvedProfileId, descriptor.managerId, descriptor.agentId)
      };
    } catch (error) {
      log(logger, "warn", "migration:worker_sessionfile_rewrite_error", {
        agentId: descriptor.agentId,
        managerId: descriptor.managerId,
        message: errorToMessage(error)
      });

      return {
        ...descriptor,
        model: { ...descriptor.model },
        profileId: resolvedProfileId
      };
    }
  });
}

function resolveManagerProfileId(descriptor: AgentDescriptor): string {
  const explicitProfileId = normalizeOptionalString(descriptor.profileId);
  if (explicitProfileId) {
    return explicitProfileId;
  }

  return deriveProfileIdFromSessionAgentId(descriptor.agentId) ?? descriptor.agentId;
}

function deriveProfileIdFromSessionAgentId(agentId: string): string | undefined {
  const match = SESSION_AGENT_ID_PATTERN.exec(agentId);
  if (!match) {
    return undefined;
  }

  return normalizeOptionalString(match[1]);
}

function resolveWorkerProfileId(
  descriptor: AgentDescriptor,
  managerProfileBySessionId: Map<string, string>,
  profileIds: Set<string>
): string {
  const ownerProfileId = managerProfileBySessionId.get(descriptor.managerId);
  if (ownerProfileId) {
    return ownerProfileId;
  }

  const descriptorProfileId = normalizeOptionalString(descriptor.profileId);
  if (descriptorProfileId) {
    return descriptorProfileId;
  }

  const managerId = normalizeOptionalString(descriptor.managerId);
  if (managerId && profileIds.has(managerId)) {
    return managerId;
  }

  return DEFAULT_FALLBACK_PROFILE_ID;
}

async function hardlinkOrCopyFileIfMissing(
  sourcePath: string,
  targetPath: string,
  logger: DataMigrationLogger,
  fileOps: DataMigrationFileOps
): Promise<void> {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return;
  }

  await fs.mkdir(dirname(targetPath), { recursive: true });

  try {
    await fileOps.link(sourcePath, targetPath);
    return;
  } catch (error) {
    if (isEexistError(error) || isEnoentError(error)) {
      return;
    }

    log(logger, "debug", "migration:hardlink_failed_copy_fallback", {
      sourcePath,
      targetPath,
      message: errorToMessage(error)
    });
  }

  try {
    await fileOps.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (isEexistError(error) || isEnoentError(error)) {
      return;
    }

    throw error;
  }
}

async function copyFileIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return;
  }

  await fs.mkdir(dirname(targetPath), { recursive: true });

  try {
    await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (isEexistError(error) || isEnoentError(error)) {
      return;
    }

    throw error;
  }
}

async function copyDirectoryIfExists(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await pathExists(sourceDir))) {
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryIfExists(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFileIfMissing(sourcePath, targetPath);
    }
  }
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagerDescriptor(
  descriptor: AgentDescriptor
): descriptor is AgentDescriptor & { role: "manager" } {
  return descriptor.role === "manager";
}

function log(
  logger: DataMigrationLogger,
  level: "debug" | "info" | "warn",
  message: string,
  details?: unknown
): void {
  const logHandler = logger[level];
  if (!logHandler) {
    return;
  }

  logHandler(message, details);
}

function isEexistError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
