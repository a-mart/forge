import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { getModel, getModels, type Api, type Model } from "@mariozechner/pi-ai";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  PROJECT_AGENT_CAPABILITIES,
  type AgentRuntimeExtensionSnapshot,
  type SessionMemoryMergeFailureStage
} from "@forge/protocol";
import { sanitizePathSegment as sanitizePersistedPathSegment } from "./data-paths.js";
import { modelCatalogService } from "./model-catalog-service.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment
} from "./conversation-validators.js";
import { classifyRuntimeCapacityError } from "./runtime-utils.js";
import {
  normalizeAgentStatus,
  type AgentStatusInput
} from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeUserMessage
} from "./runtime-contracts.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
  MessageTargetContext
} from "./types.js";

const VALID_PERSISTED_AGENT_ROLES = new Set(["manager", "worker"]);

const SYNTHETIC_PI_MODEL_BLUEPRINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "openai-codex": {
    "gpt-5.5": "gpt-5.4"
  }
};
const VALID_PERSISTED_PROJECT_AGENT_CAPABILITIES = new Set<string>(PROJECT_AGENT_CAPABILITIES);
const VALID_PERSISTED_SESSION_SURFACES = new Set(["builder", "collab"]);
const VALID_PERSISTED_AGENT_STATUSES = new Set([
  "idle",
  "streaming",
  "terminated",
  "stopped",
  "error",
  "stopped_on_restart"
]);
const OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN = ["gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5"];
const MAX_WORKER_COMPLETION_REPORT_CHARS = 4_000;
const WORKER_COMPLETION_TRUNCATION_SUFFIX = "\n\n[truncated]";
const SESSION_ID_SUFFIX_SEPARATOR = "--s";
const ROOT_SESSION_NUMBER = 1;
const WORKER_ERROR_SUMMARY_PATTERNS = [
  /^⚠️\s*Worker reply failed\b/i,
  /^⚠️\s*Agent error\b/i,
  /^⚠️\s*Extension error\b/i,
  /^⚠️\s*Context guard error\b/i,
  /^⚠️\s*Compaction error\b/i,
  /^🚨\s*Context recovery failed\b/i,
];

function cloneContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent
  };
}

export function cloneProjectAgentInfoValue(
  projectAgent: AgentDescriptor["projectAgent"] | null | undefined
): AgentDescriptor["projectAgent"] | null | undefined {
  if (!projectAgent) {
    return projectAgent;
  }

  return {
    handle: projectAgent.handle,
    whenToUse: projectAgent.whenToUse,
    // systemPrompt intentionally omitted — fetched via get_project_agent_config
    ...(projectAgent.creatorSessionId !== undefined
      ? { creatorSessionId: projectAgent.creatorSessionId }
      : {}),
    ...(projectAgent.capabilities !== undefined
      ? { capabilities: [...projectAgent.capabilities] }
      : {})
  };
}

function cloneProjectAgentInfo(descriptor: AgentDescriptor): AgentDescriptor["projectAgent"] {
  return cloneProjectAgentInfoValue(descriptor.projectAgent) ?? undefined;
}

export function isCollabSession(
  descriptor: Pick<AgentDescriptor, "sessionSurface"> | null | undefined
): boolean {
  return descriptor?.sessionSurface === "collab";
}

export function getCollabSessionInfo(
  descriptor: Pick<AgentDescriptor, "sessionSurface" | "collab"> | null | undefined
): { workspaceId: string; channelId: string } | null {
  if (descriptor?.sessionSurface !== "collab") {
    return null;
  }

  const collab = descriptor.collab;
  if (!isRecord(collab)) {
    return null;
  }

  if (!isNonEmptyString(collab.workspaceId) || !isNonEmptyString(collab.channelId)) {
    return null;
  }

  return {
    workspaceId: collab.workspaceId,
    channelId: collab.channelId
  };
}

export function assertBuilderSession(
  descriptor: Pick<AgentDescriptor, "agentId" | "sessionSurface"> | null | undefined,
  action = "perform this Builder operation"
): void {
  if (descriptor?.sessionSurface !== "collab") {
    return;
  }

  throw new Error(`Cannot ${action} for collaboration-backed session ${descriptor.agentId}.`);
}

