import {
  describeSwarmModelPresets,
  describeSwarmReasoningLevels,
  isSwarmModelPreset,
  isSwarmReasoningLevel
} from "../../swarm/model-presets.js";
import {
  fail,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseManagerCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "kill_agent") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return fail("kill_agent.agentId must be a non-empty string");
    }

    return ok({
      type: "kill_agent",
      agentId: maybe.agentId.trim()
    });
  }

  if (maybe.type === "stop_all_agents") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("stop_all_agents.managerId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("stop_all_agents.requestId must be a string when provided");
    }

    return ok({
      type: "stop_all_agents",
      managerId: managerId.trim(),
      requestId
    });
  }

  if (maybe.type === "create_manager") {
    const name = (maybe as { name?: unknown }).name;
    const cwd = (maybe as { cwd?: unknown }).cwd;
    const model = (maybe as { model?: unknown }).model;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof name !== "string" || name.trim().length === 0) {
      return fail("create_manager.name must be a non-empty string");
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return fail("create_manager.cwd must be a non-empty string");
    }
    if (model !== undefined && !isSwarmModelPreset(model)) {
      return fail(`create_manager.model must be one of ${describeSwarmModelPresets()}`);
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("create_manager.requestId must be a string when provided");
    }

    return ok({
      type: "create_manager",
      name: name.trim(),
      cwd,
      model,
      requestId
    });
  }

  if (maybe.type === "delete_manager") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("delete_manager.managerId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("delete_manager.requestId must be a string when provided");
    }

    return ok({
      type: "delete_manager",
      managerId: managerId.trim(),
      requestId
    });
  }

  if (maybe.type === "update_profile_default_model") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const model = (maybe as { model?: unknown }).model;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("update_profile_default_model.profileId must be a non-empty string");
    }
    if (!isSwarmModelPreset(model)) {
      return fail(`update_profile_default_model.model must be one of ${describeSwarmModelPresets()}`);
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return fail(`update_profile_default_model.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`);
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("update_profile_default_model.requestId must be a string when provided");
    }

    return ok({
      type: "update_profile_default_model",
      profileId: profileId.trim(),
      model,
      reasoningLevel,
      requestId
    });
  }

  if (maybe.type === "update_manager_model") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const model = (maybe as { model?: unknown }).model;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("update_manager_model.managerId must be a non-empty string");
    }
    if (!isSwarmModelPreset(model)) {
      return fail(`update_manager_model.model must be one of ${describeSwarmModelPresets()}`);
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return fail(`update_manager_model.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`);
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("update_manager_model.requestId must be a string when provided");
    }

    return ok({
      type: "update_manager_model",
      managerId: managerId.trim(),
      model,
      reasoningLevel,
      requestId
    });
  }

  if (maybe.type === "update_manager_cwd") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const cwd = (maybe as { cwd?: unknown }).cwd;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("update_manager_cwd.managerId must be a non-empty string");
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return fail("update_manager_cwd.cwd must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("update_manager_cwd.requestId must be a string when provided");
    }

    return ok({
      type: "update_manager_cwd",
      managerId: managerId.trim(),
      cwd: cwd.trim(),
      requestId
    });
  }

  return undefined;
}
