import {
  SESSION_ATTENTION_MAX_DISMISS_IDS,
  SESSION_ATTENTION_MAX_ID_LENGTH,
} from "@forge/protocol";

import {
  fail,
  isApiProxyMethod,
  isSafeMessageCount,
  normalizeMessageCount,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

// Request IDs are reflected into api_proxy_response events. Bounding their character count keeps
// even maximally JSON-escaped IDs small enough for an explicit response under MAX_WS_EVENT_BYTES.
export const MAX_API_PROXY_REQUEST_ID_LENGTH = 1024;
export const MAX_SUBSCRIPTION_ID_LENGTH = 128;
// Same reflection bound for the correlated dismissal response: an unbounded ID
// could push an otherwise-applied dismissal's response over MAX_WS_EVENT_BYTES,
// silently dropping the success the client is awaiting.
export const MAX_SESSION_ATTENTION_REQUEST_ID_LENGTH = 1024;

export function parseUtilityCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "subscribe_inventory") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > MAX_SUBSCRIPTION_ID_LENGTH) {
      return fail("subscribe_inventory.requestId must be a nonempty bounded string");
    }
    if (Object.keys(maybe).some((key) => key !== "type" && key !== "requestId")) {
      return fail("subscribe_inventory does not accept a conversation target or options", requestId);
    }
    return ok({ type: "subscribe_inventory", requestId });
  }

  if (maybe.type === "ping") {
    return ok({ type: "ping" });
  }

  if (maybe.type === "resume_restart_recovery" || maybe.type === "dismiss_restart_recovery") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail(`${maybe.type}.requestId must be a string when provided`);
    }
    return ok({ type: maybe.type, requestId });
  }

  if (maybe.type === "dismiss_session_attention") {
    // Wire-required: dismissal is a command whose success/failure must be
    // correlated back to the exact caller, so an anonymous one is rejected.
    const requestId = (maybe as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return fail("dismiss_session_attention.requestId is required");
    }
    if (requestId.length > MAX_SESSION_ATTENTION_REQUEST_ID_LENGTH) {
      // Deliberately not echoed: reflecting an oversized ID would recreate the
      // oversized-event drop this bound exists to prevent.
      return fail(
        `dismiss_session_attention.requestId must be at most ${MAX_SESSION_ATTENTION_REQUEST_ID_LENGTH} characters`,
      );
    }

    const rawIds = (maybe as { attentionIds?: unknown }).attentionIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return fail("dismiss_session_attention.attentionIds must be a nonempty array", requestId);
    }
    if (rawIds.length > SESSION_ATTENTION_MAX_DISMISS_IDS) {
      return fail(
        `dismiss_session_attention.attentionIds must contain at most ${SESSION_ATTENTION_MAX_DISMISS_IDS} entries`,
        requestId,
      );
    }

    // Deduplicate here so the coordinator only ever sees exact, unique targets.
    const attentionIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of rawIds) {
      if (typeof candidate !== "string" || candidate.length === 0) {
        return fail("dismiss_session_attention.attentionIds must contain nonempty strings", requestId);
      }
      if (candidate.length > SESSION_ATTENTION_MAX_ID_LENGTH) {
        return fail(
          `dismiss_session_attention.attentionIds entries must be at most ${SESSION_ATTENTION_MAX_ID_LENGTH} characters`,
          requestId,
        );
      }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      attentionIds.push(candidate);
    }

    return ok({ type: "dismiss_session_attention", attentionIds, requestId });
  }

  if (maybe.type === "subscribe") {
    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return fail("subscribe.agentId must be a string when provided");
    }

    const maybeMessageCount = (maybe as { messageCount?: unknown }).messageCount;
    if (maybeMessageCount !== undefined && !isSafeMessageCount(maybeMessageCount)) {
      return fail("subscribe.messageCount must be a positive finite integer");
    }
    const subscriptionId = (maybe as { subscriptionId?: unknown }).subscriptionId;
    if (subscriptionId !== undefined && typeof subscriptionId !== "string") {
      return fail("subscribe.subscriptionId must be a string when provided");
    }
    if (typeof subscriptionId === "string" && subscriptionId.trim().length === 0) {
      return fail("subscribe.subscriptionId must be non-empty when provided");
    }
    if (typeof subscriptionId === "string" && subscriptionId.length > MAX_SUBSCRIPTION_ID_LENGTH) {
      return fail(`subscribe.subscriptionId must be at most ${MAX_SUBSCRIPTION_ID_LENGTH} characters`);
    }
    const conversationPaging = (maybe as { conversationPaging?: unknown }).conversationPaging;
    if (conversationPaging !== undefined && conversationPaging !== true) {
      return fail("subscribe.conversationPaging must be true when provided");
    }
    const conversationView = (maybe as { conversationView?: unknown }).conversationView;
    if (conversationView !== undefined && conversationView !== "web" && conversationView !== "all") {
      return fail("subscribe.conversationView must be web or all when provided");
    }
    const goalControlRequestId = (maybe as { goalControlRequestId?: unknown }).goalControlRequestId;
    if (goalControlRequestId !== undefined && goalControlRequestId !== true) {
      return fail("subscribe.goalControlRequestId must be true when provided");
    }

    return ok({
      type: "subscribe",
      agentId: maybe.agentId,
      messageCount: normalizeMessageCount(maybeMessageCount),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      ...(conversationPaging === true ? { conversationPaging: true as const } : {}),
      ...(conversationView ? { conversationView } : {}),
      ...(goalControlRequestId === true ? { goalControlRequestId: true as const } : {}),
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
    if (requestId.trim().length > MAX_API_PROXY_REQUEST_ID_LENGTH) {
      return fail(`api_proxy.requestId must be at most ${MAX_API_PROXY_REQUEST_ID_LENGTH} characters`);
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

  if (maybe.type === "create_directory") {
    const parentPath = (maybe as { parentPath?: unknown }).parentPath;
    const name = (maybe as { name?: unknown }).name;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof parentPath !== "string" || parentPath.trim().length === 0) {
      return fail("create_directory.parentPath must be a non-empty string");
    }
    if (typeof name !== "string" || name.trim().length === 0) {
      return fail("create_directory.name must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("create_directory.requestId must be a string when provided");
    }

    return ok({
      type: "create_directory",
      parentPath: parentPath.trim(),
      name: name.trim(),
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
