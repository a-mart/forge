import type Database from "better-sqlite3";

// Migration 0008 backfills persisted specialist selections. These defaults and
// helpers are intentionally frozen here so historical migrations remain
// deterministic and do not drift with mutable runtime specialist/product logic.
// Do not change these values or normalization rules after release; add a new
// migration instead if persisted collaboration defaults need to evolve.
const MIGRATION_0008_DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES = [
  "collab-planner",
  "collab-reviewer",
  "collab-doc-writer",
  "collab-scout",
  "collab-researcher",
] as const;

export interface CollaborationAuthMigration {
  name: string;
  sql?: string;
  apply?: (database: Database.Database) => void;
  backupBeforeApply?: boolean;
}

export const COLLABORATION_AUTH_MIGRATIONS: CollaborationAuthMigration[] = [
  {
    name: "0001-better-auth-base.sql",
    sql: `CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
`,
  },
  {
    name: "0002-collaboration-user.sql",
    sql: `CREATE TABLE IF NOT EXISTS collaboration_user (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  disabled INTEGER NOT NULL DEFAULT 0,
  password_change_required INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collaboration_user_role_idx ON collaboration_user(role);
CREATE INDEX IF NOT EXISTS collaboration_user_disabled_idx ON collaboration_user(disabled);
`,
  },
  {
    name: "0003-collaboration-invite.sql",
    sql: `CREATE TABLE IF NOT EXISTS collaboration_invite (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('member')),
  invited_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  consumed_at TEXT,
  consumed_by_user_id TEXT,
  FOREIGN KEY (invited_by_user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (consumed_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS collaboration_invite_email_idx ON collaboration_invite(email);
CREATE INDEX IF NOT EXISTS collaboration_invite_expires_at_idx ON collaboration_invite(expires_at);
CREATE INDEX IF NOT EXISTS collaboration_invite_pending_idx ON collaboration_invite(consumed_at, revoked_at);
`,
  },
  {
    name: "0004-collaboration-workspace.sql",
    sql: `CREATE TABLE IF NOT EXISTS collab_workspace (
  workspace_id TEXT PRIMARY KEY,
  backing_profile_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  ai_display_name TEXT,
  created_by_user_id TEXT,
  default_model_provider TEXT NOT NULL,
  default_model_id TEXT NOT NULL,
  default_model_thinking_level TEXT NOT NULL,
  default_cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS collab_category (
  category_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  default_model_provider TEXT,
  default_model_id TEXT,
  default_model_thinking_level TEXT,
  default_cwd TEXT,
  default_specialist_handles_json TEXT,
  default_skill_handles_json TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES collab_workspace(workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS collab_category_workspace_position_idx ON collab_category(workspace_id, position, category_id);

CREATE TABLE IF NOT EXISTS collab_channel (
  channel_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category_id TEXT,
  backing_session_agent_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ai_enabled IN (0, 1)),
  model_id TEXT,
  model_thinking_level TEXT,
  active_specialist_handles_json TEXT,
  active_skill_handles_json TEXT,
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  archived_by_user_id TEXT,
  created_by_user_id TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES collab_workspace(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES collab_category(category_id) ON DELETE SET NULL,
  FOREIGN KEY (archived_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS collab_channel_workspace_listing_idx ON collab_channel(workspace_id, archived, category_id, position, channel_id);
CREATE INDEX IF NOT EXISTS collab_channel_backing_session_idx ON collab_channel(backing_session_agent_id);

CREATE TABLE IF NOT EXISTS collab_channel_user_state (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_message_id TEXT,
  last_read_message_seq INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES collab_channel(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collab_channel_user_state_user_idx ON collab_channel_user_state(user_id, channel_id);
`,
  },
  {
    name: "0005-collaboration-audit-log.sql",
    sql: `CREATE TABLE IF NOT EXISTS collaboration_audit_log (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  target_user_id TEXT,
  target_invite_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  FOREIGN KEY (target_invite_id) REFERENCES collaboration_invite(invite_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS collaboration_audit_log_created_at_idx ON collaboration_audit_log(created_at);
CREATE INDEX IF NOT EXISTS collaboration_audit_log_target_user_id_idx ON collaboration_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS collaboration_audit_log_target_invite_id_idx ON collaboration_audit_log(target_invite_id);
`,
  },
  {
    name: "0006-collab-category-defaults-upgrade.sql",
    apply: (database) => {
      addColumnIfMissing(database, "collab_category", "default_model_provider", "TEXT");
      addColumnIfMissing(database, "collab_category", "default_model_thinking_level", "TEXT");
      addColumnIfMissing(database, "collab_category", "default_cwd", "TEXT");
    },
  },
  {
    name: "0007-collab-channel-reasoning.sql",
    apply: (database) => {
      addColumnIfMissing(database, "collab_channel", "model_thinking_level", "TEXT");
    },
  },
  {
    name: "0008-collab-specialist-selections.sql",
    backupBeforeApply: true,
    apply: (database) => {
      addColumnIfMissing(database, "collab_category", "default_specialist_handles_json", "TEXT");
      addColumnIfMissing(database, "collab_channel", "active_specialist_handles_json", "TEXT");

      const defaultHandlesJson = serializeMigration0008SpecialistHandles(
        MIGRATION_0008_DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES,
      );

      database
        .prepare(
          `UPDATE collab_category
           SET default_specialist_handles_json = ?
           WHERE default_specialist_handles_json IS NULL`,
        )
        .run(defaultHandlesJson);

      database
        .prepare(
          `UPDATE collab_channel
           SET active_specialist_handles_json = COALESCE(
             (
               SELECT collab_category.default_specialist_handles_json
               FROM collab_category
               WHERE collab_category.category_id = collab_channel.category_id
             ),
             ?
           )
           WHERE active_specialist_handles_json IS NULL`,
        )
        .run(defaultHandlesJson);

      validateCollaborationSpecialistSelectionMigration(database);
    },
  },
  {
    name: "0009-collab-skill-selections.sql",
    backupBeforeApply: true,
    apply: (database) => {
      addColumnIfMissing(database, "collab_category", "default_skill_handles_json", "TEXT");
      addColumnIfMissing(database, "collab_channel", "active_skill_handles_json", "TEXT");

      validateCollaborationSkillSelectionMigration(database);
    },
  },
];

