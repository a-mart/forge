import { normalizeProjectAgentHandle } from "../../swarm/project-agents.js";
import {
  fail,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseProjectAgentCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "set_session_project_agent") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const projectAgent = (maybe as { projectAgent?: unknown }).projectAgent;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("set_session_project_agent.agentId must be a non-empty string");
    }
    if (projectAgent !== null && (typeof projectAgent !== "object" || projectAgent === null || Array.isArray(projectAgent))) {
      return fail("set_session_project_agent.projectAgent must be an object or null");
    }
    if (
      projectAgent !== null &&
      (typeof (projectAgent as { whenToUse?: unknown }).whenToUse !== "string")
    ) {
      return fail("set_session_project_agent.projectAgent.whenToUse must be a string");
    }
    if (
      projectAgent !== null &&
      (projectAgent as { systemPrompt?: unknown }).systemPrompt !== undefined &&
      typeof (projectAgent as { systemPrompt?: unknown }).systemPrompt !== "string"
    ) {
      return fail("set_session_project_agent.projectAgent.systemPrompt must be a string when provided");
    }
    if (
      projectAgent !== null &&
      (projectAgent as { handle?: unknown }).handle !== undefined &&
      typeof (projectAgent as { handle?: unknown }).handle !== "string"
    ) {
      return fail("set_session_project_agent.projectAgent.handle must be a string when provided");
    }
    if (
      projectAgent !== null &&
      typeof (projectAgent as { handle?: unknown }).handle === "string"
    ) {
      const handle = (projectAgent as { handle: string }).handle;
      if (handle.length === 0 || normalizeProjectAgentHandle(handle) !== handle) {
        return fail(
          "set_session_project_agent.projectAgent.handle must be a normalized non-empty string containing only lowercase letters, numbers, and dashes"
        );
      }
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("set_session_project_agent.requestId must be a string when provided");
    }

    return ok({
      type: "set_session_project_agent",
      agentId: agentId.trim(),
      projectAgent:
        projectAgent === null
          ? null
          : {
              whenToUse: (projectAgent as { whenToUse: string }).whenToUse,
              ...((projectAgent as { systemPrompt?: string }).systemPrompt !== undefined
                ? { systemPrompt: (projectAgent as { systemPrompt?: string }).systemPrompt }
                : {}),
              ...((projectAgent as { handle?: string }).handle !== undefined
                ? { handle: (projectAgent as { handle?: string }).handle }
                : {})
            },
      requestId
    });
  }

  if (maybe.type === "get_project_agent_config") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("get_project_agent_config.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("get_project_agent_config.requestId must be a string when provided");
    }

    return ok({
      type: "get_project_agent_config",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "list_project_agent_references") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("list_project_agent_references.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("list_project_agent_references.requestId must be a string when provided");
    }

    return ok({
      type: "list_project_agent_references",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "get_project_agent_reference") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const fileName = (maybe as { fileName?: unknown }).fileName;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("get_project_agent_reference.agentId must be a non-empty string");
    }
    if (typeof fileName !== "string" || fileName.trim().length === 0) {
      return fail("get_project_agent_reference.fileName must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("get_project_agent_reference.requestId must be a string when provided");
    }

    return ok({
      type: "get_project_agent_reference",
      agentId: agentId.trim(),
      fileName: fileName.trim(),
      requestId
    });
  }

  if (maybe.type === "set_project_agent_reference") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const fileName = (maybe as { fileName?: unknown }).fileName;
    const content = (maybe as { content?: unknown }).content;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("set_project_agent_reference.agentId must be a non-empty string");
    }
    if (typeof fileName !== "string" || fileName.trim().length === 0) {
      return fail("set_project_agent_reference.fileName must be a non-empty string");
    }
    if (typeof content !== "string") {
      return fail("set_project_agent_reference.content must be a string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("set_project_agent_reference.requestId must be a string when provided");
    }

    return ok({
      type: "set_project_agent_reference",
      agentId: agentId.trim(),
      fileName: fileName.trim(),
      content,
      requestId
    });
  }

  if (maybe.type === "delete_project_agent_reference") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const fileName = (maybe as { fileName?: unknown }).fileName;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("delete_project_agent_reference.agentId must be a non-empty string");
    }
    if (typeof fileName !== "string" || fileName.trim().length === 0) {
      return fail("delete_project_agent_reference.fileName must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("delete_project_agent_reference.requestId must be a string when provided");
    }

    return ok({
      type: "delete_project_agent_reference",
      agentId: agentId.trim(),
      fileName: fileName.trim(),
      requestId
    });
  }

  if (maybe.type === "request_project_agent_recommendations") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("request_project_agent_recommendations.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("request_project_agent_recommendations.requestId must be a string when provided");
    }

    return ok({
      type: "request_project_agent_recommendations",
      agentId: agentId.trim(),
      requestId
    });
  }

  return undefined;
}
