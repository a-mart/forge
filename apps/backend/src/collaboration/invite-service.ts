import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CollaborationCreatedInvite,
  CollaborationInvite,
  CollaborationInviteLookupResult,
  CollaborationInviteRedeemedUser,
  CollaborationInviteStatus,
} from "@forge/protocol";
import type { CollaborationAuditService } from "./audit-service.js";
import type { CollaborationAuthUser, CollaborationBetterAuthService } from "./auth/better-auth-service.js";
import type { CollaborationSettingsService } from "./settings-service.js";

const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const MEMBER_ROLE = "member";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CollaborationInviteErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "consumed"
  | "unsupported"
  | "email_required"
  | "invalid_email"
  | "invalid_password"
  | "email_mismatch"
  | "duplicate_email"
  | "invalid_expires_in_days"
  | "missing_base_url";

interface CollaborationInviteRow {
  invite_id: string;
  token_hash: string;
  email: string | null;
  role: "member";
  invited_by_user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
  consumed_by_user_id: string | null;
}

export class CollaborationInviteServiceError extends Error {
  constructor(
    public readonly code: CollaborationInviteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationInviteServiceError";
  }
}

export class CollaborationInviteService {
  constructor(
    private readonly db: Database.Database,
    private readonly authService: CollaborationBetterAuthService,
    private readonly settingsService: CollaborationSettingsService,
    private readonly auditService?: CollaborationAuditService,
  ) {}

  createInvite(invitedByUserId: string, email: string, expiresInDays = DEFAULT_INVITE_EXPIRY_DAYS): CollaborationCreatedInvite {
    const normalizedInvitedByUserId = normalizeRequiredString(invitedByUserId, "invitedByUserId");
    const normalizedEmail = normalizeInviteEmail(email);
    const normalizedExpiryDays = normalizeExpiresInDays(expiresInDays);
    const baseUrl = normalizeBaseUrl(this.settingsService.getCollaborationBaseUrl());
    const inviteId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(token);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + normalizedExpiryDays * 24 * 60 * 60 * 1000);
    const createdAtIso = createdAt.toISOString();
    const expiresAtIso = expiresAt.toISOString();

    this.db.transaction(() => {
      const replacedInvites = this.db.prepare<[string, string], CollaborationInviteRow>(
        `SELECT invite_id,
                token_hash,
                email,
                role,
                invited_by_user_id,
                created_at,
                expires_at,
                revoked_at,
                consumed_at,
                consumed_by_user_id
         FROM collaboration_invite
         WHERE email = ?
           AND revoked_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?
         ORDER BY created_at ASC, invite_id ASC`,
      ).all(normalizedEmail, createdAtIso);

      if (replacedInvites.length > 0) {
        this.db.prepare(
          `UPDATE collaboration_invite
           SET revoked_at = ?
           WHERE email = ?
             AND revoked_at IS NULL
             AND consumed_at IS NULL
             AND expires_at > ?`,
        ).run(createdAtIso, normalizedEmail, createdAtIso);
      }

      this.db.prepare(
        `INSERT INTO collaboration_invite (
           invite_id,
           token_hash,
           email,
           role,
           invited_by_user_id,
           created_at,
           expires_at,
           revoked_at,
           consumed_at,
           consumed_by_user_id
         )
         VALUES (?, ?, ?, 'member', ?, ?, ?, NULL, NULL, NULL)`,
      ).run(inviteId, tokenHash, normalizedEmail, normalizedInvitedByUserId, createdAtIso, expiresAtIso);

      for (const replacedInvite of replacedInvites) {
        this.auditService?.log({
          action: "collaboration_invite_revoked",
          actorUserId: normalizedInvitedByUserId,
          targetInviteId: replacedInvite.invite_id,
          metadata: { status: "revoked", reason: "replaced" },
        });
      }

      this.auditService?.log({
        action: "collaboration_invite_created",
        actorUserId: normalizedInvitedByUserId,
        targetInviteId: inviteId,
        metadata: { role: MEMBER_ROLE, emailBound: true, expiresInDays: normalizedExpiryDays },
      });
    })();

