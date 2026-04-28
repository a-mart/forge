import type Database from "better-sqlite3";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { SwarmConfig } from "../../swarm/types.js";
import type { CollaborationBetterAuthService } from "./better-auth-service.js";

const ADMIN_DISPLAY_NAME = "Administrator";

interface AdminExistsRow {
  has_admin: number;
}

export async function bootstrapCollaborationAdmin(
  config: SwarmConfig,
  db: Database.Database,
  authService: CollaborationBetterAuthService,
): Promise<void> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget) || hasAdmin(db)) {
    return;
  }

  const { email, password } = requireAdminBootstrapCredentials(config);
  const user = await authService.createUser(email, ADMIN_DISPLAY_NAME, password);
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO collaboration_user (
         user_id,
         role,
         disabled,
         password_change_required,
         created_by_user_id,
         created_at,
         updated_at
       )
       VALUES (?, 'admin', 0, 0, NULL, ?, ?)`,
    ).run(user.id, now, now);
  } catch (error) {
    await authService.deleteUser(user.id).catch(() => undefined);
    throw error;
  }

  console.info(`[collaboration] Bootstrapped first admin user ${user.email}`);
}

function hasAdmin(db: Database.Database): boolean {
  const row = db.prepare<[], AdminExistsRow>(
    `SELECT 1 AS has_admin
     FROM collaboration_user
     WHERE role = 'admin'
       AND disabled = 0
     LIMIT 1`,
  ).get();

  return row?.has_admin === 1;
}

function requireAdminBootstrapCredentials(config: SwarmConfig): { email: string; password: string } {
  const email = config.adminEmail?.trim() ?? "";
  const password = config.adminPassword ?? "";
  const missingEnvVars: string[] = [];

  if (!email) {
    missingEnvVars.push("FORGE_ADMIN_EMAIL");
  }

  if (password.length === 0) {
    missingEnvVars.push("FORGE_ADMIN_PASSWORD");
  }

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Collaboration server runtime is enabled but no admin exists. Missing required admin bootstrap env var(s): ${missingEnvVars.join(", ")}`,
    );
  }

  return { email, password };
}
