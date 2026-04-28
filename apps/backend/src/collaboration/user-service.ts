import type Database from "better-sqlite3";
import type { CollaborationRole, CollaborationUser } from "@forge/protocol";
import type { CollaborationBetterAuthService } from "./auth/better-auth-service.js";

interface CollaborationUserRow {
  user_id: string;
  email: string;
  name: string;
  role: CollaborationRole;
  disabled: number;
  password_change_required: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationUserState extends CollaborationUser {
  passwordChangeRequired: boolean;
}

export interface CollaborationUserUpdate {
  name?: string;
  role?: CollaborationRole;
  disabled?: boolean;
}

export interface CollaborationUserUpdateResult {
  user: CollaborationUser;
  previousUser: CollaborationUser;
  nameChanged: boolean;
  roleChanged: boolean;
  disabledChanged: boolean;
  deactivated: boolean;
  reactivated: boolean;
}

export class CollaborationUserServiceError extends Error {
  constructor(
    public readonly code: "not_found" | "last_admin" | "invalid_password",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationUserServiceError";
  }
}

export class CollaborationUserService {
  constructor(
    private readonly db: Database.Database,
    private readonly authService: CollaborationBetterAuthService,
  ) {}

  listUsers(): CollaborationUser[] {
    return this.db.prepare<[], CollaborationUserRow>(
      `SELECT cu.user_id,
              u.email,
              u.name,
              cu.role,
              cu.disabled,
              cu.password_change_required,
              cu.created_at,
              cu.updated_at
       FROM collaboration_user cu
       JOIN "user" u ON u.id = cu.user_id
       ORDER BY cu.created_at ASC, u.email ASC`,
    ).all().map(toCollaborationUser);
  }

  getUser(userId: string): CollaborationUser | null {
    const row = this.getUserRow(normalizeRequiredString(userId, "userId"));
    return row ? toCollaborationUser(row) : null;
  }

  getUserState(userId: string): CollaborationUserState | null {
    const row = this.getUserRow(normalizeRequiredString(userId, "userId"));
    return row ? toCollaborationUserState(row) : null;
  }

  async updateUser(userId: string, update: CollaborationUserUpdate): Promise<CollaborationUserUpdateResult> {
    const normalizedUserId = normalizeRequiredString(userId, "userId");
    const normalizedUpdate = normalizeUserUpdate(update);
    const now = new Date().toISOString();

    const result = this.db.transaction(() => {
      const existingUser = this.getRequiredUserRow(normalizedUserId);
      const nextName = normalizedUpdate.name ?? existingUser.name;
      const nextRole = normalizedUpdate.role ?? existingUser.role;
      const nextDisabled = normalizedUpdate.disabled ?? existingUser.disabled === 1;
      const nameChanged = nextName !== existingUser.name;
      const roleChanged = nextRole !== existingUser.role;
      const disabledChanged = nextDisabled !== (existingUser.disabled === 1);

      if (!nameChanged && !roleChanged && !disabledChanged) {
        return {
          user: toCollaborationUser(existingUser),
          previousUser: toCollaborationUser(existingUser),
          nameChanged: false,
          roleChanged: false,
          disabledChanged: false,
          deactivated: false,
          reactivated: false,
        } satisfies CollaborationUserUpdateResult;
      }

      this.assertNotRemovingLastAdmin(existingUser, { role: nextRole, disabled: nextDisabled });

      if (nameChanged) {
        this.db.prepare(
          `UPDATE "user"
           SET name = ?,
               updatedAt = ?
           WHERE id = ?`,
        ).run(nextName, now, normalizedUserId);
      }

      this.db.prepare(
        `UPDATE collaboration_user
         SET role = ?,
             disabled = ?,
             updated_at = ?
         WHERE user_id = ?`,
      ).run(nextRole, nextDisabled ? 1 : 0, now, normalizedUserId);

      const updatedUser = this.getRequiredUserRow(normalizedUserId);
      return {
        user: toCollaborationUser(updatedUser),
        previousUser: toCollaborationUser(existingUser),
        nameChanged,
        roleChanged,
        disabledChanged,
        deactivated: disabledChanged && nextDisabled,
        reactivated: disabledChanged && !nextDisabled,
      } satisfies CollaborationUserUpdateResult;
    })();

    if (result.deactivated) {
      await this.authService.revokeUserSessions(normalizedUserId);
    }

    return result;
  }