    return {
      inviteId,
      email: normalizedEmail,
      role: MEMBER_ROLE,
      createdAt: createdAtIso,
      expiresAt: expiresAtIso,
      inviteUrl: `${baseUrl}/collaboration/invite/${token}`,
    };
  }

  getInvite(token: string): CollaborationInviteLookupResult {
    const invite = this.findInviteByTokenHash(hashInviteToken(normalizeRequiredString(token, "token")));
    if (!invite) {
      return { valid: false, error: "not_found" };
    }

    const status = computeInviteStatus(invite);
    if (status !== "pending") {
      return { valid: false, error: status };
    }

    if (!invite.email) {
      return { valid: false, error: "unsupported" };
    }

    return {
      valid: true,
      invite: {
        inviteId: invite.invite_id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expires_at,
      },
    };
  }

  async redeemInvite(token: string, email: string, name: string, password: string): Promise<CollaborationInviteRedeemedUser> {
    const normalizedToken = normalizeRequiredString(token, "token");
    const normalizedEmail = normalizeRedeemEmail(email);
    const normalizedName = normalizeRequiredString(name, "name");
    const normalizedPassword = normalizeRequiredPassword(password, "password");
    const tokenHash = hashInviteToken(normalizedToken);
    const invite = this.findInviteByTokenHash(tokenHash);

    assertInviteCanBeRedeemed(invite, normalizedEmail);

    let user: CollaborationAuthUser;
    try {
      user = await this.authService.createUser(normalizedEmail, normalizedName, normalizedPassword);
    } catch (error) {
      if (isDuplicateUserError(error)) {
        throw new CollaborationInviteServiceError(
          "duplicate_email",
          `A collaboration account already exists for ${normalizedEmail}`,
        );
      }

      if (isPasswordValidationError(error)) {
        throw new CollaborationInviteServiceError("invalid_password", error instanceof Error ? error.message : String(error));
      }

      throw error;
    }

    try {
      this.db.transaction(() => {
        const currentInvite = this.findInviteByTokenHash(tokenHash);
        assertInviteCanBeRedeemed(currentInvite, normalizedEmail);

        const now = new Date().toISOString();
        this.db.prepare(
          `INSERT INTO collaboration_user (
             user_id,
             role,
             disabled,
             password_change_required,
             created_by_user_id,
             created_at,
             updated_at
           )
           VALUES (?, 'member', 0, 0, ?, ?, ?)`,
        ).run(user.id, currentInvite.invited_by_user_id, now, now);

        this.db.prepare(
          `UPDATE collaboration_invite
           SET consumed_at = ?,
               consumed_by_user_id = ?
           WHERE invite_id = ?`,
        ).run(now, user.id, currentInvite.invite_id);
      })();
    } catch (error) {
      await this.authService.deleteUser(user.id).catch(() => undefined);
      throw error;
    }

    this.auditService?.log({
      action: "collaboration_invite_redeemed",
      actorUserId: user.id,
      targetUserId: user.id,
      targetInviteId: invite.invite_id,
      metadata: { role: MEMBER_ROLE, emailBound: true },
    });

    return { userId: user.id, email: user.email, name: user.name, role: MEMBER_ROLE };
  }

  listInvites(): CollaborationInvite[] {
    return this.db.prepare<[], CollaborationInviteRow>(
      `SELECT invite_id,
              token_hash,
              email,
              role,
              invited_by_user_id,
              created_at,
              expires_at,
              revoked_at,
              consumed_at,
              consumed_by_user_id
       FROM collaboration_invite
       ORDER BY created_at DESC, invite_id DESC`,
    ).all().map(toCollaborationInvite);
  }

  revokeInvite(inviteId: string, actorUserId?: string): void {
    const normalizedInviteId = normalizeRequiredString(inviteId, "inviteId");

    this.db.transaction(() => {
      const invite = this.db.prepare<[string], CollaborationInviteRow>(
        `SELECT invite_id,
                token_hash,
                email,
                role,
                invited_by_user_id,
                created_at,
                expires_at,
                revoked_at,
                consumed_at,
                consumed_by_user_id
         FROM collaboration_invite
         WHERE invite_id = ?`,
      ).get(normalizedInviteId);

      if (!invite) {
        throw new CollaborationInviteServiceError("not_found", `Unknown collaboration invite: ${normalizedInviteId}`);
      }

      if (invite.consumed_at) {
        throw new CollaborationInviteServiceError("consumed", `Collaboration invite ${normalizedInviteId} has already been consumed`);
      }

      if (invite.revoked_at) {
        return;
      }

      const revokedAt = new Date().toISOString();
      this.db.prepare(
        `UPDATE collaboration_invite
         SET revoked_at = ?
         WHERE invite_id = ?`,
      ).run(revokedAt, normalizedInviteId);

      this.auditService?.log({
        action: "collaboration_invite_revoked",
        actorUserId: actorUserId ? normalizeRequiredString(actorUserId, "actorUserId") : null,
        targetInviteId: normalizedInviteId,
        metadata: { status: "revoked", reason: "manual" },
      });
    })();
  }

  private findInviteByTokenHash(tokenHash: string): CollaborationInviteRow | null {
    return this.db.prepare<[string], CollaborationInviteRow>(
      `SELECT invite_id,
              token_hash,
              email,
              role,
              invited_by_user_id,
              created_at,
              expires_at,
              revoked_at,
              consumed_at,
              consumed_by_user_id
       FROM collaboration_invite
       WHERE token_hash = ?`,
    ).get(tokenHash) ?? null;
  }
}

