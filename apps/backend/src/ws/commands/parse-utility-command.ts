import {
  fail,
  isApiProxyMethod,
  isSafeMessageCount,
  normalizeMessageCount,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseUtilityCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "ping") {
    return ok({ type: "ping" });
  }

  if (maybe.type === "subscribe") {
    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return fail("subscribe.agentId must be a string when provided");
    }

    const maybeMessageCount = (maybe as { messageCount?: unknown }).messageCount;
    if (maybeMessageCount !== undefined && !isSafeMessageCount(maybeMessageCount)) {
      return fail("subscribe.messageCount must be a positive finite integer");
    }

    return ok({
      type: "subscribe",
      agentId: maybe.agentId,
      messageCount: normalizeMessageCount(maybeMessageCount)
    });
  }

  if (maybe.type === "api_proxy") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    const method = (maybe as { method?: unknown }).method;
    const path = (maybe as { path?: unknown }).path;
    const body = (maybe as { body?: unknown }).body;

    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      return fail("api_proxy.requestId must be a non-empty string");
    }
    if (!isApiProxyMethod(method)) {
      return fail("api_proxy.method must be one of GET|POST|PUT|PATCH|DELETE");
    }
    if (typeof path !== "string" || path.trim().length === 0 || !path.trim().startsWith("/")) {
      return fail("api_proxy.path must be a non-empty string starting with /");
    }
    if (body !== undefined && typeof body !== "string") {
      return fail("api_proxy.body must be a string when provided");
    }

    return ok({
      type: "api_proxy",
      requestId: requestId.trim(),
      method,
      path: path.trim(),
      body
    });
  }

  if (maybe.type === "rename_profile") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const displayName = (maybe as { displayName?: unknown }).displayName;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("rename_profile.profileId must be a non-empty string");
    }
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return fail("rename_profile.displayName must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("rename_profile.requestId must be a string when provided");
    }

    return ok({
      type: "rename_profile",
      profileId: profileId.trim(),
      displayName: displayName.trim(),
      requestId
    });
  }

  if (maybe.type === "list_directories") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (path !== undefined && typeof path !== "string") {
      return fail("list_directories.path must be a string when provided");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("list_directories.requestId must be a string when provided");
    }

    return ok({
      type: "list_directories",
      path,
      requestId
    });
  }

  if (maybe.type === "validate_directory") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof path !== "string" || path.trim().length === 0) {
      return fail("validate_directory.path must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("validate_directory.requestId must be a string when provided");
    }

    return ok({
      type: "validate_directory",
      path,
      requestId
    });
  }

  if (maybe.type === "pick_directory") {
    const defaultPath = (maybe as { defaultPath?: unknown }).defaultPath;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (defaultPath !== undefined && typeof defaultPath !== "string") {
      return fail("pick_directory.defaultPath must be a string when provided");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("pick_directory.requestId must be a string when provided");
    }

    return ok({
      type: "pick_directory",
      defaultPath: defaultPath?.trim() ? defaultPath : undefined,
      requestId
    });
  }

  if (maybe.type === "reorder_profiles") {
    const profileIds = (maybe as { profileIds?: unknown }).profileIds;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return fail("reorder_profiles.profileIds must be a non-empty array");
    }
    for (let i = 0; i < profileIds.length; i++) {
      if (typeof profileIds[i] !== "string" || (profileIds[i] as string).trim().length === 0) {
        return fail(`reorder_profiles.profileIds[${i}] must be a non-empty string`);
      }
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("reorder_profiles.requestId must be a string when provided");
    }

    return ok({
      type: "reorder_profiles",
      profileIds: profileIds.map((id: string) => id.trim()),
      requestId
    });
  }

  return undefined;
}
