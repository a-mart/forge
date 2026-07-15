import {
  isConversationMessageSource,
  MODEL_CACHE_CLASSIFICATION_VERSION,
  MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS,
  MODEL_CACHE_HIT_RATIO_THRESHOLD,
  MODEL_CACHE_PROVIDERS,
  MODEL_CACHE_STATUSES,
  MODEL_CACHE_TOKEN_NORMALIZATIONS,
  type ConversationReplyTarget,
  type ModelCacheObservationEvent,
  type PlanSummaryEvent,
} from "@forge/protocol";
import {
  areModelCacheTokenFactsConsistent,
  isModelCacheClassificationConsistent,
} from "../runtime/model-cache-observation.js";
import type {
  ActivitySummaryEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
  ChoiceRequestEvent,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationImageAttachment,
  ConversationLogEvent,
  ConversationMessageAttachment,
  ConversationMessageEvent,
  ConversationTextAttachment,
  ExternalThreadMessageContext,
  MessageSourceContext,
  ProjectAgentMessageContext
} from "../types.js";

const EXTERNAL_THREAD_MESSAGE_STATUSES = [
  "sent",
  "running",
  "completed",
  "stopped",
  "error",
] as const;

export function isConversationEntryEvent(value: unknown): value is ConversationEntryEvent {
  return isConversationTimelineMetadata(value) && (
    isConversationMessageEvent(value) ||
    isConversationLogEvent(value) ||
    isAgentMessageEvent(value) ||
    isAgentToolCallEvent(value) ||
    isActivitySummaryEvent(value) ||
    isChoiceRequestEvent(value) ||
    isPlanSummaryEvent(value) ||
    isModelCacheObservationEvent(value)
  );
}

function isConversationTimelineMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { timelineEntryId?: unknown; timelineSequence?: unknown };
  if (maybe.timelineEntryId !== undefined && !isNonEmptyString(maybe.timelineEntryId)) return false;
  if (
    maybe.timelineSequence !== undefined &&
    (!Number.isSafeInteger(maybe.timelineSequence) || (maybe.timelineSequence as number) < 0)
  ) return false;
  return true;
}

function isActivitySummaryEvent(value: unknown): value is ActivitySummaryEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ActivitySummaryEvent>;
  if (maybe.type !== "activity_summary" || maybe.schemaVersion !== 1) return false;
  if (!isNonEmptyString(maybe.itemId) || !isNonEmptyString(maybe.agentId)) return false;
  if (!isNonEmptyString(maybe.actorAgentId) || !isNonEmptyString(maybe.timestamp)) return false;
  if (maybe.turnId !== undefined && !isNonEmptyString(maybe.turnId)) return false;
  if (maybe.kind !== "tool_activity") return false;
  if (maybe.status !== "completed" && maybe.status !== "failed" && maybe.status !== "interrupted") return false;
  if (maybe.toolName !== undefined && !isNonEmptyString(maybe.toolName)) return false;
  if (maybe.correlationId !== undefined && !isNonEmptyString(maybe.correlationId)) return false;
  if (!isNonEmptyString(maybe.displaySummary) || maybe.displaySummary.length > 512) return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;
  return true;
}

function isPlanSummaryEvent(value: unknown): value is PlanSummaryEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<PlanSummaryEvent>;
  if (maybe.type !== "plan_summary") return false;
  if (!isNonEmptyString(maybe.id) || !isNonEmptyString(maybe.agentId)) return false;
  if (!isNonEmptyString(maybe.timestamp) || !isNonEmptyString(maybe.updatedAt)) return false;
  if (!isNonNegativeInteger(maybe.revision) || !Array.isArray(maybe.plan) || maybe.plan.length === 0) return false;
  if (maybe.explanation !== undefined && !isNonEmptyString(maybe.explanation)) return false;

  const validSteps = maybe.plan.every((step) => {
    if (!step || typeof step !== "object") return false;
    const item = step as { step?: unknown; status?: unknown };
    return isNonEmptyString(item.step) && (
      item.status === "pending" || item.status === "in_progress" || item.status === "completed"
    );
  });
  if (!validSteps) return false;
  if (maybe.state !== undefined && maybe.state !== "active" && maybe.state !== "completed") return false;
  return maybe.state === "active" || maybe.plan.every((step) => step.status === "completed");
}

