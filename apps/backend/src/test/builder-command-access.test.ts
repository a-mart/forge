import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@forge/protocol";
import type { CollaborationAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  BUILDER_COMMAND_ACCESS,
  MEMBER_ALLOWED_TIERS,
  canUseBuilder,
  evaluateApiProxyMemberAccess,
  evaluateBuilderCommandAccess,
} from "../ws/builder-command-access.js";

function createAuthContext(
  role: CollaborationAuthContext["role"],
  overrides?: Partial<CollaborationAuthContext>,
): CollaborationAuthContext {
  return {
    userId: overrides?.userId ?? `${role}-user`,
    email: overrides?.email ?? `${role}@example.com`,
    name: overrides?.name ?? `${role} user`,
    role,
    disabled: overrides?.disabled ?? false,
    passwordChangeRequired: overrides?.passwordChangeRequired ?? false,
    sessionId: overrides?.sessionId,
  };
}

const READ_COMMANDS = (Object.keys(BUILDER_COMMAND_ACCESS) as Array<ClientCommand["type"]>).filter(
  (type) => BUILDER_COMMAND_ACCESS[type] === "read",
);
const WRITE_COMMANDS = (Object.keys(BUILDER_COMMAND_ACCESS) as Array<ClientCommand["type"]>).filter(
  (type) => BUILDER_COMMAND_ACCESS[type] === "write",
);
const ADMIN_COMMANDS = (Object.keys(BUILDER_COMMAND_ACCESS) as Array<ClientCommand["type"]>).filter(
  (type) => BUILDER_COMMAND_ACCESS[type] === "admin",
);

describe("builder command access policy", () => {
  it("classifies key commands into the expected tiers", () => {
    expect(BUILDER_COMMAND_ACCESS.subscribe).toBe("read");
    expect(BUILDER_COMMAND_ACCESS.get_session_workers).toBe("read");
    expect(BUILDER_COMMAND_ACCESS.user_message).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.session_goal_control).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.create_manager).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.delete_session).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.api_proxy).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.list_directories).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.validate_directory).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.create_directory).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.pick_directory).toBe("admin");
    expect(BUILDER_COMMAND_ACCESS.create_repository_project).toBe("admin");
    expect(BUILDER_COMMAND_ACCESS.cancel_repository_project_creation).toBe("admin");
    expect(MEMBER_ALLOWED_TIERS.has(BUILDER_COMMAND_ACCESS.create_directory)).toBe(true);
    expect(
      evaluateBuilderCommandAccess({
        commandType: "create_directory",
        authContext: createAuthContext("member"),
        remoteBuildEnabled: true,
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateBuilderCommandAccess({
        commandType: "create_directory",
        authContext: createAuthContext("member"),
        remoteBuildEnabled: false,
      }),
    ).toMatchObject({ ok: false, reason: "remote_build_disabled" });
    expect(
      evaluateBuilderCommandAccess({
        commandType: "pick_directory",
        authContext: createAuthContext("member"),
        remoteBuildEnabled: true,
      }),
    ).toMatchObject({ ok: false, reason: "tier_not_granted" });
    expect(BUILDER_COMMAND_ACCESS.resume_restart_recovery).toBe("admin");
    expect(BUILDER_COMMAND_ACCESS.dismiss_restart_recovery).toBe("admin");
    // Tier sets stay non-empty; a refactor emptying one is suspicious.
    expect(READ_COMMANDS.length).toBeGreaterThan(0);
    expect(WRITE_COMMANDS.length).toBeGreaterThan(0);
    expect(ADMIN_COMMANDS.length).toBeGreaterThan(0);
  });

  it("canUseBuilder: admins always; members only when remote build is enabled", () => {
    const admin = createAuthContext("admin");
    const member = createAuthContext("member");

    expect(canUseBuilder(admin, { remoteBuildEnabled: false })).toBe(true);
    expect(canUseBuilder(admin, { remoteBuildEnabled: true })).toBe(true);
    expect(canUseBuilder(member, { remoteBuildEnabled: false })).toBe(false);
    expect(canUseBuilder(member, { remoteBuildEnabled: true })).toBe(true);
    expect(canUseBuilder(null, { remoteBuildEnabled: true })).toBe(false);
    expect(canUseBuilder(createAuthContext("member", { disabled: true }), { remoteBuildEnabled: true })).toBe(false);
    expect(
      canUseBuilder(createAuthContext("member", { passwordChangeRequired: true }), { remoteBuildEnabled: true }),
    ).toBe(false);
  });

  it("admins pass every command regardless of the kill switch", () => {
    const admin = createAuthContext("admin");
    for (const commandType of Object.keys(BUILDER_COMMAND_ACCESS) as Array<ClientCommand["type"]>) {
      for (const remoteBuildEnabled of [true, false]) {
        const decision = evaluateBuilderCommandAccess({ commandType, authContext: admin, remoteBuildEnabled });
        expect(decision.ok, `${commandType} for admin (remoteBuild ${remoteBuildEnabled})`).toBe(true);
      }
    }
  });

  it("members get exactly the granted tiers while remote build is enabled", () => {
    const member = createAuthContext("member");

    for (const commandType of READ_COMMANDS) {
      const decision = evaluateBuilderCommandAccess({ commandType, authContext: member, remoteBuildEnabled: true });
      expect(decision.ok, `${commandType} read for member`).toBe(MEMBER_ALLOWED_TIERS.has("read"));
    }

    for (const commandType of WRITE_COMMANDS) {
      const decision = evaluateBuilderCommandAccess({ commandType, authContext: member, remoteBuildEnabled: true });
      expect(decision.ok, `${commandType} write for member`).toBe(MEMBER_ALLOWED_TIERS.has("write"));
      if (!decision.ok) {
        expect(decision.reason).toBe("tier_not_granted");
      }
    }

    for (const commandType of ADMIN_COMMANDS) {
      const decision = evaluateBuilderCommandAccess({ commandType, authContext: member, remoteBuildEnabled: true });
      expect(decision.ok, `${commandType} admin for member`).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe("tier_not_granted");
      }
    }
  });

  it("the kill switch denies members every command", () => {
    const member = createAuthContext("member");
    for (const commandType of Object.keys(BUILDER_COMMAND_ACCESS) as Array<ClientCommand["type"]>) {
      const decision = evaluateBuilderCommandAccess({ commandType, authContext: member, remoteBuildEnabled: false });
      expect(decision.ok, `${commandType} for member with kill switch off`).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe("remote_build_disabled");
      }
    }
  });

  it("denies unauthenticated, disabled, and password-change-required accounts", () => {
    expect(
      evaluateBuilderCommandAccess({ commandType: "subscribe", authContext: null, remoteBuildEnabled: true }),
    ).toMatchObject({ ok: false, reason: "auth_required" });
    expect(
      evaluateBuilderCommandAccess({
        commandType: "subscribe",
        authContext: createAuthContext("member", { disabled: true }),
        remoteBuildEnabled: true,
      }),
    ).toMatchObject({ ok: false, reason: "account_disabled" });
    expect(
      evaluateBuilderCommandAccess({
        commandType: "subscribe",
        authContext: createAuthContext("admin", { passwordChangeRequired: true }),
        remoteBuildEnabled: true,
      }),
    ).toMatchObject({ ok: false, reason: "account_disabled" });
  });
});

