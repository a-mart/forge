import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionMeta, SessionWorkerMeta } from "@middleman/protocol";
import {
  getSessionFilePath,
  getSessionMetaPath,
  resolveMemoryFilePath
} from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";
import type { AgentDescriptor } from "./types.js";

export interface RebuildSessionMetaOptions {
  dataDir: string;
  agentsStoreFile: string;
  descriptors?: AgentDescriptor[];
  now?: () => string;
}

export interface SessionMetaWorkerUpdate {
  id: string;
  model?: string | null;
  status?: SessionWorkerMeta["status"];
  createdAt?: string;
  terminatedAt?: string | null;
  tokens?: {
    input: number | null;
    output: number | null;
  };
}

export interface SessionMetaStatsUpdateOptions {
  sessionFilePath?: string;
  memoryFilePath?: string;
  now?: () => string;
}

const SESSION_META_REBUILD_BATCH_SIZE = 10;

export async function writeSessionMeta(dataDir: string, meta: SessionMeta): Promise<void> {
  const target = getSessionMetaPath(dataDir, meta.profileId, meta.sessionId);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await renameWithRetry(tmp, target, { retries: 8, baseDelayMs: 15 });
}

export async function readSessionMeta(
  dataDir: string,
  profileId: string,
  sessionAgentId: string
): Promise<SessionMeta | undefined> {
  const path = getSessionMetaPath(dataDir, profileId, sessionAgentId);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    console.warn(`[swarm] Failed to read session meta ${path}: ${errorToMessage(error)}`);
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const meta = coerceSessionMeta(parsed);
    if (!meta) {
      console.warn(`[swarm] Ignoring invalid session meta at ${path}`);
      return undefined;
    }
    return meta;
  } catch (error) {
    console.warn(`[swarm] Failed to parse session meta ${path}: ${errorToMessage(error)}`);
    return undefined;
  }
}