export function assertCollabSession(
  descriptor: Pick<AgentDescriptor, "agentId" | "sessionSurface"> | null | undefined,
  action = "perform this collaboration operation"
): void {
  if (descriptor?.sessionSurface === "collab") {
    return;
  }

  throw new Error(`Cannot ${action} for Builder session ${descriptor?.agentId ?? "unknown"}.`);
}

export function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: cloneContextUsage(descriptor.contextUsage),
    projectAgent: cloneProjectAgentInfo(descriptor),
    collab: descriptor.collab ? { ...descriptor.collab } : undefined,
    ...(descriptor.agentCreatorResult !== undefined
      ? {
          agentCreatorResult: {
            createdAgentId: descriptor.agentCreatorResult.createdAgentId,
            createdHandle: descriptor.agentCreatorResult.createdHandle,
            createdAt: descriptor.agentCreatorResult.createdAt
          }
        }
      : {})
  };
}

export function normalizeContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  if (
    typeof contextUsage.tokens !== "number" ||
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0
  ) {
    return undefined;
  }

  if (
    typeof contextUsage.contextWindow !== "number" ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (typeof contextUsage.percent !== "number" || !Number.isFinite(contextUsage.percent)) {
    return undefined;
  }

  return {
    tokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
    percent: Math.max(0, Math.min(100, contextUsage.percent))
  };
}

export function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}

export function compareRuntimeExtensionSnapshots(
  left: AgentRuntimeExtensionSnapshot,
  right: AgentRuntimeExtensionSnapshot
): number {
  const leftRoleRank = left.role === "manager" ? 0 : 1;
  const rightRoleRank = right.role === "manager" ? 0 : 1;
  if (leftRoleRank !== rightRoleRank) {
    return leftRoleRank - rightRoleRank;
  }

  const leftProfileOrSession = left.profileId ?? left.managerId;
  const rightProfileOrSession = right.profileId ?? right.managerId;
  const byProfileOrSession = leftProfileOrSession.localeCompare(rightProfileOrSession);
  if (byProfileOrSession !== 0) {
    return byProfileOrSession;
  }

  const byManager = left.managerId.localeCompare(right.managerId);
  if (byManager !== 0) {
    return byManager;
  }

  return left.agentId.localeCompare(right.agentId);
}

