import type Database from "better-sqlite3";

export interface CollaborationAuthMigration {
  name: string;
  sql?: string;
  apply?: (database: Database.Database) => void;
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

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