function isConversationMessageEvent(value: unknown): value is ConversationMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationMessageEvent>;
  if (maybe.type !== "conversation_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (maybe.turnId !== undefined && (typeof maybe.turnId !== "string" || maybe.turnId.trim().length === 0)) {
    return false;
  }
  if (maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") return false;
  if (typeof maybe.id !== "undefined" && (typeof maybe.id !== "string" || maybe.id.trim().length === 0)) {
    return false;
  }
  if (typeof maybe.text !== "string") return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (!isConversationMessageSource(maybe.source)) return false;
  if (!isConversationMessageRoleSourcePair(maybe.role, maybe.source)) return false;

  if (maybe.attachments !== undefined) {
    if (!Array.isArray(maybe.attachments)) {
      return false;
    }

    for (const attachment of maybe.attachments) {
      if (!isConversationMessageAttachment(attachment)) {
        return false;
      }
    }
  }

  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) {
    return false;
  }

  if (maybe.projectAgentContext !== undefined && !isProjectAgentMessageContext(maybe.projectAgentContext)) {
    return false;
  }

  if (maybe.externalThreadContext !== undefined && !isExternalThreadMessageContext(maybe.externalThreadContext)) {
    return false;
  }

  if (maybe.terminal !== undefined && typeof maybe.terminal !== "boolean") {
    return false;
  }

  if (maybe.sourceWorkerId !== undefined && (typeof maybe.sourceWorkerId !== "string" || maybe.sourceWorkerId.trim().length === 0)) {
    return false;
  }

  if (maybe.excludeFromModelContext !== undefined && maybe.excludeFromModelContext !== true) {
    return false;
  }

  if (maybe.pinned !== undefined && typeof maybe.pinned !== "boolean") {
    return false;
  }

  if (maybe.replyTo !== undefined && !isConversationReplyTarget(maybe.replyTo)) {
    return false;
  }

  if (maybe.systemNoticeKind !== undefined && maybe.systemNoticeKind !== "worker_outcome_backstop") {
    return false;
  }

  return true;
}

function isConversationReplyTarget(value: unknown): value is ConversationReplyTarget {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationReplyTarget>;
  if (typeof maybe.messageId !== "string" || maybe.messageId.trim().length === 0) {
    return false;
  }

  if (maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") {
    return false;
  }

  if (typeof maybe.timestamp !== "string" || maybe.timestamp.trim().length === 0) {
    return false;
  }

  if (typeof maybe.text !== "string") {
    return false;
  }

  if (maybe.source !== undefined && !isConversationMessageSource(maybe.source)) {
    return false;
  }

  if (maybe.source !== undefined && !isConversationMessageRoleSourcePair(maybe.role, maybe.source)) {
    return false;
  }

  if (
    maybe.attachmentCount !== undefined &&
    (typeof maybe.attachmentCount !== "number" ||
      !Number.isInteger(maybe.attachmentCount) ||
      maybe.attachmentCount < 0)
  ) {
    return false;
  }

  if (maybe.truncated !== undefined && typeof maybe.truncated !== "boolean") {
    return false;
  }

  return true;
}

function isConversationMessageRoleSourcePair(
  role: ConversationMessageEvent["role"],
  source: ConversationMessageEvent["source"],
): boolean {
  switch (source) {
    case "speak_to_user":
    case "assistant_output":
    case "assistant_progress":
      return role === "assistant";
    case "user_input":
    case "project_agent_input":
      return role === "user";
    case "system":
      return role === "system" || role === "assistant";
    case "worker_report":
      return role === "system";
    default:
      return false;
  }
}

function isMessageSourceContext(value: unknown): value is MessageSourceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<MessageSourceContext>;

  if (maybe.channel !== "web" && maybe.channel !== "telegram" && maybe.channel !== "cli") {
    return false;
  }

  if (maybe.channelId !== undefined && typeof maybe.channelId !== "string") {
    return false;
  }

  if (maybe.userId !== undefined && typeof maybe.userId !== "string") {
    return false;
  }

  if (maybe.messageId !== undefined && typeof maybe.messageId !== "string") {
    return false;
  }

  if (maybe.threadTs !== undefined && typeof maybe.threadTs !== "string") {
    return false;
  }

  if (maybe.integrationProfileId !== undefined && typeof maybe.integrationProfileId !== "string") {
    return false;
  }

  if (
    maybe.channelType !== undefined &&
    maybe.channelType !== "dm" &&
    maybe.channelType !== "channel" &&
    maybe.channelType !== "group" &&
    maybe.channelType !== "mpim"
  ) {
    return false;
  }

  if (maybe.teamId !== undefined && typeof maybe.teamId !== "string") {
    return false;
  }

  return true;
}