export function validateAgentDescriptor(value: unknown): AgentDescriptor | string {
  if (!isRecord(value)) {
    return "descriptor must be an object";
  }

  if (!isNonEmptyString(value.agentId)) {
    return "agentId must be a non-empty string";
  }

  if (typeof value.displayName !== "string") {
    return "displayName must be a string";
  }

  if (!isNonEmptyString(value.role) || !VALID_PERSISTED_AGENT_ROLES.has(value.role)) {
    return "role must be one of manager|worker";
  }

  if (!isNonEmptyString(value.managerId)) {
    return "managerId must be a non-empty string";
  }

  if (value.creatorAgentId !== undefined && typeof value.creatorAgentId !== "string") {
    return "creatorAgentId must be a string when provided";
  }

  if (!isNonEmptyString(value.status) || !VALID_PERSISTED_AGENT_STATUSES.has(value.status)) {
    return "status must be one of idle|streaming|terminated|stopped|error|stopped_on_restart";
  }
  const normalizedStatus = normalizeAgentStatus(value.status as AgentStatusInput);

  if (!isNonEmptyString(value.createdAt)) {
    return "createdAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.updatedAt)) {
    return "updatedAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.cwd)) {
    return "cwd must be a non-empty string";
  }

  if (!isNonEmptyString(value.sessionFile)) {
    return "sessionFile must be a non-empty string";
  }

  const model = value.model;
  if (!isRecord(model)) {
    return "model must be an object";
  }

  if (!isNonEmptyString(model.provider)) {
    return "model.provider must be a non-empty string";
  }

  if (!isNonEmptyString(model.modelId)) {
    return "model.modelId must be a non-empty string";
  }

  if (!isNonEmptyString(model.thinkingLevel)) {
    return "model.thinkingLevel must be a non-empty string";
  }

  if (value.archetypeId !== undefined && typeof value.archetypeId !== "string") {
    return "archetypeId must be a string when provided";
  }

  if (
    value.sessionPurpose !== undefined &&
    value.sessionPurpose !== "cortex_review" &&
    value.sessionPurpose !== "agent_creator"
  ) {
    return 'sessionPurpose must be "cortex_review" or "agent_creator" when provided';
  }

  if (
    value.sessionSurface !== undefined &&
    (!isNonEmptyString(value.sessionSurface) || !VALID_PERSISTED_SESSION_SURFACES.has(value.sessionSurface))
  ) {
    return 'sessionSurface must be "builder" or "collab" when provided';
  }

  if (value.collab !== undefined) {
    if (!isRecord(value.collab)) {
      return "collab must be an object when provided";
    }

    if (!isNonEmptyString(value.collab.workspaceId)) {
      return "collab.workspaceId must be a non-empty string";
    }

    if (!isNonEmptyString(value.collab.channelId)) {
      return "collab.channelId must be a non-empty string";
    }
  }

  if (value.sessionSurface === "collab" && value.collab === undefined) {
    return 'collab metadata is required when sessionSurface is "collab"';
  }

  if (value.sessionSurface !== "collab" && value.collab !== undefined) {
    return 'collab metadata must be omitted unless sessionSurface is "collab"';
  }

  if (value.sessionSystemPrompt !== undefined && typeof value.sessionSystemPrompt !== "string") {
    return "sessionSystemPrompt must be a string when provided";
  }

  if (
    value.modelOrigin !== undefined &&
    value.modelOrigin !== "profile_default" &&
    value.modelOrigin !== "session_override"
  ) {
    return 'modelOrigin must be "profile_default" or "session_override" when provided';
  }

  if (value.pinnedAt !== undefined && typeof value.pinnedAt !== "string") {
    return "pinnedAt must be a string when provided";
  }

  let normalizedProjectAgentHandle: string | undefined;
  if (value.projectAgent !== undefined) {
    if (!isRecord(value.projectAgent)) {
      return "projectAgent must be an object when provided";
    }

    if (!isNonEmptyString(value.projectAgent.handle)) {
      return "projectAgent.handle must be a non-empty string";
    }

    try {
      normalizedProjectAgentHandle = sanitizePersistedPathSegment(value.projectAgent.handle);
    } catch {
      return "projectAgent.handle must be a safe single path segment";
    }

    if (!isNonEmptyString(value.projectAgent.whenToUse)) {
      return "projectAgent.whenToUse must be a non-empty string";
    }

    if (
      value.projectAgent.systemPrompt !== undefined &&
      typeof value.projectAgent.systemPrompt !== "string"
    ) {
      return "projectAgent.systemPrompt must be a string when provided";
    }

    if (
      value.projectAgent.creatorSessionId !== undefined &&
      typeof value.projectAgent.creatorSessionId !== "string"
    ) {
      return "projectAgent.creatorSessionId must be a string when provided";
    }

    if (value.projectAgent.capabilities !== undefined) {
      if (!Array.isArray(value.projectAgent.capabilities)) {
        return "projectAgent.capabilities must be an array when provided";
      }

      for (const capability of value.projectAgent.capabilities) {
        if (typeof capability !== "string" || !VALID_PERSISTED_PROJECT_AGENT_CAPABILITIES.has(capability)) {
          return "projectAgent.capabilities contains an unknown capability";
        }
      }
    }
  }

  if (value.agentCreatorResult !== undefined) {
    if (!isRecord(value.agentCreatorResult)) {
      return "agentCreatorResult must be an object when provided";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdAgentId)) {
      return "agentCreatorResult.createdAgentId must be a non-empty string";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdHandle)) {
      return "agentCreatorResult.createdHandle must be a non-empty string";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdAt)) {
      return "agentCreatorResult.createdAt must be a non-empty string";
    }
  }

  const descriptor = value as unknown as AgentDescriptor;
  const normalizedProjectAgent =
    descriptor.projectAgent && normalizedProjectAgentHandle && descriptor.projectAgent.handle !== normalizedProjectAgentHandle
      ? {
          ...descriptor.projectAgent,
          handle: normalizedProjectAgentHandle
        }
      : descriptor.projectAgent;

  if (descriptor.status === normalizedStatus && normalizedProjectAgent === descriptor.projectAgent) {
    return descriptor;
  }

  return {
    ...descriptor,
    status: normalizedStatus,
    ...(normalizedProjectAgent !== descriptor.projectAgent ? { projectAgent: normalizedProjectAgent } : {})
  };
}

