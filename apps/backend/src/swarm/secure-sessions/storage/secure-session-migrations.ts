import type Database from "better-sqlite3";

export interface SecureSessionMigration {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
}

export const SECURE_SESSION_MIGRATIONS: readonly SecureSessionMigration[] = [
  {
    version: 1,
    name: "initial_secure_session_schema",
    up(database) {
      database.exec(`
        CREATE TABLE secure_session_provider (
          provider_id TEXT PRIMARY KEY CHECK (length(provider_id) BETWEEN 1 AND 256),
          kind TEXT NOT NULL CHECK (kind IN ('local_keychain', 'bitwarden_secrets_manager')),
          display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          status TEXT NOT NULL CHECK (status IN (
            'available', 'locked', 'auth_required', 'unreachable', 'missing', 'disabled'
          )),
          last_verified_at TEXT,
          last_status_code TEXT CHECK (last_status_code IS NULL OR last_status_code IN (
            'ok', 'source_locked', 'provider_auth_required', 'source_unreachable',
            'source_missing', 'provider_disabled', 'provider_error'
          )),
          server_origin TEXT CHECK (server_origin IS NULL OR length(server_origin) BETWEEN 1 AND 4096),
          organization_id TEXT CHECK (organization_id IS NULL OR length(organization_id) BETWEEN 1 AND 256),
          project_id TEXT CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 256),
          encrypted_access_token BLOB CHECK (
            encrypted_access_token IS NULL OR (
              typeof(encrypted_access_token) = 'blob'
              AND length(encrypted_access_token) BETWEEN 1 AND 1048576
            )
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            kind = 'bitwarden_secrets_manager'
            OR (
              server_origin IS NULL AND organization_id IS NULL AND project_id IS NULL
              AND encrypted_access_token IS NULL
            )
          )
        ) STRICT;

        CREATE TABLE secure_session_catalog_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE secure_session_secret (
          secret_id TEXT PRIMARY KEY CHECK (length(secret_id) BETWEEN 1 AND 256),
          provider_id TEXT NOT NULL REFERENCES secure_session_provider(provider_id) ON DELETE CASCADE,
          display_alias TEXT NOT NULL CHECK (length(display_alias) BETWEEN 1 AND 256),
          display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 256),
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('instance', 'profile')),
          profile_id TEXT CHECK (
            (scope_kind = 'instance' AND profile_id IS NULL)
            OR (scope_kind = 'profile' AND length(profile_id) BETWEEN 1 AND 256)
          ),
          retention TEXT NOT NULL CHECK (retention IN ('saved', 'session')),
          source_locator TEXT NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 4096),
          encrypted_material BLOB CHECK (
            encrypted_material IS NULL
            OR (typeof(encrypted_material) = 'blob' AND length(encrypted_material) BETWEEN 1 AND 1048576)
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX secure_session_secret_provider_idx
          ON secure_session_secret(provider_id, display_alias, secret_id);
        CREATE UNIQUE INDEX secure_session_secret_instance_alias_idx
          ON secure_session_secret(display_alias)
          WHERE scope_kind = 'instance';
        CREATE UNIQUE INDEX secure_session_secret_profile_alias_idx
          ON secure_session_secret(profile_id, display_alias)
          WHERE scope_kind = 'profile';

        CREATE TABLE secure_session_binding (
          binding_id TEXT PRIMARY KEY CHECK (length(binding_id) BETWEEN 1 AND 256),
          secret_id TEXT NOT NULL REFERENCES secure_session_secret(secret_id) ON DELETE CASCADE,
          delivery_kind TEXT NOT NULL CHECK (
            delivery_kind IN ('environment', 'stdin', 'file', 'askpass', 'ssh_agent')
          ),
          target_name TEXT CHECK (target_name IS NULL OR length(target_name) BETWEEN 1 AND 4096),
          target_path TEXT CHECK (target_path IS NULL OR length(target_path) BETWEEN 1 AND 4096),
          file_mode INTEGER CHECK (file_mode IS NULL OR file_mode BETWEEN 0 AND 511),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (delivery_kind = 'environment' AND target_name IS NOT NULL AND target_path IS NULL AND file_mode IS NULL)
            OR (delivery_kind = 'askpass' AND target_name IS NOT NULL AND target_path IS NULL AND file_mode IS NULL)
            OR (delivery_kind = 'file' AND target_name IS NULL AND target_path IS NOT NULL)
            OR (delivery_kind IN ('stdin', 'ssh_agent') AND target_name IS NULL AND target_path IS NULL AND file_mode IS NULL)
          )
        ) STRICT;

        CREATE INDEX secure_session_binding_secret_idx
          ON secure_session_binding(secret_id, binding_id);

        CREATE TABLE secure_session_state (
          session_agent_id TEXT PRIMARY KEY CHECK (length(session_agent_id) BETWEEN 1 AND 256),
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          forked_from_session_agent_id TEXT CHECK (
            forked_from_session_agent_id IS NULL OR length(forked_from_session_agent_id) BETWEEN 1 AND 256
          ),
          profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 256),
          execution_mode TEXT NOT NULL CHECK (execution_mode IN ('standard', 'secure')),
          environment_status TEXT NOT NULL CHECK (
            environment_status IN ('stopped', 'starting', 'ready', 'degraded', 'failed')
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE secure_session_revision (
          session_agent_id TEXT NOT NULL
            REFERENCES secure_session_state(session_agent_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          event_type TEXT NOT NULL CHECK (event_type IN (
            'initialized', 'fork_initialized', 'request_created', 'request_resolved',
            'lease_created', 'lease_revoked', 'leases_expired', 'lease_used',
            'lease_consumed', 'session_revoked', 'session_runtime_updated'
          )),
          lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 256),
          affected_count INTEGER NOT NULL DEFAULT 1 CHECK (affected_count >= 0),
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (session_agent_id, revision)
        ) STRICT;

        CREATE TABLE secure_session_request (
          request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 256),
          session_agent_id TEXT NOT NULL REFERENCES secure_session_state(session_agent_id) ON DELETE CASCADE,
          secret_id TEXT REFERENCES secure_session_secret(secret_id) ON DELETE SET NULL,
          display_alias TEXT NOT NULL CHECK (length(display_alias) BETWEEN 1 AND 256),
          requested_lease_kind TEXT NOT NULL CHECK (requested_lease_kind IN ('task', 'timed', 'one_use')),
          requested_duration_seconds INTEGER CHECK (
            (requested_lease_kind = 'timed' AND requested_duration_seconds BETWEEN 1 AND 86400)
            OR (requested_lease_kind != 'timed' AND requested_duration_seconds IS NULL)
          ),
          purpose_summary TEXT NOT NULL CHECK (length(purpose_summary) BETWEEN 1 AND 2000),
          requested_by_agent_id TEXT NOT NULL CHECK (length(requested_by_agent_id) BETWEEN 1 AND 256),
          requested_by_display_name TEXT NOT NULL CHECK (length(requested_by_display_name) BETWEEN 1 AND 256),
          state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'cancelled')),
          requested_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT
        ) STRICT;

        CREATE INDEX secure_session_request_session_idx
          ON secure_session_request(session_agent_id, requested_at, request_id);

        CREATE TABLE secure_session_request_exposure (
          request_id TEXT NOT NULL REFERENCES secure_session_request(request_id) ON DELETE CASCADE,
          exposure_index INTEGER NOT NULL CHECK (exposure_index BETWEEN 0 AND 15),
          delivery_kind TEXT NOT NULL CHECK (
            delivery_kind IN ('environment', 'stdin', 'file', 'askpass', 'ssh_agent')
          ),
          target_name TEXT CHECK (target_name IS NULL OR length(target_name) BETWEEN 1 AND 4096),
          target_path TEXT CHECK (target_path IS NULL OR length(target_path) BETWEEN 1 AND 4096),
          file_mode INTEGER CHECK (file_mode IS NULL OR file_mode BETWEEN 0 AND 511),
          PRIMARY KEY (request_id, exposure_index),
          CHECK (
            (delivery_kind = 'environment' AND target_name IS NOT NULL AND target_path IS NULL AND file_mode IS NULL)
            OR (delivery_kind = 'askpass' AND target_name IS NOT NULL AND target_path IS NULL AND file_mode IS NULL)
            OR (delivery_kind = 'file' AND target_name IS NULL AND target_path IS NOT NULL)
            OR (delivery_kind IN ('stdin', 'ssh_agent') AND target_name IS NULL AND target_path IS NULL AND file_mode IS NULL)
          )
        ) STRICT;

        CREATE TABLE secure_session_lease (
          lease_id TEXT PRIMARY KEY CHECK (length(lease_id) BETWEEN 1 AND 256),
          session_agent_id TEXT NOT NULL REFERENCES secure_session_state(session_agent_id) ON DELETE CASCADE,
          secret_id TEXT NOT NULL REFERENCES secure_session_secret(secret_id) ON DELETE CASCADE,
          request_id TEXT REFERENCES secure_session_request(request_id) ON DELETE SET NULL,
          lease_kind TEXT NOT NULL CHECK (lease_kind IN ('task', 'timed', 'one_use')),
          state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
          issued_revision INTEGER NOT NULL CHECK (issued_revision > 0),
          updated_revision INTEGER NOT NULL CHECK (updated_revision >= issued_revision),
          expires_at TEXT,
          last_used_at TEXT,
          remaining_uses INTEGER CHECK (
            (lease_kind = 'one_use' AND remaining_uses IN (0, 1))
            OR (lease_kind != 'one_use' AND remaining_uses IS NULL)
          ),
          revoked_at TEXT,
          revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN (
            'user', 'session_archived', 'session_stopped', 'session_deleted',
            'binding_deleted', 'secret_deleted', 'provider_deleted', 'policy_changed'
          )),
          one_use_operation_id TEXT UNIQUE CHECK (
            one_use_operation_id IS NULL OR length(one_use_operation_id) BETWEEN 1 AND 256
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((lease_kind = 'timed' AND expires_at IS NOT NULL) OR lease_kind != 'timed')
        ) STRICT;

        CREATE INDEX secure_session_lease_session_idx
          ON secure_session_lease(session_agent_id, state, lease_id);
        CREATE INDEX secure_session_lease_expiry_idx
          ON secure_session_lease(state, expires_at);

        CREATE TABLE secure_session_lease_binding (
          lease_id TEXT NOT NULL REFERENCES secure_session_lease(lease_id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL REFERENCES secure_session_binding(binding_id) ON DELETE CASCADE,
          PRIMARY KEY (lease_id, binding_id)
        ) STRICT;

        CREATE TABLE secure_session_use_reservation (
          operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
          lease_id TEXT NOT NULL REFERENCES secure_session_lease(lease_id) ON DELETE CASCADE,
          session_agent_id TEXT NOT NULL REFERENCES secure_session_state(session_agent_id) ON DELETE CASCADE,
          reserved_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
          CHECK (
            (completed_at IS NULL AND outcome IS NULL)
            OR (completed_at IS NOT NULL AND outcome IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX secure_session_reservation_lease_idx
          ON secure_session_use_reservation(lease_id, reserved_at, operation_id);

        CREATE TABLE secure_session_exposure (
          exposure_id TEXT PRIMARY KEY CHECK (length(exposure_id) BETWEEN 1 AND 256),
          operation_id TEXT NOT NULL REFERENCES secure_session_use_reservation(operation_id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL REFERENCES secure_session_binding(binding_id) ON DELETE CASCADE,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'cancelled')),
          CHECK (
            (closed_at IS NULL AND outcome IS NULL)
            OR (closed_at IS NOT NULL AND outcome IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX secure_session_exposure_operation_idx
          ON secure_session_exposure(operation_id, opened_at, exposure_id);

        CREATE TABLE secure_session_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'provider_upserted', 'provider_backend_updated', 'provider_deleted', 'secret_created', 'secret_updated',
            'secret_deleted', 'binding_put', 'binding_deleted', 'session_initialized',
            'fork_initialized', 'request_created', 'request_resolved', 'lease_created',
            'lease_revoked', 'leases_expired', 'lease_used', 'lease_consumed',
            'session_revoked', 'session_deleted', 'session_runtime_updated',
            'exposure_opened', 'exposure_closed'
          )),
          session_agent_id TEXT CHECK (
            session_agent_id IS NULL OR length(session_agent_id) BETWEEN 1 AND 256
          ),
          provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 256),
          secret_id TEXT CHECK (secret_id IS NULL OR length(secret_id) BETWEEN 1 AND 256),
          binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 256),
          request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 256),
          lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 256),
          operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 256),
          outcome TEXT NOT NULL CHECK (outcome IN (
            'created', 'updated', 'deleted', 'approved', 'denied', 'cancelled',
            'revoked', 'expired', 'reserved', 'succeeded', 'failed', 'completed'
          )),
          occurred_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX secure_session_audit_session_idx
          ON secure_session_audit(session_agent_id, audit_id);
      `);

      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO secure_session_catalog_state (id, revision, updated_at)
        VALUES (1, 0, ?)
      `).run(now);
    }
  },
  {
    version: 2,
    name: "project_secret_defaults_and_lease_grant_source",
    up(database) {
      database.exec(`
        CREATE TABLE secure_session_project_default (
          profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 256),
          secret_id TEXT NOT NULL
            REFERENCES secure_session_secret(secret_id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, secret_id)
        ) STRICT;

        CREATE INDEX secure_session_project_default_secret_idx
          ON secure_session_project_default(secret_id, profile_id);

        ALTER TABLE secure_session_lease
          ADD COLUMN grant_source TEXT NOT NULL DEFAULT 'manual'
          CHECK (grant_source IN ('manual', 'access_request', 'project_default'));

        UPDATE secure_session_lease
        SET grant_source = 'access_request'
        WHERE request_id IS NOT NULL;

        CREATE TABLE secure_session_audit_v2 (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'provider_upserted', 'provider_backend_updated', 'provider_deleted',
            'secret_created', 'secret_updated', 'secret_deleted', 'binding_put',
            'binding_deleted', 'project_default_put', 'project_default_deleted',
            'session_initialized', 'fork_initialized', 'request_created',
            'request_resolved', 'lease_created', 'lease_revoked', 'leases_expired',
            'lease_used', 'lease_consumed', 'session_revoked', 'session_deleted',
            'session_runtime_updated', 'exposure_opened', 'exposure_closed'
          )),
          session_agent_id TEXT CHECK (
            session_agent_id IS NULL OR length(session_agent_id) BETWEEN 1 AND 256
          ),
          profile_id TEXT CHECK (
            profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 256
          ),
          provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 256),
          secret_id TEXT CHECK (secret_id IS NULL OR length(secret_id) BETWEEN 1 AND 256),
          binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 256),
          request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 256),
          lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 256),
          operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 256),
          outcome TEXT NOT NULL CHECK (outcome IN (
            'created', 'updated', 'deleted', 'approved', 'denied', 'cancelled',
            'revoked', 'expired', 'reserved', 'succeeded', 'failed', 'completed'
          )),
          occurred_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO secure_session_audit_v2 (
          audit_id, event_type, session_agent_id, profile_id, provider_id,
          secret_id, binding_id, request_id, lease_id, operation_id, outcome,
          occurred_at
        )
        SELECT audit_id, event_type, session_agent_id, NULL, provider_id,
          secret_id, binding_id, request_id, lease_id, operation_id, outcome,
          occurred_at
        FROM secure_session_audit
        ORDER BY audit_id;

        DROP TABLE secure_session_audit;
        ALTER TABLE secure_session_audit_v2 RENAME TO secure_session_audit;
        CREATE INDEX secure_session_audit_session_idx
          ON secure_session_audit(session_agent_id, audit_id);
      `);
    }
  }
];

export function runSecureSessionMigrations(database: Database.Database): void {
  validateMigrationDefinitions();
  database.exec(`
    CREATE TABLE IF NOT EXISTS secure_session_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const appliedRows = database.prepare(
    "SELECT version, name FROM secure_session_schema_migrations ORDER BY version"
  ).all() as Array<{ version: number; name: string }>;
  const known = new Map(SECURE_SESSION_MIGRATIONS.map(({ version, name }) => [version, name]));
  for (const row of appliedRows) {
    if (known.get(row.version) !== row.name) {
      throw new Error("Secure session schema migration ledger mismatch");
    }
  }

  const appliedVersions = new Set(appliedRows.map(({ version }) => version));
  for (const migration of SECURE_SESSION_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    database.transaction(() => {
      migration.up(database);
      database.prepare(`
        INSERT INTO secure_session_schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, new Date().toISOString());
    })();
  }

  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") {
    throw new Error(`Secure session database quick_check failed: ${String(quickCheck)}`);
  }
  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`Secure session database foreign_key_check failed for ${foreignKeyFailures.length} row(s)`);
  }
}

function validateMigrationDefinitions(): void {
  for (const [index, migration] of SECURE_SESSION_MIGRATIONS.entries()) {
    if (migration.version !== index + 1) {
      throw new Error("Secure session migrations must be a contiguous, ordered ledger");
    }
  }
}
