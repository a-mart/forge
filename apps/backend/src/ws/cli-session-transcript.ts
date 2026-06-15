import type {
  CliSessionTranscriptAttachment,
  CliSessionTranscriptMessage,
  CliSessionTranscriptResponse,
  ConversationEntryEvent,
  ConversationMessageAttachment,
} from "@forge/protocol";
import type { AgentDescriptor } from "../swarm/types.js";

export const CLI_SESSION_TRANSCRIPT_DEFAULT_LIMIT = 200;
export const CLI_SESSION_TRANSCRIPT_MAX_LIMIT = 2000;

export interface CliSessionTranscriptOptions {
  includeWorkerUpdates: boolean;
  limit: number;
  offset: number;
}

export type CliSessionTranscriptOptionsResult =
  | { ok: true; options: CliSessionTranscriptOptions }
  | { ok: false; status: 400; code: string; message: string };

export function parseCliSessionTranscriptOptions(searchParams: URLSearchParams): CliSessionTranscriptOptionsResult {
  const includeWorkerUpdatesResult = parseOptionalBoolean(searchParams.get("includeWorkerUpdates"));
  if (!includeWorkerUpdatesResult.ok) {
    return {
      ok: false,
      status: 400,
      code: "invalid_include_worker_updates",
      message: "includeWorkerUpdates must be true or false",
    };
  }

  const limitResult = parseBoundedInteger(
    searchParams.get("limit"),
    CLI_SESSION_TRANSCRIPT_DEFAULT_LIMIT,
    1,
    CLI_SESSION_TRANSCRIPT_MAX_LIMIT,
    "limit",
  );
  if (!limitResult.ok) {
    return limitResult;
  }

  const offsetResult = parseBoundedInteger(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (!offsetResult.ok) {
    return offsetResult;
  }

  return {
    ok: true,
    options: {
      includeWorkerUpdates: includeWorkerUpdatesResult.value,
      limit: limitResult.value,
      offset: offsetResult.value,
    },
  };
}

export function buildCliSessionTranscriptResponse(options: {
  session: AgentDescriptor;
  agents: AgentDescriptor[];
  history: ConversationEntryEvent[];
  transcriptOptions: CliSessionTranscriptOptions;
}): CliSessionTranscriptResponse {
  const agentById = new Map(options.agents.map((agent) => [agent.agentId, agent]));
  const messages: CliSessionTranscriptMessage[] = [];

  for (const entry of options.history) {
    const message = mapUserFacingTranscriptMessage(entry, options.session.agentId)
      ?? (options.transcriptOptions.includeWorkerUpdates
        ? mapWorkerUpdateTranscriptMessage(entry, options.session.agentId, agentById)
        : undefined);
    if (!message) {
      continue;
    }

    messages.push({ ...message, ordinal: messages.length });
  }

  const pagedMessages = messages.slice(
    options.transcriptOptions.offset,
    options.transcriptOptions.offset + options.transcriptOptions.limit,
  );
  const nextOffset = options.transcriptOptions.offset + pagedMessages.length;
  const hasMore = nextOffset < messages.length;

  return {
    session: {
      agentId: options.session.agentId,
      ...(options.session.profileId !== undefined ? { profileId: options.session.profileId } : {}),
      displayName: options.session.sessionLabel ?? options.session.displayName,
    },
    options: { ...options.transcriptOptions },
    page: {
      total: messages.length,
      returned: pagedMessages.length,
      offset: options.transcriptOptions.offset,
      limit: options.transcriptOptions.limit,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    },
    messages: pagedMessages,
  };
}

function mapUserFacingTranscriptMessage(
  entry: ConversationEntryEvent,
  sessionAgentId: string,
): Omit<CliSessionTranscriptMessage, "ordinal"> | undefined {
  if (entry.type !== "conversation_message" || entry.agentId !== sessionAgentId) {
    return undefined;
  }

  if (entry.role === "user" && entry.source === "user_input") {
    const attachments = sanitizeTranscriptAttachments(entry.attachments);
    return {
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      timestamp: entry.timestamp,
      kind: "user",
      role: "user",
      source: "user_input",
      text: entry.text,
      agentId: entry.agentId,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  if (entry.role === "assistant" && entry.source === "speak_to_user") {
    const attachments = sanitizeTranscriptAttachments(entry.attachments);
    return {
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      timestamp: entry.timestamp,
      kind: "assistant",
      role: "assistant",
      source: "speak_to_user",
      text: entry.text,
      agentId: entry.agentId,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  return undefined;
}

function mapWorkerUpdateTranscriptMessage(
  entry: ConversationEntryEvent,
  sessionAgentId: string,
  agentById: Map<string, AgentDescriptor>,
): Omit<CliSessionTranscriptMessage, "ordinal"> | undefined {
  if (
    entry.type !== "agent_message"
    || entry.agentId !== sessionAgentId
    || entry.source !== "agent_to_agent"
    || entry.toAgentId !== sessionAgentId
    || !entry.fromAgentId
  ) {
    return undefined;
  }

  const worker = agentById.get(entry.fromAgentId);
  if (!worker || worker.role !== "worker" || worker.managerId !== sessionAgentId) {
    return undefined;
  }

  return {
    timestamp: entry.timestamp,
    kind: "worker_update",
    role: "worker",
    source: "worker_update",
    text: entry.text,
    agentId: entry.agentId,
    fromAgentId: entry.fromAgentId,
    fromDisplayName: resolveWorkerDisplayName(worker),
    toAgentId: entry.toAgentId,
  };
}

function sanitizeTranscriptAttachments(
  attachments: ConversationMessageAttachment[] | undefined,
): CliSessionTranscriptAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  return attachments
    .map((attachment): CliSessionTranscriptAttachment | undefined => {
      if (!attachment || typeof attachment.mimeType !== "string" || attachment.mimeType.length === 0) {
        return undefined;
      }

      return {
        ...(isAllowedAttachmentType(attachment.type) ? { type: attachment.type } : {}),
        mimeType: attachment.mimeType,
        ...sanitizeOptionalFileName(attachment.fileName),
        ...(hasStringProperty(attachment, "fileRef") ? { fileRef: attachment.fileRef } : {}),
        ...(hasFiniteNumberProperty(attachment, "sizeBytes") ? { sizeBytes: attachment.sizeBytes } : {}),
      };
    })
    .filter((attachment): attachment is CliSessionTranscriptAttachment => attachment !== undefined);
}

function resolveWorkerDisplayName(worker: AgentDescriptor): string {
  return worker.specialistDisplayName ?? worker.displayName ?? worker.agentId;
}

function parseOptionalBoolean(rawValue: string | null): { ok: true; value: boolean } | { ok: false } {
  if (rawValue === null || rawValue === "" || rawValue === "false") {
    return { ok: true, value: false };
  }
  if (rawValue === "true") {
    return { ok: true, value: true };
  }
  return { ok: false };
}

function parseBoundedInteger(
  rawValue: string | null,
  defaultValue: number,
  min: number,
  max: number,
  fieldName: "limit" | "offset",
): { ok: true; value: number } | { ok: false; status: 400; code: string; message: string } {
  if (rawValue === null || rawValue === "") {
    return { ok: true, value: defaultValue };
  }

  if (!/^\d+$/.test(rawValue)) {
    return {
      ok: false,
      status: 400,
      code: `invalid_${fieldName}`,
      message: `${fieldName} must be an integer between ${min} and ${max}`,
    };
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      ok: false,
      status: 400,
      code: `invalid_${fieldName}`,
      message: `${fieldName} must be an integer between ${min} and ${max}`,
    };
  }

  return { ok: true, value };
}

function isAllowedAttachmentType(value: unknown): value is "image" | "text" | "binary" | undefined {
  return value === undefined || value === "image" || value === "text" || value === "binary";
}

function sanitizeOptionalFileName(fileName: string | undefined): { fileName?: string } {
  if (typeof fileName !== "string") {
    return {};
  }

  const sanitized = fileName.split(/[\\/]/).pop()?.trim();
  return sanitized ? { fileName: sanitized } : {};
}

function hasStringProperty<TProperty extends string>(
  value: object,
  property: TProperty,
): value is object & Record<TProperty, string> {
  return property in value && typeof (value as Record<TProperty, unknown>)[property] === "string";
}

function hasFiniteNumberProperty<TProperty extends string>(
  value: object,
  property: TProperty,
): value is object & Record<TProperty, number> {
  return property in value
    && typeof (value as Record<TProperty, unknown>)[property] === "number"
    && Number.isFinite((value as Record<TProperty, unknown>)[property]);
}