function isProjectAgentMessageContext(value: unknown): value is ProjectAgentMessageContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ProjectAgentMessageContext>;
  if (typeof maybe.fromAgentId !== "string" || typeof maybe.fromDisplayName !== "string") {
    return false;
  }

  if (maybe.external !== undefined && typeof maybe.external !== "boolean") {
    return false;
  }

  if (maybe.fromProfileId !== undefined && typeof maybe.fromProfileId !== "string") {
    return false;
  }

  if (maybe.fromProjectName !== undefined && typeof maybe.fromProjectName !== "string") {
    return false;
  }

  return true;
}

function isExternalThreadMessageContext(value: unknown): value is ExternalThreadMessageContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ExternalThreadMessageContext>;
  if (maybe.type !== "codex_app_server") {
    return false;
  }
  if (typeof maybe.sidecarAgentId !== "string" || maybe.sidecarAgentId.length === 0) {
    return false;
  }
  if (typeof maybe.requestId !== "string" || maybe.requestId.length === 0) {
    return false;
  }
  if (typeof maybe.turnCorrelationId !== "string" || maybe.turnCorrelationId.length === 0) {
    return false;
  }
  if (maybe.threadId !== undefined && typeof maybe.threadId !== "string") {
    return false;
  }
  if (maybe.promptPreview !== undefined && typeof maybe.promptPreview !== "string") {
    return false;
  }
  if (maybe.resultPreview !== undefined && typeof maybe.resultPreview !== "string") {
    return false;
  }
  if (
    maybe.status === undefined ||
    !(EXTERNAL_THREAD_MESSAGE_STATUSES as readonly string[]).includes(maybe.status)
  ) {
    return false;
  }
  if (maybe.detailMessageId !== undefined && typeof maybe.detailMessageId !== "string") {
    return false;
  }
  if (maybe.excludeFromModelContext !== true) {
    return false;
  }

  return true;
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return (
    isConversationImageAttachment(value) ||
    isConversationTextAttachment(value) ||
    isConversationBinaryAttachment(value)
  );
}

function isConversationMessageAttachment(value: unknown): value is ConversationMessageAttachment {
  return isConversationAttachment(value) || isConversationAttachmentMetadata(value);
}

function isConversationAttachmentMetadata(value: unknown): value is ConversationAttachmentMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationAttachmentMetadata>;

  if (
    maybe.type !== undefined &&
    maybe.type !== "image" &&
    maybe.type !== "text" &&
    maybe.type !== "binary"
  ) {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  if (maybe.fileRef !== undefined && typeof maybe.fileRef !== "string") {
    return false;
  }

  if (
    maybe.sizeBytes !== undefined &&
    (typeof maybe.sizeBytes !== "number" || !Number.isFinite(maybe.sizeBytes) || maybe.sizeBytes < 0)
  ) {
    return false;
  }

  return true;
}

export function isConversationImageAttachment(value: unknown): value is ConversationImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationImageAttachment> & { type?: unknown };
  if (maybe.type !== undefined && maybe.type !== "image") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || !maybe.mimeType.startsWith("image/")) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

export function isConversationTextAttachment(value: unknown): value is ConversationTextAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationTextAttachment>;
  if (maybe.type !== "text") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

export function isConversationBinaryAttachment(value: unknown): value is ConversationBinaryAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationBinaryAttachment>;
  if (maybe.type !== "binary") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

function isConversationLogEvent(value: unknown): value is ConversationLogEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationLogEvent>;
  if (maybe.type !== "conversation_log") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "runtime_log") return false;

  if (
    maybe.kind !== "message_start" &&
    maybe.kind !== "message_end" &&
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }

  if (maybe.role !== undefined && maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") {
    return false;
  }

  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}

