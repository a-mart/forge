import { readFile } from "node:fs/promises";
import type { AgentModelDescriptor } from "../types.js";
import {
  appendImmediateCustomEntry,
  type ImmediateCustomEntryWriteResult
} from "../session/immediate-custom-entry-writer.js";

const MODEL_CHANGE_CONTINUITY_REQUEST_ENTRY_TYPE = "swarm_model_change_continuity_request";
const MODEL_CHANGE_CONTINUITY_APPLIED_ENTRY_TYPE = "swarm_model_change_continuity_applied";

export type ModelChangeContinuityRuntimeKind = "pi" | "claude";

export interface ModelChangeContinuityModel {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  runtimeKind: ModelChangeContinuityRuntimeKind;
}

export interface ModelChangeContinuityRequest {
  version: 1;
  requestId: string;
  createdAt: string;
  sessionAgentId: string;
  sourceModel: ModelChangeContinuityModel;
  targetModel: ModelChangeContinuityModel;
}

export interface ModelChangeContinuityApplied {
  version: 1;
  requestId: string;
  appliedAt: string;
  sessionAgentId: string;
  attachedRuntime: {
    provider: string;
    modelId: string;
    runtimeKind: ModelChangeContinuityRuntimeKind;
  };
}

export interface ModelChangeContinuityState {
  requests: ModelChangeContinuityRequest[];
  applied: ModelChangeContinuityApplied[];
}

export function inferModelChangeContinuityRuntimeKind(
  model: Pick<AgentModelDescriptor, "provider">
): ModelChangeContinuityRuntimeKind {
  const provider = model.provider.trim().toLowerCase();
  if (provider === "claude-sdk") {
    return "claude";
  }

  return "pi";
}

function buildModelChangeContinuityModel(
  model: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string }
): ModelChangeContinuityModel {
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: normalizeThinkingLevel(model.thinkingLevel),
    runtimeKind: inferModelChangeContinuityRuntimeKind(model)
  };
}

export function createModelChangeContinuityRequest(options: {
  requestId: string;
  createdAt: string;
  sessionAgentId: string;
  sourceModel: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string };
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string };
}): ModelChangeContinuityRequest {
  return {
    version: 1,
    requestId: options.requestId,
    createdAt: options.createdAt,
    sessionAgentId: options.sessionAgentId,
    sourceModel: buildModelChangeContinuityModel(options.sourceModel),
    targetModel: buildModelChangeContinuityModel(options.targetModel)
  };
}

export function createModelChangeContinuityApplied(options: {
  requestId: string;
  appliedAt: string;
  sessionAgentId: string;
  attachedRuntime: Pick<AgentModelDescriptor, "provider" | "modelId">;
}): ModelChangeContinuityApplied {
  return {
    version: 1,
    requestId: options.requestId,
    appliedAt: options.appliedAt,
    sessionAgentId: options.sessionAgentId,
    attachedRuntime: {
      provider: options.attachedRuntime.provider,
      modelId: options.attachedRuntime.modelId,
      runtimeKind: inferModelChangeContinuityRuntimeKind(options.attachedRuntime)
    }
  };
}

export async function appendModelChangeContinuityRequest(options: {
  sessionFile: string;
  cwd: string;
  request: ModelChangeContinuityRequest;
  now?: () => string;
}): Promise<ImmediateCustomEntryWriteResult> {
  return appendImmediateCustomEntry({
    sessionFile: options.sessionFile,
    cwd: options.cwd,
    customType: MODEL_CHANGE_CONTINUITY_REQUEST_ENTRY_TYPE,
    data: options.request,
    now: options.now
  });
}

export async function appendModelChangeContinuityApplied(options: {
  sessionFile: string;
  cwd: string;
  applied: ModelChangeContinuityApplied;
  now?: () => string;
}): Promise<ImmediateCustomEntryWriteResult> {
  return appendImmediateCustomEntry({
    sessionFile: options.sessionFile,
    cwd: options.cwd,
    customType: MODEL_CHANGE_CONTINUITY_APPLIED_ENTRY_TYPE,
    data: options.applied,
    now: options.now
  });
}

export async function loadModelChangeContinuityState(sessionFile: string): Promise<ModelChangeContinuityState> {
  const content = await readFile(sessionFile, "utf8").catch((error: unknown) => {
    if (isEnoentError(error)) {
      return "";
    }

    throw error;
  });

  const state: ModelChangeContinuityState = {
    requests: [],
    applied: []
  };

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const customEntry = parsed as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (customEntry.type !== "custom") {
      continue;
    }

    if (customEntry.customType === MODEL_CHANGE_CONTINUITY_REQUEST_ENTRY_TYPE) {
      const request = parseModelChangeContinuityRequest(customEntry.data);
      if (request) {
        state.requests.push(request);
      }
      continue;
    }

    if (customEntry.customType === MODEL_CHANGE_CONTINUITY_APPLIED_ENTRY_TYPE) {
      const applied = parseModelChangeContinuityApplied(customEntry.data);
      if (applied) {
        state.applied.push(applied);
      }
    }
  }

  return state;
}

