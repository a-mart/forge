import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyCollaborationHttpRequest,
  type CollaborationHttpAccessPolicy,
  type CollaborationHttpAccessClass,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  clearCollaborationBetterAuthService,
} from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { startServer, type StartedServer } from "../server.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

/**
 * Route-inventory classification gate (SPEC §10.1).
 *
 * Every HTTP route registered on a collaboration-server instance must appear
 * in the reviewed inventory below with an explicit access class per method.
 * The test fails when:
 *  - a registered route matches no inventory sample (new route without a
 *    reviewed classification), or
 *  - a non-optional inventory sample matches no registered route (inventory
 *    rot), or
 *  - the classifier disagrees with the reviewed classification, with the
 *    remote-build kill switch on or off.
 *
 * The default classification for anything unlisted stays `admin` — that rule
 * is asserted here too and is permanent.
 */

const ADMIN_EMAIL = "route-inventory-admin@example.com";
const ADMIN_PASSWORD = "route-inventory-password-1";

const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const REMOTE_BUILD_ON: CollaborationHttpAccessPolicy = { remoteBuildEnabled: true, terminalsEnabled: true };
const REMOTE_BUILD_OFF: CollaborationHttpAccessPolicy = { remoteBuildEnabled: false, terminalsEnabled: true };

type AccessClass = CollaborationHttpAccessClass;

interface RouteInventoryEntry {
  /** Canonical sample pathname matching the registered route. */
  sample: string;
  /** Reviewed classification per method with remoteBuild enabled. */
  expect: Record<string, AccessClass>;
  /**
   * Member PROJECT surface: classification falls back to `admin` when the
   * remoteBuild kill switch is off. Member COLLAB surfaces omit this.
   */
  killSwitched?: boolean;
  /** Factory registers only when its service/config is present. */
  optional?: boolean;
}