export async function rebuildSessionMeta(options: RebuildSessionMetaOptions): Promise<SessionMeta[]> {
  const now = options.now ?? nowIso;
  const descriptors = options.descriptors ?? (await readDescriptorsFromAgentsStore(options.agentsStoreFile));

  const managerDescriptors = descriptors.filter(isManagerDescriptor);
  const workerDescriptorsByManager = new Map<string, AgentDescriptor[]>();

  for (const descriptor of descriptors) {
    if (descriptor.role !== "worker") {
      continue;
    }

    const managerWorkers = workerDescriptorsByManager.get(descriptor.managerId) ?? [];
    managerWorkers.push(descriptor);
    workerDescriptorsByManager.set(descriptor.managerId, managerWorkers);
  }

  const metas: SessionMeta[] = [];

  for (let i = 0; i < managerDescriptors.length; i += SESSION_META_REBUILD_BATCH_SIZE) {
    const batch = managerDescriptors.slice(i, i + SESSION_META_REBUILD_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (sessionDescriptor): Promise<SessionMeta | null> => {
        try {
          const profileId = normalizeProfileId(sessionDescriptor);
          const workers = (workerDescriptorsByManager.get(sessionDescriptor.agentId) ?? []).map((worker) =>
            buildWorkerMeta(worker)
          );

          const existingMeta = await readSessionMeta(options.dataDir, profileId, sessionDescriptor.agentId);

          const sessionFilePath =
            normalizeOptionalString(sessionDescriptor.sessionFile) ??
            getSessionFilePath(options.dataDir, profileId, sessionDescriptor.agentId);

          const memoryFilePath = resolveMemoryFilePath(options.dataDir, {
            agentId: sessionDescriptor.agentId,
            role: "manager",
            profileId,
            managerId: sessionDescriptor.managerId
          });

          const [sessionFileSize, memoryFileSize] = await Promise.all([
            readFileSize(sessionFilePath),
            readFileSize(memoryFilePath)
          ]);

          const meta: SessionMeta = {
            sessionId: sessionDescriptor.agentId,
            profileId,
            label: normalizeOptionalString(sessionDescriptor.sessionLabel) ?? null,
            model: {
              provider: normalizeOptionalString(sessionDescriptor.model.provider) ?? null,
              modelId: normalizeOptionalString(sessionDescriptor.model.modelId) ?? null
            },
            createdAt: sessionDescriptor.createdAt,
            updatedAt: sessionDescriptor.updatedAt ?? now(),
            cwd: normalizeOptionalString(sessionDescriptor.cwd) ?? null,
            promptFingerprint: existingMeta?.promptFingerprint ?? null,
            promptComponents: existingMeta?.promptComponents ?? null,
            cortexReviewedAt: existingMeta?.cortexReviewedAt,
            cortexReviewedBytes: existingMeta?.cortexReviewedBytes,
            cortexReviewExcludedAt: existingMeta?.cortexReviewExcludedAt ?? null,
            cortexReviewedMemoryBytes: resolveInitialReviewedMemoryBytes(
              existingMeta?.cortexReviewedMemoryBytes,
              memoryFileSize
            ),
            cortexReviewedMemoryAt: existingMeta?.cortexReviewedMemoryAt ?? null,
            feedbackFileSize: existingMeta?.feedbackFileSize,
            lastFeedbackAt: existingMeta?.lastFeedbackAt,
            cortexReviewedFeedbackBytes: existingMeta?.cortexReviewedFeedbackBytes,
            cortexReviewedFeedbackAt: existingMeta?.cortexReviewedFeedbackAt,
            memoryMergeAttemptCount: existingMeta?.memoryMergeAttemptCount ?? 0,
            lastMemoryMergeAttemptId: existingMeta?.lastMemoryMergeAttemptId ?? null,
            lastMemoryMergeAttemptAt: existingMeta?.lastMemoryMergeAttemptAt ?? null,
            lastMemoryMergeAppliedAt: existingMeta?.lastMemoryMergeAppliedAt ?? null,
            lastMemoryMergeStatus: existingMeta?.lastMemoryMergeStatus ?? null,
            lastMemoryMergeStrategy: existingMeta?.lastMemoryMergeStrategy ?? null,
            lastMemoryMergeFailureStage: existingMeta?.lastMemoryMergeFailureStage ?? null,
            lastMemoryMergeSourceHash: existingMeta?.lastMemoryMergeSourceHash ?? null,
            lastMemoryMergeProfileHashBefore: existingMeta?.lastMemoryMergeProfileHashBefore ?? null,
            lastMemoryMergeProfileHashAfter: existingMeta?.lastMemoryMergeProfileHashAfter ?? null,
            lastMemoryMergeAppliedSourceHash: existingMeta?.lastMemoryMergeAppliedSourceHash ?? null,
            lastMemoryMergeError: existingMeta?.lastMemoryMergeError ?? null,
            workers,
            stats: buildWorkerStats(workers, {
              sessionFileSize,
              memoryFileSize
            })
          };

          await writeSessionMeta(options.dataDir, meta);
          return meta;
        } catch (error) {
          console.warn(
            `[swarm] Failed to rebuild session meta for ${sessionDescriptor.agentId}: ${errorToMessage(error)}`
          );
          return null;
        }
      })
    );

    metas.push(...batchResults.filter((meta): meta is SessionMeta => meta !== null));
  }

  return metas;
}

export async function updateSessionMetaWorker(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  update: SessionMetaWorkerUpdate,
  now: () => string = nowIso
): Promise<SessionMeta> {
  const existing = await readSessionMeta(dataDir, profileId, sessionAgentId);
  const base = existing ?? createEmptySessionMeta(profileId, sessionAgentId, now());

  const workerId = normalizeOptionalString(update.id);
  if (!workerId) {
    throw new Error("worker id is required");
  }

  const existingIndex = base.workers.findIndex((worker) => worker.id === workerId);
  const existingWorker = existingIndex >= 0 ? base.workers[existingIndex] : undefined;
  const nextStatus = update.status ?? existingWorker?.status ?? "idle";

  const nextWorker: SessionWorkerMeta = {
    id: workerId,
    model:
      update.model !== undefined
        ? update.model
        : existingWorker?.model ?? null,
    status: nextStatus,
    createdAt: update.createdAt ?? existingWorker?.createdAt ?? now(),
    terminatedAt:
      update.terminatedAt !== undefined
        ? update.terminatedAt
        : nextStatus === "terminated"
          ? existingWorker?.terminatedAt ?? now()
          : null,
    tokens: normalizeWorkerTokens(update.tokens ?? existingWorker?.tokens)
  };

  if (existingIndex >= 0) {
    base.workers[existingIndex] = nextWorker;
  } else {
    base.workers.push(nextWorker);
  }

  base.workers.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }

    return left.id.localeCompare(right.id);
  });

  base.updatedAt = now();
  base.stats = buildWorkerStats(base.workers, {
    sessionFileSize: base.stats.sessionFileSize,
    memoryFileSize: base.stats.memoryFileSize
  });

  await writeSessionMeta(dataDir, base);
  return base;
}

