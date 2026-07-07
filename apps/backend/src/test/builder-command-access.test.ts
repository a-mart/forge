import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@forge/protocol";
import type { CollaborationAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  BUILDER_COMMAND_ACCESS,
  MEMBER_ALLOWED_TIERS,
  canUseBuilder,
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
    expect(BUILDER_COMMAND_ACCESS.create_manager).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.delete_session).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.api_proxy).toBe("write");
    expect(BUILDER_COMMAND_ACCESS.pick_directory).toBe("admin");
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