const ROUTE_INVENTORY: RouteInventoryEntry[] = [
  // --- health -------------------------------------------------------------
  { sample: "/api/health", expect: { GET: "public" } },
  { sample: "/api/reboot", expect: { POST: "admin" } },

  // --- collaboration core (existing surface, unchanged) --------------------
  { sample: "/api/collaboration/status", expect: { GET: "public" } },
  { sample: "/api/collaboration/me", expect: { GET: "public" } },
  { sample: "/api/collaboration/me/password", expect: { POST: "public" } },
  { sample: "/api/collaboration/users", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/collaboration/users/user-1", expect: { PATCH: "admin", DELETE: "admin" } },
  { sample: "/api/collaboration/users/user-1/password-reset", expect: { POST: "admin" } },
  { sample: "/api/collaboration/invites", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/collaboration/invites/token-1", expect: { GET: "public", DELETE: "admin" } },
  { sample: "/api/collaboration/invites/token-1/redeem", expect: { POST: "public" } },
  { sample: "/api/collaboration/categories", expect: { GET: "public", POST: "admin" } },
  { sample: "/api/collaboration/categories/reorder", expect: { POST: "admin" } },
  { sample: "/api/collaboration/categories/cat-1", expect: { PATCH: "admin", DELETE: "admin" } },
  { sample: "/api/collaboration/channels", expect: { GET: "public", POST: "admin" } },
  { sample: "/api/collaboration/channels/reorder", expect: { POST: "admin" } },
  { sample: "/api/collaboration/channels/chan-1", expect: { GET: "public", PATCH: "admin", DELETE: "admin" } },
  { sample: "/api/collaboration/channels/chan-1/specialists", expect: { GET: "admin" } },
  { sample: "/api/collaboration/channels/chan-1/specialists/roster-prompt", expect: { GET: "admin" } },
  { sample: "/api/collaboration/channels/chan-1/specialists/selection", expect: { PUT: "admin" } },
  { sample: "/api/collaboration/channels/chan-1/skills/selection", expect: { PUT: "admin" } },
  { sample: "/api/collaboration/channels/chan-1/specialists/spec-1", expect: { PUT: "admin", DELETE: "admin" } },
  // Audited former `authenticated`-class route → member (not kill-switched).
  { sample: "/api/collaboration/channels/chan-1/prompt-preview", expect: { GET: "member" } },
  { sample: "/api/collaboration/channels/chan-1/archive", expect: { POST: "admin" } },

  // --- files (member project reads, R1) ------------------------------------
  { sample: "/api/attachments/file-1", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/read-file", expect: { GET: "member", POST: "member" }, killSwitched: true },
  { sample: "/api/chat-artifacts/read", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/write-file", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/files/list", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/files/count", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/files/search", expect: { GET: "member" }, killSwitched: true },
  {
    sample: "/api/files/content",
    expect: { GET: "member", PUT: "member", DELETE: "member" },
    killSwitched: true,
  },
  { sample: "/api/files/raw", expect: { GET: "member", HEAD: "member" }, killSwitched: true },
  // File browser create/rename (R2) — project-scoped mutations, same category as write-file.
  { sample: "/api/files/create", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/files/rename", expect: { PATCH: "member" }, killSwitched: true },

  // --- git (member project reads, R1; mutations remain admin until R2) -----
  { sample: "/api/git/status", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/diff", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/log", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/file-log", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/file-section-provenance", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/commit", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/commit-diff", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/worktrees", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/branches", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/mutation-preflight", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/fetch", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/git/switch-branch", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/git/create-branch", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/git/pull-ff-only", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/git/provider/status", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/pull-requests", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/pull-requests/42", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/git/pull-requests/42/merge", expect: { POST: "member" }, killSwitched: true },

  // --- feedback -------------------------------------------------------------
  {
    sample: "/api/v1/profiles/prof-1/sessions/sess-1/feedback",
    expect: { GET: "member", POST: "member" },
    killSwitched: true,
  },
  {
    sample: "/api/v1/profiles/prof-1/sessions/sess-1/feedback/state",
    expect: { GET: "member" },
    killSwitched: true,
  },
  { sample: "/api/v1/feedback", expect: { GET: "admin" } },

  // --- cortex / onboarding (remote Cortex surfacing is deferred) ------------
  { sample: "/api/onboarding/state", expect: { GET: "admin" } },
  { sample: "/api/onboarding/preferences", expect: { POST: "admin" } },
  { sample: "/api/cortex/index", expect: { GET: "admin" } },
  { sample: "/api/cortex/entries", expect: { GET: "admin" } },
  { sample: "/api/cortex/entry/entry-1", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/cortex/changelog", expect: { GET: "admin" } },
  { sample: "/api/cortex/consolidation", expect: { GET: "admin", POST: "admin" } },

  // --- instance settings (admin forever) ------------------------------------
  // Registered on builder targets only (CLI keys stay local-builder-only, D9).
  { sample: "/api/settings/cli-access/keys", expect: { GET: "admin", POST: "admin" }, optional: true },
  { sample: "/api/settings/cortex-auto-review", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/knowledge-v2", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/settings/knowledge-v2/cleanup-legacy", expect: { POST: "admin" }, optional: true },
  { sample: "/api/settings/compaction", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/settings/repositories", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/settings/remote-build", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/env", expect: { GET: "admin", PUT: "admin", DELETE: "admin" } },
  { sample: "/api/settings/auth", expect: { GET: "admin", PUT: "admin", POST: "admin", DELETE: "admin" } },
  { sample: "/api/settings/notifications", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/models", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/settings/specialists", expect: { GET: "admin", PUT: "admin", DELETE: "admin" } },
  { sample: "/api/settings/specialists/enabled", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/specialists/tiers", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/model-cache-visualization/enabled", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/settings/model-overrides", expect: { GET: "member", PUT: "admin", DELETE: "admin" }, killSwitched: true },
  { sample: "/api/settings/openrouter/available-models", expect: { GET: "admin" } },
  { sample: "/api/settings/openrouter/models", expect: { GET: "admin", PUT: "admin", DELETE: "admin" } },
  { sample: "/api/settings/extensions", expect: { GET: "admin" } },
  { sample: "/api/settings/skills", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/settings/chrome-cdp", expect: { GET: "admin", PUT: "admin", POST: "admin" } },

  // --- project resources (member project reads, R1) -------------------------
  { sample: "/api/settings/project-resources", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/settings/project-resources/override", expect: { PUT: "member" }, killSwitched: true },
  { sample: "/api/settings/project-resources/trust", expect: { PUT: "member" }, killSwitched: true },
  { sample: "/api/settings/project-resources/seed", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/settings/project-resources/project-agents/activate", expect: { POST: "member" }, killSwitched: true },

  // --- debug / stats / telemetry (instance-scoped) ---------------------------
  { sample: "/api/debug/codex-transport", expect: { GET: "admin" }, optional: true },
  { sample: "/api/debug/sidebar-perf", expect: { GET: "admin" } },
  { sample: "/api/stats", expect: { GET: "admin" } },
  { sample: "/api/stats/refresh", expect: { POST: "admin" } },
  { sample: "/api/stats/tokens", expect: { GET: "admin" } },
  { sample: "/api/stats/tokens/refresh", expect: { POST: "admin" } },
  { sample: "/api/stats/tokens/workers", expect: { GET: "admin" } },
  { sample: "/api/stats/tokens/worker-events", expect: { GET: "admin" } },
  { sample: "/api/provider-usage", expect: { GET: "admin" } },
  { sample: "/api/telemetry/send-now", expect: { POST: "admin" }, optional: true },

  // --- transcription (member from R2) ----------------------------------------
  { sample: "/api/transcribe", expect: { POST: "member" }, killSwitched: true },

  // --- project-scoped session surfaces ---------------------------------------
  { sample: "/api/managers/mgr-1/schedules", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/restart-recovery", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/slash-commands", expect: { GET: "admin", POST: "admin" } },
  { sample: "/api/agents/agent-1/compact", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/agents/agent-1/smart-compact", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/agents/agent-1/clear", expect: { POST: "member" }, killSwitched: true },
  { sample: "/api/agents/agent-1/system-prompt", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/sessions/sess-1/audit", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/sessions/sess-1/audit/entry", expect: { GET: "member" }, killSwitched: true },
  { sample: "/api/codex-app-server/catalog", expect: { GET: "admin" } },

  // --- mobile push (instance-scoped; remote desktop notifications deferred) --
  { sample: "/api/mobile/push/register", expect: { POST: "admin" } },
  { sample: "/api/mobile/push/unregister", expect: { POST: "admin" } },
  { sample: "/api/mobile/notification-preferences", expect: { GET: "admin", PUT: "admin" } },
  { sample: "/api/mobile/push/test", expect: { POST: "admin" } },

  // --- terminals (list/shells member-read R1; mutations/tickets R2) ----------
  { sample: "/api/terminals/settings", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/terminals/available-shells", expect: { GET: "member" }, killSwitched: true, optional: true },
  { sample: "/api/terminals", expect: { GET: "member", POST: "member" }, killSwitched: true, optional: true },
  { sample: "/api/terminals/term-1", expect: { PATCH: "member", DELETE: "member" }, killSwitched: true, optional: true },
  { sample: "/api/terminals/term-1/resize", expect: { POST: "member" }, killSwitched: true, optional: true },
  { sample: "/api/terminals/term-1/ticket", expect: { POST: "member" }, killSwitched: true, optional: true },

  // --- integrations / prompts (instance prompt registry — admin forever) -----
  { sample: "/api/managers/mgr-1/integrations/telegram", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/prompts", expect: { GET: "admin" }, optional: true },
  { sample: "/api/prompts/preview", expect: { POST: "admin" }, optional: true },
  { sample: "/api/prompts/cortex-surfaces", expect: { GET: "admin" }, optional: true },
  { sample: "/api/prompts/cortex-surfaces/surface-1", expect: { GET: "admin", PUT: "admin" }, optional: true },
  { sample: "/api/prompts/cortex-surfaces/surface-1/reset", expect: { POST: "admin" }, optional: true },
  { sample: "/api/prompts/prompt-1/variant-1", expect: { GET: "admin", PUT: "admin", DELETE: "admin" }, optional: true },

  // --- non-API static surfaces ------------------------------------------------
  { sample: "/mermaid-preview", expect: { GET: "public" } },
  { sample: "/mermaid-preview/assets/vendor/mermaid.min.js", expect: { GET: "public" } },
  { sample: "/index.html", expect: { GET: "public" }, optional: true },
];

const tempConfigHandles: TempConfigHandle[] = [];
let activeServer: StartedServer | null = null;

afterAll(async () => {
  if (activeServer) {
    await activeServer.stop();
    activeServer = null;
  }

  while (tempConfigHandles.length > 0) {
    const handle = tempConfigHandles.pop();
    if (!handle) {
      continue;
    }
    clearCollaborationBetterAuthService(handle.config);
    closeCollaborationAuthDb(handle.config);
    await handle.cleanup();
  }
});

async function startCollaborationServer(): Promise<StartedServer> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "forge-route-inventory-"));
  const tempConfigHandle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
  });
  tempConfigHandle.config.collaborationBaseUrl = `http://${tempConfigHandle.config.host}:${tempConfigHandle.config.port}`;
  tempConfigHandles.push(tempConfigHandle);

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  });
  activeServer = server;
  return server;
}

describe("route inventory classification gate", () => {
  it("keeps the default classification admin and OPTIONS public", () => {
    expect(classifyCollaborationHttpRequest("/api/definitely-not-a-route", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/definitely-not-a-route", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/files/list", "OPTIONS")).toBe("public");
  });

  it("matches the reviewed classification for every inventory entry", () => {
    for (const entry of ROUTE_INVENTORY) {
      for (const [method, expected] of Object.entries(entry.expect)) {
        const on = classifyCollaborationHttpRequest(entry.sample, method, REMOTE_BUILD_ON);
        expect(on, `${method} ${entry.sample} with remoteBuild on`).toBe(expected);

        const off = classifyCollaborationHttpRequest(entry.sample, method, REMOTE_BUILD_OFF);
        const expectedOff = entry.killSwitched && expected === "member" ? "admin" : expected;
        expect(off, `${method} ${entry.sample} with remoteBuild off`).toBe(expectedOff);

        // No policy supplied → fail closed, identical to kill switch off.
        const bare = classifyCollaborationHttpRequest(entry.sample, method);
        expect(bare, `${method} ${entry.sample} with no policy`).toBe(expectedOff);
      }
    }
  });

  it("covers every registered collaboration-server route with a reviewed entry", async () => {
    const server = await startCollaborationServer();
    const routes = server.listRegisteredHttpRoutes();

    expect(
      routes.some((route) => route.matches("/api/settings/builder-sidebar-order")),
      "The local Builder sidebar preference must never be mounted on collaboration-server instances.",
    ).toBe(false);

    const unmatchedRoutes: string[] = [];
    for (const route of routes) {
      const matched = ROUTE_INVENTORY.some((entry) => route.matches(entry.sample));
      if (!matched) {
        unmatchedRoutes.push(route.methods);
      }
    }

    expect(
      unmatchedRoutes,
      `Registered routes without a reviewed inventory entry (identified by methods string). ` +
        `Add each new route to ROUTE_INVENTORY with an explicit access class.`,
    ).toEqual([]);

    const staleSamples: string[] = [];
    for (const entry of ROUTE_INVENTORY) {
      if (entry.optional) {
        continue;
      }
      const matched = routes.some((route) => route.matches(entry.sample));
      if (!matched) {
        staleSamples.push(entry.sample);
      }
    }

    expect(
      staleSamples,
      "Inventory samples that no longer match any registered route — prune or fix them.",
    ).toEqual([]);
  });
});