function isAgentMessageEvent(value: unknown): value is AgentMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentMessageEvent>;
  if (maybe.type !== "agent_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_to_agent" && maybe.source !== "agent_to_agent") return false;
  if (maybe.fromAgentId !== undefined && typeof maybe.fromAgentId !== "string") return false;
  if (typeof maybe.toAgentId !== "string" || maybe.toAgentId.length === 0) return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) return false;
  if (
    maybe.requestedDelivery !== undefined &&
    maybe.requestedDelivery !== "auto" &&
    maybe.requestedDelivery !== "followUp" &&
    maybe.requestedDelivery !== "steer"
  ) {
    return false;
  }
  if (
    maybe.acceptedMode !== undefined &&
    maybe.acceptedMode !== "prompt" &&
    maybe.acceptedMode !== "followUp" &&
    maybe.acceptedMode !== "steer"
  ) {
    return false;
  }
  if (
    maybe.attachmentCount !== undefined &&
    (typeof maybe.attachmentCount !== "number" ||
      !Number.isFinite(maybe.attachmentCount) ||
      maybe.attachmentCount < 0)
  ) {
    return false;
  }
  if (maybe.projectAgentExchange !== undefined && maybe.projectAgentExchange !== true) return false;

  return true;
}

function isChoiceRequestEvent(value: unknown): value is ChoiceRequestEvent {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<ChoiceRequestEvent>;
  if (maybe.type !== "choice_request") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.choiceId !== "string" || maybe.choiceId.length === 0) return false;
  if (!Array.isArray(maybe.questions) || maybe.questions.length === 0) return false;
  if (maybe.status !== "pending" && maybe.status !== "answered" && maybe.status !== "cancelled" && maybe.status !== "expired") return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.status === "answered" && !Array.isArray(maybe.answers)) return false;
  return true;
}

function isModelCacheObservationEvent(value: unknown): value is ModelCacheObservationEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ModelCacheObservationEvent>;
  if (maybe.type !== "model_cache_observation") return false;
  if (!isNonEmptyString(maybe.agentId)) return false;
  if (typeof maybe.id !== "undefined" && !isNonEmptyString(maybe.id)) return false;
  if (!isNonEmptyString(maybe.timestamp)) return false;
  if (maybe.runtimeType !== "pi") return false;
  if (!isStringInSet(maybe.provider, MODEL_CACHE_PROVIDERS)) return false;
  if (!isNonEmptyString(maybe.modelId)) return false;
  if (maybe.api !== undefined && !isNonEmptyString(maybe.api)) return false;
  if (maybe.turnId !== undefined && !isNonEmptyString(maybe.turnId)) return false;
  if (!maybe.tokens || typeof maybe.tokens !== "object") return false;

  const tokens = maybe.tokens;
  if (!isNonNegativeInteger(tokens.promptInputTokens)) return false;
  if (!isNonNegativeInteger(tokens.cachedInputTokens)) return false;
  if (!isNonNegativeInteger(tokens.cacheWriteInputTokens)) return false;
  if (!isNonNegativeInteger(tokens.uncachedInputTokens)) return false;
  if (!isNonNegativeInteger(tokens.outputTokens)) return false;
  if (!isNonNegativeInteger(tokens.totalTokens)) return false;
  if (!isStringInSet(tokens.normalization, MODEL_CACHE_TOKEN_NORMALIZATIONS)) return false;
  if (tokens.promptInputTokens < MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS) return false;

  if (!maybe.classification || typeof maybe.classification !== "object") return false;
  const classification = maybe.classification;
  if (classification.version !== MODEL_CACHE_CLASSIFICATION_VERSION) return false;
  if (!isStringInSet(classification.status, MODEL_CACHE_STATUSES)) return false;
  if (!isFiniteRatio(classification.cachedRatio)) return false;
  if (classification.thresholdTokens !== MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS) return false;
  if (classification.hitRatioThreshold !== MODEL_CACHE_HIT_RATIO_THRESHOLD) return false;
  if (!areModelCacheTokenFactsConsistent(tokens)) return false;
  if (!isModelCacheClassificationConsistent(tokens, classification)) return false;

  return true;
}

function isFiniteRatio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStringInSet<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAgentToolCallEvent(value: unknown): value is AgentToolCallEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentToolCallEvent>;
  if (maybe.type !== "agent_tool_call") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.actorAgentId !== "string" || maybe.actorAgentId.length === 0) return false;
  if (maybe.turnId !== undefined && (typeof maybe.turnId !== "string" || maybe.turnId.trim().length === 0)) {
    return false;
  }
  if (typeof maybe.timestamp !== "string") return false;
  if (
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }
  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}