export function extractDescriptorAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isNonEmptyString(value.agentId) ? value.agentId.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function parseSessionNumberFromAgentId(agentId: string, profileId: string): number | undefined {
  if (!agentId.startsWith(`${profileId}${SESSION_ID_SUFFIX_SEPARATOR}`)) {
    return undefined;
  }

  const rawSessionNumber = agentId.slice(`${profileId}${SESSION_ID_SUFFIX_SEPARATOR}`.length);
  if (!/^[0-9]+$/.test(rawSessionNumber)) {
    return undefined;
  }

  const sessionNumber = Number.parseInt(rawSessionNumber, 10);
  if (!Number.isFinite(sessionNumber) || sessionNumber <= ROOT_SESSION_NUMBER) {
    return undefined;
  }

  return sessionNumber;
}

export function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeAgentId(input: string): string {
  const trimmed = input.trim();
  if (/[/\\\x00]/.test(trimmed)) {
    throw new Error(`agentId contains invalid characters: "${trimmed}"`);
  }

  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function normalizeOptionalAgentId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeOptionalModelId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildModelCapacityBlockKey(provider: string, modelId: string): string | undefined {
  const normalizedProvider = normalizeOptionalAgentId(provider)?.toLowerCase();
  const normalizedModelId = normalizeOptionalModelId(modelId)?.toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return undefined;
  }

  return `${normalizedProvider}/${normalizedModelId}`;
}

export function resolveNextCapacityFallbackModelId(provider: string, modelId: string): string | undefined {
  const normalizedProvider = normalizeOptionalAgentId(provider)?.toLowerCase();
  const normalizedModelId = normalizeOptionalModelId(modelId)?.toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return undefined;
  }

  if (normalizedProvider !== "openai-codex") {
    return undefined;
  }

  const index = OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN.indexOf(normalizedModelId);
  if (index < 0 || index + 1 >= OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN.length) {
    return undefined;
  }

  return OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN[index + 1];
}

export function shouldRetrySpecialistSpawnWithFallback(
  error: unknown,
  attemptedModel: Pick<AgentModelDescriptor, "provider" | "modelId">
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const capacity = classifyRuntimeCapacityError(message);
  if (capacity.isQuotaOrRateLimit) {
    return true;
  }

  const normalizedMessage = message.trim().toLowerCase();
  const authIndicators = [
    "authentication",
    "unauthorized",
    "invalid api key",
    "api key",
    "missing auth",
    "no auth",
    "forbidden",
    "permission denied",
    "access denied",
    "oauth"
  ];

  const isAuthError = authIndicators.some((indicator) => normalizedMessage.includes(indicator));
  if (isAuthError) {
    return true;
  }

  const provider = attemptedModel.provider.trim().toLowerCase();
  const modelId = attemptedModel.modelId.trim().toLowerCase();

  return normalizedMessage.includes(provider) && normalizedMessage.includes(modelId) && normalizedMessage.includes("auth");
}

export function clampModelCapacityBlockDurationMs(durationMs: number): number | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }

  const rounded = Math.round(durationMs);
  if (rounded < 5_000) {
    return 5_000;
  }

  if (rounded > 7 * 24 * 60 * 60 * 1_000) {
    return 7 * 24 * 60 * 60 * 1_000;
  }

  return rounded;
}

export function normalizeThinkingLevelForProvider(provider: string, thinkingLevel: string): string {
  if (provider.trim().toLowerCase() !== "anthropic") {
    return thinkingLevel;
  }

  const normalized = thinkingLevel.trim().toLowerCase();
  if (normalized === "none") {
    return "low";
  }

  if (normalized === "xhigh" || normalized === "x-high") {
    return "high";
  }

  return thinkingLevel;
}

