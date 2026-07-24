import type Database from "better-sqlite3";
import {
  closeSecureSessionDb,
  getOrCreateSecureSessionDb,
  type SecureSessionDatabaseOptions
} from "./secure-session-db.js";
import {
  SECURE_SESSION_DELIVERY_KINDS,
  SECURE_SESSION_EXPOSURE_OUTCOMES,
  SECURE_SESSION_LEASE_GRANT_SOURCES,
  SECURE_SESSION_LEASE_KINDS,
  SECURE_SESSION_PROVIDER_KINDS,
  SECURE_SESSION_REQUEST_STATES,
  SECURE_SESSION_RESERVATION_OUTCOMES,
  SECURE_SESSION_RETENTIONS,
  SECURE_SESSION_REVOCATION_REASONS,
  SECURE_SESSION_SCOPE_KINDS,
  SECURE_SESSION_SOURCE_STATUSES,
  SECURE_SESSION_SOURCE_STATUS_CODES,
  type BeginSecureSessionExposureInput,
  type CloseSecureSessionExposureInput,
  type CompleteSecureSessionLeaseUseInput,
  type CreateSecureSessionLeaseGrantInput,
  type CreateSecureSessionLeaseInput,
  type CreateSecureSessionLeasesInput,
  type CreateSecureSessionRequestInput,
  type CreateSecureSessionSecretInput,
  type DeleteSecureSessionProjectStateResult,
  type InitializeSecureSessionStateInput,
  type PutSecureSessionProjectDefaultInput,
  type PutSecureSessionSecretWithBindingsInput,
  type PutSecureSessionBindingInput,
  type ReserveSecureSessionLeaseUseInput,
  type ReserveSecureSessionLeaseUseResult,
  type ResolveSecureSessionRequestInput,
  type RevokeSecureSessionLeaseInput,
  type SecureSessionAuditRecord,
  type SecureSessionBinding,
  type SecureSessionCatalogState,
  type SecureSessionEncryptedSecret,
  type SecureSessionExposure,
  type SecureSessionLease,
  type SecureSessionMutationResult,
  type SecureSessionProvider,
  type SecureSessionProviderBackendConfig,
  type SecureSessionProjectDefault,
  type SecureSessionRequest,
  type SecureSessionRequestedExposure,
  type SecureSessionRevocationReason,
  type SecureSessionSecret,
  type SecureSessionSecretWithBindings,
  type SecureSessionSnapshot,
  type SecureSessionState,
  type SecureSessionUseReservation,
  type UpdateSecureSessionSecretInput,
  type UpdateSecureSessionRuntimeStateInput,
  type UpsertSecureSessionProviderBackendConfigInput,
  type UpsertSecureSessionProviderInput
} from "./types.js";

const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_LENGTH = 256;
const MAX_SOURCE_LOCATOR_LENGTH = 4096;
const MAX_TARGET_LENGTH = 4096;
const MAX_PURPOSE_LENGTH = 2000;
const MAX_BINDINGS = 16;
const MAX_ENCRYPTED_MATERIAL_BYTES = 1024 * 1024;

export class SecureSessionRevisionConflictError extends Error {
  readonly code = "secure_session_revision_conflict";

  constructor(readonly currentRevision: number) {
    super(`Secure session revision conflict; current revision is ${currentRevision}`);
    this.name = "SecureSessionRevisionConflictError";
  }
}

export class SecureSessionIdConflictError extends Error {
  readonly code = "secure_session_id_conflict";

  constructor(kind: string) {
    super(`Secure session ${kind} ID conflicts with an existing record`);
    this.name = "SecureSessionIdConflictError";
  }
}

export class SecureSessionNotFoundError extends Error {
  readonly code = "secure_session_not_found";

  constructor(kind: string) {
    super(`Secure session ${kind} was not found`);
    this.name = "SecureSessionNotFoundError";
  }
}

export class SecureSessionAliasConflictError extends Error {
  readonly code = "secure_secret_alias_conflict";

  constructor() {
    super("A secret with this alias already exists in the selected scope");
    this.name = "SecureSessionAliasConflictError";
  }
}

export class SecureSessionRequestExpiredError extends Error {
  readonly code = "secure_session_request_expired";

  constructor() {
    super("Secure session access request has expired");
    this.name = "SecureSessionRequestExpiredError";
  }
}

export class SecureSessionStore {
  static async open(
    options: SecureSessionDatabaseOptions,
    now: () => Date = () => new Date()
  ): Promise<SecureSessionStore> {
    return new SecureSessionStore(
      await getOrCreateSecureSessionDb(options),
      options.dbPath,
      now
    );
  }