export async function updateSessionMetaStats(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  options: SessionMetaStatsUpdateOptions = {}
): Promise<SessionMeta | undefined> {
  const meta = await readSessionMeta(dataDir, profileId, sessionAgentId);
  if (!meta) {
    return undefined;
  }

  const sessionFilePath =
    options.sessionFilePath ?? getSessionFilePath(dataDir, profileId, sessionAgentId);
  const memoryFilePath =
    options.memoryFilePath ??
    resolveMemoryFilePath(dataDir, {
      agentId: sessionAgentId,
      role: "manager",
      profileId,
      managerId: sessionAgentId
    });

  const sessionFileSize = await readFileSize(sessionFilePath);
  const memoryFileSize = await readFileSize(memoryFilePath);

  meta.stats = buildWorkerStats(meta.workers, {
    sessionFileSize,
    memoryFileSize
  });
  if (meta.cortexReviewedMemoryBytes === undefined) {
    meta.cortexReviewedMemoryBytes = resolveInitialReviewedMemoryBytes(undefined, memoryFileSize);
  }
  if (meta.cortexReviewedMemoryAt === undefined) {
    meta.cortexReviewedMemoryAt = null;
  }
  meta.updatedAt = (options.now ?? nowIso)();

  await writeSessionMeta(dataDir, meta);
  return meta;
}

