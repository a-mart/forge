import type { ClientCommand } from "@forge/protocol";
import type { CollaborationAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";

/**
 * Minimum access tier required to run a builder WebSocket command on a
 * collaboration-server instance.
 *
 * - `read`  — visible-state reads; granted to members from R1.
 * - `write` — project-scoped mutations; granted to members from R2.
 * - `admin` — instance-scoped or local-machine operations; never member-run.
 *
 * Admins always pass (existing collaboration-server behavior). Members are
 * additionally gated by the `remoteBuild.enabled` instance setting — the
 * product kill switch: when off, members get no builder access at all.
 *
 * The record is total over `ClientCommand["type"]`: adding a client command
 * without classifying it here is a compile error, which is the point — every
 * command gets an explicit, reviewed access decision.
 */
export type BuilderCommandAccessTier = "read" | "write" | "admin";

export const BUILDER_COMMAND_ACCESS: Readonly<Record<ClientCommand["type"], BuilderCommandAccessTier>> = {
  // Pre-gate commands. `ping` short-circuits before the gate; collab_*
  // commands route through the collaboration handler which enforces its own
  // per-command authentication. Classified here only for totality.
  ping: "read",
  collab_bootstrap: "read",
  collab_subscribe_channel: "read",
  collab_unsubscribe_channel: "read",
  collab_user_message: "write",
  collab_mark_channel_read: "write",
  collab_choice_response: "write",
  collab_choice_cancel: "write",
  collab_pin_message: "write",

  // Reads: subscriptions and get/list surfaces.
  subscribe: "read",
  get_project_agent_config: "read",
  list_project_agent_references: "read",
  get_project_agent_reference: "read",
  get_project_agent_sharing: "read",
  get_project_agent_external_directory: "read",
  get_session_workers: "read",
  get_conversation_page: "read",
  // Idempotent metadata backfill required to browse the session archive.
  hydrate_archive_last_used: "read",

  // Project-scoped mutations (chat, choices, session/project CRUD).
  user_message: "write",
  choice_response: "write",
  choice_cancel: "write",
  codex_elicitation_response: "write",
  kill_agent: "write",
  stop_all_agents: "write",
  create_manager: "write",
  // Local Builder/admin-only: clones write arbitrary content and use host credentials.
  create_repository_project: "admin",
  cancel_repository_project_creation: "admin",
  delete_manager: "write",
  update_profile_default_model: "write",
  update_manager_model: "write",
  update_manager_cwd: "write",
  update_session_model: "write",
  create_session: "write",
  stop_session: "write",
  resume_session: "write",
  archive_session: "write",
  restore_session: "write",
  delete_session: "write",
  rename_session: "write",
  pin_session: "write",
  set_session_project_agent: "write",
  set_project_agent_reference: "write",
  delete_project_agent_reference: "write",
  request_project_agent_recommendations: "write",
  set_project_agent_sharing: "write",
  fork_session: "write",
  clear_session: "write",
  session_goal_control: "write",
  pin_message: "write",
  clear_all_pins: "write",
  merge_session_memory: "write",
  rename_profile: "write",
  archive_profile: "write",
  restore_profile: "write",
  reorder_profiles: "write",
  // Unread state is instance-shared; cheap, project-scoped bookkeeping.
  mark_unread: "write",
  mark_all_read: "write",
  // Server-disk browsing for remote create-project; write tier keeps the R1
  // member read surface project-scoped.
  list_directories: "write",
  validate_directory: "write",
  create_directory: "write",
  // Proxied HTTP surface; members are additionally gated per proxied path
  // (default deny) via evaluateApiProxyMemberAccess.
  api_proxy: "write",

  // Instance-scoped or local-machine operations — admin only.
  resume_restart_recovery: "admin",
  dismiss_restart_recovery: "admin",
  // Browser host ownership and managed webviews are local-machine capabilities.
  browser_host_register: "admin",
  browser_host_hydrate: "admin",
  browser_host_focus: "admin",
  browser_host_response: "admin",
  browser_host_state_report: "admin",
  browser_panel_reveal_acknowledge: "admin",
  browser_host_select: "admin",
  browser_external_chrome_detach_confirmed: "admin",
  browser_tab_open: "admin",
  browser_tab_activate: "admin",
  browser_tab_close: "admin",
  browser_tab_resize: "admin",
  browser_recording_start: "admin",
  browser_recording_stop: "admin",
  // Opens a native picker on the server host; meaningless and unsafe remotely.
  pick_directory: "admin",
};

/**
 * Tiers granted to members. R1 shipped `read`; R2 extends to `write` —
 * members are operators of this instance (D6), gated only by the
 * remoteBuild.enabled kill switch and the admin-only tier.
 */
export const MEMBER_ALLOWED_TIERS: ReadonlySet<BuilderCommandAccessTier> = new Set(["read", "write"]);

export interface BuilderCommandAccessDecision {
  ok: boolean;
  /** Machine-checkable denial reason for tests and logging. */
  reason?: "auth_required" | "account_disabled" | "remote_build_disabled" | "tier_not_granted";
  message?: string;
}

/**
 * Policy from SPEC §4.2: builder access on a collaboration-server instance is
 * available to admins unconditionally and to active members when the
 * `remoteBuild.enabled` instance setting is on.
 */
export function canUseBuilder(
  authContext: CollaborationAuthContext | null,
  options: { remoteBuildEnabled: boolean },
): boolean {
  if (!authContext || authContext.disabled || authContext.passwordChangeRequired) {
    return false;
  }

  if (authContext.role === "admin") {
    return true;
  }

  return options.remoteBuildEnabled;
}

/**
 * Gate for non-collab builder commands on a collaboration-server socket.
 * Builder-runtime sockets never reach this gate (no auth context exists).
 */
export function evaluateBuilderCommandAccess(options: {
  commandType: ClientCommand["type"];
  authContext: CollaborationAuthContext | null;
  remoteBuildEnabled: boolean;
}): BuilderCommandAccessDecision {
  const { commandType, authContext, remoteBuildEnabled } = options;

  if (!authContext) {
    return {
      ok: false,
      reason: "auth_required",
      message: "Authentication is required for builder WebSocket commands.",
    };
  }

  if (authContext.disabled || authContext.passwordChangeRequired) {
    return {
      ok: false,
      reason: "account_disabled",
      message: "This account cannot use builder WebSocket commands.",
    };
  }

  if (authContext.role === "admin") {
    return { ok: true };
  }

  if (!remoteBuildEnabled) {
    return {
      ok: false,
      reason: "remote_build_disabled",
      message: "Remote projects are disabled on this instance.",
    };
  }

  const tier = BUILDER_COMMAND_ACCESS[commandType];
  if (tier !== "admin" && MEMBER_ALLOWED_TIERS.has(tier)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "tier_not_granted",
    message:
      tier === "admin"
        ? `The ${commandType} command requires admin access.`
        : `Members currently have read-only builder access; ${commandType} is not permitted.`,
  };
}

// ---------------------------------------------------------------------------
// api_proxy member classification (R2)
// ---------------------------------------------------------------------------

const API_PROXY_MEMBER_READ_PATHS = new Set(["/api/read-file", "/api/unread", "/api/slash-commands"]);
const API_PROXY_MEMBER_WRITE_PATHS = new Set(["/api/read-file", "/api/unread", "/api/feedback"]);
const API_PROXY_MEMBER_SMART_COMPACT_PATH = /^\/api\/agents\/[^/]+\/smart-compact$/;
const API_PROXY_TERMINALS_COLLECTION_PATH = "/api/terminals";
const API_PROXY_TERMINAL_MUTATION_PATH = /^\/api\/terminals\/[^/]+(?:\/(?:ticket|resize))?$/;

export interface ApiProxyAccessDecision {
  ok: boolean;
  /** HTTP-shaped status carried back through the proxy response. */
  statusCode?: 403;
  message?: string;
}

/**
 * Member allowlist for the WS `api_proxy` surface, mirroring the HTTP
 * default-admin discipline: anything unlisted is denied for members.
 * Admins and local (builder-runtime) sockets pass everything.
 */
export function evaluateApiProxyMemberAccess(options: {
  pathname: string;
  method: string;
  authContext: CollaborationAuthContext | null;
  terminalsEnabled: boolean;
}): ApiProxyAccessDecision {
  const { pathname, method, authContext, terminalsEnabled } = options;

  if (!authContext || authContext.role === "admin") {
    return { ok: true };
  }

  const normalizedMethod = method.toUpperCase();
  const isRead = normalizedMethod === "GET" || normalizedMethod === "HEAD";

  if (isRead && API_PROXY_MEMBER_READ_PATHS.has(pathname)) {
    return { ok: true };
  }

  if (normalizedMethod === "POST" && pathname === "/api/chat-artifacts/read") {
    return { ok: true };
  }

  if (!isRead && API_PROXY_MEMBER_WRITE_PATHS.has(pathname)) {
    return { ok: true };
  }

  if (!isRead && API_PROXY_MEMBER_SMART_COMPACT_PATH.test(pathname)) {
    return { ok: true };
  }

  if (pathname === API_PROXY_TERMINALS_COLLECTION_PATH) {
    if (isRead) {
      return { ok: true };
    }
    return terminalsEnabled
      ? { ok: true }
      : { ok: false, statusCode: 403, message: "Remote terminals are disabled on this instance." };
  }

  if (API_PROXY_TERMINAL_MUTATION_PATH.test(pathname)) {
    return terminalsEnabled
      ? { ok: true }
      : { ok: false, statusCode: 403, message: "Remote terminals are disabled on this instance." };
  }

  return {
    ok: false,
    statusCode: 403,
    message: `Members may not access ${pathname} through the API proxy.`,
  };
}
