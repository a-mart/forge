import type { ClientCommand } from "@forge/protocol";
import { type RawData } from "ws";
import { parseConversationAttachments } from "./attachment-parser.js";
import {
  describeSwarmModelPresets,
  describeSwarmReasoningLevels,
  isSwarmModelPreset,
  isSwarmReasoningLevel
} from "../swarm/model-presets.js";

export type ParsedClientCommand =
  | { ok: true; command: ClientCommand }
  | { ok: false; error: string };

function isValidChoiceAnswer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Record<string, unknown>;
  if (typeof maybe.questionId !== "string" || maybe.questionId.trim().length === 0) return false;
  if (!Array.isArray(maybe.selectedOptionIds)) return false;
  if (maybe.selectedOptionIds.some((id: unknown) => typeof id !== "string" || id.trim().length === 0)) return false;
  if (maybe.text !== undefined && typeof maybe.text !== "string") return false;
  return true;
}

export function parseClientCommand(raw: RawData): ParsedClientCommand {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Command must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Command must be a JSON object" };
  }

  const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

  if (maybe.type === "ping") {
    return { ok: true, command: { type: "ping" } };
  }

  if (maybe.type === "subscribe") {
    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return { ok: false, error: "subscribe.agentId must be a string when provided" };
    }

    const maybeMessageCount = (maybe as { messageCount?: unknown }).messageCount;
    if (maybeMessageCount !== undefined && !isSafeMessageCount(maybeMessageCount)) {
      return { ok: false, error: "subscribe.messageCount must be a positive finite integer" };
    }

    return {
      ok: true,
      command: {
        type: "subscribe",
        agentId: maybe.agentId,
        messageCount: normalizeMessageCount(maybeMessageCount)
      }
    };
  }

  if (maybe.type === "api_proxy") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    const method = (maybe as { method?: unknown }).method;
    const path = (maybe as { path?: unknown }).path;
    const body = (maybe as { body?: unknown }).body;

    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      return { ok: false, error: "api_proxy.requestId must be a non-empty string" };
    }
    if (!isApiProxyMethod(method)) {
      return { ok: false, error: "api_proxy.method must be one of GET|POST|PUT|DELETE" };
    }
    if (typeof path !== "string" || path.trim().length === 0 || !path.trim().startsWith("/")) {
      return { ok: false, error: "api_proxy.path must be a non-empty string starting with /" };
    }
    if (body !== undefined && typeof body !== "string") {
      return { ok: false, error: "api_proxy.body must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "api_proxy",
        requestId: requestId.trim(),
        method,
        path: path.trim(),
        body
      }
    };
  }

  if (maybe.type === "kill_agent") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return { ok: false, error: "kill_agent.agentId must be a non-empty string" };
    }

    return {
      ok: true,
      command: {
        type: "kill_agent",
        agentId: maybe.agentId.trim()
      }
    };
  }

  if (maybe.type === "stop_all_agents") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return { ok: false, error: "stop_all_agents.managerId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "stop_all_agents.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "stop_all_agents",
        managerId: managerId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "create_manager") {
    const name = (maybe as { name?: unknown }).name;
    const cwd = (maybe as { cwd?: unknown }).cwd;
    const model = (maybe as { model?: unknown }).model;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: "create_manager.name must be a non-empty string" };
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return { ok: false, error: "create_manager.cwd must be a non-empty string" };
    }
    if (model !== undefined && !isSwarmModelPreset(model)) {
      return {
        ok: false,
        error: `create_manager.model must be one of ${describeSwarmModelPresets()}`
      };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "create_manager.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "create_manager",
        name: name.trim(),
        cwd,
        model,
        requestId
      }
    };
  }

  if (maybe.type === "delete_manager") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return { ok: false, error: "delete_manager.managerId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "delete_manager.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "delete_manager",
        managerId: managerId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "update_manager_model") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const model = (maybe as { model?: unknown }).model;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return { ok: false, error: "update_manager_model.managerId must be a non-empty string" };
    }
    if (!isSwarmModelPreset(model)) {
      return {
        ok: false,
        error: `update_manager_model.model must be one of ${describeSwarmModelPresets()}`
      };
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return {
        ok: false,
        error: `update_manager_model.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`
      };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "update_manager_model.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "update_manager_model",
        managerId: managerId.trim(),
        model,
        reasoningLevel,
        requestId
      }
    };
  }

  if (maybe.type === "create_session") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const label = (maybe as { label?: unknown }).label;
    const name = (maybe as { name?: unknown }).name;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return { ok: false, error: "create_session.profileId must be a non-empty string" };
    }
    if (label !== undefined && typeof label !== "string") {
      return { ok: false, error: "create_session.label must be a string when provided" };
    }
    if (name !== undefined && typeof name !== "string") {
      return { ok: false, error: "create_session.name must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "create_session.requestId must be a string when provided" };
    }

    const normalizedLabel = label?.trim();
    const normalizedName = name?.trim();

    return {
      ok: true,
      command: {
        type: "create_session",
        profileId: profileId.trim(),
        label: normalizedLabel ? normalizedLabel : undefined,
        name: normalizedName ? normalizedName : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "stop_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "stop_session.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "stop_session.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "stop_session",
        agentId: agentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "resume_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "resume_session.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "resume_session.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "resume_session",
        agentId: agentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "delete_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "delete_session.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "delete_session.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "delete_session",
        agentId: agentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "clear_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "clear_session.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "clear_session.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "clear_session",
        agentId: agentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "rename_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const label = (maybe as { label?: unknown }).label;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "rename_session.agentId must be a non-empty string" };
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      return { ok: false, error: "rename_session.label must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "rename_session.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "rename_session",
        agentId: agentId.trim(),
        label: label.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "fork_session") {
    const sourceAgentId = (maybe as { sourceAgentId?: unknown }).sourceAgentId;
    const label = (maybe as { label?: unknown }).label;
    const fromMessageId = (maybe as { fromMessageId?: unknown }).fromMessageId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sourceAgentId !== "string" || sourceAgentId.trim().length === 0) {
      return { ok: false, error: "fork_session.sourceAgentId must be a non-empty string" };
    }
    if (label !== undefined && typeof label !== "string") {
      return { ok: false, error: "fork_session.label must be a string when provided" };
    }
    if (fromMessageId !== undefined && typeof fromMessageId !== "string") {
      return { ok: false, error: "fork_session.fromMessageId must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "fork_session.requestId must be a string when provided" };
    }

    const normalizedLabel = label?.trim();
    const normalizedFromMessageId = fromMessageId?.trim();

    return {
      ok: true,
      command: {
        type: "fork_session",
        sourceAgentId: sourceAgentId.trim(),
        label: normalizedLabel ? normalizedLabel : undefined,
        fromMessageId: normalizedFromMessageId ? normalizedFromMessageId : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "merge_session_memory") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "merge_session_memory.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "merge_session_memory.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "merge_session_memory",
        agentId: agentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "get_session_workers") {
    const sessionAgentId = (maybe as { sessionAgentId?: unknown }).sessionAgentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sessionAgentId !== "string" || sessionAgentId.trim().length === 0) {
      return { ok: false, error: "get_session_workers.sessionAgentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "get_session_workers.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "get_session_workers",
        sessionAgentId: sessionAgentId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "list_directories") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (path !== undefined && typeof path !== "string") {
      return { ok: false, error: "list_directories.path must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "list_directories.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "list_directories",
        path,
        requestId
      }
    };
  }

  if (maybe.type === "validate_directory") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof path !== "string" || path.trim().length === 0) {
      return { ok: false, error: "validate_directory.path must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "validate_directory.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "validate_directory",
        path,
        requestId
      }
    };
  }

  if (maybe.type === "pick_directory") {
    const defaultPath = (maybe as { defaultPath?: unknown }).defaultPath;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (defaultPath !== undefined && typeof defaultPath !== "string") {
      return { ok: false, error: "pick_directory.defaultPath must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "pick_directory.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "pick_directory",
        defaultPath: defaultPath?.trim() ? defaultPath : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "reorder_profiles") {
    const profileIds = (maybe as { profileIds?: unknown }).profileIds;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return { ok: false, error: "reorder_profiles.profileIds must be a non-empty array" };
    }
    for (let i = 0; i < profileIds.length; i++) {
      if (typeof profileIds[i] !== "string" || (profileIds[i] as string).trim().length === 0) {
        return { ok: false, error: `reorder_profiles.profileIds[${i}] must be a non-empty string` };
      }
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "reorder_profiles.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "reorder_profiles",
        profileIds: profileIds.map((id: string) => id.trim()),
        requestId
      }
    };
  }

  if (maybe.type === "user_message") {
    if (typeof maybe.text !== "string") {
      return { ok: false, error: "user_message.text must be a string" };
    }

    const normalizedText = maybe.text.trim();
    const parsedAttachments = parseConversationAttachments(
      (maybe as { attachments?: unknown }).attachments,
      "user_message.attachments"
    );
    if (!parsedAttachments.ok) {
      return { ok: false, error: parsedAttachments.error };
    }

    if (!normalizedText && parsedAttachments.attachments.length === 0) {
      return {
        ok: false,
        error: "user_message must include non-empty text or at least one attachment"
      };
    }

    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return { ok: false, error: "user_message.agentId must be a string when provided" };
    }

    if (
      maybe.delivery !== undefined &&
      maybe.delivery !== "auto" &&
      maybe.delivery !== "followUp" &&
      maybe.delivery !== "steer"
    ) {
      return { ok: false, error: "user_message.delivery must be one of auto|followUp|steer" };
    }

    return {
      ok: true,
      command: {
        type: "user_message",
        text: normalizedText,
        attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
        agentId: maybe.agentId,
        delivery: maybe.delivery
      }
    };
  }

  if (maybe.type === "choice_response") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;
    const answers = (maybe as { answers?: unknown }).answers;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "choice_response.agentId must be a non-empty string" };
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return { ok: false, error: "choice_response.choiceId must be a non-empty string" };
    }
    if (!Array.isArray(answers) || !answers.every(isValidChoiceAnswer)) {
      return { ok: false, error: "choice_response.answers must be an array of valid ChoiceAnswer objects" };
    }

    return {
      ok: true,
      command: {
        type: "choice_response",
        agentId: agentId.trim(),
        choiceId: choiceId.trim(),
        answers,
      }
    };
  }

  if (maybe.type === "choice_cancel") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "choice_cancel.agentId must be a non-empty string" };
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return { ok: false, error: "choice_cancel.choiceId must be a non-empty string" };
    }

    return {
      ok: true,
      command: {
        type: "choice_cancel",
        agentId: agentId.trim(),
        choiceId: choiceId.trim(),
      }
    };
  }

  if (maybe.type === "mark_unread") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "mark_unread.agentId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "mark_unread.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "mark_unread",
        agentId: agentId.trim(),
        requestId,
      }
    };
  }

  return { ok: false, error: "Unknown command type" };
}

function isApiProxyMethod(value: unknown): value is "GET" | "POST" | "PUT" | "DELETE" {
  return value === "GET" || value === "POST" || value === "PUT" || value === "DELETE";
}

function isSafeMessageCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  );
}

function normalizeMessageCount(value: unknown): number | undefined {
  if (!isSafeMessageCount(value)) {
    return undefined;
  }

  return value;
}

export function extractRequestId(command: ClientCommand): string | undefined {
  switch (command.type) {
    case "api_proxy":
    case "create_manager":
    case "delete_manager":
    case "update_manager_model":
    case "create_session":
    case "stop_session":
    case "resume_session":
    case "delete_session":
    case "clear_session":
    case "rename_session":
    case "fork_session":
    case "merge_session_memory":
    case "get_session_workers":
    case "stop_all_agents":
    case "reorder_profiles":
    case "list_directories":
    case "validate_directory":
    case "pick_directory":
    case "mark_unread":
      return command.requestId;

    case "subscribe":
    case "user_message":
    case "kill_agent":
    case "choice_response":
    case "choice_cancel":
    case "ping":
      return undefined;
  }
}