/** @visibleForTesting Root/profile memory composition is part of the Phase 3 ownership contract. */
export function buildSessionMemoryRuntimeView(profileMemoryContent: string, sessionMemoryContent: string): string {
  const normalizedProfileMemory = profileMemoryContent.trimEnd();
  const normalizedSessionMemory = sessionMemoryContent.trimEnd();

  return [
    "# Manager Memory (shared across all sessions — read-only reference)",
    "",
    normalizedProfileMemory,
    "",
    "---",
    "",
    "# Session Memory (this session's working memory — your writes go here)",
    "",
    normalizedSessionMemory
  ].join("\n");
}

export function normalizeMemoryMergeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

export function finalizeMergedMemoryContent(content: string): string {
  const normalized = normalizeMemoryMergeContent(content);
  return normalized.length > 0 ? `${normalized}\n` : "";
}

export function hashMemoryMergeContent(content: string): string {
  return createHash("sha256").update(normalizeMemoryMergeContent(content)).digest("hex");
}

export function isPostApplyFailureStage(stage: SessionMemoryMergeFailureStage): boolean {
  return (
    stage === "refresh_session_meta_stats" ||
    stage === "record_attempt" ||
    stage === "write_audit" ||
    stage === "save_store"
  );
}

export function resolveExactModel(
  modelRegistry: ModelRegistry,
  descriptor: AgentModelDescriptor
): Model<Api> | undefined {
  const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
  if (direct) {
    return direct;
  }

  const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
  if (fromCatalog) {
    return fromCatalog as Model<Api>;
  }

  return synthesizeCatalogBackedPiModel(descriptor);
}

export function resolveModel(
  modelRegistry: ModelRegistry,
  descriptor: AgentModelDescriptor
): Model<Api> | undefined {
  return resolveExactModel(modelRegistry, descriptor) ?? modelRegistry.getAll()[0];
}

function synthesizeCatalogBackedPiModel(descriptor: AgentModelDescriptor): Model<Api> | undefined {
  const blueprintModelId = SYNTHETIC_PI_MODEL_BLUEPRINTS[descriptor.provider]?.[descriptor.modelId];
  if (!blueprintModelId) {
    return undefined;
  }

  const catalogModel = modelCatalogService.getModel(descriptor.modelId, descriptor.provider);
  if (!catalogModel) {
    return undefined;
  }

  const blueprint =
    (getModel(descriptor.provider as any, blueprintModelId as any) as Model<Api> | undefined) ??
    (getModels(descriptor.provider as any) as Model<Api>[]).find((model) => model.id === blueprintModelId);
  if (!blueprint) {
    return undefined;
  }

  return {
    ...blueprint,
    id: catalogModel.modelId,
    name: catalogModel.displayName,
    reasoning: catalogModel.supportsReasoning,
    input: [...catalogModel.inputModes],
    contextWindow:
      modelCatalogService.getEffectiveContextWindow(catalogModel.modelId, catalogModel.provider) ??
      catalogModel.contextWindow,
    maxTokens: catalogModel.maxOutputTokens
  };
}

export function buildWorkerCompletionReport(
  agentId: string,
  history: ConversationEntryEvent[]
): { message: string; summaryTimestamp?: number; summaryKey?: string } {
  const latestSummary = findLatestWorkerCompletionSummary(history);
  if (!latestSummary) {
    return {
      message: `SYSTEM: Worker ${agentId} completed its turn.`
    };
  }

  const summaryTimestamp = parseTimestampToMillis(latestSummary.timestamp);
  const summaryKey = buildWorkerCompletionSummaryKey(latestSummary);
  const summaryText = truncateWorkerCompletionText(
    latestSummary.text,
    MAX_WORKER_COMPLETION_REPORT_CHARS
  );
  const attachmentCount = latestSummary.attachments?.length ?? 0;
  const attachmentLine =
    attachmentCount > 0
      ? `\n\nAttachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}.`
      : "";
  const turnOutcomeLine = isWorkerErrorSummary(latestSummary)
    ? `SYSTEM: Worker ${agentId} ended its turn with an error.`
    : `SYSTEM: Worker ${agentId} completed its turn.`;

  if (summaryText.length > 0) {
    return {
      message: [
        turnOutcomeLine,
        "",
        `${latestSummary.role === "system" ? "Last system message" : "Last assistant message"}:`,
        summaryText
      ].join("\n") + attachmentLine,
      summaryTimestamp,
      summaryKey
    };
  }

  if (attachmentCount > 0) {
    return {
      message: isWorkerErrorSummary(latestSummary)
        ? `SYSTEM: Worker ${agentId} ended its turn with an error and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`
        : `SYSTEM: Worker ${agentId} completed its turn and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`,
      summaryTimestamp,
      summaryKey
    };
  }

  return {
    message: turnOutcomeLine,
    summaryTimestamp,
    summaryKey
  };
}