describe("api_proxy member access", () => {
  const member = createAuthContext("member");
  const admin = createAuthContext("admin");

  it("admins and local sockets pass every proxied path", () => {
    for (const authContext of [admin, null]) {
      expect(
        evaluateApiProxyMemberAccess({
          pathname: "/api/auth/tokens",
          method: "GET",
          authContext,
          terminalsEnabled: false,
        }).ok,
      ).toBe(true);
    }
  });

  it("members get the allowlisted project surfaces and nothing else", () => {
    const allowed: Array<[string, string]> = [
      ["/api/read-file", "GET"],
      ["/api/read-file", "POST"],
      ["/api/chat-artifacts/read", "POST"],
      ["/api/unread", "GET"],
      ["/api/unread", "POST"],
      ["/api/slash-commands", "GET"],
      ["/api/feedback", "POST"],
      ["/api/agents/agent-1/smart-compact", "POST"],
      ["/api/terminals", "GET"],
      ["/api/terminals", "POST"],
      ["/api/terminals/term-1", "DELETE"],
      ["/api/terminals/term-1/ticket", "POST"],
      ["/api/terminals/term-1/resize", "POST"],
    ];
    for (const [pathname, method] of allowed) {
      expect(
        evaluateApiProxyMemberAccess({ pathname, method, authContext: member, terminalsEnabled: true }).ok,
        `${method} ${pathname}`,
      ).toBe(true);
    }

    const denied: Array<[string, string]> = [
      ["/api/auth/tokens", "GET"],
      ["/api/mobile/notification-preferences", "GET"],
      ["/api/mobile/devices/register", "POST"],
      ["/api/mobile/push/register", "POST"],
      ["/api/mobile/push/test", "POST"],
      ["/api/slash-commands", "POST"],
      ["/api/anything-else", "GET"],
      ["/api/chat-artifacts/read/", "POST"],
      ["/api/chat-artifacts/read%2f", "POST"],
    ];
    for (const [pathname, method] of denied) {
      expect(
        evaluateApiProxyMemberAccess({ pathname, method, authContext: member, terminalsEnabled: true }).ok,
        `${method} ${pathname}`,
      ).toBe(false);
    }
  });

  it("terminal mutations honor the terminalsEnabled lever; reads do not", () => {
    expect(
      evaluateApiProxyMemberAccess({ pathname: "/api/terminals", method: "POST", authContext: member, terminalsEnabled: false }).ok,
    ).toBe(false);
    expect(
      evaluateApiProxyMemberAccess({ pathname: "/api/terminals/t/ticket", method: "POST", authContext: member, terminalsEnabled: false }).ok,
    ).toBe(false);
    expect(
      evaluateApiProxyMemberAccess({ pathname: "/api/terminals", method: "GET", authContext: member, terminalsEnabled: false }).ok,
    ).toBe(true);
  });
});