  async resetUserPassword(userId: string, temporaryPassword: string): Promise<CollaborationUserState> {
    const normalizedUserId = normalizeRequiredString(userId, "userId");
    this.getRequiredUserRow(normalizedUserId);

    await this.authService.setUserPassword(normalizedUserId, temporaryPassword, {
      passwordChangeRequired: true,
    });

    const updatedUser = this.getUserState(normalizedUserId);
    if (!updatedUser) {
      throw new CollaborationUserServiceError("not_found", `Unknown collaboration user: ${normalizedUserId}`);
    }

    return updatedUser;
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId: string,
  ): Promise<CollaborationUserState> {
    const normalizedUserId = normalizeRequiredString(userId, "userId");
    const passwordMatches = await this.authService.verifyUserPassword(normalizedUserId, currentPassword);
    if (!passwordMatches) {
      throw new CollaborationUserServiceError("invalid_password", "Current password is incorrect");
    }

    await this.authService.setUserPassword(normalizedUserId, newPassword, {
      passwordChangeRequired: false,
    });
    await this.authService.revokeOtherUserSessions(normalizedUserId, currentSessionId);

    const updatedUser = this.getUserState(normalizedUserId);
    if (!updatedUser) {
      throw new CollaborationUserServiceError("not_found", `Unknown collaboration user: ${normalizedUserId}`);
    }

    return updatedUser;
  }

  deleteUser(userId: string): CollaborationUserState {
    const normalizedUserId = normalizeRequiredString(userId, "userId");

    return this.db.transaction(() => {
      const existingUser = this.getRequiredUserRow(normalizedUserId);
      this.assertNotRemovingLastAdmin(existingUser, { role: "member", disabled: true });

      const deletedUser = toCollaborationUserState(existingUser);
      this.db.prepare(`DELETE FROM "user" WHERE id = ?`).run(normalizedUserId);
      return deletedUser;
    })();
  }

  private getRequiredUserRow(userId: string): CollaborationUserRow {
    const row = this.getUserRow(userId);
    if (!row) {
      throw new CollaborationUserServiceError("not_found", `Unknown collaboration user: ${userId}`);
    }

    return row;
  }

  private getUserRow(userId: string): CollaborationUserRow | undefined {
    return this.db.prepare<[string], CollaborationUserRow>(
      `SELECT cu.user_id,
              u.email,
              u.name,
              cu.role,
              cu.disabled,
              cu.password_change_required,
              cu.created_at,
              cu.updated_at
       FROM collaboration_user cu
       JOIN "user" u ON u.id = cu.user_id
       WHERE cu.user_id = ?`,
    ).get(userId);
  }

  private assertNotRemovingLastAdmin(
    existingUser: CollaborationUserRow,
    nextState: { role: CollaborationRole; disabled: boolean },
  ): void {
    const isCurrentlyEnabledAdmin = existingUser.role === "admin" && existingUser.disabled === 0;
    const remainsEnabledAdmin = nextState.role === "admin" && nextState.disabled === false;
    if (!isCurrentlyEnabledAdmin || remainsEnabledAdmin) {
      return;
    }

    const row = this.db.prepare<[string], { admin_count: number }>(
      `SELECT COUNT(*) AS admin_count
       FROM collaboration_user
       WHERE role = 'admin'
         AND disabled = 0
         AND user_id != ?`,
    ).get(existingUser.user_id);

    if (Number(row?.admin_count ?? 0) === 0) {
      throw new CollaborationUserServiceError(
        "last_admin",
        `Cannot change collaboration user ${existingUser.user_id}; it is the last enabled admin`,
      );
    }
  }
}

function toCollaborationUser(row: CollaborationUserRow): CollaborationUser {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabled === 1,
    authMethods: ["password"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCollaborationUserState(row: CollaborationUserRow): CollaborationUserState {
  return {
    ...toCollaborationUser(row),
    passwordChangeRequired: row.password_change_required === 1,
  };
}

function normalizeUserUpdate(update: CollaborationUserUpdate): CollaborationUserUpdate {
  return {
    ...(update.name !== undefined ? { name: normalizeRequiredString(update.name, "name") } : {}),
    ...(update.role !== undefined ? { role: normalizeRole(update.role) } : {}),
    ...(update.disabled !== undefined ? { disabled: update.disabled } : {}),
  };
}

function normalizeRole(role: CollaborationRole): CollaborationRole {
  if (role !== "admin" && role !== "member") {
    throw new Error(`Invalid collaboration user role: ${role}`);
  }

  return role;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration user ${fieldName}`);
  }

  return normalized;
}
