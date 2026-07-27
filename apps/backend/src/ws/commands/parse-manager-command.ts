import {
  describeSwarmModelPresets,
  describeSwarmReasoningLevels,
  isSwarmModelPreset,
  isSwarmReasoningLevel,
  parseSwarmModelPreset
} from "../../swarm/model-presets.js";
import {
  fail,
  ok,
  parseManagerExactModelSelection,
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
    const modelSelection = (maybe as { modelSelection?: unknown }).modelSelection;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof name !== "string" || name.trim().length === 0) {
      return fail("create_manager.name must be a non-empty string");
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return fail("create_manager.cwd must be a non-empty string");
    }
    if (model !== undefined && modelSelection !== undefined) {
      return fail("create_manager.model and create_manager.modelSelection are mutually exclusive");
    }
    if (model !== undefined && !isSwarmModelPreset(model)) {
      return fail(`create_manager.model must be one of ${describeSwarmModelPresets()}`);
    }
    const parsedModelSelection = modelSelection === undefined
      ? undefined
      : parseManagerExactModelSelection(modelSelection, "create_manager.modelSelection");
    if (typeof parsedModelSelection === "string") {
      return fail(parsedModelSelection);
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return fail(`create_manager.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`);
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("create_manager.requestId must be a string when provided");
    }

    return ok({
      type: "create_manager",
      name: name.trim(),
      cwd,
      ...(model !== undefined ? { model } : {}),
      ...(parsedModelSelection ? { modelSelection: parsedModelSelection } : {}),
      reasoningLevel,
      requestId
    });
  }

  if (maybe.type === "create_repository_project") {
    const name = (maybe as { name?: unknown }).name;
    const repositoryUrl = (maybe as { repositoryUrl?: unknown }).repositoryUrl;
    const repositoryBasePath = (maybe as { repositoryBasePath?: unknown }).repositoryBasePath;
    const repositoryFolder = (maybe as { repositoryFolder?: unknown }).repositoryFolder;
    const modelSelection = (maybe as { modelSelection?: unknown }).modelSelection;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof name !== "string" || name.trim().length === 0) {
      return fail("create_repository_project.name must be a non-empty string");
    }
    if (typeof repositoryUrl !== "string" || repositoryUrl.trim().length === 0) {
      return fail("create_repository_project.repositoryUrl must be a non-empty string");
    }
    if (typeof repositoryBasePath !== "string" || repositoryBasePath.trim().length === 0) {
      return fail("create_repository_project.repositoryBasePath must be a non-empty string");
    }
    if (typeof repositoryFolder !== "string" || repositoryFolder.trim().length === 0) {
      return fail("create_repository_project.repositoryFolder must be a non-empty string");
    }
    const parsedModelSelection = parseManagerExactModelSelection(
      modelSelection,
      "create_repository_project.modelSelection",
    );
    if (typeof parsedModelSelection === "string") {
      return fail(parsedModelSelection);
    }
    if (!parsedModelSelection) {
      return fail("create_repository_project.modelSelection is required");
    }
    if (reasoningLevel !== undefined && !isSwarmReasoningLevel(reasoningLevel)) {
      return fail(`create_repository_project.reasoningLevel must be one of ${describeSwarmReasoningLevels()}`);
    }
    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      return fail("create_repository_project.requestId must be a non-empty string");
    }

    return ok({
      type: "create_repository_project",
      name: name.trim(),
      repositoryUrl: repositoryUrl.trim(),
      repositoryBasePath: repositoryBasePath.trim(),
      repositoryFolder: repositoryFolder.trim(),
      modelSelection: parsedModelSelection,
      reasoningLevel,
      requestId: requestId.trim(),
    });
  }

  if (maybe.type === "cancel_repository_project_creation") {
    const operationRequestId = (maybe as { operationRequestId?: unknown }).operationRequestId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof operationRequestId !== "string" || operationRequestId.trim().length === 0) {
      return fail("cancel_repository_project_creation.operationRequestId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("cancel_repository_project_creation.requestId must be a string when provided");
    }

    return ok({
      type: "cancel_repository_project_creation",
      operationRequestId: operationRequestId.trim(),
      requestId,
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

  if (maybe.type === "update_project_delegation_defaults") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const managerPosture = (maybe as { managerPosture?: unknown }).managerPosture;
    const delegationRosterId =
      (maybe as { delegationRosterId?: unknown }).delegationRosterId;
    const requestId = (maybe as { requestId?: unknown }).requestId;
    const hasPosture = Object.prototype.hasOwnProperty.call(maybe, "managerPosture");
    const hasRoster = Object.prototype.hasOwnProperty.call(maybe, "delegationRosterId");
    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("update_project_delegation_defaults.profileId must be a non-empty string");
    }
    if (!hasPosture && !hasRoster) {
      return fail("update_project_delegation_defaults requires managerPosture or delegationRosterId");
    }
    if (hasPosture && managerPosture !== null && !isManagerPosture(managerPosture)) {
      return fail(
        'update_project_delegation_defaults.managerPosture must be "delegation_first", "hands_on", or null',
      );
    }
    if (
      hasRoster
      && delegationRosterId !== null
      && (
        typeof delegationRosterId !== "string"
        || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(delegationRosterId.trim())
      )
    ) {
      return fail(
        "update_project_delegation_defaults.delegationRosterId must be a lowercase roster id or null",
      );
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("update_project_delegation_defaults.requestId must be a string when provided");
    }
    return ok({
      type: "update_project_delegation_defaults",
      profileId: profileId.trim(),
      ...(hasPosture ? { managerPosture: managerPosture as "delegation_first" | "hands_on" | null } : {}),
      ...(hasRoster
        ? {
            delegationRosterId:
              delegationRosterId === null ? null : (delegationRosterId as string).trim(),
          }
        : {}),
      requestId,
    });
  }

  if (maybe.type === "update_profile_default_model") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const model = (maybe as { model?: unknown }).model;
    const modelSelection = (maybe as { modelSelection?: unknown }).modelSelection;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("update_profile_default_model.profileId must be a non-empty string");
    }
    if (model !== undefined && modelSelection !== undefined) {
      return fail("update_profile_default_model.model and update_profile_default_model.modelSelection are mutually exclusive");
    }
    if (modelSelection === undefined && !isSwarmModelPreset(model)) {
      return fail(`update_profile_default_model.model must be one of ${describeSwarmModelPresets()}`);
    }
    const parsedModel = modelSelection === undefined
      ? parseSwarmModelPreset(model, "update_profile_default_model.model")
      : undefined;
    const parsedModelSelection = modelSelection === undefined
      ? undefined
      : parseManagerExactModelSelection(modelSelection, "update_profile_default_model.modelSelection");
    if (typeof parsedModelSelection === "string") {
      return fail(parsedModelSelection);
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
      ...(parsedModelSelection ? { modelSelection: parsedModelSelection } : { model: parsedModel }),
      reasoningLevel,
      requestId
    });
  }

  if (maybe.type === "update_manager_model") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const model = (maybe as { model?: unknown }).model;
    const modelSelection = (maybe as { modelSelection?: unknown }).modelSelection;
    const reasoningLevel = (maybe as { reasoningLevel?: unknown }).reasoningLevel;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("update_manager_model.managerId must be a non-empty string");
    }
    if (model !== undefined && modelSelection !== undefined) {
      return fail("update_manager_model.model and update_manager_model.modelSelection are mutually exclusive");
    }
    if (modelSelection === undefined && !isSwarmModelPreset(model)) {
      return fail(`update_manager_model.model must be one of ${describeSwarmModelPresets()}`);
    }
    const parsedModel = modelSelection === undefined
      ? parseSwarmModelPreset(model, "update_manager_model.model")
      : undefined;
    const parsedModelSelection = modelSelection === undefined
      ? undefined
      : parseManagerExactModelSelection(modelSelection, "update_manager_model.modelSelection");
    if (typeof parsedModelSelection === "string") {
      return fail(parsedModelSelection);
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
      ...(parsedModelSelection ? { modelSelection: parsedModelSelection } : { model: parsedModel }),
      reasoningLevel,
      requestId
    });
  }

  if (maybe.type === "hydrate_archive_last_used") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("hydrate_archive_last_used.requestId must be a string when provided");
    }

    return ok({
      type: "hydrate_archive_last_used",
      requestId
    });
  }

  if (maybe.type === "archive_profile") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("archive_profile.profileId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("archive_profile.requestId must be a string when provided");
    }

    return ok({
      type: "archive_profile",
      profileId: profileId.trim(),
      requestId
    });
  }

  if (maybe.type === "restore_profile") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("restore_profile.profileId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("restore_profile.requestId must be a string when provided");
    }

    return ok({
      type: "restore_profile",
      profileId: profileId.trim(),
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

function isManagerPosture(value: unknown): value is "delegation_first" | "hands_on" {
  return value === "delegation_first" || value === "hands_on";
}