export function findLatestPendingModelChangeContinuityRequest(options: {
  sessionAgentId: string;
  requests: ModelChangeContinuityRequest[];
  applied: ModelChangeContinuityApplied[];
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string };
}): ModelChangeContinuityRequest | undefined {
  const targetRuntimeKind = inferModelChangeContinuityRuntimeKind(options.targetModel);
  const targetThinkingLevel = normalizeThinkingLevel(options.targetModel.thinkingLevel);
  const appliedRequestIds = getAppliedRequestIdsForSession(options.sessionAgentId, options.applied);

  for (let index = options.requests.length - 1; index >= 0; index -= 1) {
    const request = options.requests[index];
    if (!request || request.sessionAgentId !== options.sessionAgentId) {
      continue;
    }

    if (appliedRequestIds.has(request.requestId)) {
      continue;
    }

    if (request.targetModel.provider !== options.targetModel.provider) {
      continue;
    }

    if (request.targetModel.modelId !== options.targetModel.modelId) {
      continue;
    }

    if (request.targetModel.runtimeKind !== targetRuntimeKind) {
      continue;
    }

    if (normalizeThinkingLevel(request.targetModel.thinkingLevel) !== targetThinkingLevel) {
      continue;
    }

    return request;
  }

  return undefined;
}

export function findLatestUnappliedModelChangeContinuityRequestForSession(options: {
  sessionAgentId: string;
  requests: ModelChangeContinuityRequest[];
  applied: ModelChangeContinuityApplied[];
}): ModelChangeContinuityRequest | undefined {
  const appliedRequestIds = getAppliedRequestIdsForSession(options.sessionAgentId, options.applied);

  for (let index = options.requests.length - 1; index >= 0; index -= 1) {
    const request = options.requests[index];
    if (!request || request.sessionAgentId !== options.sessionAgentId) {
      continue;
    }

    if (appliedRequestIds.has(request.requestId)) {
      continue;
    }

    return request;
  }

  return undefined;
}

function getAppliedRequestIdsForSession(
  sessionAgentId: string,
  applied: ModelChangeContinuityApplied[]
): Set<string> {
  return new Set(
    applied
      .filter((entry) => entry.sessionAgentId === sessionAgentId)
      .map((entry) => entry.requestId)
  );
}

function parseModelChangeContinuityRequest(data: unknown): ModelChangeContinuityRequest | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const value = data as Partial<ModelChangeContinuityRequest>;
  if (
    value.version !== 1 ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.sessionAgentId) ||
    !isValidModelChangeContinuityModel(value.sourceModel) ||
    !isValidModelChangeContinuityModel(value.targetModel)
  ) {
    return undefined;
  }

  return {
    version: 1,
    requestId: value.requestId,
    createdAt: value.createdAt,
    sessionAgentId: value.sessionAgentId,
    sourceModel: normalizeModelChangeContinuityModel(value.sourceModel),
    targetModel: normalizeModelChangeContinuityModel(value.targetModel)
  };
}

function parseModelChangeContinuityApplied(data: unknown): ModelChangeContinuityApplied | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const value = data as Partial<ModelChangeContinuityApplied>;
  if (
    value.version !== 1 ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.appliedAt) ||
    !isNonEmptyString(value.sessionAgentId) ||
    !value.attachedRuntime ||
    typeof value.attachedRuntime !== "object" ||
    Array.isArray(value.attachedRuntime) ||
    !isNonEmptyString(value.attachedRuntime.provider) ||
    !isNonEmptyString(value.attachedRuntime.modelId) ||
    !isPersistedRuntimeKind(value.attachedRuntime.runtimeKind)
  ) {
    return undefined;
  }

  return {
    version: 1,
    requestId: value.requestId,
    appliedAt: value.appliedAt,
    sessionAgentId: value.sessionAgentId,
    attachedRuntime: {
      provider: value.attachedRuntime.provider,
      modelId: value.attachedRuntime.modelId,
      runtimeKind: normalizeRuntimeKind(value.attachedRuntime.runtimeKind)
    }
  };
}

function normalizeModelChangeContinuityModel(model: ModelChangeContinuityModel): ModelChangeContinuityModel {
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: normalizeThinkingLevel(model.thinkingLevel),
    runtimeKind: normalizeRuntimeKind(model.runtimeKind)
  };
}

function isValidModelChangeContinuityModel(value: unknown): value is ModelChangeContinuityModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.provider) &&
    isNonEmptyString(candidate.modelId) &&
    isPersistedRuntimeKind(candidate.runtimeKind) &&
    (candidate.thinkingLevel === undefined || typeof candidate.thinkingLevel === "string")
  );
}

function isPersistedRuntimeKind(value: unknown): value is ModelChangeContinuityRuntimeKind | "codex" {
  return value === "pi" || value === "claude" || value === "codex";
}

function normalizeRuntimeKind(value: ModelChangeContinuityRuntimeKind | "codex"): ModelChangeContinuityRuntimeKind {
  return value === "codex" ? "pi" : value;
}

function normalizeThinkingLevel(level: string | undefined): string | undefined {
  if (typeof level !== "string") {
    return undefined;
  }

  return level === "x-high" ? "xhigh" : level;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