  constructor(
    private readonly database: Database.Database,
    private readonly dbPath?: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async close(): Promise<void> {
    if (this.dbPath) {
      await closeSecureSessionDb(this.dbPath);
    } else if (this.database.open) {
      this.database.close();
    }
  }

  /**
   * Composes synchronous store mutations into one SQLite transaction. Provider
   * I/O and decryption must complete before entering this boundary.
   */
  withTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  listProviders(): SecureSessionProvider[] {
    return (this.database.prepare(`
      SELECT provider_id, kind, display_name, enabled, status, last_verified_at,
        last_status_code, created_at, updated_at
      FROM secure_session_provider
      ORDER BY display_name COLLATE NOCASE, provider_id
    `).all() as ProviderRow[]).map(mapProvider);
  }

  getProvider(providerId: string): SecureSessionProvider | null {
    assertId(providerId, "provider ID");
    const row = this.database.prepare(`
      SELECT provider_id, kind, display_name, enabled, status, last_verified_at,
        last_status_code, created_at, updated_at
      FROM secure_session_provider WHERE provider_id = ?
    `).get(providerId) as ProviderRow | undefined;
    return row ? mapProvider(row) : null;
  }

  getCatalogState(): SecureSessionCatalogState {
    const row = this.database.prepare(`
      SELECT revision, updated_at FROM secure_session_catalog_state WHERE id = 1
    `).get() as { revision: number; updated_at: string } | undefined;
    if (!row) throw new SecureSessionNotFoundError("catalog state");
    return { revision: row.revision, updatedAt: row.updated_at };
  }

  getProviderBackendConfig(providerId: string): SecureSessionProviderBackendConfig | null {
    assertId(providerId, "provider ID");
    const row = this.database.prepare(`
      SELECT provider_id, server_origin, organization_id, project_id, encrypted_access_token
      FROM secure_session_provider
      WHERE provider_id = ? AND kind = 'bitwarden_secrets_manager'
        AND server_origin IS NOT NULL AND encrypted_access_token IS NOT NULL
    `).get(providerId) as ProviderBackendRow | undefined;
    return row ? mapProviderBackend(row) : null;
  }

  upsertProviderBackendConfig(
    input: UpsertSecureSessionProviderBackendConfigInput
  ): SecureSessionProviderBackendConfig {
    assertId(input.providerId, "provider ID");
    const serverOrigin = normalizeServerOrigin(input.serverOrigin);
    const organizationId = normalizeOptionalId(input.organizationId, "organization ID");
    const projectId = normalizeOptionalId(input.projectId, "project ID");
    const encryptedAccessToken = normalizeEncryptedBuffer(
      input.encryptedAccessToken,
      "encrypted access token"
    );
    return this.database.transaction(() => {
      const provider = this.requireProvider(input.providerId);
      if (provider.kind !== "bitwarden_secrets_manager") {
        throw new Error("Only Bitwarden providers accept backend configuration");
      }
      const now = this.timestamp();
      this.revokeCatalogLeases("provider", input.providerId, "policy_changed", now);
      this.database.prepare(`
        UPDATE secure_session_provider
        SET server_origin = ?, organization_id = ?, project_id = ?,
          encrypted_access_token = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(
        serverOrigin,
        organizationId,
        projectId,
        encryptedAccessToken,
        now,
        input.providerId
      );
      this.bumpCatalog(now);
      this.audit({
        eventType: "provider_backend_updated",
        providerId: input.providerId,
        outcome: "updated",
        occurredAt: now
      });
      const record = this.getProviderBackendConfig(input.providerId);
      if (!record) throw new SecureSessionNotFoundError("provider backend configuration");
      return record;
    })();
  }

  upsertProvider(input: UpsertSecureSessionProviderInput): SecureSessionProvider {
    assertId(input.providerId, "provider ID");
    assertEnum(input.kind, SECURE_SESSION_PROVIDER_KINDS, "provider kind");
    assertBoundedText(input.displayName, "provider display name", MAX_DISPLAY_LENGTH);
    const enabled = input.enabled !== false;
    const status = enabled
      ? (input.status ?? (input.kind === "bitwarden_secrets_manager" ? "auth_required" : "available"))
      : "disabled";
    const statusCode = enabled
      ? (input.lastStatusCode ?? defaultStatusCode(status))
      : "provider_disabled";
    assertEnum(status, SECURE_SESSION_SOURCE_STATUSES, "provider status");
    if (statusCode !== null) {
      assertEnum(statusCode, SECURE_SESSION_SOURCE_STATUS_CODES, "provider status code");
    }
    const lastVerifiedAt = normalizeOptionalTimestamp(input.lastVerifiedAt, "provider verification time");
    const now = this.timestamp();
    return this.database.transaction(() => {
      const existed = this.getProvider(input.providerId) !== null;
      if (existed) {
        this.revokeCatalogLeases("provider", input.providerId, "policy_changed", now);
      }
      this.database.prepare(`
        INSERT INTO secure_session_provider (
          provider_id, kind, display_name, enabled, status, last_verified_at,
          last_status_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          kind = excluded.kind,
          display_name = excluded.display_name,
          enabled = excluded.enabled,
          status = excluded.status,
          last_verified_at = excluded.last_verified_at,
          last_status_code = excluded.last_status_code,
          server_origin = CASE
            WHEN excluded.kind = 'bitwarden_secrets_manager' THEN secure_session_provider.server_origin
            ELSE NULL
          END,
          organization_id = CASE
            WHEN excluded.kind = 'bitwarden_secrets_manager' THEN secure_session_provider.organization_id
            ELSE NULL
          END,
          project_id = CASE
            WHEN excluded.kind = 'bitwarden_secrets_manager' THEN secure_session_provider.project_id
            ELSE NULL
          END,
          encrypted_access_token = CASE
            WHEN excluded.kind = 'bitwarden_secrets_manager' THEN secure_session_provider.encrypted_access_token
            ELSE NULL
          END,
          updated_at = excluded.updated_at
      `).run(
        input.providerId,
        input.kind,
        input.displayName,
        enabled ? 1 : 0,
        status,
        lastVerifiedAt,
        statusCode,
        now,
        now
      );
      this.audit({
        eventType: "provider_upserted",
        providerId: input.providerId,
        outcome: existed ? "updated" : "created",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireProvider(input.providerId);
    })();
  }

  updateProviderStatus(input: {
    providerId: string;
    status: SecureSessionProvider["status"];
    lastStatusCode: SecureSessionProvider["lastStatusCode"];
    lastVerifiedAt: string;
  }): SecureSessionProvider | null {
    assertId(input.providerId, "provider ID");
    assertEnum(input.status, SECURE_SESSION_SOURCE_STATUSES, "provider status");
    if (input.lastStatusCode !== null) {
      assertEnum(
        input.lastStatusCode,
        SECURE_SESSION_SOURCE_STATUS_CODES,
        "provider status code"
      );
    }
    const lastVerifiedAt = normalizeOptionalTimestamp(
      input.lastVerifiedAt,
      "provider verification time"
    );
    const now = this.timestamp();
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE secure_session_provider
        SET status = ?, last_verified_at = ?, last_status_code = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(
        input.status,
        lastVerifiedAt,
        input.lastStatusCode,
        now,
        input.providerId
      );
      if (result.changes === 0) return null;
      this.audit({
        eventType: "provider_backend_updated",
        providerId: input.providerId,
        outcome: "updated",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireProvider(input.providerId);
    })();
  }

  deleteProvider(providerId: string): boolean {
    assertId(providerId, "provider ID");
    return this.database.transaction(() => {
      if (!this.getProvider(providerId)) return false;
      const now = this.timestamp();
      const removedProjectDefaults = this.database.prepare(`
        SELECT pd.profile_id, pd.secret_id, pd.created_at, pd.updated_at
        FROM secure_session_project_default pd
        JOIN secure_session_secret s ON s.secret_id = pd.secret_id
        WHERE s.provider_id = ?
        ORDER BY pd.profile_id, pd.secret_id
      `).all(providerId) as ProjectDefaultRow[];
      this.revokeCatalogLeases("provider", providerId, "provider_deleted", now);
      this.database.prepare("DELETE FROM secure_session_provider WHERE provider_id = ?").run(providerId);
      for (const projectDefault of removedProjectDefaults) {
        this.audit({
          eventType: "project_default_deleted",
          profileId: projectDefault.profile_id,
          secretId: projectDefault.secret_id,
          outcome: "deleted",
          occurredAt: now
        });
      }
      this.audit({
        eventType: "provider_deleted",
        providerId,
        outcome: "deleted",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return true;
    })();
  }

  listSecrets(providerId?: string): SecureSessionSecret[] {
    if (providerId !== undefined) assertId(providerId, "provider ID");
    const rows = providerId === undefined
      ? this.database.prepare(`${SECRET_SELECT} ORDER BY display_alias COLLATE NOCASE, secret_id`).all()
      : this.database.prepare(`${SECRET_SELECT} WHERE provider_id = ?
          ORDER BY display_alias COLLATE NOCASE, secret_id`).all(providerId);
    return (rows as SecretRow[]).map((row) => this.hydrateSecret(row));
  }

  getSecret(secretId: string): SecureSessionSecret | null {
    assertId(secretId, "secret ID");
    const row = this.database.prepare(`${SECRET_SELECT} WHERE secret_id = ?`).get(secretId) as
      | SecretRow
      | undefined;
    return row ? this.hydrateSecret(row) : null;
  }

  getEncryptedSecret(secretId: string): SecureSessionEncryptedSecret | null {
    assertId(secretId, "secret ID");
    const row = this.database.prepare(`
      SELECT secret_id, provider_id, display_alias, display_name, scope_kind, profile_id,
        retention, source_locator, encrypted_material, created_at, updated_at
      FROM secure_session_secret WHERE secret_id = ?
    `).get(secretId) as EncryptedSecretRow | undefined;
    return row
      ? {
          ...this.hydrateSecret(row),
          encryptedMaterial: row.encrypted_material === null
            ? null
            : Buffer.from(row.encrypted_material)
        }
      : null;
  }

  createSecret(input: CreateSecureSessionSecretInput): SecureSessionSecret {
    const normalized = this.normalizeSecretInput(input);
    const now = this.timestamp();
    return this.database.transaction(() => {
      if (this.getSecret(input.secretId)) throw new SecureSessionIdConflictError("secret");
      this.assertSecretAliasAvailable(
        input.displayAlias,
        input.scopeKind,
        normalized.profileId,
        input.secretId
      );
      const provider = this.requireProvider(input.providerId);
      if (provider.kind === "local_keychain" && normalized.encryptedMaterial === null) {
        throw new Error("Local keychain secrets require encrypted material");
      }
      this.database.prepare(`
        INSERT INTO secure_session_secret (
          secret_id, provider_id, display_alias, display_name, scope_kind, profile_id,
          retention, source_locator, encrypted_material, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.secretId,
        input.providerId,
        input.displayAlias,
        normalized.displayName,
        input.scopeKind,
        normalized.profileId,
        input.retention,
        input.sourceLocator,
        normalized.encryptedMaterial,
        now,
        now
      );
      this.audit({
        eventType: "secret_created",
        providerId: input.providerId,
        secretId: input.secretId,
        outcome: "created",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireSecret(input.secretId);
    })();
  }

  updateSecret(input: UpdateSecureSessionSecretInput): SecureSessionSecret {
    const normalized = this.normalizeSecretInput(input);
    const now = this.timestamp();
    return this.database.transaction(() => {
      if (!this.getSecret(input.secretId)) throw new SecureSessionNotFoundError("secret");
      this.assertSecretAliasAvailable(
        input.displayAlias,
        input.scopeKind,
        normalized.profileId,
        input.secretId
      );
      this.revokeCatalogLeases("secret", input.secretId, "policy_changed", now);
      const existingProjectDefaults = this.listProjectDefaultsForSecret(input.secretId);
      const removedProjectDefaults = input.retention === "session"
        ? existingProjectDefaults
        : input.scopeKind === "profile"
          ? existingProjectDefaults.filter(({ profileId }) =>
              profileId !== normalized.profileId
            )
          : [];
      const provider = this.requireProvider(input.providerId);
      if (provider.kind === "local_keychain" && normalized.encryptedMaterial === null) {
        throw new Error("Local keychain secrets require encrypted material");
      }
      this.database.prepare(`
        UPDATE secure_session_secret
        SET provider_id = ?, display_alias = ?, display_name = ?, scope_kind = ?,
          profile_id = ?, retention = ?, source_locator = ?, encrypted_material = ?, updated_at = ?
        WHERE secret_id = ?
      `).run(
        input.providerId,
        input.displayAlias,
        normalized.displayName,
        input.scopeKind,
        normalized.profileId,
        input.retention,
        input.sourceLocator,
        normalized.encryptedMaterial,
        now,
        input.secretId
      );
      for (const projectDefault of removedProjectDefaults) {
        this.database.prepare(`
          DELETE FROM secure_session_project_default
          WHERE profile_id = ? AND secret_id = ?
        `).run(projectDefault.profileId, input.secretId);
        this.audit({
          eventType: "project_default_deleted",
          profileId: projectDefault.profileId,
          secretId: input.secretId,
          outcome: "deleted",
          occurredAt: now
        });
      }
      this.audit({
        eventType: "secret_updated",
        providerId: input.providerId,
        secretId: input.secretId,
        outcome: "updated",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireSecret(input.secretId);
    })();
  }

  deleteSecret(secretId: string): boolean {
    assertId(secretId, "secret ID");
    return this.database.transaction(() => {
      const secret = this.getSecret(secretId);
      if (!secret) return false;
      const now = this.timestamp();
      const removedProjectDefaults = this.listProjectDefaultsForSecret(secretId);
      this.revokeCatalogLeases("secret", secretId, "secret_deleted", now);
      this.database.prepare("DELETE FROM secure_session_secret WHERE secret_id = ?").run(secretId);
      for (const projectDefault of removedProjectDefaults) {
        this.audit({
          eventType: "project_default_deleted",
          profileId: projectDefault.profileId,
          secretId,
          outcome: "deleted",
          occurredAt: now
        });
      }
      this.audit({
        eventType: "secret_deleted",
        providerId: secret.providerId,
        secretId,
        outcome: "deleted",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return true;
    })();
  }

  listProjectDefaults(profileId?: string): SecureSessionProjectDefault[] {
    if (profileId !== undefined) assertId(profileId, "profile ID");
    const rows = profileId === undefined
      ? this.database.prepare(`
          SELECT profile_id, secret_id, created_at, updated_at
          FROM secure_session_project_default
          ORDER BY profile_id, secret_id
        `).all()
      : this.database.prepare(`
          SELECT profile_id, secret_id, created_at, updated_at
          FROM secure_session_project_default
          WHERE profile_id = ?
          ORDER BY secret_id
        `).all(profileId);
    return (rows as ProjectDefaultRow[]).map(mapProjectDefault);
  }

  putProjectDefault(
    input: PutSecureSessionProjectDefaultInput
  ): SecureSessionProjectDefault {
    assertId(input.profileId, "profile ID");
    assertId(input.secretId, "secret ID");
    return this.database.transaction(() => {
      const secret = this.requireSecret(input.secretId);
      if (secret.retention !== "saved") {
        throw new Error("Session-only secrets cannot be project defaults");
      }
      if (secret.scopeKind === "profile" && secret.profileId !== input.profileId) {
        throw new Error("Project defaults cannot reference another project's secret");
      }
      const existing = this.getProjectDefault(input.profileId, input.secretId);
      if (existing) return existing;
      const now = this.timestamp();
      this.database.prepare(`
        INSERT INTO secure_session_project_default (
          profile_id, secret_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run(input.profileId, input.secretId, now, now);
      this.audit({
        eventType: "project_default_put",
        profileId: input.profileId,
        secretId: input.secretId,
        outcome: "created",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireProjectDefault(input.profileId, input.secretId);
    })();
  }

  deleteProjectDefault(profileId: string, secretId: string): boolean {
    assertId(profileId, "profile ID");
    assertId(secretId, "secret ID");
    return this.database.transaction(() => {
      if (!this.getProjectDefault(profileId, secretId)) return false;
      const now = this.timestamp();
      this.revokeProjectDefaultLeases(profileId, [secretId], now);
      this.database.prepare(`
        DELETE FROM secure_session_project_default
        WHERE profile_id = ? AND secret_id = ?
      `).run(profileId, secretId);
      this.audit({
        eventType: "project_default_deleted",
        profileId,
        secretId,
        outcome: "deleted",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return true;
    })();
  }

  listActiveProjectDefaultLeases(
    profileId: string,
    secretId?: string
  ): SecureSessionLease[] {
    assertId(profileId, "profile ID");
    if (secretId !== undefined) assertId(secretId, "secret ID");
    const rows = secretId === undefined
      ? this.database.prepare(`
          SELECT l.lease_id
          FROM secure_session_lease l
          JOIN secure_session_state ss ON ss.session_agent_id = l.session_agent_id
          WHERE ss.profile_id = ?
            AND l.grant_source = 'project_default'
            AND l.state = 'active'
          ORDER BY l.session_agent_id, l.lease_id
        `).all(profileId)
      : this.database.prepare(`
          SELECT l.lease_id
          FROM secure_session_lease l
          JOIN secure_session_state ss ON ss.session_agent_id = l.session_agent_id
          WHERE ss.profile_id = ?
            AND l.secret_id = ?
            AND l.grant_source = 'project_default'
            AND l.state = 'active'
          ORDER BY l.session_agent_id, l.lease_id
        `).all(profileId, secretId);
    return (rows as Array<{ lease_id: string }>).map(({ lease_id }) =>
      this.requireLease(lease_id)
    );
  }

  /**
   * Removes every secret policy owned by a deleted project. Instance-scoped
   * secrets survive; only their association with this project is removed.
   */
  deleteProjectSecretState(
    profileId: string
  ): DeleteSecureSessionProjectStateResult {
    assertId(profileId, "profile ID");
    return this.database.transaction(() => {
      const defaultSecretIds = this.listProjectDefaults(profileId)
        .map(({ secretId }) => secretId);
      const scopedSecrets = this.database.prepare(`
        SELECT secret_id, provider_id
        FROM secure_session_secret
        WHERE scope_kind = 'profile' AND profile_id = ?
        ORDER BY secret_id
      `).all(profileId) as Array<{ secret_id: string; provider_id: string }>;
      const result = {
        projectDefaultsDeleted: defaultSecretIds.length,
        secretsDeleted: scopedSecrets.length
      };
      if (result.projectDefaultsDeleted === 0 && result.secretsDeleted === 0) {
        return result;
      }
      const now = this.timestamp();
      this.revokeProjectDefaultLeases(profileId, defaultSecretIds, now);
      this.database.prepare(`
        DELETE FROM secure_session_project_default WHERE profile_id = ?
      `).run(profileId);
      for (const secretId of defaultSecretIds) {
        this.audit({
          eventType: "project_default_deleted",
          profileId,
          secretId,
          outcome: "deleted",
          occurredAt: now
        });
      }
      for (const secret of scopedSecrets) {
        this.revokeCatalogLeases("secret", secret.secret_id, "secret_deleted", now);
        this.database.prepare(`
          DELETE FROM secure_session_secret WHERE secret_id = ?
        `).run(secret.secret_id);
        this.audit({
          eventType: "secret_deleted",
          providerId: secret.provider_id,
          secretId: secret.secret_id,
          outcome: "deleted",
          occurredAt: now
        });
      }
      this.bumpCatalog(now);
      return result;
    })();
  }

  createSecretWithBindings(
    input: PutSecureSessionSecretWithBindingsInput
  ): SecureSessionSecretWithBindings {
    return this.database.transaction(() => {
      const secret = this.createSecret(input.secret);
      const bindings = input.bindings.map((binding) => this.putBinding({
        ...binding,
        secretId: secret.secretId
      }));
      return {
        secret: this.requireSecret(secret.secretId),
        bindings,
        catalog: this.getCatalogState()
      };
    })();
  }

  updateSecretWithBindings(
    input: PutSecureSessionSecretWithBindingsInput
  ): SecureSessionSecretWithBindings {
    return this.database.transaction(() => {
      const secret = this.updateSecret(input.secret);
      const desiredIds = new Set(input.bindings.map(({ bindingId }) => bindingId));
      for (const existing of this.listBindings(secret.secretId)) {
        if (!desiredIds.has(existing.bindingId)) this.deleteBinding(existing.bindingId);
      }
      const bindings = input.bindings.map((binding) => this.putBinding({
        ...binding,
        secretId: secret.secretId
      }));
      return {
        secret: this.requireSecret(secret.secretId),
        bindings,
        catalog: this.getCatalogState()
      };
    })();
  }

  listBindings(secretId?: string): SecureSessionBinding[] {
    if (secretId !== undefined) assertId(secretId, "secret ID");
    const rows = secretId === undefined
      ? this.database.prepare(`${BINDING_SELECT} ORDER BY secret_id, binding_id`).all()
      : this.database.prepare(`${BINDING_SELECT} WHERE secret_id = ? ORDER BY binding_id`).all(secretId);
    return (rows as BindingRow[]).map(mapBinding);
  }

  getBinding(bindingId: string): SecureSessionBinding | null {
    assertId(bindingId, "binding ID");
    const row = this.database.prepare(`${BINDING_SELECT} WHERE binding_id = ?`).get(bindingId) as
      | BindingRow
      | undefined;
    return row ? mapBinding(row) : null;
  }

  putBinding(input: PutSecureSessionBindingInput): SecureSessionBinding {
    const normalized = normalizeBindingInput(input);
    const now = this.timestamp();
    return this.database.transaction(() => {
      this.requireSecret(input.secretId);
      const existed = this.getBinding(input.bindingId) !== null;
      if (existed) {
        this.revokeCatalogLeases("binding", input.bindingId, "policy_changed", now);
      }
      this.database.prepare(`
        INSERT INTO secure_session_binding (
          binding_id, secret_id, delivery_kind, target_name, target_path, file_mode,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          secret_id = excluded.secret_id,
          delivery_kind = excluded.delivery_kind,
          target_name = excluded.target_name,
          target_path = excluded.target_path,
          file_mode = excluded.file_mode,
          updated_at = excluded.updated_at
      `).run(
        input.bindingId,
        input.secretId,
        input.deliveryKind,
        normalized.targetName,
        normalized.targetPath,
        normalized.fileMode,
        now,
        now
      );
      this.audit({
        eventType: "binding_put",
        secretId: input.secretId,
        bindingId: input.bindingId,
        outcome: existed ? "updated" : "created",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return this.requireBinding(input.bindingId);
    })();
  }

  deleteBinding(bindingId: string): boolean {
    assertId(bindingId, "binding ID");
    return this.database.transaction(() => {
      const binding = this.getBinding(bindingId);
      if (!binding) return false;
      const now = this.timestamp();
      this.revokeCatalogLeases("binding", bindingId, "binding_deleted", now);
      this.database.prepare("DELETE FROM secure_session_binding WHERE binding_id = ?").run(bindingId);
      this.audit({
        eventType: "binding_deleted",
        secretId: binding.secretId,
        bindingId,
        outcome: "deleted",
        occurredAt: now
      });
      this.bumpCatalog(now);
      return true;
    })();
  }

  getOrCreateSessionState(
    sessionAgentId: string,
    input?: InitializeSecureSessionStateInput
  ): SecureSessionState {
    assertId(sessionAgentId, "session agent ID");
    const profileId = input?.profileId ?? sessionAgentId;
    assertId(profileId, "profile ID");
    const executionMode = input?.executionMode ?? "standard";
    const environmentStatus = input?.environmentStatus ?? "stopped";
    assertEnum(executionMode, ["standard", "secure"], "execution mode");
    assertEnum(
      environmentStatus,
      ["stopped", "starting", "ready", "degraded", "failed"],
      "environment status"
    );
    return this.database.transaction(() => {
      const existing = this.getSessionState(sessionAgentId);
      if (existing) return existing;
      const now = this.timestamp();
      this.database.prepare(`
        INSERT INTO secure_session_state (
          session_agent_id, revision, forked_from_session_agent_id, profile_id,
          execution_mode, environment_status, created_at, updated_at
        ) VALUES (?, 0, NULL, ?, ?, ?, ?, ?)
      `).run(sessionAgentId, profileId, executionMode, environmentStatus, now, now);
      this.insertRevision(sessionAgentId, 0, "initialized", null, 0, now);
      this.audit({
        eventType: "session_initialized",
        sessionAgentId,
        outcome: "created",
        occurredAt: now
      });
      return this.requireSessionState(sessionAgentId);
    })();
  }

  updateSessionRuntimeState(
    input: UpdateSecureSessionRuntimeStateInput
  ): SecureSessionMutationResult {
    assertId(input.sessionAgentId, "session agent ID");
    if (input.baseRevision !== undefined) assertRevision(input.baseRevision);
    if (input.profileId !== undefined) assertId(input.profileId, "profile ID");
    if (input.executionMode !== undefined) {
      assertEnum(input.executionMode, ["standard", "secure"], "execution mode");
    }
    if (input.environmentStatus !== undefined) {
      assertEnum(
        input.environmentStatus,
        ["stopped", "starting", "ready", "degraded", "failed"],
        "environment status"
      );
    }
    return this.database.transaction(() => {
      const state = this.getOrCreateSessionState(input.sessionAgentId, {
        profileId: input.profileId ?? input.sessionAgentId,
        executionMode: input.executionMode,
        environmentStatus: input.environmentStatus
      });
      if (input.baseRevision !== undefined) {
        this.assertRevision(state, input.baseRevision);
      }
      const profileId = input.profileId ?? state.profileId;
      const executionMode = input.executionMode ?? state.executionMode;
      const environmentStatus = input.environmentStatus ?? state.environmentStatus;
      if (
        state.profileId === profileId &&
        state.executionMode === executionMode &&
        state.environmentStatus === environmentStatus
      ) {
        const snapshot = this.getSnapshot(input.sessionAgentId);
        return { changed: false, revision: state.revision, snapshot };
      }
      const now = this.timestamp();
      const revision = this.incrementRevision(
        input.sessionAgentId,
        "session_runtime_updated",
        null,
        1,
        now
      );
      this.database.prepare(`
        UPDATE secure_session_state
        SET profile_id = ?, execution_mode = ?, environment_status = ?, updated_at = ?
        WHERE session_agent_id = ?
      `).run(profileId, executionMode, environmentStatus, now, input.sessionAgentId);
      this.audit({
        eventType: "session_runtime_updated",
        sessionAgentId: input.sessionAgentId,
        outcome: "updated",
        occurredAt: now
      });
      return {
        changed: true,
        revision,
        snapshot: this.getSnapshot(input.sessionAgentId)
      };
    })();
  }

  createForkSessionState(
    sourceSessionAgentId: string,
    forkSessionAgentId: string
  ): SecureSessionSnapshot {
    assertId(sourceSessionAgentId, "source session agent ID");
    assertId(forkSessionAgentId, "fork session agent ID");
    if (sourceSessionAgentId === forkSessionAgentId) throw new SecureSessionIdConflictError("fork");
    return this.database.transaction(() => {
      const existing = this.getSessionState(forkSessionAgentId);
      if (existing) {
        if (existing.forkedFromSessionAgentId !== sourceSessionAgentId) {
          throw new SecureSessionIdConflictError("fork");
        }
        return this.getSnapshot(forkSessionAgentId);
      }
      const now = this.timestamp();
      const sourceState = this.getSessionState(sourceSessionAgentId);
      this.database.prepare(`
        INSERT INTO secure_session_state (
          session_agent_id, revision, forked_from_session_agent_id, profile_id,
          execution_mode, environment_status, created_at, updated_at
        ) VALUES (?, 0, ?, ?, 'standard', 'stopped', ?, ?)
      `).run(
        forkSessionAgentId,
        sourceSessionAgentId,
        sourceState?.profileId ?? sourceSessionAgentId,
        now,
        now
      );
      this.insertRevision(forkSessionAgentId, 0, "fork_initialized", null, 0, now);
      this.audit({
        eventType: "fork_initialized",
        sessionAgentId: forkSessionAgentId,
        outcome: "created",
        occurredAt: now
      });
      return this.getSnapshot(forkSessionAgentId);
    })();
  }

  getSnapshot(sessionAgentId: string): SecureSessionSnapshot {
    const state = this.getOrCreateSessionState(sessionAgentId);
    const leaseRows = this.database.prepare(`${LEASE_SELECT}
      WHERE session_agent_id = ? ORDER BY issued_revision, lease_id`).all(sessionAgentId) as LeaseRow[];
    const requestRows = this.database.prepare(`${REQUEST_SELECT}
      WHERE session_agent_id = ? AND state = 'pending'
      ORDER BY requested_at, request_id`).all(sessionAgentId) as RequestRow[];
    return {
      state,
      leases: leaseRows.map((row) => this.mapLease(row)),
      requests: requestRows.map((row) => this.mapRequest(row))
    };
  }

  listSessionStates(): SecureSessionState[] {
    const rows = this.database.prepare(`
      SELECT session_agent_id, revision, forked_from_session_agent_id, profile_id,
        execution_mode, environment_status, created_at, updated_at
      FROM secure_session_state
      ORDER BY session_agent_id
    `).all() as StateRow[];
    return rows.map(mapState);
  }

  createRequest(input: CreateSecureSessionRequestInput): SecureSessionSnapshot {
    const normalized = this.normalizeRequestInput(input);
    return this.database.transaction(() => {
      this.getOrCreateSessionState(input.sessionAgentId);
      if (input.secretId) {
        const secret = this.requireSecret(input.secretId);
        if (secret.displayAlias !== input.displayAlias) {
          throw new Error("Secure session request alias does not match the selected secret");
        }
      }
      const existing = this.getRequest(input.requestId);
      if (existing) {
        if (!sameRequest(existing, input, normalized)) {
          throw new SecureSessionIdConflictError("request");
        }
        return this.getSnapshot(input.sessionAgentId);
      }
      const now = this.timestamp();
      const revision = this.incrementRevision(input.sessionAgentId, "request_created", null, 1, now);
      this.database.prepare(`
        INSERT INTO secure_session_request (
          request_id, session_agent_id, secret_id, display_alias, requested_lease_kind,
          requested_duration_seconds, purpose_summary, requested_by_agent_id,
          requested_by_display_name, state, requested_at, expires_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
      `).run(
        input.requestId,
        input.sessionAgentId,
        input.secretId ?? null,
        input.displayAlias,
        input.requestedLeaseKind,
        normalized.durationSeconds,
        input.purposeSummary,
        input.requestedByAgentId,
        input.requestedByDisplayName,
        now,
        normalized.expiresAt
      );
      this.insertRequestExposures(input.requestId, normalized.requestedExposures);
      this.audit({
        eventType: "request_created",
        sessionAgentId: input.sessionAgentId,
        secretId: input.secretId ?? null,
        requestId: input.requestId,
        outcome: "created",
        occurredAt: now
      });
      const snapshot = this.getSnapshot(input.sessionAgentId);
      assertSnapshotRevision(snapshot, revision);
      return snapshot;
    })();
  }

  resolveRequest(input: ResolveSecureSessionRequestInput): SecureSessionSnapshot {
    assertId(input.requestId, "request ID");
    if (input.baseRevision !== undefined) assertRevision(input.baseRevision);
    assertEnum(
      input.state,
      SECURE_SESSION_REQUEST_STATES.filter((state) => state !== "pending"),
      "request state"
    );
    return this.database.transaction(() => {
      const request = this.requireRequest(input.requestId);
      const now = this.timestamp();
      if (input.baseRevision !== undefined) {
        this.assertRevision(
          this.requireSessionState(request.sessionAgentId),
          input.baseRevision
        );
      }
      const selectedSecretId = input.selectedSecretId ?? request.secretId;
      if (request.state === input.state && request.secretId === selectedSecretId) {
        return this.getSnapshot(request.sessionAgentId);
      }
      if (request.state !== "pending") throw new SecureSessionIdConflictError("request resolution");
      if (input.state === "approved") {
        if (request.expiresAt !== null && request.expiresAt <= now) {
          throw new SecureSessionRequestExpiredError();
        }
        if (!selectedSecretId) {
          throw new Error("Approved secure session requests require a selected secret");
        }
        const secret = this.requireSecret(selectedSecretId);
        if (secret.displayAlias !== request.displayAlias) {
          throw new Error("Selected secret alias does not match the request");
        }
        this.requireExposureDescriptorsForSecret(selectedSecretId, request.requestedExposures);
      } else if (input.selectedSecretId !== undefined && input.selectedSecretId !== null) {
        throw new Error("Only approved requests can select a secret");
      }
      const revision = this.incrementRevision(request.sessionAgentId, "request_resolved", null, 1, now);
      this.database.prepare(`
        UPDATE secure_session_request SET state = ?, secret_id = ?, resolved_at = ?
        WHERE request_id = ?
      `).run(input.state, selectedSecretId, now, input.requestId);
      this.audit({
        eventType: "request_resolved",
        sessionAgentId: request.sessionAgentId,
        secretId: selectedSecretId,
        requestId: input.requestId,
        outcome: input.state,
        occurredAt: now
      });
      const snapshot = this.getSnapshot(request.sessionAgentId);
      assertSnapshotRevision(snapshot, revision);
      return snapshot;
    })();
  }

  createLease(input: CreateSecureSessionLeaseInput): SecureSessionMutationResult {
    return this.createLeases({
      sessionAgentId: input.sessionAgentId,
      baseRevision: input.baseRevision,
      grants: [{
        leaseId: input.leaseId,
        secretId: input.secretId,
        bindingIds: input.bindingIds,
        leaseKind: input.leaseKind,
        grantSource: input.grantSource,
        requestId: input.requestId,
        expiresAt: input.expiresAt,
      }],
    });
  }

  createLeases(input: CreateSecureSessionLeasesInput): SecureSessionMutationResult {
    assertId(input.sessionAgentId, "session agent ID");
    assertRevision(input.baseRevision);
    if (
      !Array.isArray(input.grants)
      || input.grants.length < 1
      || input.grants.length > MAX_BINDINGS
    ) {
      throw new Error(`Lease grants must contain between 1 and ${MAX_BINDINGS} entries`);
    }
    const normalized = input.grants.map((grant) => ({
      grant,
      normalized: this.normalizeCreateLeaseGrantInput(grant),
    }));
    if (new Set(input.grants.map(({ leaseId }) => leaseId)).size !== input.grants.length) {
      throw new Error("Lease grants must contain unique lease IDs");
    }
    if (new Set(input.grants.map(({ secretId }) => secretId)).size !== input.grants.length) {
      throw new Error("Lease grants must contain unique secret IDs");
    }
    return this.database.transaction(() => {
      const pending: typeof normalized = [];
      for (const item of normalized) {
        const existing = this.getLease(item.grant.leaseId);
        if (existing) {
          if (
            !sameLeaseGrant(
              existing,
              input.sessionAgentId,
              item.grant,
              item.normalized,
            )
          ) {
            throw new SecureSessionIdConflictError("lease");
          }
        } else {
          pending.push(item);
        }
      }
      if (pending.length === 0) {
        const snapshot = this.getSnapshot(input.sessionAgentId);
        return { changed: false, revision: snapshot.state.revision, snapshot };
      }

      const state = this.getOrCreateSessionState(input.sessionAgentId);
      for (const { grant, normalized: normalizedGrant } of pending) {
        const secret = this.requireSecret(grant.secretId);
        this.requireBindingsForSecret(grant.secretId, normalizedGrant.bindingIds);
        if (
          normalizedGrant.grantSource === "project_default"
          && !this.getProjectDefault(state.profileId, grant.secretId)
        ) {
          throw new Error("Project-default leases require a configured project default");
        }
        if (!grant.requestId) continue;
        const request = this.requireRequest(grant.requestId);
        if (
          request.sessionAgentId !== input.sessionAgentId ||
          (request.secretId !== null && request.secretId !== grant.secretId)
        ) {
          throw new SecureSessionIdConflictError("lease request");
        }
        if (request.displayAlias !== secret.displayAlias) {
          throw new SecureSessionIdConflictError("lease request alias");
        }
        if (request.expiresAt !== null && request.expiresAt <= this.timestamp()) {
          throw new SecureSessionRequestExpiredError();
        }
        const bindings = normalizedGrant.bindingIds.map(
          (bindingId) => this.requireBinding(bindingId),
        );
        if (!sameExposureDescriptors(request.requestedExposures, bindings)) {
          throw new SecureSessionIdConflictError("lease request exposures");
        }
        if (!["pending", "approved"].includes(request.state)) {
          throw new Error("Secure session request is not grantable");
        }
      }

      this.assertRevision(state, input.baseRevision);
      const now = this.timestamp();
      const revision = this.incrementRevision(
        input.sessionAgentId,
        "lease_created",
        pending.length === 1 ? pending[0]!.grant.leaseId : null,
        pending.length,
        now,
      );
      const insertLease = this.database.prepare(`
        INSERT INTO secure_session_lease (
          lease_id, session_agent_id, secret_id, request_id, grant_source, lease_kind, state,
          issued_revision, updated_revision, expires_at, last_used_at, remaining_uses,
          revoked_at, revocation_reason, one_use_operation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)
      `);
      const approveRequest = this.database.prepare(`
          UPDATE secure_session_request
          SET secret_id = COALESCE(secret_id, ?), state = 'approved',
            resolved_at = COALESCE(resolved_at, ?)
          WHERE request_id = ?
      `);
      for (const { grant, normalized: normalizedGrant } of pending) {
        insertLease.run(
          grant.leaseId,
          input.sessionAgentId,
          grant.secretId,
          grant.requestId ?? null,
          normalizedGrant.grantSource,
          grant.leaseKind,
          revision,
          revision,
          normalizedGrant.expiresAt,
          grant.leaseKind === "one_use" ? 1 : null,
          now,
          now,
        );
        this.insertBindingLinks(
          "secure_session_lease_binding",
          "lease_id",
          grant.leaseId,
          normalizedGrant.bindingIds,
        );
        if (grant.requestId) {
          approveRequest.run(grant.secretId, now, grant.requestId);
        }
        this.audit({
          eventType: "lease_created",
          sessionAgentId: input.sessionAgentId,
          secretId: grant.secretId,
          requestId: grant.requestId ?? null,
          leaseId: grant.leaseId,
          outcome: "created",
          occurredAt: now,
        });
      }
      return {
        changed: true,
        revision,
        snapshot: this.getSnapshot(input.sessionAgentId)
      };
    })();
  }

  revokeLease(input: RevokeSecureSessionLeaseInput): SecureSessionMutationResult {
    assertId(input.leaseId, "lease ID");
    assertId(input.sessionAgentId, "session agent ID");
    assertRevision(input.baseRevision);
    assertEnum(input.reason, SECURE_SESSION_REVOCATION_REASONS, "revocation reason");
    return this.database.transaction(() => {
      const lease = this.requireLease(input.leaseId);
      if (lease.sessionAgentId !== input.sessionAgentId) {
        throw new SecureSessionIdConflictError("lease session");
      }
      if (lease.state === "revoked" && lease.revocationReason === input.reason) {
        const snapshot = this.getSnapshot(input.sessionAgentId);
        return { changed: false, revision: snapshot.state.revision, snapshot };
      }
      this.assertRevision(this.requireSessionState(input.sessionAgentId), input.baseRevision);
      if (lease.state !== "active") {
        const snapshot = this.getSnapshot(input.sessionAgentId);
        return { changed: false, revision: snapshot.state.revision, snapshot };
      }
      const now = this.timestamp();
      const revision = this.incrementRevision(input.sessionAgentId, "lease_revoked", input.leaseId, 1, now);
      this.database.prepare(`
        UPDATE secure_session_lease
        SET state = 'revoked', updated_revision = ?, revoked_at = ?,
          revocation_reason = ?, updated_at = ?
        WHERE lease_id = ? AND state = 'active'
      `).run(revision, now, input.reason, now, input.leaseId);
      this.audit({
        eventType: "lease_revoked",
        sessionAgentId: input.sessionAgentId,
        secretId: lease.secretId,
        requestId: lease.requestId,
        leaseId: input.leaseId,
        outcome: "revoked",
        occurredAt: now
      });
      return { changed: true, revision, snapshot: this.getSnapshot(input.sessionAgentId) };
    })();
  }

  expireLeases(
    now = this.timestamp(),
    sessionAgentId?: string,
  ): SecureSessionMutationResult[] {
    const at = normalizeTimestamp(now, "lease expiration time");
    if (sessionAgentId !== undefined) {
      assertId(sessionAgentId, "session agent ID");
    }
    return this.database.transaction(() => {
      const sessions = (
        sessionAgentId === undefined
          ? this.database.prepare(`
              SELECT session_agent_id, COUNT(*) AS lease_count
              FROM secure_session_lease
              WHERE state = 'active' AND expires_at IS NOT NULL
                AND expires_at <= ?
              GROUP BY session_agent_id ORDER BY session_agent_id
            `).all(at)
          : this.database.prepare(`
              SELECT session_agent_id, COUNT(*) AS lease_count
              FROM secure_session_lease
              WHERE state = 'active' AND expires_at IS NOT NULL
                AND expires_at <= ? AND session_agent_id = ?
              GROUP BY session_agent_id
            `).all(at, sessionAgentId)
      ) as Array<{ session_agent_id: string; lease_count: number }>;
      return sessions.map((session) => {
        const leases = this.database.prepare(`
          SELECT lease_id, secret_id, request_id FROM secure_session_lease
          WHERE session_agent_id = ? AND state = 'active'
            AND expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY lease_id
        `).all(session.session_agent_id, at) as Array<{
          lease_id: string; secret_id: string; request_id: string | null
        }>;
        const revision = this.incrementRevision(
          session.session_agent_id,
          "leases_expired",
          null,
          session.lease_count,
          at
        );
        this.database.prepare(`
          UPDATE secure_session_lease
          SET state = 'expired', updated_revision = ?, updated_at = ?
          WHERE session_agent_id = ? AND state = 'active'
            AND expires_at IS NOT NULL AND expires_at <= ?
        `).run(revision, at, session.session_agent_id, at);
        for (const lease of leases) {
          this.audit({
            eventType: "leases_expired",
            sessionAgentId: session.session_agent_id,
            secretId: lease.secret_id,
            requestId: lease.request_id,
            leaseId: lease.lease_id,
            outcome: "expired",
            occurredAt: at
          });
        }
        return {
          changed: true,
          revision,
          snapshot: this.getSnapshot(session.session_agent_id)
        };
      });
    })();
  }

  expireRequests(
    now = this.timestamp(),
    sessionAgentId?: string
  ): SecureSessionMutationResult[] {
    const at = normalizeTimestamp(now, "request expiration time");
    if (sessionAgentId !== undefined) {
      assertId(sessionAgentId, "session agent ID");
    }
    return this.database.transaction(() => {
      const sessions = (
        sessionAgentId === undefined
          ? this.database.prepare(`
              SELECT session_agent_id, COUNT(*) AS request_count
              FROM secure_session_request
              WHERE state = 'pending' AND expires_at IS NOT NULL
                AND expires_at <= ?
              GROUP BY session_agent_id
              ORDER BY session_agent_id
            `).all(at)
          : this.database.prepare(`
              SELECT session_agent_id, COUNT(*) AS request_count
              FROM secure_session_request
              WHERE state = 'pending' AND expires_at IS NOT NULL
                AND expires_at <= ? AND session_agent_id = ?
              GROUP BY session_agent_id
            `).all(at, sessionAgentId)
      ) as Array<{ session_agent_id: string; request_count: number }>;
      return sessions.map((session) => {
        const requests = this.database.prepare(`
          SELECT request_id, secret_id
          FROM secure_session_request
          WHERE session_agent_id = ? AND state = 'pending'
            AND expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY request_id
        `).all(session.session_agent_id, at) as Array<{
          request_id: string;
          secret_id: string | null;
        }>;
        const revision = this.incrementRevision(
          session.session_agent_id,
          "request_resolved",
          null,
          session.request_count,
          at
        );
        this.database.prepare(`
          UPDATE secure_session_request
          SET state = 'cancelled', resolved_at = ?
          WHERE session_agent_id = ? AND state = 'pending'
            AND expires_at IS NOT NULL AND expires_at <= ?
        `).run(at, session.session_agent_id, at);
        for (const request of requests) {
          this.audit({
            eventType: "request_resolved",
            sessionAgentId: session.session_agent_id,
            secretId: request.secret_id,
            requestId: request.request_id,
            outcome: "cancelled",
            occurredAt: at
          });
        }
        return {
          changed: true,
          revision,
          snapshot: this.getSnapshot(session.session_agent_id)
        };
      });
    })();
  }

  reserveLeaseUse(input: ReserveSecureSessionLeaseUseInput): ReserveSecureSessionLeaseUseResult {
    assertId(input.operationId, "operation ID");
    assertId(input.leaseId, "lease ID");
    assertId(input.sessionAgentId, "session agent ID");
    const at = normalizeOptionalTimestamp(input.now, "reservation time") ?? this.timestamp();
    return this.database.transaction(() => {
      const existing = this.getUseReservation(input.operationId);
      if (existing) {
        if (existing.leaseId !== input.leaseId || existing.sessionAgentId !== input.sessionAgentId) {
          throw new SecureSessionIdConflictError("operation");
        }
        const snapshot = this.getSnapshot(input.sessionAgentId);
        return {
          reserved: true,
          idempotent: true,
          revision: snapshot.state.revision,
          reservation: existing,
          snapshot
        };
      }
      const lease = this.getLease(input.leaseId);
      if (
        !lease ||
        lease.sessionAgentId !== input.sessionAgentId ||
        lease.state !== "active"
      ) {
        return this.unreservedResult(input.sessionAgentId);
      }
      if (lease.expiresAt !== null && lease.expiresAt <= at) {
        this.expireLeases(at, input.sessionAgentId);
        return this.unreservedResult(input.sessionAgentId);
      }
      if (lease.leaseKind === "one_use") {
        const claim = this.database.prepare(`
          UPDATE secure_session_lease
          SET remaining_uses = 0, one_use_operation_id = ?, updated_at = ?
          WHERE lease_id = ? AND state = 'active'
            AND remaining_uses = 1 AND one_use_operation_id IS NULL
        `).run(input.operationId, at, input.leaseId);
        if (claim.changes !== 1) return this.unreservedResult(input.sessionAgentId);
      }
      this.database.prepare(`
        INSERT INTO secure_session_use_reservation (
          operation_id, lease_id, session_agent_id, reserved_at, completed_at, outcome
        ) VALUES (?, ?, ?, ?, NULL, NULL)
      `).run(input.operationId, input.leaseId, input.sessionAgentId, at);
      this.audit({
        eventType: "lease_used",
        sessionAgentId: input.sessionAgentId,
        secretId: lease.secretId,
        requestId: lease.requestId,
        leaseId: input.leaseId,
        operationId: input.operationId,
        outcome: "reserved",
        occurredAt: at
      });
      const snapshot = this.getSnapshot(input.sessionAgentId);
      return {
        reserved: true,
        idempotent: false,
        revision: snapshot.state.revision,
        reservation: this.requireUseReservation(input.operationId),
        snapshot
      };
    })();
  }

  completeLeaseUse(input: CompleteSecureSessionLeaseUseInput): SecureSessionMutationResult {
    assertId(input.operationId, "operation ID");
    assertEnum(input.outcome, SECURE_SESSION_RESERVATION_OUTCOMES, "reservation outcome");
    return this.database.transaction(() => {
      const reservation = this.requireUseReservation(input.operationId);
      if (reservation.outcome !== null) {
        if (reservation.outcome !== input.outcome) {
          throw new SecureSessionIdConflictError("operation completion");
        }
        const snapshot = this.getSnapshot(reservation.sessionAgentId);
        return { changed: false, revision: snapshot.state.revision, snapshot };
      }
      const lease = this.requireLease(reservation.leaseId);
      if (lease.state !== "active") throw new Error("Secure session lease is not active");
      if (
        lease.leaseKind === "one_use" &&
        lease.oneUseOperationId !== input.operationId
      ) {
        throw new SecureSessionIdConflictError("one-use operation");
      }
      const now = this.timestamp();
      const eventType = lease.leaseKind === "one_use" ? "lease_consumed" : "lease_used";
      const revision = this.incrementRevision(
        reservation.sessionAgentId,
        eventType,
        reservation.leaseId,
        1,
        now
      );
      this.database.prepare(`
        UPDATE secure_session_use_reservation
        SET completed_at = ?, outcome = ?
        WHERE operation_id = ? AND completed_at IS NULL
      `).run(now, input.outcome, input.operationId);
      this.database.prepare(`
        UPDATE secure_session_lease
        SET state = ?, updated_revision = ?, last_used_at = ?, updated_at = ?
        WHERE lease_id = ? AND state = 'active'
      `).run(
        lease.leaseKind === "one_use" ? "consumed" : "active",
        revision,
        now,
        now,
        reservation.leaseId
      );
      this.audit({
        eventType,
        sessionAgentId: reservation.sessionAgentId,
        secretId: lease.secretId,
        requestId: lease.requestId,
        leaseId: reservation.leaseId,
        operationId: input.operationId,
        outcome: input.outcome,
        occurredAt: now
      });
      return {
        changed: true,
        revision,
        snapshot: this.getSnapshot(reservation.sessionAgentId)
      };
    })();
  }

  beginExposure(input: BeginSecureSessionExposureInput): SecureSessionExposure {
    assertId(input.exposureId, "exposure ID");
    assertId(input.operationId, "operation ID");
    assertId(input.bindingId, "binding ID");
    return this.database.transaction(() => {
      const existing = this.getExposure(input.exposureId);
      if (existing) {
        if (existing.operationId !== input.operationId || existing.bindingId !== input.bindingId) {
          throw new SecureSessionIdConflictError("exposure");
        }
        return existing;
      }
      const reservation = this.requireUseReservation(input.operationId);
      if (reservation.completedAt !== null) throw new Error("Secure session operation is completed");
      const allowed = this.database.prepare(`
        SELECT 1 FROM secure_session_lease_binding
        WHERE lease_id = ? AND binding_id = ?
      `).get(reservation.leaseId, input.bindingId);
      if (!allowed) throw new Error("Secure session binding is not granted by the lease");
      const now = this.timestamp();
      this.database.prepare(`
        INSERT INTO secure_session_exposure (
          exposure_id, operation_id, binding_id, opened_at, closed_at, outcome
        ) VALUES (?, ?, ?, ?, NULL, NULL)
      `).run(input.exposureId, input.operationId, input.bindingId, now);
      this.audit({
        eventType: "exposure_opened",
        sessionAgentId: reservation.sessionAgentId,
        bindingId: input.bindingId,
        leaseId: reservation.leaseId,
        operationId: input.operationId,
        outcome: "created",
        occurredAt: now
      });
      return this.requireExposure(input.exposureId);
    })();
  }

  closeExposure(input: CloseSecureSessionExposureInput): SecureSessionExposure {
    assertId(input.exposureId, "exposure ID");
    assertEnum(input.outcome, SECURE_SESSION_EXPOSURE_OUTCOMES, "exposure outcome");
    return this.database.transaction(() => {
      const exposure = this.requireExposure(input.exposureId);
      if (exposure.outcome !== null) {
        if (exposure.outcome !== input.outcome) {
          throw new SecureSessionIdConflictError("exposure completion");
        }
        return exposure;
      }
      const reservation = this.requireUseReservation(exposure.operationId);
      const now = this.timestamp();
      this.database.prepare(`
        UPDATE secure_session_exposure SET closed_at = ?, outcome = ?
        WHERE exposure_id = ? AND closed_at IS NULL
      `).run(now, input.outcome, input.exposureId);
      this.audit({
        eventType: "exposure_closed",
        sessionAgentId: reservation.sessionAgentId,
        bindingId: exposure.bindingId,
        leaseId: reservation.leaseId,
        operationId: exposure.operationId,
        outcome: input.outcome,
        occurredAt: now
      });
      return this.requireExposure(input.exposureId);
    })();
  }

  revokeSessionLeases(
    sessionAgentId: string,
    reason: SecureSessionRevocationReason
  ): SecureSessionMutationResult {
    assertId(sessionAgentId, "session agent ID");
    assertEnum(reason, SECURE_SESSION_REVOCATION_REASONS, "revocation reason");
    return this.database.transaction(() => {
      this.getOrCreateSessionState(sessionAgentId);
      const leases = this.database.prepare(`
        SELECT lease_id, secret_id, request_id FROM secure_session_lease
        WHERE session_agent_id = ? AND state = 'active' ORDER BY lease_id
      `).all(sessionAgentId) as Array<{
        lease_id: string; secret_id: string; request_id: string | null
      }>;
      if (leases.length === 0) {
        const snapshot = this.getSnapshot(sessionAgentId);
        return { changed: false, revision: snapshot.state.revision, snapshot };
      }
      const now = this.timestamp();
      const revision = this.incrementRevision(sessionAgentId, "session_revoked", null, leases.length, now);
      this.database.prepare(`
        UPDATE secure_session_lease
        SET state = 'revoked', updated_revision = ?, revoked_at = ?,
          revocation_reason = ?, updated_at = ?
        WHERE session_agent_id = ? AND state = 'active'
      `).run(revision, now, reason, now, sessionAgentId);
      for (const lease of leases) {
        this.audit({
          eventType: "session_revoked",
          sessionAgentId,
          secretId: lease.secret_id,
          requestId: lease.request_id,
          leaseId: lease.lease_id,
          outcome: "revoked",
          occurredAt: now
        });
      }
      return { changed: true, revision, snapshot: this.getSnapshot(sessionAgentId) };
    })();
  }

  deleteSessionState(sessionAgentId: string): boolean {
    assertId(sessionAgentId, "session agent ID");
    return this.database.transaction(() => {
      if (!this.getSessionState(sessionAgentId)) return false;
      this.revokeSessionLeases(sessionAgentId, "session_deleted");
      const now = this.timestamp();
      this.database.prepare(`
        UPDATE secure_session_request
        SET state = 'cancelled', resolved_at = COALESCE(resolved_at, ?)
        WHERE session_agent_id = ? AND state = 'pending'
      `).run(now, sessionAgentId);
      this.database.prepare("DELETE FROM secure_session_state WHERE session_agent_id = ?").run(sessionAgentId);
      this.audit({
        eventType: "session_deleted",
        sessionAgentId,
        outcome: "deleted",
        occurredAt: now
      });
      return true;
    })();
  }

  listAudit(sessionAgentId?: string): SecureSessionAuditRecord[] {
    if (sessionAgentId !== undefined) assertId(sessionAgentId, "session agent ID");
    const rows = sessionAgentId === undefined
      ? this.database.prepare("SELECT * FROM secure_session_audit ORDER BY audit_id").all()
      : this.database.prepare(
          "SELECT * FROM secure_session_audit WHERE session_agent_id = ? ORDER BY audit_id"
        ).all(sessionAgentId);
    return (rows as AuditRow[]).map(mapAudit);
  }

  private normalizeSecretInput(input: CreateSecureSessionSecretInput): {
    displayName: string | null;
    profileId: string | null;
    encryptedMaterial: Buffer | null;
  } {
    assertId(input.secretId, "secret ID");
    assertId(input.providerId, "provider ID");
    assertBoundedText(input.displayAlias, "secret display alias", MAX_DISPLAY_LENGTH);
    const displayName = normalizeOptionalText(input.displayName, "secret display name", MAX_DISPLAY_LENGTH);
    assertEnum(input.scopeKind, SECURE_SESSION_SCOPE_KINDS, "secret scope");
    const profileId = input.scopeKind === "instance"
      ? requireAbsent(input.profileId, "Instance-scoped secrets cannot have a profile ID")
      : requireId(input.profileId, "Profile-scoped secrets require a profile ID");
    assertEnum(input.retention, SECURE_SESSION_RETENTIONS, "secret retention");
    assertBoundedText(input.sourceLocator, "secret source locator", MAX_SOURCE_LOCATOR_LENGTH);
    const encryptedMaterial = input.encryptedMaterial ?? null;
    if (
      encryptedMaterial !== null &&
      (
        !Buffer.isBuffer(encryptedMaterial) ||
        encryptedMaterial.byteLength < 1 ||
        encryptedMaterial.byteLength > MAX_ENCRYPTED_MATERIAL_BYTES
      )
    ) {
      throw new Error("Encrypted material must be a non-empty bounded Buffer");
    }
    return {
      displayName,
      profileId,
      encryptedMaterial: encryptedMaterial === null ? null : Buffer.from(encryptedMaterial)
    };
  }

  private assertSecretAliasAvailable(
    displayAlias: string,
    scopeKind: SecureSessionSecret["scopeKind"],
    profileId: string | null,
    excludingSecretId: string
  ): void {
    const conflict = scopeKind === "instance"
      ? this.database.prepare(`
          SELECT 1
          FROM secure_session_secret
          WHERE scope_kind = 'instance' AND display_alias = ? AND secret_id != ?
        `).get(displayAlias, excludingSecretId)
      : this.database.prepare(`
          SELECT 1
          FROM secure_session_secret
          WHERE scope_kind = 'profile' AND profile_id = ?
            AND display_alias = ? AND secret_id != ?
        `).get(profileId, displayAlias, excludingSecretId);
    if (conflict) throw new SecureSessionAliasConflictError();
  }

  private hydrateSecret(row: SecretRow): SecureSessionSecret {
    const metadata = mapSecretMetadata(row);
    const provider = this.requireProvider(row.provider_id);
    const providerConfigured = provider.kind === "local_keychain" ||
      this.getProviderBackendConfig(provider.providerId) !== null;
    return {
      ...metadata,
      bindings: this.listBindings(row.secret_id),
      available: provider.enabled && provider.status === "available" && providerConfigured
    };
  }

  private normalizeRequestInput(input: CreateSecureSessionRequestInput): {
    requestedExposures: SecureSessionRequestedExposure[];
    durationSeconds: number | null;
    expiresAt: string | null;
  } {
    assertId(input.requestId, "request ID");
    assertId(input.sessionAgentId, "session agent ID");
    if (input.secretId !== undefined && input.secretId !== null) {
      assertId(input.secretId, "secret ID");
    }
    assertBoundedText(input.displayAlias, "request display alias", MAX_DISPLAY_LENGTH);
    if (
      !Array.isArray(input.requestedExposures) ||
      input.requestedExposures.length < 1 ||
      input.requestedExposures.length > MAX_BINDINGS
    ) {
      throw new Error(`Requested exposures must contain between 1 and ${MAX_BINDINGS} entries`);
    }
    const requestedExposures = input.requestedExposures.map(normalizeExposureDescriptor);
    if (hasDuplicateExposureDescriptors(requestedExposures)) {
      throw new Error("Requested exposures must not contain duplicates");
    }
    assertEnum(input.requestedLeaseKind, SECURE_SESSION_LEASE_KINDS, "requested lease kind");
    const durationSeconds = input.requestedLeaseKind === "timed"
      ? requireDuration(input.requestedDurationSeconds)
      : requireAbsent(input.requestedDurationSeconds, "Only timed requests can specify a duration");
    assertBoundedText(input.purposeSummary, "request purpose summary", MAX_PURPOSE_LENGTH);
    assertId(input.requestedByAgentId, "requesting agent ID");
    assertBoundedText(input.requestedByDisplayName, "requesting agent display name", MAX_DISPLAY_LENGTH);
    return {
      requestedExposures,
      durationSeconds,
      expiresAt: normalizeOptionalTimestamp(input.expiresAt, "request expiration time")
    };
  }

  private normalizeCreateLeaseGrantInput(input: CreateSecureSessionLeaseGrantInput): {
    bindingIds: string[];
    expiresAt: string | null;
    grantSource: SecureSessionLease["grantSource"];
  } {
    assertId(input.leaseId, "lease ID");
    assertId(input.secretId, "secret ID");
    if (input.requestId !== undefined && input.requestId !== null) {
      assertId(input.requestId, "request ID");
    }
    const grantSource = input.grantSource
      ?? (input.requestId ? "access_request" : "manual");
    assertEnum(grantSource, SECURE_SESSION_LEASE_GRANT_SOURCES, "lease grant source");
    if (grantSource === "access_request" && !input.requestId) {
      throw new Error("Access-request leases require a request ID");
    }
    if (grantSource !== "access_request" && input.requestId) {
      throw new Error("Only access-request leases can have a request ID");
    }
    const bindingIds = normalizeIds(input.bindingIds, "lease binding IDs");
    assertEnum(input.leaseKind, SECURE_SESSION_LEASE_KINDS, "lease kind");
    const expiresAt = normalizeOptionalTimestamp(input.expiresAt, "lease expiration time");
    if (input.leaseKind === "timed" && expiresAt === null) {
      throw new Error("Timed leases require an expiration time");
    }
    if (input.leaseKind !== "timed" && expiresAt !== null) {
      throw new Error("Only timed leases can have an expiration time");
    }
    return { bindingIds, expiresAt, grantSource };
  }

  private requireBindingsForSecret(secretId: string, bindingIds: readonly string[]): void {
    const rows = this.database.prepare(`
      SELECT binding_id FROM secure_session_binding
      WHERE secret_id = ? AND binding_id IN (${bindingIds.map(() => "?").join(", ")})
      ORDER BY binding_id
    `).all(secretId, ...bindingIds) as Array<{ binding_id: string }>;
    if (!sameIds(rows.map(({ binding_id }) => binding_id), bindingIds)) {
      throw new Error("Secure session bindings must all belong to the selected secret");
    }
  }

  private insertBindingLinks(
    table: "secure_session_lease_binding",
    idColumn: "lease_id",
    id: string,
    bindingIds: readonly string[]
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO ${table} (${idColumn}, binding_id) VALUES (?, ?)`
    );
    for (const bindingId of bindingIds) statement.run(id, bindingId);
  }

  private insertRequestExposures(
    requestId: string,
    exposures: readonly SecureSessionRequestedExposure[]
  ): void {
    const statement = this.database.prepare(`
      INSERT INTO secure_session_request_exposure (
        request_id, exposure_index, delivery_kind, target_name, target_path, file_mode
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    exposures.forEach((exposure, index) => {
      statement.run(
        requestId,
        index,
        exposure.deliveryKind,
        exposure.targetName,
        exposure.targetPath,
        exposure.fileMode
      );
    });
  }

  private requireExposureDescriptorsForSecret(
    secretId: string,
    requested: readonly SecureSessionRequestedExposure[]
  ): void {
    const bindings = this.listBindings(secretId);
    for (const exposure of requested) {
      if (!bindings.some((binding) => sameExposureDescriptor(exposure, binding))) {
        throw new Error("Requested exposure is not configured for the selected secret");
      }
    }
  }

  private getSessionState(sessionAgentId: string): SecureSessionState | null {
    const row = this.database.prepare(`
      SELECT session_agent_id, revision, forked_from_session_agent_id, profile_id,
        execution_mode, environment_status, created_at, updated_at
      FROM secure_session_state WHERE session_agent_id = ?
    `).get(sessionAgentId) as StateRow | undefined;
    return row ? mapState(row) : null;
  }

  private getRequest(requestId: string): SecureSessionRequest | null {
    const row = this.database.prepare(`${REQUEST_SELECT} WHERE request_id = ?`).get(requestId) as
      | RequestRow
      | undefined;
    return row ? this.mapRequest(row) : null;
  }

  private getLease(leaseId: string): SecureSessionLease | null {
    const row = this.database.prepare(`${LEASE_SELECT} WHERE lease_id = ?`).get(leaseId) as
      | LeaseRow
      | undefined;
    return row ? this.mapLease(row) : null;
  }

  private getProjectDefault(
    profileId: string,
    secretId: string
  ): SecureSessionProjectDefault | null {
    const row = this.database.prepare(`
      SELECT profile_id, secret_id, created_at, updated_at
      FROM secure_session_project_default
      WHERE profile_id = ? AND secret_id = ?
    `).get(profileId, secretId) as ProjectDefaultRow | undefined;
    return row ? mapProjectDefault(row) : null;
  }

  private listProjectDefaultsForSecret(
    secretId: string
  ): SecureSessionProjectDefault[] {
    return (this.database.prepare(`
      SELECT profile_id, secret_id, created_at, updated_at
      FROM secure_session_project_default
      WHERE secret_id = ?
      ORDER BY profile_id
    `).all(secretId) as ProjectDefaultRow[]).map(mapProjectDefault);
  }

  private getUseReservation(operationId: string): SecureSessionUseReservation | null {
    const row = this.database.prepare(`
      SELECT operation_id, lease_id, session_agent_id, reserved_at, completed_at, outcome
      FROM secure_session_use_reservation WHERE operation_id = ?
    `).get(operationId) as ReservationRow | undefined;
    return row ? mapReservation(row) : null;
  }

  private getExposure(exposureId: string): SecureSessionExposure | null {
    const row = this.database.prepare(`
      SELECT exposure_id, operation_id, binding_id, opened_at, closed_at, outcome
      FROM secure_session_exposure WHERE exposure_id = ?
    `).get(exposureId) as ExposureRow | undefined;
    return row ? mapExposure(row) : null;
  }

  private mapRequest(row: RequestRow): SecureSessionRequest {
    return {
      requestId: row.request_id,
      sessionAgentId: row.session_agent_id,
      secretId: row.secret_id,
      displayAlias: row.display_alias,
      requestedExposures: this.listRequestExposures(row.request_id),
      leaseKind: row.requested_lease_kind,
      requestedLeaseKind: row.requested_lease_kind,
      requestedDurationSeconds: row.requested_duration_seconds,
      purposeSummary: row.purpose_summary,
      requestedByAgentId: row.requested_by_agent_id,
      requestedByDisplayName: row.requested_by_display_name,
      state: row.state,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at
    };
  }

  private mapLease(row: LeaseRow): SecureSessionLease {
    return {
      leaseId: row.lease_id,
      sessionAgentId: row.session_agent_id,
      secretId: row.secret_id,
      requestId: row.request_id,
      grantSource: row.grant_source,
      leaseKind: row.lease_kind,
      state: row.state,
      bindingIds: this.listLinkIds("secure_session_lease_binding", "lease_id", row.lease_id),
      issuedRevision: row.issued_revision,
      updatedRevision: row.updated_revision,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      remainingUses: row.remaining_uses,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      oneUseOperationId: row.one_use_operation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private listLinkIds(
    table: "secure_session_lease_binding",
    idColumn: "lease_id",
    id: string
  ): string[] {
    return (this.database.prepare(
      `SELECT binding_id FROM ${table} WHERE ${idColumn} = ? ORDER BY binding_id`
    ).all(id) as Array<{ binding_id: string }>).map(({ binding_id }) => binding_id);
  }

  private listRequestExposures(requestId: string): SecureSessionRequestedExposure[] {
    return (this.database.prepare(`
      SELECT delivery_kind, target_name, target_path, file_mode
      FROM secure_session_request_exposure
      WHERE request_id = ?
      ORDER BY exposure_index
    `).all(requestId) as RequestExposureRow[]).map((row) => ({
      deliveryKind: row.delivery_kind,
      targetName: row.target_name,
      targetPath: row.target_path,
      fileMode: row.file_mode
    }));
  }

  private requireProvider(providerId: string): SecureSessionProvider {
    const record = this.getProvider(providerId);
    if (!record) throw new SecureSessionNotFoundError("provider");
    return record;
  }

  private requireSecret(secretId: string): SecureSessionSecret {
    const record = this.getSecret(secretId);
    if (!record) throw new SecureSessionNotFoundError("secret");
    return record;
  }

  private requireBinding(bindingId: string): SecureSessionBinding {
    const record = this.getBinding(bindingId);
    if (!record) throw new SecureSessionNotFoundError("binding");
    return record;
  }

  private requireSessionState(sessionAgentId: string): SecureSessionState {
    const record = this.getSessionState(sessionAgentId);
    if (!record) throw new SecureSessionNotFoundError("session state");
    return record;
  }

  private requireRequest(requestId: string): SecureSessionRequest {
    const record = this.getRequest(requestId);
    if (!record) throw new SecureSessionNotFoundError("request");
    return record;
  }

  private requireLease(leaseId: string): SecureSessionLease {
    const record = this.getLease(leaseId);
    if (!record) throw new SecureSessionNotFoundError("lease");
    return record;
  }

  private requireProjectDefault(
    profileId: string,
    secretId: string
  ): SecureSessionProjectDefault {
    const record = this.getProjectDefault(profileId, secretId);
    if (!record) throw new SecureSessionNotFoundError("project default");
    return record;
  }

  private requireUseReservation(operationId: string): SecureSessionUseReservation {
    const record = this.getUseReservation(operationId);
    if (!record) throw new SecureSessionNotFoundError("use reservation");
    return record;
  }

  private requireExposure(exposureId: string): SecureSessionExposure {
    const record = this.getExposure(exposureId);
    if (!record) throw new SecureSessionNotFoundError("exposure");
    return record;
  }

  private assertRevision(state: SecureSessionState, baseRevision: number): void {
    if (state.revision !== baseRevision) {
      throw new SecureSessionRevisionConflictError(state.revision);
    }
  }

  private bumpCatalog(updatedAt: string): SecureSessionCatalogState {
    const update = this.database.prepare(`
      UPDATE secure_session_catalog_state
      SET revision = revision + 1, updated_at = ?
      WHERE id = 1
    `).run(updatedAt);
    if (update.changes !== 1) throw new SecureSessionNotFoundError("catalog state");
    return this.getCatalogState();
  }

  private incrementRevision(
    sessionAgentId: string,
    eventType: string,
    leaseId: string | null,
    affectedCount: number,
    occurredAt: string
  ): number {
    const update = this.database.prepare(`
      UPDATE secure_session_state SET revision = revision + 1, updated_at = ?
      WHERE session_agent_id = ?
    `).run(occurredAt, sessionAgentId);
    if (update.changes !== 1) throw new SecureSessionNotFoundError("session state");
    const revision = this.requireSessionState(sessionAgentId).revision;
    this.insertRevision(sessionAgentId, revision, eventType, leaseId, affectedCount, occurredAt);
    return revision;
  }

  private insertRevision(
    sessionAgentId: string,
    revision: number,
    eventType: string,
    leaseId: string | null,
    affectedCount: number,
    occurredAt: string
  ): void {
    this.database.prepare(`
      INSERT INTO secure_session_revision (
        session_agent_id, revision, event_type, lease_id, affected_count, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionAgentId, revision, eventType, leaseId, affectedCount, occurredAt);
  }

  private revokeCatalogLeases(
    kind: "provider" | "secret" | "binding",
    id: string,
    reason: SecureSessionRevocationReason,
    now: string
  ): void {
    const query = kind === "provider"
      ? `SELECT l.session_agent_id, l.lease_id, l.secret_id, l.request_id
          FROM secure_session_lease l
          JOIN secure_session_secret s ON s.secret_id = l.secret_id
          WHERE s.provider_id = ? AND l.state = 'active'`
      : kind === "secret"
        ? `SELECT l.session_agent_id, l.lease_id, l.secret_id, l.request_id
            FROM secure_session_lease l
            WHERE l.secret_id = ? AND l.state = 'active'`
        : `SELECT l.session_agent_id, l.lease_id, l.secret_id, l.request_id
            FROM secure_session_lease l
            JOIN secure_session_lease_binding lb ON lb.lease_id = l.lease_id
            WHERE lb.binding_id = ? AND l.state = 'active'`;
    const leases = this.database.prepare(`${query} ORDER BY l.session_agent_id, l.lease_id`).all(id) as Array<{
      session_agent_id: string;
      lease_id: string;
      secret_id: string;
      request_id: string | null;
    }>;
    const sessions = new Map<string, typeof leases>();
    for (const lease of leases) {
      const entries = sessions.get(lease.session_agent_id) ?? [];
      entries.push(lease);
      sessions.set(lease.session_agent_id, entries);
    }
    for (const [sessionAgentId, entries] of sessions) {
      const revision = this.incrementRevision(sessionAgentId, "session_revoked", null, entries.length, now);
      for (const lease of entries) {
        this.database.prepare(`
          UPDATE secure_session_lease
          SET state = 'revoked', updated_revision = ?, revoked_at = ?,
            revocation_reason = ?, updated_at = ?
          WHERE lease_id = ? AND state = 'active'
        `).run(revision, now, reason, now, lease.lease_id);
        this.audit({
          eventType: "session_revoked",
          sessionAgentId,
          secretId: lease.secret_id,
          requestId: lease.request_id,
          leaseId: lease.lease_id,
          outcome: "revoked",
          occurredAt: now
        });
      }
    }
  }

  private revokeProjectDefaultLeases(
    profileId: string,
    secretIds: readonly string[],
    now: string
  ): void {
    if (secretIds.length === 0) return;
    const leases = this.database.prepare(`
      SELECT l.session_agent_id, l.lease_id, l.secret_id, l.request_id
      FROM secure_session_lease l
      JOIN secure_session_state ss ON ss.session_agent_id = l.session_agent_id
      WHERE ss.profile_id = ?
        AND l.secret_id IN (${secretIds.map(() => "?").join(", ")})
        AND l.grant_source = 'project_default'
        AND l.state = 'active'
      ORDER BY l.session_agent_id, l.lease_id
    `).all(profileId, ...secretIds) as Array<{
      session_agent_id: string;
      lease_id: string;
      secret_id: string;
      request_id: string | null;
    }>;
    const sessions = new Map<string, typeof leases>();
    for (const lease of leases) {
      const entries = sessions.get(lease.session_agent_id) ?? [];
      entries.push(lease);
      sessions.set(lease.session_agent_id, entries);
    }
    for (const [sessionAgentId, entries] of sessions) {
      const revision = this.incrementRevision(
        sessionAgentId,
        "session_revoked",
        null,
        entries.length,
        now
      );
      for (const lease of entries) {
        this.database.prepare(`
          UPDATE secure_session_lease
          SET state = 'revoked', updated_revision = ?, revoked_at = ?,
            revocation_reason = 'policy_changed', updated_at = ?
          WHERE lease_id = ? AND state = 'active'
        `).run(revision, now, now, lease.lease_id);
        this.audit({
          eventType: "session_revoked",
          sessionAgentId,
          profileId,
          secretId: lease.secret_id,
          requestId: lease.request_id,
          leaseId: lease.lease_id,
          outcome: "revoked",
          occurredAt: now
        });
      }
    }
  }

  private unreservedResult(sessionAgentId: string): ReserveSecureSessionLeaseUseResult {
    const snapshot = this.getSnapshot(sessionAgentId);
    return {
      reserved: false,
      idempotent: false,
      revision: snapshot.state.revision,
      reservation: null,
      snapshot
    };
  }

  private audit(input: {
    eventType: string;
    sessionAgentId?: string | null;
    profileId?: string | null;
    providerId?: string | null;
    secretId?: string | null;
    bindingId?: string | null;
    requestId?: string | null;
    leaseId?: string | null;
    operationId?: string | null;
    outcome: string;
    occurredAt: string;
  }): void {
    this.database.prepare(`
      INSERT INTO secure_session_audit (
        event_type, session_agent_id, profile_id, provider_id, secret_id, binding_id,
        request_id, lease_id, operation_id, outcome, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventType,
      input.sessionAgentId ?? null,
      input.profileId ?? null,
      input.providerId ?? null,
      input.secretId ?? null,
      input.bindingId ?? null,
      input.requestId ?? null,
      input.leaseId ?? null,
      input.operationId ?? null,
      input.outcome,
      input.occurredAt
    );
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

const SECRET_SELECT = `SELECT secret_id, provider_id, display_alias, display_name,
  scope_kind, profile_id, retention, source_locator, created_at, updated_at
  FROM secure_session_secret`;
const BINDING_SELECT = `SELECT binding_id, secret_id, delivery_kind, target_name,
  target_path, file_mode, created_at, updated_at FROM secure_session_binding`;
const LEASE_SELECT = `SELECT lease_id, session_agent_id, secret_id, request_id,
  grant_source, lease_kind, state, issued_revision, updated_revision, expires_at, last_used_at,
  remaining_uses, revoked_at, revocation_reason, one_use_operation_id, created_at,
  updated_at FROM secure_session_lease`;
const REQUEST_SELECT = `SELECT request_id, session_agent_id, secret_id,
  display_alias, requested_lease_kind, requested_duration_seconds, purpose_summary,
  requested_by_agent_id, requested_by_display_name, state, requested_at,
  expires_at, resolved_at FROM secure_session_request`;

interface ProviderRow {
  provider_id: string;
  kind: SecureSessionProvider["kind"];
  display_name: string;
  enabled: number;
  status: SecureSessionProvider["status"];
  last_verified_at: string | null;
  last_status_code: SecureSessionProvider["lastStatusCode"];
  created_at: string;
  updated_at: string;
}
interface SecretRow {
  secret_id: string;
  provider_id: string;
  display_alias: string;
  display_name: string | null;
  scope_kind: SecureSessionSecret["scopeKind"];
  profile_id: string | null;
  retention: SecureSessionSecret["retention"];
  source_locator: string;
  created_at: string;
  updated_at: string;
}
interface EncryptedSecretRow extends SecretRow {
  source_locator: string;
  encrypted_material: Buffer | null;
}
interface ProjectDefaultRow {
  profile_id: string;
  secret_id: string;
  created_at: string;
  updated_at: string;
}
interface BindingRow {
  binding_id: string;
  secret_id: string;
  delivery_kind: SecureSessionBinding["deliveryKind"];
  target_name: string | null;
  target_path: string | null;
  file_mode: number | null;
  created_at: string;
  updated_at: string;
}
interface StateRow {
  session_agent_id: string;
  revision: number;
  forked_from_session_agent_id: string | null;
  profile_id: string;
  execution_mode: SecureSessionState["executionMode"];
  environment_status: SecureSessionState["environmentStatus"];
  created_at: string;
  updated_at: string;
}
interface LeaseRow {
  lease_id: string;
  session_agent_id: string;
  secret_id: string;
  request_id: string | null;
  grant_source: SecureSessionLease["grantSource"];
  lease_kind: SecureSessionLease["leaseKind"];
  state: SecureSessionLease["state"];
  issued_revision: number;
  updated_revision: number;
  expires_at: string | null;
  last_used_at: string | null;
  remaining_uses: number | null;
  revoked_at: string | null;
  revocation_reason: SecureSessionLease["revocationReason"];
  one_use_operation_id: string | null;
  created_at: string;
  updated_at: string;
}
interface RequestRow {
  request_id: string;
  session_agent_id: string;
  secret_id: string | null;
  display_alias: string;
  requested_lease_kind: SecureSessionRequest["requestedLeaseKind"];
  requested_duration_seconds: number | null;
  purpose_summary: string;
  requested_by_agent_id: string;
  requested_by_display_name: string;
  state: SecureSessionRequest["state"];
  requested_at: string;
  expires_at: string | null;
  resolved_at: string | null;
}
interface RequestExposureRow {
  delivery_kind: SecureSessionRequestedExposure["deliveryKind"];
  target_name: string | null;
  target_path: string | null;
  file_mode: number | null;
}
interface ProviderBackendRow {
  provider_id: string;
  server_origin: string;
  organization_id: string | null;
  project_id: string | null;
  encrypted_access_token: Buffer;
}
interface ReservationRow {
  operation_id: string;
  lease_id: string;
  session_agent_id: string;
  reserved_at: string;
  completed_at: string | null;
  outcome: SecureSessionUseReservation["outcome"];
}
interface ExposureRow {
  exposure_id: string;
  operation_id: string;
  binding_id: string;
  opened_at: string;
  closed_at: string | null;
  outcome: SecureSessionExposure["outcome"];
}
interface AuditRow {
  audit_id: number;
  event_type: string;
  session_agent_id: string | null;
  profile_id: string | null;
  provider_id: string | null;
  secret_id: string | null;
  binding_id: string | null;
  request_id: string | null;
  lease_id: string | null;
  operation_id: string | null;
  outcome: string;
  occurred_at: string;
}

function mapProvider(row: ProviderRow): SecureSessionProvider {
  return {
    providerId: row.provider_id,
    kind: row.kind,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    lastStatusCode: row.last_status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProjectDefault(row: ProjectDefaultRow): SecureSessionProjectDefault {
  return {
    profileId: row.profile_id,
    secretId: row.secret_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProviderBackend(row: ProviderBackendRow): SecureSessionProviderBackendConfig {
  return {
    providerId: row.provider_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    projectId: row.project_id,
    encryptedAccessToken: Buffer.from(row.encrypted_access_token)
  };
}

function mapSecretMetadata(
  row: SecretRow
): Omit<SecureSessionSecret, "bindings" | "available"> {
  return {
    secretId: row.secret_id,
    providerId: row.provider_id,
    displayAlias: row.display_alias,
    displayName: row.display_name,
    scopeKind: row.scope_kind,
    profileId: row.profile_id,
    retention: row.retention,
    sourceLocator: row.source_locator,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBinding(row: BindingRow): SecureSessionBinding {
  return {
    bindingId: row.binding_id,
    secretId: row.secret_id,
    deliveryKind: row.delivery_kind,
    targetName: row.target_name,
    targetPath: row.target_path,
    fileMode: row.file_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapState(row: StateRow): SecureSessionState {
  return {
    sessionAgentId: row.session_agent_id,
    revision: row.revision,
    forkedFromSessionAgentId: row.forked_from_session_agent_id,
    profileId: row.profile_id,
    executionMode: row.execution_mode,
    environmentStatus: row.environment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapReservation(row: ReservationRow): SecureSessionUseReservation {
  return {
    operationId: row.operation_id,
    leaseId: row.lease_id,
    sessionAgentId: row.session_agent_id,
    reservedAt: row.reserved_at,
    completedAt: row.completed_at,
    outcome: row.outcome
  };
}

function mapExposure(row: ExposureRow): SecureSessionExposure {
  return {
    exposureId: row.exposure_id,
    operationId: row.operation_id,
    bindingId: row.binding_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    outcome: row.outcome
  };
}

function mapAudit(row: AuditRow): SecureSessionAuditRecord {
  return {
    auditId: row.audit_id,
    eventType: row.event_type,
    sessionAgentId: row.session_agent_id,
    profileId: row.profile_id,
    providerId: row.provider_id,
    secretId: row.secret_id,
    bindingId: row.binding_id,
    requestId: row.request_id,
    leaseId: row.lease_id,
    operationId: row.operation_id,
    outcome: row.outcome,
    occurredAt: row.occurred_at
  };
}

function normalizeBindingInput(input: PutSecureSessionBindingInput): {
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
} {
  assertId(input.bindingId, "binding ID");
  assertId(input.secretId, "secret ID");
  assertEnum(input.deliveryKind, SECURE_SESSION_DELIVERY_KINDS, "delivery kind");
  const targetName = normalizeOptionalText(input.targetName, "binding target name", MAX_TARGET_LENGTH);
  const targetPath = normalizeOptionalText(input.targetPath, "binding target path", MAX_TARGET_LENGTH);
  const fileMode = input.fileMode ?? null;
  if (fileMode !== null && (!Number.isInteger(fileMode) || fileMode < 0 || fileMode > 0o777)) {
    throw new Error("Binding file mode must be an integer between 0 and 0777");
  }
  switch (input.deliveryKind) {
    case "environment":
    case "askpass":
      if (targetName === null || targetPath !== null || fileMode !== null) {
        throw new Error(`${input.deliveryKind} bindings require only a target name`);
      }
      break;
    case "file":
      if (targetName !== null || targetPath === null) {
        throw new Error("File bindings require a target path and no target name");
      }
      break;
    case "stdin":
    case "ssh_agent":
      if (targetName !== null || targetPath !== null || fileMode !== null) {
        throw new Error(`${input.deliveryKind} bindings cannot have target fields`);
      }
      break;
  }
  return { targetName, targetPath, fileMode };
}

function defaultStatusCode(
  status: SecureSessionProvider["status"]
): SecureSessionProvider["lastStatusCode"] {
  switch (status) {
    case "available": return "ok";
    case "locked": return "source_locked";
    case "auth_required": return "provider_auth_required";
    case "unreachable": return "source_unreachable";
    case "missing": return "source_missing";
    case "disabled": return "provider_disabled";
  }
}

function sameRequest(
  existing: SecureSessionRequest,
  input: CreateSecureSessionRequestInput,
  normalized: {
    requestedExposures: SecureSessionRequestedExposure[];
    durationSeconds: number | null;
    expiresAt: string | null;
  }
): boolean {
  return existing.sessionAgentId === input.sessionAgentId &&
    existing.secretId === (input.secretId ?? null) &&
    existing.displayAlias === input.displayAlias &&
    existing.requestedLeaseKind === input.requestedLeaseKind &&
    existing.requestedDurationSeconds === normalized.durationSeconds &&
    existing.purposeSummary === input.purposeSummary &&
    existing.requestedByAgentId === input.requestedByAgentId &&
    existing.requestedByDisplayName === input.requestedByDisplayName &&
    existing.expiresAt === normalized.expiresAt &&
    sameExposureDescriptors(existing.requestedExposures, normalized.requestedExposures);
}

function sameLeaseGrant(
  existing: SecureSessionLease,
  sessionAgentId: string,
  input: CreateSecureSessionLeaseGrantInput,
  normalized: {
    bindingIds: string[];
    expiresAt: string | null;
    grantSource: SecureSessionLease["grantSource"];
  }
): boolean {
  return existing.sessionAgentId === sessionAgentId &&
    existing.secretId === input.secretId &&
    existing.requestId === (input.requestId ?? null) &&
    existing.grantSource === normalized.grantSource &&
    existing.leaseKind === input.leaseKind &&
    existing.expiresAt === normalized.expiresAt &&
    sameIds(existing.bindingIds, normalized.bindingIds);
}

function normalizeIds(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BINDINGS) {
    throw new Error(`${label} must contain between 1 and ${MAX_BINDINGS} IDs`);
  }
  for (const value of values) assertId(value, label);
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length) throw new Error(`${label} must not contain duplicates`);
  return unique;
}

function normalizeExposureDescriptor(
  input: {
    deliveryKind: SecureSessionBinding["deliveryKind"];
    targetName?: string | null;
    targetPath?: string | null;
    fileMode?: number | null;
  }
): SecureSessionRequestedExposure {
  const normalized = normalizeBindingInput({
    bindingId: "requested-exposure",
    secretId: "requested-secret",
    ...input
  });
  return {
    deliveryKind: input.deliveryKind,
    targetName: normalized.targetName,
    targetPath: normalized.targetPath,
    fileMode: normalized.fileMode
  };
}

function sameExposureDescriptor(
  left: SecureSessionRequestedExposure,
  right: SecureSessionRequestedExposure | SecureSessionBinding
): boolean {
  return left.deliveryKind === right.deliveryKind &&
    left.targetName === right.targetName &&
    left.targetPath === right.targetPath &&
    left.fileMode === right.fileMode;
}

function exposureDescriptorKey(exposure: SecureSessionRequestedExposure): string {
  return [
    exposure.deliveryKind,
    exposure.targetName ?? "",
    exposure.targetPath ?? "",
    exposure.fileMode?.toString(10) ?? ""
  ].join("\0");
}

function hasDuplicateExposureDescriptors(
  exposures: readonly SecureSessionRequestedExposure[]
): boolean {
  return new Set(exposures.map(exposureDescriptorKey)).size !== exposures.length;
}

function sameExposureDescriptors(
  left: readonly SecureSessionRequestedExposure[],
  right: readonly (SecureSessionRequestedExposure | SecureSessionBinding)[]
): boolean {
  const leftKeys = left.map(exposureDescriptorKey).sort();
  const rightKeys = right.map((exposure) => exposureDescriptorKey({
    deliveryKind: exposure.deliveryKind,
    targetName: exposure.targetName,
    targetPath: exposure.targetPath,
    fileMode: exposure.fileMode
  })).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertId(value: string, label: string): void {
  assertBoundedText(value, label, MAX_ID_LENGTH);
  if (value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} contains invalid whitespace or null bytes`);
  }
}

function requireId(value: string | null | undefined, message: string): string {
  if (value === null || value === undefined) throw new Error(message);
  assertId(value, "profile ID");
  return value;
}

function normalizeOptionalId(
  value: string | null | undefined,
  label: string
): string | null {
  if (value === null || value === undefined) return null;
  assertId(value, label);
  return value;
}

function normalizeServerOrigin(value: string): string {
  assertBoundedText(value, "provider server origin", MAX_SOURCE_LOCATOR_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Provider server origin must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("Provider server origin must be a credential-free HTTPS origin");
  }
  return parsed.origin;
}

function normalizeEncryptedBuffer(value: Buffer, label: string): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_ENCRYPTED_MATERIAL_BYTES
  ) {
    throw new Error(`${label} must be a non-empty bounded Buffer`);
  }
  return Buffer.from(value);
}

function assertBoundedText(value: string, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
}

function normalizeOptionalText(
  value: string | null | undefined,
  label: string,
  maximum: number
): string | null {
  if (value === null || value === undefined) return null;
  assertBoundedText(value, label, maximum);
  return value;
}

function requireAbsent<T>(value: T | null | undefined, message: string): null {
  if (value !== null && value !== undefined) throw new Error(message);
  return null;
}

function requireDuration(value: number | null | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86400) {
    throw new Error("Timed request duration must be an integer between 1 and 86400 seconds");
  }
  return value as number;
}

function normalizeTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeOptionalTimestamp(
  value: string | null | undefined,
  label: string
): string | null {
  return value === null || value === undefined ? null : normalizeTimestamp(value, label);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Secure session revision must be a non-negative safe integer");
  }
}

function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): asserts value is T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${label}`);
}

function assertSnapshotRevision(snapshot: SecureSessionSnapshot, revision: number): void {
  if (snapshot.state.revision !== revision) {
    throw new Error("Secure session snapshot revision invariant failed");
  }
}