function findLatestWorkerCompletionSummary(
  history: ConversationEntryEvent[]
): ConversationMessageEvent | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message") {
      continue;
    }

    if (entry.role !== "assistant" && entry.role !== "system") {
      continue;
    }

    const trimmedText = entry.text.trim();
    const attachmentCount = entry.attachments?.length ?? 0;
    if (trimmedText.length === 0 && attachmentCount === 0) {
      continue;
    }

    return entry;
  }

  return undefined;
}

function buildWorkerCompletionSummaryKey(entry: ConversationMessageEvent): string {
  return createHash("sha256").update(JSON.stringify({
    role: entry.role,
    text: entry.text,
    attachmentCount: entry.attachments?.length ?? 0,
    timestamp: entry.timestamp
  })).digest("hex");
}

function isWorkerErrorSummary(entry: ConversationMessageEvent): boolean {
  if (entry.role !== "system") {
    return false;
  }

  const trimmed = entry.text.trim();
  return WORKER_ERROR_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function truncateWorkerCompletionText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const availableChars = Math.max(0, maxChars - WORKER_COMPLETION_TRUNCATION_SUFFIX.length);
  let truncated = trimmed.slice(0, availableChars).trimEnd();

  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(" "));
  if (lastBreak > Math.floor(availableChars * 0.6)) {
    truncated = truncated.slice(0, lastBreak).trimEnd();
  }

  return `${truncated}${WORKER_COMPLETION_TRUNCATION_SUFFIX}`;
}

export function normalizeCortexUserVisiblePaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:)?(?:[\\/][^,\s`]+)+[\\/]profiles(?:[\\/][^,\s`]+)+/g, (matchedPath) => {
    const normalized = matchedPath.replace(/\\/g, "/");
    const profilesIndex = normalized.toLowerCase().lastIndexOf("/profiles/");
    if (profilesIndex < 0) {
      return matchedPath;
    }

    return normalized.slice(profilesIndex + 1);
  });
}

export function analyzeLatestCortexCloseoutNeed(
  history: ConversationEntryEvent[]
): { needsReminder: boolean; userTimestamp?: number; reason?: "missing_speak_to_user" | "stale_after_worker_progress" } {
  let latestUserIndex = -1;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type === "conversation_message" && entry.role === "user" && entry.source === "user_input") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return { needsReminder: false };
  }

  const latestUserEntry = history[latestUserIndex];
  const userTimestamp =
    latestUserEntry.type === "conversation_message"
      ? parseTimestampToMillis(latestUserEntry.timestamp)
      : undefined;

  let lastSpeakToUserTimestamp: number | undefined;
  for (let index = latestUserIndex + 1; index < history.length; index += 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message" || entry.source !== "speak_to_user") {
      continue;
    }

    const timestamp = parseTimestampToMillis(entry.timestamp);
    if (typeof timestamp === "number") {
      lastSpeakToUserTimestamp = timestamp;
    }
  }

  if (typeof lastSpeakToUserTimestamp !== "number") {
    return {
      needsReminder: true,
      userTimestamp,
      reason: "missing_speak_to_user"
    };
  }

  for (let index = latestUserIndex + 1; index < history.length; index += 1) {
    const entry = history[index];
    if (!isCortexCloseoutFollowUpEntry(entry)) {
      continue;
    }

    const timestamp = parseTimestampToMillis(entry.timestamp);
    if (typeof timestamp === "number" && timestamp > lastSpeakToUserTimestamp) {
      return {
        needsReminder: true,
        userTimestamp,
        reason: "stale_after_worker_progress"
      };
    }
  }

  return {
    needsReminder: false,
    userTimestamp
  };
}