function toCollaborationInvite(row: CollaborationInviteRow): CollaborationInvite {
  return {
    inviteId: row.invite_id,
    ...(row.email ? { email: row.email } : {}),
    role: row.role,
    status: computeInviteStatus(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

function computeInviteStatus(invite: CollaborationInviteRow): CollaborationInviteStatus {
  if (invite.consumed_at) {
    return "consumed";
  }

  if (invite.revoked_at) {
    return "revoked";
  }

  if (Date.parse(invite.expires_at) <= Date.now()) {
    return "expired";
  }

  return "pending";
}

function assertInviteCanBeRedeemed(
  invite: CollaborationInviteRow | null,
  email: string,
): asserts invite is CollaborationInviteRow & { email: string } {
  if (!invite) {
    throw new CollaborationInviteServiceError("not_found", "Collaboration invite was not found");
  }

  if (!invite.email) {
    throw new CollaborationInviteServiceError("unsupported", "Unsupported collaboration invite type");
  }

  const status = computeInviteStatus(invite);
  if (status !== "pending") {
    throw new CollaborationInviteServiceError(status, `Collaboration invite is ${status}`);
  }

  if (invite.email.toLowerCase() !== email.toLowerCase()) {
    throw new CollaborationInviteServiceError(
      "email_mismatch",
      `Collaboration invite is bound to ${invite.email}`,
    );
  }
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeInviteEmail(email: string | undefined): string {
  if (!email) {
    throw new CollaborationInviteServiceError("email_required", "Collaboration invite email is required");
  }

  return normalizeEmail(email, "invalid_email");
}

function normalizeRedeemEmail(email: string): string {
  return normalizeEmail(email, "invalid_email");
}

function normalizeEmail(email: string, code: CollaborationInviteServiceError["code"]): string {
  const normalized = normalizeRequiredString(email, "email").toLowerCase();
  if (!EMAIL_ADDRESS_PATTERN.test(normalized)) {
    throw new CollaborationInviteServiceError(code, `Invalid collaboration invite email: ${email}`);
  }

  return normalized;
}

function normalizeExpiresInDays(expiresInDays: number): number {
  if (!Number.isInteger(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) {
    throw new CollaborationInviteServiceError(
      "invalid_expires_in_days",
      "Collaboration invite expiry must be an integer between 1 and 90 days",
    );
  }

  return expiresInDays;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const normalized = baseUrl?.trim();
  if (!normalized) {
    throw new CollaborationInviteServiceError(
      "missing_base_url",
      "FORGE_COLLABORATION_BASE_URL must be configured to issue collaboration invites",
    );
  }

  return normalized.replace(/\/$/, "");
}

function normalizeRequiredPassword(password: string, fieldName: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new CollaborationInviteServiceError("invalid_password", `Missing collaboration invite ${fieldName}`);
  }

  return password;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration invite ${fieldName}`);
  }

  return normalized;
}

function isDuplicateUserError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already exists");
}

function isPasswordValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("password");
}