function addColumnIfMissing(
  database: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinitionSql: string,
): void {
  const existingColumn = database
    .prepare<[], { name: string }>(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`)
    .all()
    .some((row) => row.name === columnName);

  if (existingColumn) {
    return;
  }

  database.exec(
    `ALTER TABLE ${quoteSqliteIdentifier(tableName)} ADD COLUMN ${quoteSqliteIdentifier(columnName)} ${columnDefinitionSql}`,
  );
}

function validateCollaborationSpecialistSelectionMigration(database: Database.Database): void {
  requireColumn(database, "collab_category", "default_specialist_handles_json");
  requireColumn(database, "collab_channel", "active_specialist_handles_json");

  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") {
    throw new Error(`Collaboration DB quick_check failed: ${String(quickCheck)}`);
  }

  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`Collaboration DB foreign_key_check failed for ${foreignKeyFailures.length} row(s)`);
  }

  validateJsonArrayColumn(database, "collab_category", "category_id", "default_specialist_handles_json");
  validateJsonArrayColumn(database, "collab_channel", "channel_id", "active_specialist_handles_json");
}

function validateCollaborationSkillSelectionMigration(database: Database.Database): void {
  requireColumn(database, "collab_category", "default_skill_handles_json");
  requireColumn(database, "collab_channel", "active_skill_handles_json");

  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") {
    throw new Error(`Collaboration DB quick_check failed: ${String(quickCheck)}`);
  }

  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`Collaboration DB foreign_key_check failed for ${foreignKeyFailures.length} row(s)`);
  }

  validateJsonArrayColumn(database, "collab_category", "category_id", "default_skill_handles_json", {
    label: "skill",
    allowNull: true,
  });
  validateJsonArrayColumn(database, "collab_channel", "channel_id", "active_skill_handles_json", {
    label: "skill",
    allowNull: true,
  });
}

function requireColumn(database: Database.Database, tableName: string, columnName: string): void {
  const hasColumn = database
    .prepare<[], { name: string }>(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`)
    .all()
    .some((row) => row.name === columnName);

  if (!hasColumn) {
    throw new Error(`Collaboration DB migration missing expected column ${tableName}.${columnName}`);
  }
}

function validateJsonArrayColumn(
  database: Database.Database,
  tableName: string,
  idColumnName: string,
  jsonColumnName: string,
  options: { label: string; allowNull: boolean } = { label: "specialist", allowNull: false },
): void {
  const rows = database
    .prepare<[], { row_id: string; handles_json: string | null }>(
      `SELECT ${quoteSqliteIdentifier(idColumnName)} AS row_id,
              ${quoteSqliteIdentifier(jsonColumnName)} AS handles_json
       FROM ${quoteSqliteIdentifier(tableName)}`,
    )
    .all();

  for (const row of rows) {
    try {
      parseMigrationJsonHandleArray(row.handles_json, options);
    } catch (error) {
      throw new Error(
        `Invalid collaboration ${options.label} handle JSON in ${tableName}.${jsonColumnName} for ${row.row_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function parseMigrationJsonHandleArray(
  value: string | null | undefined,
  options: { label: string; allowNull: boolean },
): string[] {
  if (value == null) {
    if (options.allowNull) {
      return [];
    }
    throw new Error(`${options.label} handles JSON cannot be null`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${options.label} handles JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${options.label} handles JSON must be an array`);
  }

  return normalizeMigration0008SpecialistHandles(parsed);
}

function serializeMigration0008SpecialistHandles(handles: readonly string[]): string {
  return JSON.stringify(normalizeMigration0008SpecialistHandles(handles));
}

function normalizeMigration0008SpecialistHandles(handles: readonly unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawHandle of handles) {
    if (typeof rawHandle !== "string") {
      throw new Error("specialist handle lists must contain only strings");
    }

    const handle = normalizeMigration0008SpecialistHandle(rawHandle);
    if (!handle) {
      throw new Error(`Invalid specialist handle: ${rawHandle}`);
    }

    if (!seen.has(handle)) {
      seen.add(handle);
      normalized.push(handle);
    }
  }

  return normalized;
}

function normalizeMigration0008SpecialistHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