export function computePromptFingerprint(
  components: SessionMeta["promptComponents"]
): string | null {
  if (!components) {
    return null;
  }

  const normalized = {
    archetype: normalizeOptionalString(components.archetype) ?? null,
    agentsFile: normalizeOptionalString(components.agentsFile) ?? null,
    skills: [...components.skills]
      .map((skill) => normalizeOptionalString(skill))
      .filter((skill): skill is string => !!skill)
      .sort((left, right) => left.localeCompare(right)),
    memoryFile: normalizeOptionalString(components.memoryFile) ?? null,
    profileMemoryFile: normalizeOptionalString(components.profileMemoryFile) ?? null
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function createEmptySessionMeta(profileId: string, sessionId: string, timestamp: string): SessionMeta {
  return {
    sessionId,
    profileId,
    label: null,
    model: {
      provider: null,
      modelId: null
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: null,
    promptFingerprint: null,
    promptComponents: null,
    cortexReviewExcludedAt: null,
    feedbackFileSize: null,
    lastFeedbackAt: null,
    cortexReviewedFeedbackBytes: 0,
    cortexReviewedFeedbackAt: null,
    memoryMergeAttemptCount: 0,
    lastMemoryMergeAttemptId: null,
    lastMemoryMergeAttemptAt: null,
    lastMemoryMergeAppliedAt: null,
    lastMemoryMergeStatus: null,
    lastMemoryMergeStrategy: null,
    lastMemoryMergeFailureStage: null,
    lastMemoryMergeSourceHash: null,
    lastMemoryMergeProfileHashBefore: null,
    lastMemoryMergeProfileHashAfter: null,
    lastMemoryMergeAppliedSourceHash: null,
    lastMemoryMergeError: null,
    workers: [],
    stats: {
      totalWorkers: 0,
      activeWorkers: 0,
      totalTokens: {
        input: null,
        output: null
      },
      sessionFileSize: null,
      memoryFileSize: null
    }
  };
}

function normalizeProfileId(descriptor: AgentDescriptor): string {
  return normalizeOptionalString(descriptor.profileId) ?? descriptor.agentId;
}

function buildWorkerMeta(descriptor: AgentDescriptor): SessionWorkerMeta {
  return {
    id: descriptor.agentId,
    model: buildWorkerModelString(descriptor),
    status: mapWorkerStatus(descriptor.status),
    createdAt: descriptor.createdAt,
    terminatedAt: descriptor.status === "terminated" ? descriptor.updatedAt : null,
    tokens: {
      input:
        typeof descriptor.contextUsage?.tokens === "number"
          ? Math.max(0, Math.round(descriptor.contextUsage.tokens))
          : null,
      output: null
    }
  };
}

function buildWorkerModelString(descriptor: AgentDescriptor): string | null {
  const provider = normalizeOptionalString(descriptor.model.provider);
  const modelId = normalizeOptionalString(descriptor.model.modelId);
  if (!provider || !modelId) {
    return null;
  }

  return `${provider}/${modelId}`;
}

function mapWorkerStatus(status: AgentDescriptor["status"]): SessionWorkerMeta["status"] {
  if (status === "terminated") {
    return "terminated";
  }

  if (status === "streaming") {
    return "streaming";
  }

  return "idle";
}

function buildWorkerStats(
  workers: SessionWorkerMeta[],
  fileSizes: { sessionFileSize: string | null; memoryFileSize: string | null }
): SessionMeta["stats"] {
  const totalInput = sumNullableValues(workers.map((worker) => worker.tokens.input));
  const totalOutput = sumNullableValues(workers.map((worker) => worker.tokens.output));

  return {
    totalWorkers: workers.length,
    activeWorkers: workers.filter((worker) => worker.status === "streaming").length,
    totalTokens: {
      input: totalInput,
      output: totalOutput
    },
    sessionFileSize: fileSizes.sessionFileSize,
    memoryFileSize: fileSizes.memoryFileSize
  };
}

function normalizeWorkerTokens(
  tokens:
    | {
        input: number | null;
        output: number | null;
      }
    | undefined
): {
  input: number | null;
  output: number | null;
} {
  if (!tokens) {
    return {
      input: null,
      output: null
    };
  }

  return {
    input: normalizeOptionalNumber(tokens.input),
    output: normalizeOptionalNumber(tokens.output)
  };
}

function sumNullableValues(values: Array<number | null>): number | null {
  const normalized = values.filter((value): value is number => typeof value === "number");
  if (normalized.length === 0) {
    return null;
  }

  return normalized.reduce((sum, value) => sum + value, 0);
}

function normalizeOptionalNumber(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

async function readFileSize(path: string): Promise<string | null> {
  try {
    const fileStats = await stat(path);
    return String(fileStats.size);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    return null;
  }
}

function resolveInitialReviewedMemoryBytes(
  reviewedBytes: number | undefined,
  memoryFileSize: string | null
): number {
  if (typeof reviewedBytes === "number" && Number.isFinite(reviewedBytes)) {
    return Math.max(0, Math.round(reviewedBytes));
  }

  if (typeof memoryFileSize === "string") {
    const parsed = Number.parseInt(memoryFileSize, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return 0;
}

async function readDescriptorsFromAgentsStore(agentsStoreFile: string): Promise<AgentDescriptor[]> {
  try {
    const raw = await readFile(agentsStoreFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
      return [];
    }

    return parsed.agents
      .map((candidate) => coerceAgentDescriptor(candidate))
      .filter((descriptor): descriptor is AgentDescriptor => !!descriptor);
  } catch {
    return [];
  }
}

function coerceAgentDescriptor(value: unknown): AgentDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const role = value.role;
  if (role !== "manager" && role !== "worker") {
    return undefined;
  }

  const agentId = normalizeOptionalString(value.agentId);
  const managerId = normalizeOptionalString(value.managerId);
  const createdAt = normalizeOptionalString(value.createdAt);
  const updatedAt = normalizeOptionalString(value.updatedAt);
  const cwd = normalizeOptionalString(value.cwd);
  const sessionFile = normalizeOptionalString(value.sessionFile);
  const model = isRecord(value.model) ? value.model : undefined;
  const provider = normalizeOptionalString(model?.provider);
  const modelId = normalizeOptionalString(model?.modelId);
  const thinkingLevel = normalizeOptionalString(model?.thinkingLevel);
  const status = normalizeOptionalString(value.status);

  if (!agentId || !managerId || !createdAt || !updatedAt || !cwd || !sessionFile || !provider || !modelId || !status) {
    return undefined;
  }

  return {
    agentId,
    managerId,
    displayName: normalizeOptionalString(value.displayName) ?? agentId,
    role,
    archetypeId: normalizeOptionalString(value.archetypeId),
    status: status as AgentDescriptor["status"],
    createdAt,
    updatedAt,
    cwd,
    model: {
      provider,
      modelId,
      thinkingLevel: thinkingLevel ?? "default"
    },
    sessionFile,
    contextUsage: undefined,
    profileId: normalizeOptionalString(value.profileId),
    sessionLabel: normalizeOptionalString(value.sessionLabel),
    sessionPurpose: normalizeOptionalString(value.sessionPurpose) === "cortex_review" ? "cortex_review" : undefined,
    mergedAt: normalizeOptionalString(value.mergedAt)
  };
}

function isManagerDescriptor(descriptor: AgentDescriptor): descriptor is AgentDescriptor & { role: "manager" } {
  return descriptor.role === "manager";
}

function coerceSessionMeta(value: unknown): SessionMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = normalizeOptionalString(value.sessionId);
  const profileId = normalizeOptionalString(value.profileId);
  const createdAt = normalizeOptionalString(value.createdAt);
  const updatedAt = normalizeOptionalString(value.updatedAt);

  if (!sessionId || !profileId || !createdAt || !updatedAt) {
    return undefined;
  }

  const modelRecord = isRecord(value.model) ? value.model : {};
  const promptComponentsRecord = isRecord(value.promptComponents) ? value.promptComponents : null;
  const workers = Array.isArray(value.workers)
    ? value.workers
        .map((worker) => coerceSessionWorkerMeta(worker))
        .filter((worker): worker is SessionWorkerMeta => !!worker)
    : [];

  const statsRecord = isRecord(value.stats) ? value.stats : {};

  return {
    sessionId,
    profileId,
    label: normalizeOptionalString(value.label) ?? null,
    model: {
      provider: normalizeOptionalString(modelRecord.provider) ?? null,
      modelId: normalizeOptionalString(modelRecord.modelId) ?? null
    },
    createdAt,
    updatedAt,
    cwd: normalizeOptionalString(value.cwd) ?? null,
    promptFingerprint: normalizeOptionalString(value.promptFingerprint) ?? null,
    promptComponents: promptComponentsRecord
      ? {
          archetype: normalizeOptionalString(promptComponentsRecord.archetype) ?? null,
          agentsFile: normalizeOptionalString(promptComponentsRecord.agentsFile) ?? null,
          skills: Array.isArray(promptComponentsRecord.skills)
            ? promptComponentsRecord.skills
                .map((skill) => normalizeOptionalString(skill))
                .filter((skill): skill is string => !!skill)
            : [],
          memoryFile: normalizeOptionalString(promptComponentsRecord.memoryFile) ?? null,
          profileMemoryFile: normalizeOptionalString(promptComponentsRecord.profileMemoryFile) ?? null
        }
      : null,
    cortexReviewedAt: normalizeOptionalString(value.cortexReviewedAt),
    cortexReviewedBytes: coerceOptionalNonNegativeInteger(value.cortexReviewedBytes),
    cortexReviewExcludedAt: normalizeOptionalNullableString(value.cortexReviewExcludedAt),
    cortexReviewedMemoryBytes: coerceOptionalNonNegativeInteger(value.cortexReviewedMemoryBytes),
    cortexReviewedMemoryAt: normalizeOptionalNullableString(value.cortexReviewedMemoryAt),
    feedbackFileSize: coerceOptionalFileSizeString(value.feedbackFileSize),
    lastFeedbackAt: normalizeOptionalNullableString(value.lastFeedbackAt),
    cortexReviewedFeedbackBytes: coerceOptionalNonNegativeInteger(value.cortexReviewedFeedbackBytes),
    cortexReviewedFeedbackAt: normalizeOptionalNullableString(value.cortexReviewedFeedbackAt),
    memoryMergeAttemptCount: coerceOptionalNonNegativeInteger(value.memoryMergeAttemptCount),
    lastMemoryMergeAttemptId: normalizeOptionalNullableString(value.lastMemoryMergeAttemptId),
    lastMemoryMergeAttemptAt: normalizeOptionalNullableString(value.lastMemoryMergeAttemptAt),
    lastMemoryMergeAppliedAt: normalizeOptionalNullableString(value.lastMemoryMergeAppliedAt),
    lastMemoryMergeStatus: normalizeOptionalNullableString(value.lastMemoryMergeStatus) as SessionMeta["lastMemoryMergeStatus"],
    lastMemoryMergeStrategy: normalizeOptionalNullableString(value.lastMemoryMergeStrategy) as SessionMeta["lastMemoryMergeStrategy"],
    lastMemoryMergeFailureStage: normalizeOptionalNullableString(value.lastMemoryMergeFailureStage) as SessionMeta["lastMemoryMergeFailureStage"],
    lastMemoryMergeSourceHash: normalizeOptionalNullableString(value.lastMemoryMergeSourceHash),
    lastMemoryMergeProfileHashBefore: normalizeOptionalNullableString(value.lastMemoryMergeProfileHashBefore),
    lastMemoryMergeProfileHashAfter: normalizeOptionalNullableString(value.lastMemoryMergeProfileHashAfter),
    lastMemoryMergeAppliedSourceHash: normalizeOptionalNullableString(value.lastMemoryMergeAppliedSourceHash),
    lastMemoryMergeError: normalizeOptionalNullableString(value.lastMemoryMergeError),
    workers,
    stats: {
      totalWorkers:
        typeof statsRecord.totalWorkers === "number" && Number.isFinite(statsRecord.totalWorkers)
          ? Math.max(0, Math.round(statsRecord.totalWorkers))
          : workers.length,
      activeWorkers:
        typeof statsRecord.activeWorkers === "number" && Number.isFinite(statsRecord.activeWorkers)
          ? Math.max(0, Math.round(statsRecord.activeWorkers))
          : workers.filter((worker) => worker.status === "streaming").length,
      totalTokens: {
        input: coerceNullableTokenValue(
          isRecord(statsRecord.totalTokens) ? statsRecord.totalTokens.input : undefined
        ),
        output: coerceNullableTokenValue(
          isRecord(statsRecord.totalTokens) ? statsRecord.totalTokens.output : undefined
        )
      },
      sessionFileSize: normalizeOptionalString(statsRecord.sessionFileSize) ?? null,
      memoryFileSize: normalizeOptionalString(statsRecord.memoryFileSize) ?? null
    }
  };
}

function coerceSessionWorkerMeta(value: unknown): SessionWorkerMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = normalizeOptionalString(value.id);
  const createdAt = normalizeOptionalString(value.createdAt);
  const status = normalizeOptionalString(value.status);

  if (!id || !createdAt || !status) {
    return undefined;
  }

  const normalizedStatus: SessionWorkerMeta["status"] =
    status === "running" || status === "streaming"
      ? "streaming"
      : status === "terminated"
        ? "terminated"
        : "idle";

  const tokensRecord = isRecord(value.tokens) ? value.tokens : {};

  return {
    id,
    model: normalizeOptionalString(value.model) ?? null,
    status: normalizedStatus,
    createdAt,
    terminatedAt: normalizeOptionalString(value.terminatedAt) ?? null,
    tokens: {
      input: coerceNullableTokenValue(tokensRecord.input),
      output: coerceNullableTokenValue(tokensRecord.output)
    }
  };
}

function coerceNullableTokenValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

function coerceOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.round(value));
}

function coerceOptionalFileSizeString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.max(0, Math.round(value)));
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return String(Math.max(0, parsed));
}

function normalizeOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return normalizeOptionalString(value);
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

function nowIso(): string {
  return new Date().toISOString();
}
