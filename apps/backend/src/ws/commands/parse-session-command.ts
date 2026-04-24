import {
  describeSwarmModelPresets,
  describeSwarmReasoningLevels,
  isSwarmModelPreset,
  isSwarmReasoningLevel
} from "../../swarm/model-presets.js";
import {
  fail,
  ok,
  parseManagerExactModelSelection,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseSessionCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "create_session") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const label = (maybe as { label?: unknown }).label;
    const name = (maybe as { name?: unknown }).name;
    const sessionPurpose = (maybe as { sessionPurpose?: unknown }).sessionPurpose;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("create_session.profileId must be a non-empty string");
    }
    if (label !== undefined && typeof label !== "string") {
      return fail("create_session.label must be a string when provided");
    }
    if (name !== undefined && typeof name !== "string") {
      return fail("create_session.name must be a string when provided");
    }
    if (sessionPurpose !== undefined && sessionPurpose !== "cortex_review" && sessionPurpose !== "agent_creator") {
      return fail('create_session.sessionPurpose must be "cortex_review" or "agent_creator" when provided');
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("create_session.requestId must be a string when provided");
    }

    const normalizedLabel = label?.trim();
    const normalizedName = name?.trim();

    return ok({
      type: "create_session",
      profileId: profileId.trim(),
      label: normalizedLabel ? normalizedLabel : undefined,
      name: normalizedName ? normalizedName : undefined,
      sessionPurpose,
      requestId
    });
  }

  if (maybe.type === "stop_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("stop_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("stop_session.requestId must be a string when provided");
    }

    return ok({
      type: "stop_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "resume_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("resume_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("resume_session.requestId must be a string when provided");
    }

    return ok({
      type: "resume_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "delete_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("delete_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("delete_session.requestId must be a string when provided");
    }

    return ok({
      type: "delete_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "clear_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("clear_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("clear_session.requestId must be a string when provided");
    }

    return ok({
      type: "clear_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "rename_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const label = (maybe as { label?: unknown }).label;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("rename_session.agentId must be a non-empty string");
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      return fail("rename_session.label must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("rename_session.requestId must be a string when provided");
    }

    return ok({
      type: "rename_session",
      agentId: agentId.trim(),
      label: label.trim(),
      requestId
    });
  }

  if (maybe.type === "pin_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const pinned = (maybe as { pinned?: unknown }).pinned;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("pin_session.agentId must be a non-empty string");
    }
    if (typeof pinned !== "boolean") {
      return fail("pin_session.pinned must be a boolean");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("pin_session.requestId must be a string when provided");
    }

    return ok({
      type: "pin_session",
      agentId: agentId.trim(),
      pinned,
      requestId
    });
  }

  if (maybe.type === "update_session_model") {
    const sessionAgentId = (maybe as { sessionAgentId?: unknown }).sessionAgentId;
    const mode = (maybe as { mode?: unknown }).mode;
    const model = (maybe as { model?: unknown }).model;
    const modelSelection = (maybe as { modelSelection?: unknown }).modelSelection;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sessionAgentId !== "string" || sessionAgentId.trim().length === 0) {
      return fail("update_session_model.sessionAgentId must be a non-empty string");
    }
    if (mode !== "inherit" && mode !== "override") {
      return fail('update_session_model.mode must be "inherit" or "override"');
    }
    if (model !== undefined && modelSelection !== undefined) {
      return fail("update_session_model.model and update_session_model.modelSelection are mutually exclusive");
    }
    if (mode === "override" && modelSelection === undefined && !isSwarmModelPreset(model)) {
      return fail(`update_session_model.model must be one of ${describeSwarmModelPresets()}`);
    }
    const parsedModelSelection = modelSelection === undefined
      ? undefined
      : parseManagerExactModelSelection(modelSelection, "update_session_model.modelSelection");
    if (typeof parsedModelSelection === "string") {
      return fail(parsedModelSelection);
    }
    if (mode === "inherit" && model !== undefined) {
      return fail("update_session_model.model must be omitted in inherit mode");
    }
    if (mode === "inherit" && parsedModelSelection !== undefined) {
      return fail("update_session_model.modelSelection must be omitted in inherit mode");
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return fail(`update_session_model.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`);
    }
    if (mode === "inherit" && reasoningLevel !== undefined) {
      return fail("update_session_model.reasoningLevel must be omitted in inherit mode");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("update_session_model.requestId must be a string when provided");
    }

    return ok({
      type: "update_session_model",
      sessionAgentId: sessionAgentId.trim(),
      mode,
      ...(mode === "override"
        ? parsedModelSelection
          ? { modelSelection: parsedModelSelection, reasoningLevel }
          : { model: model as string, reasoningLevel }
        : {}),
      requestId
    });
  }

  if (maybe.type === "fork_session") {
    const sourceAgentId = (maybe as { sourceAgentId?: unknown }).sourceAgentId;
    const label = (maybe as { label?: unknown }).label;
    const fromMessageId = (maybe as { fromMessageId?: unknown }).fromMessageId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sourceAgentId !== "string" || sourceAgentId.trim().length === 0) {
      return fail("fork_session.sourceAgentId must be a non-empty string");
    }
    if (label !== undefined && typeof label !== "string") {
      return fail("fork_session.label must be a string when provided");
    }
    if (fromMessageId !== undefined && typeof fromMessageId !== "string") {
      return fail("fork_session.fromMessageId must be a string when provided");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("fork_session.requestId must be a string when provided");
    }

    const normalizedLabel = label?.trim();
    const normalizedFromMessageId = fromMessageId?.trim();

    return ok({
      type: "fork_session",
      sourceAgentId: sourceAgentId.trim(),
      label: normalizedLabel ? normalizedLabel : undefined,
      fromMessageId: normalizedFromMessageId ? normalizedFromMessageId : undefined,
      requestId
    });
  }

  if (maybe.type === "merge_session_memory") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("merge_session_memory.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("merge_session_memory.requestId must be a string when provided");
    }

    return ok({
      type: "merge_session_memory",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "get_session_workers") {
    const sessionAgentId = (maybe as { sessionAgentId?: unknown }).sessionAgentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sessionAgentId !== "string" || sessionAgentId.trim().length === 0) {
      return fail("get_session_workers.sessionAgentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("get_session_workers.requestId must be a string when provided");
    }

    return ok({
      type: "get_session_workers",
      sessionAgentId: sessionAgentId.trim(),
      requestId
    });
  }

  return undefined;
}