function isCortexCloseoutFollowUpEntry(entry: ConversationEntryEvent): boolean {
  return entry.type === "agent_message" && entry.source === "agent_to_agent";
}

export function parseTimestampToMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatToolExecutionPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return safeJson(value);
}

export function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars);
}

export function trimToMaxCharsFromEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

export function toDisplayToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (normalized.length === 0) {
    return "Unknown";
  }

  return normalized
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function readPositiveIntegerDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

export function readStringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined
    });
  }

  return normalized;
}

export function toConversationAttachmentMetadata(
  attachments: ConversationAttachment[],
  uploadsDir: string
): ConversationAttachmentMetadata[] {
  const metadata: ConversationAttachmentMetadata[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const normalizedName = normalizeOptionalMetadataValue(attachment.fileName);
    const fileRef = resolveAttachmentFileRef(attachment.filePath, uploadsDir);
    const sizeBytes = computeAttachmentSizeBytes(attachment);

    if (isConversationTextAttachment(attachment)) {
      metadata.push({
        type: "text",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
      continue;
    }

    if (isConversationBinaryAttachment(attachment)) {
      metadata.push({
        type: "binary",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
      continue;
    }

    if (isConversationImageAttachment(attachment)) {
      metadata.push({
        type: "image",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
    }
  }

  return metadata;
}

export function toRuntimeDispatchAttachments(
  attachments: ConversationAttachment[],
  persistedAttachments: ConversationAttachment[]
): ConversationAttachment[] {
  return attachments.map((attachment, index) => {
    const persistedAttachment = persistedAttachments[index];
    const persistedPath = normalizeOptionalAttachmentPath(persistedAttachment?.filePath);
    if (!persistedAttachment || !persistedPath) {
      return attachment;
    }

    return {
      ...attachment,
      filePath: persistedPath
    };
  });
}

export async function withManagerTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function computeAttachmentSizeBytes(attachment: ConversationAttachment): number | undefined {
  if (isConversationTextAttachment(attachment)) {
    return Buffer.byteLength(attachment.text, "utf8");
  }

  if (isConversationBinaryAttachment(attachment) || isConversationImageAttachment(attachment)) {
    return decodeBase64ByteLength(attachment.data);
  }

  return undefined;
}

function decodeBase64ByteLength(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  let padding = 0;
  if (trimmed.endsWith("==")) {
    padding = 2;
  } else if (trimmed.endsWith("=")) {
    padding = 1;
  }

  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

export function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

export function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

export function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

export function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

export function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

export function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveAttachmentFileRef(path: string | undefined, uploadsDir: string): string | undefined {
  const normalizedPath = normalizeOptionalAttachmentPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const resolvedPath = resolve(normalizedPath);
  const resolvedUploadsDir = resolve(uploadsDir);
  if (dirname(resolvedPath) !== resolvedUploadsDir) {
    return undefined;
  }

  return basename(resolvedPath);
}

export function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

export function formatInboundUserMessageForManager(
  text: string,
  sourceContext: MessageSourceContext,
): string {
  const metadataBlock = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return metadataBlock;
  }

  return `${metadataBlock}\n\n${trimmed}`;
}

export function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

export function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel: input.channel === "telegram" ? input.channel : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

export function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel: input.channel === "telegram" ? input.channel : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

export function normalizeMemoryTemplateLines(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .filter((line) => line.length > 0)
}

export function escapeXmlForPreview(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nowIso(): string {
  return new Date().toISOString()
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isVersionedWriteToolName(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

export function extractVersionedToolPath(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return extractVersionedToolPath(JSON.parse(trimmed), depth + 1);
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = extractVersionedToolPath(entry, depth + 1);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["path", "filePath"]) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return record[key].trim();
    }
  }

  for (const nestedKey of ["args", "arguments", "result", "payload", "input", "data", "preview", "content"]) {
    if (!(nestedKey in record)) {
      continue;
    }

    const candidate = extractVersionedToolPath(record[nestedKey], depth + 1);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

export async function readFileHead(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}
