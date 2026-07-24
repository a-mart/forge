import { randomUUID } from "node:crypto";
import type {
  AgentDescriptor,
  GrantSecureSecretLeaseInput,
  GrantSecureSecretLeaseRequest,
  GrantSecureSecretLeasesRequest,
  ResolveSecureSecretAccessRequest,
  SecureSecretBinding,
  SecureSecretCatalogChangedEvent,
  SecureSecretProviderSummary,
  SecureSecretSummary,
  SecureSessionSnapshot as PublicSecureSessionSnapshot,
  SecureSessionSnapshotEvent,
} from "@forge/protocol";
import { SECURE_SECRET_MAX_TIMED_LEASE_SECONDS } from "@forge/protocol";
import {
  createExecutionDeliveryFromBindings,
  type ResolvedSecureSecretBinding,
} from "./execution/protocol-binding-delivery.js";
import { SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES } from "./execution/execution-frame.js";
import type {
  SecureExecutionBackend,
  SecureOrphanRecoveryResult,
  SecureExecutionTask,
} from "./execution/secure-execution-backend.js";
import { SECURE_OUTPUT_QUARANTINE, SecureValueGuard } from "./redaction/secure-value-guard.js";
import type { SecureRuntimeBinding } from "./runtime/secure-runtime-binding.js";
import type {
  FulfillSecureAccessRequestInput,
  ImportBitwardenSecureSecretInput,
  ConnectBitwardenSecureSecretProviderInput,
  CreateLocalSecureSecretInput,
  RequestSecureSecretAccessInput,
  SecureSessionAgentView,
  StartSecureSessionInput,
  StopSecureSessionInput,
  UpdateSecureSecretInput,
} from "./secure-sessions-api.js";
import {
  SecureSessionsServiceError,
  type SecureSessionsServiceErrorCode,
} from "./secure-sessions-error.js";
import type { SecureVaultCipher } from "./sources/electron-safe-storage-client.js";
import {
  HostOnlySecret,
  SecureSourceError,
  type SecureSecretSource,
} from "./sources/host-only-secret.js";
import {
  SecureSessionRevisionConflictError,
  SecureSessionStore,
} from "./storage/secure-session-store.js";
import type {
  SecureSessionBinding as StoredBinding,
  SecureSessionLease,
  SecureSessionProvider,
  SecureSessionRequestedExposure,
  SecureSessionSecret,
  SecureSessionSnapshot as StoredSnapshot,
} from "./storage/types.js";

const LOCAL_PROVIDER_ID = "forge-local-keychain";
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const REQUEST_TTL_MS = 30 * 60 * 1000;
const SECURE_FILE_ROOT = "/run/forge-secure/bindings/";

interface SecureSessionsServiceOptions {
  storeFactory: () => Promise<SecureSessionStore>;
  cipher: SecureVaultCipher & { dispose?: () => void };
  localSource: SecureSecretSource;
  bitwardenSource: SecureSecretSource & {
    testConnection(input: {
      encryptedCredential?: Uint8Array;
      endpointOrigin?: string | null;
      signal?: AbortSignal;
    }): Promise<void>;
  };
  probeBitwarden: () => Promise<boolean>;
  execution: SecureExecutionBackend;
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  requireBuilderSession: (agentId: string, action: string) => AgentDescriptor;
  emitSnapshot: (event: SecureSessionSnapshotEvent) => void;
  emitCatalogChanged: (event: SecureSecretCatalogChangedEvent) => void;
  applyModeRuntimeRecycle: (
    sessionAgentId: string,
  ) => Promise<"recycled" | "deferred" | "none"> | "recycled" | "deferred" | "none";
  now?: () => string;
  createId?: () => string;
}

interface ActiveSession {
  task: SecureExecutionTask;
  guard: SecureValueGuard | null;
  guardRequired: boolean;
  closed: boolean;
}

interface SecureOutputState {
  outputState: "clear" | "quarantined";
  outputStateCode: null | "SECURE_OUTPUT_QUARANTINED";
}

interface ReservedLease {
  lease: SecureSessionLease;
  operationId: string;
  exposureIds: string[];
}

interface PreparedSecureBashExecution {
  store: SecureSessionStore;
  reserved: ReservedLease[];
  resolved: ResolvedSecureSecretBinding[];
  guard: SecureValueGuard;
  active: ActiveSession;
}

export class SecureSessionsService {
  private storePromise: Promise<SecureSessionStore> | null = null;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly cachedLeaseSecrets = new Map<string, HostOnlySecret>();
  private readonly cachedLeaseOwners = new Map<string, string>();
  private readonly outputStates = new Map<string, SecureOutputState>();
  private readonly leaseExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeExecutionCounts = new Map<string, number>();
  private readonly executionSettlers = new Map<string, Set<() => void>>();
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  private readonly bashExecutionTails = new Map<string, Promise<void>>();
  private authorityMutationTail: Promise<void> = Promise.resolve();
  private startupRecoveryPromise: Promise<SecureOrphanRecoveryResult> | null = null;
  private startupRecoveryResult: SecureOrphanRecoveryResult | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(private readonly options: SecureSessionsServiceOptions) {}

  /**
   * Removes every sandbox left by an earlier backend process before this
   * process can authorize secure execution. In-memory runtime bindings and
   * secret leases intentionally do not survive a Forge process restart.
   */
  async initializeSecureSessions(): Promise<SecureOrphanRecoveryResult> {
    if (this.closed) throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    if (this.startupRecoveryResult) return this.startupRecoveryResult;
    this.startupRecoveryPromise ??= (async () => {
      const store = await this.store();
      let catalogChanged = false;
      for (const state of store.listSessionStates()) {
        store.revokeSessionLeases(state.sessionAgentId, "session_stopped");
        store.updateSessionRuntimeState({
          sessionAgentId: state.sessionAgentId,
          profileId: state.profileId,
          executionMode: "standard",
          environmentStatus: "stopped",
        });
        catalogChanged = this.deleteSessionSecrets(store, state.sessionAgentId) || catalogChanged;
      }
      for (const secret of store.listSecrets()) {
        if (store.listBindings(secret.secretId).length > 0) continue;
        const binding = normalizeBindings(
          [defaultSecureSecretBinding(secret.secretId, secret.displayAlias)],
          this.id.bind(this),
        )[0]!;
        store.putBinding({ ...binding, secretId: secret.secretId });
        catalogChanged = true;
      }
      if (catalogChanged) this.emitCatalog(store);

      const result = await this.options.execution.recoverOrphans([]);
      return result;
    })()
      .then((result) => {
        this.startupRecoveryResult = {
          destroyedSandboxIds: [...result.destroyedSandboxIds],
        };
        return this.startupRecoveryResult;
      })
      .catch(async (error: unknown) => {
        this.startupRecoveryPromise = null;
        const store = await this.store();
        for (const state of store.listSessionStates()) {
          store.updateSessionRuntimeState({
            sessionAgentId: state.sessionAgentId,
            profileId: state.profileId,
            executionMode: "standard",
            environmentStatus: "degraded",
          });
        }
        throw error;
      });
    try {
      return await this.startupRecoveryPromise;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async listSecureSecretProviders(): Promise<SecureSecretProviderSummary[]> {
    const store = await this.store();
    return store.listProviders().map(toProviderSummary);
  }

  async connectBitwardenSecureSecretProvider(
    input: ConnectBitwardenSecureSecretProviderInput,
  ): Promise<SecureSecretProviderSummary> {
    const serverOrigin = normalizeHttpsOrigin(input.serverOrigin);
    const encryptedAccessToken = decodeCiphertext(input.encryptedAccessToken);
    const providerId = this.options.createId?.() ?? randomUUID();
    const store = await this.store();
    try {
      await this.options.bitwardenSource.testConnection({
        encryptedCredential: encryptedAccessToken,
        endpointOrigin: serverOrigin,
      });
      const provider = store.upsertProvider({
        providerId,
        kind: "bitwarden_secrets_manager",
        displayName: bounded(input.displayName, 256),
        enabled: true,
        status: "available",
        lastStatusCode: "ok",
      });
      try {
        store.upsertProviderBackendConfig({
          providerId,
          serverOrigin,
          organizationId: optionalBounded(input.organizationId, 256),
          projectId: optionalBounded(input.projectId, 256),
          encryptedAccessToken,
        });
      } catch (error) {
        store.deleteProvider(providerId);
        throw error;
      }
      this.emitCatalog(store);
      return toProviderSummary(provider);
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedAccessToken.fill(0);
    }
  }

  async testSecureSecretProvider(providerId: string): Promise<SecureSecretProviderSummary> {
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const provider = store.getProvider(providerId);
      if (!provider) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      let status: SecureSessionProvider["status"] = "available";
      let lastStatusCode: SecureSessionProvider["lastStatusCode"] = "ok";
      try {
        if (provider.kind === "local_keychain") {
          await this.options.cipher.status();
        } else {
          const config = store.getProviderBackendConfig(providerId);
          if (!config) throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
          await this.options.bitwardenSource.testConnection({
            encryptedCredential: config.encryptedAccessToken,
            endpointOrigin: config.serverOrigin,
          });
        }
      } catch (error) {
        ({ status, lastStatusCode } = providerStatusForError(error));
      }
      const tested = store.updateProviderStatus({
        providerId,
        status,
        lastStatusCode,
        lastVerifiedAt: this.now(),
      });
      if (!tested) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      this.emitCatalog(store);
      return toProviderSummary(tested);
    });
  }

  async deleteSecureSecretProvider(providerId: string): Promise<void> {
    await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const secretIds = store.listSecrets(providerId).map((secret) => secret.secretId);
      const initiallyAffected = this.captureAffectedLeases(store, secretIds);
      await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
        const affected = this.captureAffectedLeases(store, secretIds);
        if (!store.deleteProvider(providerId)) {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        this.releaseLeases(affected.leaseIds);
        await this.deactivateAffectedSessions(store, affected.sessionIds);
        this.emitCatalog(store);
        this.emitSessionSnapshots(store, affected.sessionIds);
      });
    });
  }

  async listSecureSecrets(): Promise<SecureSecretSummary[]> {
    const store = await this.store();
    return this.listPublicSecrets(store);
  }

  async createLocalSecureSecret(input: CreateLocalSecureSecretInput): Promise<SecureSecretSummary> {
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    const store = await this.store();
    try {
      this.ensureLocalProvider(store);
      const secretId = this.id();
      const displayAlias = bounded(input.displayAlias, 256);
      const result = store.createSecretWithBindings({
        secret: {
          secretId,
          providerId: LOCAL_PROVIDER_ID,
          displayAlias,
          displayName: optionalBounded(input.displayName, 256),
          ...toStoredScope(input.scope),
          retention: input.retention ?? "saved",
          sourceLocator: "local",
          encryptedMaterial,
        },
        bindings: normalizeBindings(
          input.bindings?.length
            ? input.bindings
            : [defaultSecureSecretBinding(secretId, displayAlias)],
          this.id.bind(this),
        ),
      });
      this.emitCatalog(store);
      return this.toSecretSummary(store, result.secret);
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedMaterial.fill(0);
    }
  }

  async importBitwardenSecureSecret(
    providerId: string,
    input: ImportBitwardenSecureSecretInput,
  ): Promise<SecureSecretSummary> {
    if (!/^[0-9a-fA-F-]{16,128}$/.test(input.sourceLocator)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    const provider = store.getProvider(providerId);
    if (!provider || provider.kind !== "bitwarden_secrets_manager") {
      throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    }
    try {
      const secretId = this.id();
      const displayAlias = bounded(input.displayAlias, 256);
      const result = store.createSecretWithBindings({
        secret: {
          secretId,
          providerId,
          displayAlias,
          displayName: optionalBounded(input.displayName, 256),
          ...toStoredScope(input.scope),
          retention: input.retention ?? "saved",
          sourceLocator: input.sourceLocator,
          encryptedMaterial: null,
        },
        bindings: normalizeBindings(
          input.bindings?.length
            ? input.bindings
            : [defaultSecureSecretBinding(secretId, displayAlias)],
          this.id.bind(this),
        ),
      });
      this.emitCatalog(store);
      return this.toSecretSummary(store, result.secret);
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async updateSecureSecret(
    secretId: string,
    input: UpdateSecureSecretInput,
  ): Promise<SecureSecretSummary> {
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const initiallyAffected = this.captureAffectedLeases(store, [secretId]);
      return await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
        const existing = store.getEncryptedSecret(secretId);
        if (!existing) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        if (input.encryptedMaterial !== undefined && existing.providerId !== LOCAL_PROVIDER_ID) {
          throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
        }
        const encryptedMaterial = input.encryptedMaterial === undefined
          ? existing.encryptedMaterial
          : decodeCiphertext(input.encryptedMaterial);
        const affected = this.captureAffectedLeases(store, [secretId]);
        const nextDisplayAlias = input.displayAlias === undefined
          ? existing.displayAlias
          : bounded(input.displayAlias, 256);
        const existingBindings = store.listBindings(secretId);
        const nextBindings = input.bindings === undefined && existingBindings.length > 0
          ? existingBindings.map(toBindingInput)
          : normalizeBindings(
              input.bindings?.length
                ? input.bindings
                : [defaultSecureSecretBinding(secretId, nextDisplayAlias)],
              this.id.bind(this),
            );
        try {
          const result = store.updateSecretWithBindings({
            secret: {
              secretId,
              providerId: existing.providerId,
              displayAlias: nextDisplayAlias,
              displayName: input.displayName === undefined
                ? existing.displayName
                : optionalBounded(input.displayName, 256),
              ...toStoredScope(input.scope ?? toPublicScope(existing)),
              retention: input.retention ?? existing.retention,
              sourceLocator: existing.sourceLocator,
              encryptedMaterial,
            },
            bindings: nextBindings,
          });
          this.releaseLeases(affected.leaseIds);
          await this.deactivateAffectedSessions(store, affected.sessionIds);
          this.emitCatalog(store);
          this.emitSessionSnapshots(store, affected.sessionIds);
          return this.toSecretSummary(store, result.secret);
        } catch (error) {
          throw this.publicError(error);
        } finally {
          if (input.encryptedMaterial !== undefined) encryptedMaterial?.fill(0);
          existing.encryptedMaterial?.fill(0);
        }
      });
    });
  }

  async deleteSecureSecret(secretId: string): Promise<void> {
    await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const initiallyAffected = this.captureAffectedLeases(store, [secretId]);
      await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
        const affected = this.captureAffectedLeases(store, [secretId]);
        if (!store.deleteSecret(secretId)) {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        this.releaseLeases(affected.leaseIds);
        await this.deactivateAffectedSessions(store, affected.sessionIds);
        this.emitCatalog(store);
        this.emitSessionSnapshots(store, affected.sessionIds);
      });
    });
  }

  async getSecureSessionSnapshot(sessionAgentId: string): Promise<PublicSecureSessionSnapshot> {
    return await this.withSessionMutation(sessionAgentId, async () =>
      await this.getSecureSessionSnapshotUnlocked(sessionAgentId)
    );
  }

  private async getSecureSessionSnapshotUnlocked(
    sessionAgentId: string,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    store.getOrCreateSessionState(sessionAgentId, {
      profileId: requireProfileId(descriptor),
      executionMode: "standard",
      environmentStatus: "stopped",
    });
    let snapshot = store.getSnapshot(sessionAgentId);
    if (
      snapshot.state.executionMode === "secure"
      && snapshot.state.environmentStatus === "ready"
      && !this.activeSessions.has(sessionAgentId)
    ) {
      await this.options.execution.destroyTask(toTask(descriptor)).catch(() => false);
      store.revokeSessionLeases(sessionAgentId, "policy_changed");
      snapshot = store.updateSessionRuntimeState({
        sessionAgentId,
        executionMode: "secure",
        environmentStatus: "failed",
      }).snapshot;
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, snapshot)));
    }
    return this.toPublicSnapshot(store, snapshot);
  }

  async startSecureSession(
    sessionAgentId: string,
    input: StartSecureSessionInput = {},
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withSessionMutation(sessionAgentId, async () =>
      await this.startSecureSessionUnlocked(sessionAgentId, input)
    );
  }

  private async startSecureSessionUnlocked(
    sessionAgentId: string,
    input: StartSecureSessionInput,
    options: { emitSnapshot?: boolean } = {},
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    const store = await this.store();
    const initial = store.getOrCreateSessionState(sessionAgentId, {
      profileId: requireProfileId(descriptor),
      executionMode: "standard",
      environmentStatus: "stopped",
    });
    if (input.baseRevision !== undefined) requireRevision(initial.revision, input.baseRevision);
    const existingActive = this.activeSessions.get(sessionAgentId);
    if (existingActive?.closed) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    if (
      initial.executionMode === "secure"
      && initial.environmentStatus === "ready"
      && existingActive
    ) {
      return this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId));
    }
    const task = toTask(descriptor);
    const bindingWasActive = this.activeSessions.has(sessionAgentId);
    let activationDeferred = false;
    try {
      await this.initializeSecureSessions();
      await this.options.execution.ensureTask(task);
      const current = store.getSnapshot(sessionAgentId);
      if (input.baseRevision !== undefined) requireRevision(current.state.revision, input.baseRevision);
      const result = store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: requireProfileId(descriptor),
        executionMode: "secure",
        environmentStatus: "ready",
      });
      this.activeSessions.set(sessionAgentId, {
        task,
        guard: null,
        guardRequired: false,
        closed: false,
      });
      this.outputStates.set(sessionAgentId, {
        outputState: "clear",
        outputStateCode: null,
      });
      this.scheduleLeaseExpiry(store, sessionAgentId);
      const snapshot = this.toPublicSnapshot(store, result.snapshot);
      if (result.changed || !bindingWasActive) {
        const recycle = await this.options.applyModeRuntimeRecycle(sessionAgentId);
        if (recycle === "deferred") {
          activationDeferred = true;
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        if (options.emitSnapshot !== false) {
          this.options.emitSnapshot(toSnapshotEvent(snapshot));
        }
      }
      return snapshot;
    } catch (error) {
      await this.options.execution.destroyTask(task).catch(() => false);
      this.releaseSession(sessionAgentId);
      this.outputStates.delete(sessionAgentId);
      const failed = store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: requireProfileId(descriptor),
        executionMode: activationDeferred ? "standard" : "secure",
        environmentStatus: activationDeferred ? "stopped" : "failed",
      });
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, failed.snapshot)));
      throw this.publicError(error);
    }
  }

  async stopSecureSession(
    sessionAgentId: string,
    input: StopSecureSessionInput,
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withSessionMutation(sessionAgentId, async () =>
      await this.stopSecureSessionUnlocked(sessionAgentId, input)
    );
  }

  private async stopSecureSessionUnlocked(
    sessionAgentId: string,
    input: StopSecureSessionInput,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    if (input.stopProcesses !== true) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    const before = store.getOrCreateSessionState(sessionAgentId, {
      profileId: requireProfileId(descriptor),
      executionMode: "standard",
      environmentStatus: "stopped",
    });
    requireNonFutureRevision(before.revision, input.baseRevision);
    const task = this.activeSessions.get(sessionAgentId)?.task ?? toTask(descriptor);
    let destroyFailed = false;
    try {
      destroyFailed = !(await this.options.execution.destroyTask(task));
    } catch {
      destroyFailed = true;
    }
    this.releaseSession(sessionAgentId);
    await this.waitForSessionExecutionsToSettle(sessionAgentId);
    const revoke = store.revokeSessionLeases(sessionAgentId, "session_stopped");
    this.clearLeaseExpiryTimer(sessionAgentId);
    this.outputStates.delete(sessionAgentId);
    if (this.deleteSessionSecrets(store, sessionAgentId)) this.emitCatalog(store);
    const runtime = store.updateSessionRuntimeState({
      sessionAgentId,
      profileId: requireProfileId(descriptor),
      executionMode: "standard",
      environmentStatus: destroyFailed ? "degraded" : "stopped",
    });
    const snapshot = this.toPublicSnapshot(store, runtime.snapshot);
    if (revoke.changed || runtime.changed) {
      this.options.emitSnapshot(toSnapshotEvent(snapshot));
      await this.options.applyModeRuntimeRecycle(sessionAgentId);
    }
    return snapshot;
  }

  async stopSecureSessionForLifecycle(
    sessionAgentId: string,
    options: { deleteState?: boolean } = {},
  ): Promise<void> {
    await this.withSessionMutation(sessionAgentId, async () => {
      const descriptor = this.options.getDescriptor(sessionAgentId);
      if (
        !descriptor
        || descriptor.role !== "manager"
        || descriptor.managerId !== descriptor.agentId
        || descriptor.sessionSurface === "collab"
      ) {
        return;
      }
      const store = await this.store();
      const persistedState = store.listSessionStates().find(
        (state) => state.sessionAgentId === sessionAgentId,
      );
      const hasActiveEnvironment = this.activeSessions.has(sessionAgentId);
      if (persistedState || hasActiveEnvironment) {
        const snapshot = store.getSnapshot(sessionAgentId);
        const hasActiveLease = snapshot.leases.some(
          (lease) => lease.state === "active",
        );
        if (
          hasActiveEnvironment
          || hasActiveLease
          || snapshot.state.executionMode === "secure"
          || snapshot.state.environmentStatus !== "stopped"
        ) {
          // Only touch Docker when there is secure runtime authority or
          // recovery evidence to tear down. Standard stopped rows are purely
          // local metadata and must remain Docker-independent.
          await this.initializeSecureSessions();
          const stopped = await this.stopSecureSessionUnlocked(sessionAgentId, {
            baseRevision: snapshot.state.revision,
            stopProcesses: true,
          });
          if (stopped.environmentStatus === "degraded") {
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
        }
      }
      if (options.deleteState && persistedState) {
        const catalogChanged = this.deleteSessionSecrets(
          store,
          sessionAgentId,
        );
        store.deleteSessionState(sessionAgentId);
        if (catalogChanged) this.emitCatalog(store);
      }
    });
  }

  async grantSecureSessionLease(
    sessionAgentId: string,
    input: GrantSecureSecretLeaseRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    const { baseRevision, ...grant } = input;
    return await this.grantSecureSessionLeases(sessionAgentId, {
      baseRevision,
      grants: [grant],
    });
  }

  async grantSecureSessionLeases(
    sessionAgentId: string,
    input: GrantSecureSecretLeasesRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () =>
        await this.grantSecureSessionLeasesUnlocked(sessionAgentId, input)
      )
    );
  }

  private async grantSecureSessionLeasesUnlocked(
    sessionAgentId: string,
    input: GrantSecureSecretLeasesRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    const store = await this.store();
    if (
      !Array.isArray(input.grants)
      || input.grants.length < 1
      || input.grants.length > 16
      || new Set(input.grants.map(({ secretId }) => secretId)).size
        !== input.grants.length
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const initialState = store.listSessionStates().find(
      (state) => state.sessionAgentId === sessionAgentId,
    );
    requireRevision(initialState?.revision ?? 0, input.baseRevision);
    const profileId = requireProfileId(descriptor);
    const now = this.now();
    const grants = input.grants.map((grant) =>
      this.prepareLeaseGrant(store, profileId, grant, now)
    );
    assertSessionBindingCompatibilityForBatch(
      store,
      initialState ? store.getSnapshot(sessionAgentId) : undefined,
      grants.map(({ bindingIds }) => bindingIds),
    );

    const proposedMaterials: HostOnlySecret[] = [];
    let materialsTransferred = false;
    try {
      for (const grant of grants) {
        proposedMaterials.push(
          await this.resolveSecretMaterial(store, grant.secret.secretId),
        );
      }

      await this.expireAndPublish(store, sessionAgentId);
      const refreshedState = store.listSessionStates().find(
        (state) => state.sessionAgentId === sessionAgentId,
      );
      requireRevision(refreshedState?.revision ?? 0, input.baseRevision);
      store.getOrCreateSessionState(sessionAgentId, {
        profileId,
        executionMode: "standard",
        environmentStatus: "stopped",
      });
      const requiresCleanEnvironment = this.activeSessions.has(sessionAgentId);
      await this.ensureSecureEnvironment(store, descriptor, { emitSnapshot: false });
      if (requiresCleanEnvironment) {
        await this.rebuildEnvironmentForNewLease(store, descriptor);
      }
      const current = store.getSnapshot(sessionAgentId);
      const leaseGrants = grants.map(
        ({ secret, bindingIds, leaseKind, expiresAt: expiry }) => ({
          leaseId: this.id(),
          secretId: secret.secretId,
          bindingIds,
          leaseKind,
          expiresAt: expiry,
        }),
      );
      const result = store.createLeases({
        sessionAgentId,
        baseRevision: current.state.revision,
        grants: leaseGrants,
      });
      leaseGrants.forEach(({ leaseId }, index) => {
        this.cachedLeaseSecrets.set(leaseId, proposedMaterials[index]!);
        this.cachedLeaseOwners.set(leaseId, sessionAgentId);
      });
      materialsTransferred = true;
      try {
        await this.ensureGuardForActiveLeases(store, sessionAgentId);
      } catch (error) {
        await this.failClosedSession(store, descriptor);
        throw error;
      }
      this.scheduleLeaseExpiry(store, sessionAgentId);
      const snapshot = this.toPublicSnapshot(store, result.snapshot);
      this.options.emitSnapshot(toSnapshotEvent(snapshot));
      return snapshot;
    } catch (error) {
      throw this.publicError(error);
    } finally {
      if (!materialsTransferred) {
        for (const material of proposedMaterials) material.release();
      }
    }
  }

  private prepareLeaseGrant(
    store: SecureSessionStore,
    profileId: string,
    input: GrantSecureSecretLeaseInput,
    now: string,
  ): {
    secret: SecureSessionSecret;
    bindingIds: string[];
    leaseKind: GrantSecureSecretLeaseInput["leaseKind"];
    expiresAt: string | null;
  } {
    const secret = store.getSecret(input.secretId);
    if (!secret || !isVisibleTo(secret, profileId)) {
      throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    }
    if (
      !["task", "timed", "one_use"].includes(input.leaseKind)
      || (input.leaseKind !== "timed" && "durationSeconds" in input)
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    return {
      secret,
      bindingIds: matchBindingIds(
        store.listBindings(secret.secretId),
        input.exposures,
      ),
      leaseKind: input.leaseKind,
      expiresAt: expiresAt(input, now),
    };
  }

  async revokeSecureSessionLease(
    sessionAgentId: string,
    input: { baseRevision: number; leaseId: string },
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withSessionMutation(sessionAgentId, async () =>
      await this.revokeSecureSessionLeaseUnlocked(sessionAgentId, input)
    );
  }

  private async revokeSecureSessionLeaseUnlocked(
    sessionAgentId: string,
    input: { baseRevision: number; leaseId: string },
  ): Promise<PublicSecureSessionSnapshot> {
    this.requireBuilder(sessionAgentId);
    const store = await this.store();
    try {
      const current = store.getSnapshot(sessionAgentId);
      requireNonFutureRevision(current.state.revision, input.baseRevision);
      const result = store.revokeLease({
        sessionAgentId,
        leaseId: input.leaseId,
        baseRevision: current.state.revision,
        reason: "user",
      });
      this.releaseLeases([input.leaseId]);
      if (result.changed) {
        await this.deactivateEnvironmentAfterLeaseLoss(store, sessionAgentId, true);
      }
      this.scheduleLeaseExpiry(store, sessionAgentId);
      const snapshot = this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId));
      if (result.changed) this.options.emitSnapshot(toSnapshotEvent(snapshot));
      return snapshot;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async resolveSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: ResolveSecureSecretAccessRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () =>
        await this.resolveSecureAccessRequestUnlocked(
          sessionAgentId,
          requestId,
          input,
        )
      )
    );
  }

  private async resolveSecureAccessRequestUnlocked(
    sessionAgentId: string,
    requestId: string,
    input: ResolveSecureSecretAccessRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    if (input.requestId !== requestId) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    const snapshot = store.getSnapshot(sessionAgentId);
    requireRevision(snapshot.state.revision, input.baseRevision);
    const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
    if (!request) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    if (input.decision === "deny") {
      const resolved = store.resolveRequest({ requestId, state: "denied" });
      const result = this.toPublicSnapshot(store, resolved);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    }
    if (!request.secretId) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    const secret = store.getSecret(request.secretId);
    if (!secret || !isVisibleTo(secret, requireProfileId(descriptor))) {
      throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    }
    const bindingIds = matchRequestedBindingIds(
      store.listBindings(secret.secretId),
      request.requestedExposures,
    );
    assertSessionBindingCompatibility(store, snapshot, bindingIds);
    const requiresCleanEnvironment = this.activeSessions.has(sessionAgentId);
    await this.ensureSecureEnvironment(store, descriptor);
    if (requiresCleanEnvironment) {
      await this.rebuildEnvironmentForNewLease(store, descriptor);
    }
    const lease = store.createLease({
      leaseId: this.id(),
      sessionAgentId,
      secretId: secret.secretId,
      requestId,
      bindingIds,
      leaseKind: request.requestedLeaseKind,
      baseRevision: store.getSnapshot(sessionAgentId).state.revision,
      expiresAt: expiresAt({
        leaseKind: request.requestedLeaseKind,
        requestedDurationSeconds: request.requestedDurationSeconds,
      }, this.now()),
    });
    try {
      await this.ensureGuardForActiveLeases(store, sessionAgentId);
    } catch (error) {
      await this.failClosedSession(store, descriptor);
      throw this.publicError(error);
    }
    this.scheduleLeaseExpiry(store, sessionAgentId);
    const result = this.toPublicSnapshot(store, lease.snapshot);
    this.options.emitSnapshot(toSnapshotEvent(result));
    return result;
  }

  async fulfillSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: FulfillSecureAccessRequestInput,
  ): Promise<PublicSecureSessionSnapshot> {
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () =>
        await this.fulfillSecureAccessRequestUnlocked(
          sessionAgentId,
          requestId,
          input,
        )
      )
    );
  }

  private async fulfillSecureAccessRequestUnlocked(
    sessionAgentId: string,
    requestId: string,
    input: FulfillSecureAccessRequestInput,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.requireBuilder(sessionAgentId);
    const store = await this.store();
    const snapshot = store.getSnapshot(sessionAgentId);
    requireRevision(snapshot.state.revision, input.baseRevision);
    const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.secretId !== null || request.displayAlias !== input.displayAlias) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    if (!samePublicBindings(request.requestedExposures.map(toPublicBinding), input.exposures)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    const secretId = this.id();
    let leaseCreated = false;
    try {
      this.ensureLocalProvider(store);
      const created = store.createSecretWithBindings({
        secret: {
          secretId,
          providerId: LOCAL_PROVIDER_ID,
          displayAlias: request.displayAlias,
          scopeKind: "profile",
          profileId: requireProfileId(descriptor),
          retention: "session",
          sourceLocator: `session:${sessionAgentId}`,
          encryptedMaterial,
        },
        bindings: normalizeBindings(input.exposures, this.id.bind(this)),
      });
      assertSessionBindingCompatibility(
        store,
        store.getSnapshot(sessionAgentId),
        created.bindings.map(({ bindingId }) => bindingId),
      );
      const requiresCleanEnvironment = this.activeSessions.has(sessionAgentId);
      await this.ensureSecureEnvironment(store, descriptor);
      if (requiresCleanEnvironment) {
        await this.rebuildEnvironmentForNewLease(store, descriptor);
      }
      store.resolveRequest({
        requestId,
        state: "approved",
        selectedSecretId: secretId,
      });
      const lease = store.createLease({
        leaseId: this.id(),
        sessionAgentId,
        secretId,
        requestId,
        bindingIds: created.bindings.map(({ bindingId }) => bindingId),
        leaseKind: input.leaseKind,
        baseRevision: store.getSnapshot(sessionAgentId).state.revision,
        expiresAt: expiresAt(input, this.now()),
      });
      leaseCreated = true;
      await this.ensureGuardForActiveLeases(store, sessionAgentId);
      this.scheduleLeaseExpiry(store, sessionAgentId);
      this.emitCatalog(store);
      const result = this.toPublicSnapshot(store, lease.snapshot);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    } catch (error) {
      if (leaseCreated) {
        await this.failClosedSession(store, descriptor);
      }
      store.deleteSecret(secretId);
      throw this.publicError(error);
    } finally {
      encryptedMaterial.fill(0);
    }
  }

  async getSecureSessionAgentView(callerAgentId: string): Promise<SecureSessionAgentView> {
    const { manager, profileId } = this.resolveCaller(callerAgentId);
    const store = await this.store();
    const snapshot = await this.getSecureSessionSnapshot(manager.agentId);
    const secrets = this.listPublicSecrets(store).filter((secret) =>
      secret.available
      && (secret.scope.kind === "instance" || secret.scope.profileId === profileId)
    );
    return {
      revision: snapshot.revision,
      executionMode: snapshot.executionMode,
      environmentStatus: snapshot.environmentStatus,
      leases: snapshot.leases.map((lease) => ({
        displayAlias: lease.displayAlias,
        leaseKind: lease.leaseKind,
        exposures: lease.exposures,
        status: lease.status,
        expiresAt: lease.expiresAt,
        lastUsedAt: lease.lastUsedAt,
        remainingUses: lease.remainingUses,
      })),
      pendingRequests: snapshot.pendingRequests.map((request) => ({
        displayAlias: request.displayAlias,
        requestedLeaseKind: request.requestedLeaseKind,
        ...(request.requestedDurationSeconds === undefined
          ? {}
          : { requestedDurationSeconds: request.requestedDurationSeconds }),
        requestedExposures: request.requestedExposures,
        purposeSummary: request.purposeSummary,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      })),
      availableSecrets: secrets.map((secret) => ({
        displayAlias: secret.displayAlias,
        bindings: secret.bindings,
      })),
      updatedAt: snapshot.updatedAt,
    };
  }

  async requestSecureSecretAccess(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSecretAccessInput,
  ): Promise<void> {
    bounded(toolCallId, 256);
    const { caller, manager, profileId } = this.resolveCaller(callerAgentId);
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(manager.agentId, async () => {
        await this.requestSecureSecretAccessUnlocked(
          caller,
          manager,
          profileId,
          input,
        );
      });
    });
  }

  private async requestSecureSecretAccessUnlocked(
    caller: AgentDescriptor,
    manager: AgentDescriptor,
    profileId: string,
    input: RequestSecureSecretAccessInput,
  ): Promise<void> {
    const store = await this.store();
    const matches = store.listSecrets().filter((secret) =>
      secret.displayAlias === input.displayAlias
      && isVisibleTo(secret, profileId)
      && secret.retention === "saved"
    );
    if (matches.length > 1) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    const secret = matches[0] ?? null;
    if (secret) matchBindingIds(store.listBindings(secret.secretId), input.exposures);
    try {
      const snapshot = store.createRequest({
        requestId: this.id(),
        sessionAgentId: manager.agentId,
        secretId: secret?.secretId ?? null,
        displayAlias: bounded(input.displayAlias, 256),
        requestedExposures: input.exposures.map(toStoredExposure),
        requestedLeaseKind: input.leaseKind,
        requestedDurationSeconds: input.leaseKind === "timed"
          ? validateDuration(input.durationSeconds)
          : null,
        purposeSummary: bounded(input.purposeSummary, 2000),
        requestedByAgentId: caller.agentId,
        requestedByDisplayName: bounded(caller.displayName, 256),
        expiresAt: new Date(Date.parse(this.now()) + REQUEST_TTL_MS).toISOString(),
      });
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, snapshot)));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  getSecureRuntimeBinding(descriptor: AgentDescriptor): SecureRuntimeBinding | undefined {
    if (descriptor.role !== "manager" || descriptor.managerId !== descriptor.agentId) return undefined;
    const active = this.activeSessions.get(descriptor.agentId);
    if (!active || active.closed) return undefined;
    return {
      executeBash: (request) => this.executeSecureBash(descriptor, request),
      guardValue: <T>(value: T): T => {
        const current = this.activeSessions.get(descriptor.agentId);
        if (
          !current
          || current.closed
          || (current.guardRequired && !current.guard)
        ) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        if (!current.guard) return value;
        const guarded = current.guard.sanitizeStructured(value);
        return guarded as T;
      },
    };
  }

  async closeSecureSessions(): Promise<void> {
    if (this.closed) return;
    this.closePromise ??= this.performCloseSecureSessions();
    await this.closePromise;
  }

  private async performCloseSecureSessions(): Promise<void> {
    this.closing = true;
    for (const timer of this.leaseExpiryTimers.values()) clearTimeout(timer);
    this.leaseExpiryTimers.clear();

    // Every mutation admitted before `closing` became true owns a tail. Drain
    // those operations before taking the final active-task snapshot so a
    // start/rebuild cannot publish a new container after the shutdown sweep.
    await Promise.allSettled([
      this.authorityMutationTail,
      ...this.sessionMutationTails.values(),
    ]);

    const store = this.storePromise ? await this.storePromise.catch(() => null) : null;
    const activeEntries = [...this.activeSessions.entries()];
    for (const [, active] of activeEntries) active.closed = true;
    await Promise.allSettled(activeEntries.map(async ([sessionAgentId, active]) => {
      await this.options.execution.destroyTask(active.task).catch(() => false);
      try {
        store?.revokeSessionLeases(sessionAgentId, "session_stopped");
      } catch {
        // Continue destroying every remaining task during process shutdown.
      } finally {
        this.releaseSession(sessionAgentId);
      }
    }));
    await Promise.allSettled([...this.bashExecutionTails.values()]);
    const executingSessionIds = [...this.activeExecutionCounts.keys()];
    await Promise.allSettled(
      executingSessionIds.map(async (sessionAgentId) => {
        await this.waitForSessionExecutionsToSettle(sessionAgentId);
      }),
    );
    for (const secret of this.cachedLeaseSecrets.values()) secret.release();
    this.cachedLeaseSecrets.clear();
    this.cachedLeaseOwners.clear();
    this.outputStates.clear();
    await store?.close().catch(() => undefined);
    try {
      this.options.cipher.dispose?.();
    } catch {
      // Shutdown cleanup remains best effort after every task is destroyed.
    }
    this.closed = true;
  }

  private async executeSecureBash(
    descriptor: AgentDescriptor,
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
  ): Promise<{ exitCode: number | null }> {
    return await this.withSessionBashExecution(descriptor.agentId, async () => {
      let executionStarted = false;
      try {
        const prepared = await this.withAuthorityMutation(async () =>
          await this.withSessionMutation(
            descriptor.agentId,
            async () => {
              const result = await this.prepareSecureBashExecution(descriptor, request);
              this.beginSessionExecution(descriptor.agentId);
              executionStarted = true;
              return result;
            },
          )
        );
        return await this.runPreparedSecureBashExecution(descriptor, request, prepared);
      } finally {
        if (executionStarted) {
          this.endSessionExecution(descriptor.agentId);
        }
      }
    });
  }

  private async prepareSecureBashExecution(
    descriptor: AgentDescriptor,
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
  ): Promise<PreparedSecureBashExecution> {
    const sessionAgentId = descriptor.agentId;
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const stored = store.getSnapshot(sessionAgentId);
    const active = this.activeSessions.get(sessionAgentId);
    if (
      stored.state.executionMode !== "secure"
      || stored.state.environmentStatus !== "ready"
      || !active
      || active.closed
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const activeLeases = stored.leases.filter((lease) => lease.state === "active");
    const reserved: ReservedLease[] = [];
    const resolved: ResolvedSecureSecretBinding[] = [];
    try {
      for (const lease of activeLeases) {
        const operationId = this.id();
        const reservation = store.reserveLeaseUse({
          operationId,
          leaseId: lease.leaseId,
          sessionAgentId,
          now: this.now(),
        });
        if (!reservation.reserved) continue;
        reserved.push({ lease, operationId, exposureIds: [] });
      }
      resolved.push(...await this.resolveDeliveries(store, reserved));
      const guard = await this.rebuildGuard(sessionAgentId);
      if (
        guard.sanitizeString(request.command) === SECURE_OUTPUT_QUARANTINE
        || guard.sanitizeString(request.cwd) === SECURE_OUTPUT_QUARANTINE
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      for (const reservation of reserved) {
        for (const bindingId of reservation.lease.bindingIds) {
          const exposureId = this.id();
          store.beginExposure({
            exposureId,
            operationId: reservation.operationId,
            bindingId,
          });
          reservation.exposureIds.push(exposureId);
        }
      }
      return { store, reserved, resolved, guard, active };
    } catch (error) {
      this.completeReservations(
        store,
        reserved,
        request.signal?.aborted ? "cancelled" : "failed",
      );
      if (!(error instanceof SecureSessionsServiceError && error.code === "SECURE_REQUEST_INVALID")) {
        await this.failClosedSession(store, descriptor);
      }
      for (const item of resolved) item.value.fill(0);
      throw this.publicError(error);
    }
  }

  private async runPreparedSecureBashExecution(
    descriptor: AgentDescriptor,
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
    prepared: PreparedSecureBashExecution,
  ): Promise<{ exitCode: number | null }> {
    const sessionAgentId = descriptor.agentId;
    const { store, reserved, resolved, guard, active } = prepared;
    try {
      const delivery = createExecutionDeliveryFromBindings(resolved);
      const rawOutputGuard = guard.createOutputGuard();
      const result = await this.options.execution.execute({
        task: toTask(descriptor),
        command: {
          executable: "/bin/bash",
          args: ["-lc", request.command],
          cwd: request.cwd,
        },
        delivery,
        guardOutput: (input) => rawOutputGuard(input),
        onOutput: ({ bytes }) => request.onData(bytes),
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      });
      if (rawOutputGuard.didQuarantine()) {
        this.outputStates.set(sessionAgentId, {
          outputState: "quarantined",
          outputStateCode: "SECURE_OUTPUT_QUARANTINED",
        });
      }
      const consumedOneUseLease = this.completeReservations(
        store,
        reserved,
        "succeeded",
      );
      if (consumedOneUseLease) {
        await this.deactivateEnvironmentAfterLeaseLoss(
          store,
          sessionAgentId,
          true,
          false,
        );
      }
      this.scheduleLeaseExpiry(store, sessionAgentId);
      this.options.emitSnapshot(toSnapshotEvent(
        this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId)),
      ));
      return { exitCode: result.exitCode };
    } catch (error) {
      this.completeReservations(
        store,
        reserved,
        request.signal?.aborted ? "cancelled" : "failed",
      );
      if (
        !(error instanceof SecureSessionsServiceError && error.code === "SECURE_REQUEST_INVALID")
        && this.activeSessions.get(sessionAgentId) === active
        && !active.closed
      ) {
        await this.failClosedSession(store, descriptor);
      }
      throw this.publicError(error);
    } finally {
      for (const item of resolved) item.value.fill(0);
    }
  }

  private async resolveDeliveries(
    store: SecureSessionStore,
    reserved: ReservedLease[],
  ): Promise<ResolvedSecureSecretBinding[]> {
    const resolved: ResolvedSecureSecretBinding[] = [];
    for (const reservation of reserved) {
      let material = this.cachedLeaseSecrets.get(reservation.lease.leaseId);
      if (!material || material.released) {
        material = await this.resolveLeaseSecret(store, reservation.lease);
        this.cachedLeaseSecrets.set(reservation.lease.leaseId, material);
        this.cachedLeaseOwners.set(
          reservation.lease.leaseId,
          reservation.lease.sessionAgentId,
        );
      }
      const bindings = reservation.lease.bindingIds.map((bindingId) => {
        const binding = store.getBinding(bindingId);
        if (!binding) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        return toPublicBinding(binding);
      });
      await material.withBytes((bytes) => {
        for (const binding of bindings) {
          resolved.push({ binding, value: Buffer.from(bytes) });
        }
      });
    }
    return resolved;
  }

  private async resolveLeaseSecret(
    store: SecureSessionStore,
    lease: SecureSessionLease,
  ): Promise<HostOnlySecret> {
    return await this.resolveSecretMaterial(store, lease.secretId);
  }

  private async resolveSecretMaterial(
    store: SecureSessionStore,
    secretId: string,
  ): Promise<HostOnlySecret> {
    const secret = store.getEncryptedSecret(secretId);
    if (!secret) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    const provider = store.getProvider(secret.providerId);
    if (!provider || !provider.enabled) {
      throw new SecureSessionsServiceError("SECURE_SOURCE_UNAVAILABLE");
    }
    try {
      if (provider.kind === "local_keychain") {
        const resolution = await this.options.localSource.resolve({
          sourceLocator: secret.sourceLocator,
          encryptedMaterial: secret.encryptedMaterial ?? undefined,
        });
        return resolution.material;
      }
      const config = store.getProviderBackendConfig(provider.providerId);
      if (!config) throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
      const resolution = await this.options.bitwardenSource.resolve({
        sourceLocator: secret.sourceLocator,
        encryptedCredential: config.encryptedAccessToken,
        endpointOrigin: config.serverOrigin,
      });
      return resolution.material;
    } catch (error) {
      const next = providerStatusForError(error);
      store.updateProviderStatus({
        providerId: provider.providerId,
        status: next.status,
        lastStatusCode: next.lastStatusCode,
        lastVerifiedAt: this.now(),
      });
      this.emitCatalog(store);
      throw this.publicError(error);
    } finally {
      secret.encryptedMaterial?.fill(0);
    }
  }

  private async rebuildGuard(sessionAgentId: string): Promise<SecureValueGuard> {
    const values: Buffer[] = [];
    try {
      for (const [leaseId, secret] of this.cachedLeaseSecrets) {
        if (this.cachedLeaseOwners.get(leaseId) !== sessionAgentId) continue;
        if (!secret.released) {
          await secret.withBytes((bytes) => values.push(Buffer.from(bytes)));
        }
      }
      const guard = new SecureValueGuard(values);
      const active = this.activeSessions.get(sessionAgentId);
      if (!active) {
        guard.dispose();
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
      active.guard?.dispose();
      active.guard = guard;
      active.guardRequired = true;
      return guard;
    } finally {
      values.forEach((value) => value.fill(0));
    }
  }

  private async ensureGuardForActiveLeases(
    store: SecureSessionStore,
    sessionAgentId: string,
  ): Promise<SecureValueGuard> {
    for (const lease of store.getSnapshot(sessionAgentId).leases) {
      if (lease.state !== "active") continue;
      if (this.cachedLeaseSecrets.has(lease.leaseId)) continue;
      const material = await this.resolveLeaseSecret(store, lease);
      this.cachedLeaseSecrets.set(lease.leaseId, material);
      this.cachedLeaseOwners.set(lease.leaseId, sessionAgentId);
    }
    return await this.rebuildGuard(sessionAgentId);
  }

  private completeReservations(
    store: SecureSessionStore,
    reservations: ReservedLease[],
    outcome: "succeeded" | "failed" | "cancelled",
  ): boolean {
    const exposureOutcome = outcome === "succeeded" ? "completed" : outcome;
    let consumedOneUseLease = false;
    for (const reservation of reservations) {
      for (const exposureId of reservation.exposureIds) {
        try {
          store.closeExposure({ exposureId, outcome: exposureOutcome });
        } catch {
          // Completion continues so one-use claims cannot become reusable.
        }
      }
      try {
        store.completeLeaseUse({ operationId: reservation.operationId, outcome });
      } catch {
        // The environment is failed closed by the caller on unsafe completion.
      }
      if (reservation.lease.leaseKind === "one_use") {
        this.releaseLeases([reservation.lease.leaseId]);
        consumedOneUseLease = true;
      }
    }
    return consumedOneUseLease;
  }

  private async failClosedSession(
    store: SecureSessionStore,
    descriptor: AgentDescriptor,
  ): Promise<void> {
    const destroyed = await this.options.execution
      .destroyTask(toTask(descriptor))
      .catch(() => false);
    store.revokeSessionLeases(descriptor.agentId, "policy_changed");
    this.clearLeaseExpiryTimer(descriptor.agentId);
    this.releaseSession(descriptor.agentId);
    const failed = store.updateSessionRuntimeState({
      sessionAgentId: descriptor.agentId,
      executionMode: "secure",
      environmentStatus: destroyed ? "failed" : "degraded",
    });
    this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, failed.snapshot)));
  }

  private async expireAndPublish(
    store: SecureSessionStore,
    sessionAgentId: string,
  ): Promise<void> {
    for (const mutation of store.expireLeases(this.now(), sessionAgentId)) {
      const activeIds = new Set(
        mutation.snapshot.leases.filter((lease) => lease.state === "active")
          .map((lease) => lease.leaseId),
      );
      const released = mutation.snapshot.leases
        .filter((lease) => !activeIds.has(lease.leaseId))
        .map((lease) => lease.leaseId);
      this.releaseLeases(released);
      await this.deactivateEnvironmentAfterLeaseLoss(
        store,
        mutation.snapshot.state.sessionAgentId,
        true,
      );
      this.scheduleLeaseExpiry(store, mutation.snapshot.state.sessionAgentId);
      this.options.emitSnapshot(toSnapshotEvent(
        this.toPublicSnapshot(
          store,
          store.getSnapshot(mutation.snapshot.state.sessionAgentId),
        ),
      ));
    }
  }

  private async deactivateEnvironmentAfterLeaseLoss(
    store: SecureSessionStore,
    sessionAgentId: string,
    recycleRuntime: boolean,
    waitForExecutions = true,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionAgentId);
    if (!active) {
      this.clearLeaseExpiryTimer(sessionAgentId);
      this.releaseSession(sessionAgentId);
      const state = store.getSnapshot(sessionAgentId).state;
      if (
        state.executionMode === "secure"
        && state.environmentStatus !== "stopped"
        && state.environmentStatus !== "degraded"
      ) {
        store.updateSessionRuntimeState({
          sessionAgentId,
          executionMode: "secure",
          environmentStatus: "stopped",
        });
      }
      return;
    }

    let destroyFailed = false;
    // Publish the teardown boundary before awaiting the provider. An in-flight
    // execution can fail as soon as destruction begins; it must recognize that
    // failure as the expected result of this authority change rather than
    // revoking unrelated leases in a second fail-closed sweep.
    active.closed = true;
    try {
      destroyFailed = !(await this.options.execution.destroyTask(active.task));
    } catch {
      destroyFailed = true;
    }
    this.clearLeaseExpiryTimer(sessionAgentId);
    this.releaseSession(sessionAgentId);
    if (waitForExecutions) {
      await this.waitForSessionExecutionsToSettle(sessionAgentId);
    }
    store.updateSessionRuntimeState({
      sessionAgentId,
      executionMode: "secure",
      environmentStatus: destroyFailed ? "degraded" : "stopped",
    });
    if (recycleRuntime) {
      await Promise.resolve(
        this.options.applyModeRuntimeRecycle(sessionAgentId),
      ).catch(() => undefined);
    }
  }

  private async rebuildEnvironmentForNewLease(
    store: SecureSessionStore,
    descriptor: AgentDescriptor,
  ): Promise<void> {
    const sessionAgentId = descriptor.agentId;
    const active = this.activeSessions.get(sessionAgentId);
    if (!active) return;

    // Retire this exact environment before its process tree is destroyed. A
    // stale runtime binding must fail closed, and an execution completing a
    // one-use lease concurrently must not let this rebuild republish the same
    // now-closed ActiveSession object.
    active.closed = true;
    const destroyed = await this.options.execution
      .destroyTask(active.task)
      .catch(() => false);
    if (this.activeSessions.get(sessionAgentId) === active) {
      this.activeSessions.delete(sessionAgentId);
    }
    await this.waitForSessionExecutionsToSettle(sessionAgentId);
    if (!destroyed) {
      active.guard?.dispose();
      store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: requireProfileId(descriptor),
        executionMode: "secure",
        environmentStatus: "degraded",
      });
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const afterTeardown = store.getSnapshot(sessionAgentId).state;
    if (
      afterTeardown.executionMode !== "secure"
      || afterTeardown.environmentStatus !== "ready"
    ) {
      active.guard?.dispose();
      this.releaseSession(sessionAgentId);
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    try {
      await this.options.execution.ensureTask(active.task);
      active.guard?.dispose();
      this.activeSessions.set(sessionAgentId, {
        task: active.task,
        guard: null,
        guardRequired: true,
        closed: false,
      });
      this.outputStates.set(sessionAgentId, {
        outputState: "clear",
        outputStateCode: null,
      });
      store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: requireProfileId(descriptor),
        executionMode: "secure",
        environmentStatus: "ready",
      });
    } catch (error) {
      await this.options.execution.destroyTask(active.task).catch(() => false);
      active.closed = true;
      active.guard?.dispose();
      this.releaseSession(sessionAgentId);
      store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: requireProfileId(descriptor),
        executionMode: "secure",
        environmentStatus: "failed",
      });
      throw this.publicError(error);
    }
  }

  private beginSessionExecution(sessionAgentId: string): void {
    this.activeExecutionCounts.set(
      sessionAgentId,
      (this.activeExecutionCounts.get(sessionAgentId) ?? 0) + 1,
    );
  }

  private endSessionExecution(sessionAgentId: string): void {
    const next = (this.activeExecutionCounts.get(sessionAgentId) ?? 1) - 1;
    if (next > 0) {
      this.activeExecutionCounts.set(sessionAgentId, next);
      return;
    }
    this.activeExecutionCounts.delete(sessionAgentId);
    const settlers = this.executionSettlers.get(sessionAgentId);
    this.executionSettlers.delete(sessionAgentId);
    for (const settle of settlers ?? []) settle();
  }

  private async waitForSessionExecutionsToSettle(
    sessionAgentId: string,
  ): Promise<void> {
    if (!this.activeExecutionCounts.has(sessionAgentId)) return;
    await new Promise<void>((resolve) => {
      const settlers = this.executionSettlers.get(sessionAgentId) ?? new Set();
      settlers.add(resolve);
      this.executionSettlers.set(sessionAgentId, settlers);
    });
  }

  private async withSessionMutation<T>(
    sessionAgentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.closed) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const previous = this.sessionMutationTails.get(sessionAgentId)
      ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.sessionMutationTails.set(sessionAgentId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionMutationTails.get(sessionAgentId) === tail) {
        this.sessionMutationTails.delete(sessionAgentId);
      }
    }
  }

  private async withSessionBashExecution<T>(
    sessionAgentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.closed) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const previous = this.bashExecutionTails.get(sessionAgentId)
      ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.bashExecutionTails.set(sessionAgentId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.bashExecutionTails.get(sessionAgentId) === tail) {
        this.bashExecutionTails.delete(sessionAgentId);
      }
    }
  }

  private async withSessionMutations<T>(
    sessionAgentIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const orderedIds = [...new Set(sessionAgentIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const sessionAgentId = orderedIds[index];
      if (sessionAgentId === undefined) return await operation();
      return await this.withSessionMutation(
        sessionAgentId,
        async () => await acquire(index + 1),
      );
    };
    return await acquire(0);
  }

  private async withAuthorityMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const previous = this.authorityMutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.authorityMutationTail = tail;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private scheduleLeaseExpiry(
    store: SecureSessionStore,
    sessionAgentId: string,
  ): void {
    this.clearLeaseExpiryTimer(sessionAgentId);
    if (this.closing || this.closed || !this.activeSessions.has(sessionAgentId)) {
      return;
    }
    const expirations = store.getSnapshot(sessionAgentId).leases
      .filter((lease) => lease.state === "active" && lease.expiresAt !== null)
      .map((lease) => Date.parse(lease.expiresAt!))
      .filter(Number.isFinite);
    if (expirations.length === 0) {
      return;
    }
    const nextExpiration = Math.min(...expirations);
    const delayMs = Math.max(
      0,
      Math.min(2_147_483_647, nextExpiration - Date.parse(this.now())),
    );
    const timer = setTimeout(() => {
      if (this.leaseExpiryTimers.get(sessionAgentId) !== timer) {
        return;
      }
      this.leaseExpiryTimers.delete(sessionAgentId);
      void this.expireTimedLeasesFromTimer(sessionAgentId);
    }, delayMs);
    timer.unref?.();
    this.leaseExpiryTimers.set(sessionAgentId, timer);
  }

  private async expireTimedLeasesFromTimer(sessionAgentId: string): Promise<void> {
    if (this.closing || this.closed) return;
    try {
      const store = await this.store();
      await this.withSessionMutation(sessionAgentId, async () => {
        await this.expireAndPublish(store, sessionAgentId);
        this.scheduleLeaseExpiry(store, sessionAgentId);
      });
    } catch {
      const active = this.activeSessions.get(sessionAgentId);
      if (active) {
        await this.options.execution.destroyTask(active.task).catch(() => false);
        this.releaseSession(sessionAgentId);
      }
    }
  }

  private clearLeaseExpiryTimer(sessionAgentId: string): void {
    const timer = this.leaseExpiryTimers.get(sessionAgentId);
    if (timer) clearTimeout(timer);
    this.leaseExpiryTimers.delete(sessionAgentId);
  }

  private toPublicSnapshot(
    store: SecureSessionStore,
    snapshot: StoredSnapshot,
  ): PublicSecureSessionSnapshot {
    const outputState = this.outputStates.get(snapshot.state.sessionAgentId) ?? {
      outputState: "clear" as const,
      outputStateCode: null,
    };
    return {
      sessionAgentId: snapshot.state.sessionAgentId,
      profileId: snapshot.state.profileId,
      revision: snapshot.state.revision,
      executionMode: snapshot.state.executionMode,
      environmentStatus: snapshot.state.environmentStatus,
      leases: snapshot.leases.map((lease) => {
        const secret = store.getSecret(lease.secretId);
        return {
          leaseId: lease.leaseId,
          secretId: lease.secretId,
          displayAlias: secret?.displayAlias ?? "unavailable",
          leaseKind: lease.leaseKind,
          exposures: lease.bindingIds.map((bindingId) => {
            const binding = store.getBinding(bindingId);
            if (!binding) throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            return toPublicBinding(binding);
          }),
          status: lease.state,
          expiresAt: lease.expiresAt,
          lastUsedAt: lease.lastUsedAt,
          remainingUses: lease.remainingUses,
        };
      }),
      pendingRequests: snapshot.requests.map((request) => ({
        requestId: request.requestId,
        secretId: request.secretId,
        displayAlias: request.displayAlias,
        requestedLeaseKind: request.requestedLeaseKind,
        ...(request.requestedDurationSeconds === null
          ? {}
          : { requestedDurationSeconds: request.requestedDurationSeconds }),
        requestedExposures: request.requestedExposures.map(toPublicBinding),
        purposeSummary: request.purposeSummary,
        requestedByAgentId: request.requestedByAgentId,
        requestedByDisplayName: request.requestedByDisplayName,
        createdAt: request.requestedAt,
        expiresAt: request.expiresAt,
      })),
      updatedAt: snapshot.state.updatedAt,
      ...outputState,
    } as PublicSecureSessionSnapshot;
  }

  private listPublicSecrets(store: SecureSessionStore): SecureSecretSummary[] {
    return store.listSecrets()
      .filter((secret) => secret.retention === "saved")
      .map((secret) => this.toSecretSummary(store, secret));
  }

  private toSecretSummary(
    store: SecureSessionStore,
    secret: SecureSessionSecret,
  ): SecureSecretSummary {
    const provider = store.getProvider(secret.providerId);
    return {
      secretId: secret.secretId,
      providerId: secret.providerId,
      displayAlias: secret.displayAlias,
      displayName: secret.displayName,
      scope: toPublicScope(secret),
      retention: secret.retention,
      bindings: store.listBindings(secret.secretId).map(toPublicBinding),
      available: Boolean(provider?.enabled && provider.status === "available"),
      updatedAt: secret.updatedAt,
    };
  }

  private resolveCaller(callerAgentId: string): {
    caller: AgentDescriptor;
    manager: AgentDescriptor;
    profileId: string;
  } {
    const caller = this.options.getDescriptor(callerAgentId);
    if (!caller) throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    const managerId = caller.role === "manager" ? caller.agentId : caller.managerId;
    const manager = this.requireBuilder(managerId);
    return { caller, manager, profileId: requireProfileId(manager) };
  }

  private requireBuilder(sessionAgentId: string): AgentDescriptor {
    try {
      const descriptor = this.options.requireBuilderSession(
        sessionAgentId,
        "use Secure Sessions",
      );
      if (
        descriptor.role !== "manager"
        || descriptor.managerId !== descriptor.agentId
        || !descriptor.profileId
      ) {
        throw new Error("not builder");
      }
      return descriptor;
    } catch {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
  }

  private ensureLocalProvider(store: SecureSessionStore): SecureSessionProvider {
    return store.getProvider(LOCAL_PROVIDER_ID) ?? store.upsertProvider({
      providerId: LOCAL_PROVIDER_ID,
      kind: "local_keychain",
      displayName: "Local secure vault",
      enabled: true,
      status: "available",
      lastStatusCode: "ok",
    });
  }

  private emitCatalog(store: SecureSessionStore): void {
    this.options.emitCatalogChanged({
      type: "secure_secret_catalog_changed",
      revision: store.getCatalogState().revision,
    });
  }

  private releaseSession(sessionAgentId: string): void {
    const active = this.activeSessions.get(sessionAgentId);
    if (active) active.closed = true;
    active?.guard?.dispose();
    this.activeSessions.delete(sessionAgentId);
    for (const [leaseId, secret] of this.cachedLeaseSecrets) {
      if (this.cachedLeaseOwners.get(leaseId) !== sessionAgentId) continue;
      secret.release();
      this.cachedLeaseSecrets.delete(leaseId);
      this.cachedLeaseOwners.delete(leaseId);
    }
  }

  private releaseLeases(leaseIds: readonly string[]): void {
    for (const leaseId of leaseIds) {
      this.cachedLeaseSecrets.get(leaseId)?.release();
      this.cachedLeaseSecrets.delete(leaseId);
      this.cachedLeaseOwners.delete(leaseId);
    }
  }

  private deleteSessionSecrets(store: SecureSessionStore, sessionAgentId: string): boolean {
    let changed = false;
    for (const secret of store.listSecrets()) {
      const encrypted = store.getEncryptedSecret(secret.secretId);
      if (
        secret.retention === "session"
        && encrypted?.sourceLocator === `session:${sessionAgentId}`
      ) {
        store.deleteSecret(secret.secretId);
        changed = true;
      }
      encrypted?.encryptedMaterial?.fill(0);
    }
    return changed;
  }

  private async deactivateAffectedSessions(
    store: SecureSessionStore,
    sessionIds: readonly string[],
  ): Promise<void> {
    for (const sessionAgentId of new Set(sessionIds)) {
      await this.deactivateEnvironmentAfterLeaseLoss(store, sessionAgentId, true);
      this.scheduleLeaseExpiry(store, sessionAgentId);
    }
  }

  private captureAffectedLeases(
    store: SecureSessionStore,
    secretIds: readonly string[],
  ): { leaseIds: string[]; sessionIds: string[] } {
    const wanted = new Set(secretIds);
    const leaseIds: string[] = [];
    const sessionIds: string[] = [];
    for (const sessionAgentId of this.activeSessions.keys()) {
      const matches = store.getSnapshot(sessionAgentId).leases
        .filter((lease) =>
          lease.state === "active" && wanted.has(lease.secretId)
        );
      if (matches.length === 0) continue;
      sessionIds.push(sessionAgentId);
      leaseIds.push(...matches.map((lease) => lease.leaseId));
    }
    return { leaseIds, sessionIds };
  }

  private emitSessionSnapshots(store: SecureSessionStore, sessionIds: readonly string[]): void {
    for (const sessionAgentId of new Set(sessionIds)) {
      this.options.emitSnapshot(toSnapshotEvent(
        this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId)),
      ));
    }
  }

  private async ensureSecureEnvironment(
    store: SecureSessionStore,
    descriptor: AgentDescriptor,
    options: { emitSnapshot?: boolean } = {},
  ): Promise<void> {
    const state = store.getSnapshot(descriptor.agentId).state;
    const active = this.activeSessions.get(descriptor.agentId);
    if (active?.closed) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    if (
      state.executionMode === "secure"
      && state.environmentStatus === "ready"
      && active
    ) {
      return;
    }
    await this.startSecureSessionUnlocked(descriptor.agentId, {
      baseRevision: state.revision,
    }, options);
  }

  private async store(): Promise<SecureSessionStore> {
    if (this.closed) throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    this.storePromise ??= this.options.storeFactory();
    try {
      return await this.storePromise;
    } catch {
      this.storePromise = null;
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
  }

  private publicError(error: unknown): SecureSessionsServiceError {
    if (error instanceof SecureSessionsServiceError) return error;
    if (error instanceof SecureSessionRevisionConflictError) {
      return new SecureSessionsServiceError("SECURE_STALE_REVISION");
    }
    if (error instanceof SecureSourceError) {
      return new SecureSessionsServiceError(sourcePublicCode(error.code));
    }
    return new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }

  private id(): string {
    return this.options.createId?.() ?? randomUUID();
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function toProviderSummary(provider: SecureSessionProvider): SecureSecretProviderSummary {
  return {
    providerId: provider.providerId,
    kind: provider.kind,
    displayName: provider.displayName,
    enabled: provider.enabled,
    status: provider.status,
    lastVerifiedAt: provider.lastVerifiedAt,
    lastStatusCode: provider.lastStatusCode,
  };
}

function toSnapshotEvent(snapshot: PublicSecureSessionSnapshot): SecureSessionSnapshotEvent {
  return { type: "secure_session_snapshot", ...snapshot };
}

function toTask(descriptor: AgentDescriptor): SecureExecutionTask {
  return { taskId: descriptor.agentId, workspacePath: descriptor.cwd };
}

function requireProfileId(descriptor: AgentDescriptor): string {
  if (!descriptor.profileId) throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
  return descriptor.profileId;
}

function requireRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new SecureSessionsServiceError("SECURE_STALE_REVISION");
}

function requireNonFutureRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > actual) {
    throw new SecureSessionsServiceError("SECURE_STALE_REVISION");
  }
}

function bounded(value: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximum
    || value.includes("\0")
  ) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return value.trim();
}

function optionalBounded(value: string | null | undefined, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return bounded(value, maximum);
}

function decodeCiphertext(value: string): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0
    || decoded.byteLength > MAX_CIPHERTEXT_BYTES
    || decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return decoded;
}

function normalizeHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
}

function toStoredScope(scope: CreateLocalSecureSecretInput["scope"]): {
  scopeKind: "instance" | "profile";
  profileId: string | null;
} {
  if (!scope || scope.kind === "instance") return { scopeKind: "instance", profileId: null };
  return { scopeKind: "profile", profileId: bounded(scope.profileId, 256) };
}

function toPublicScope(secret: Pick<SecureSessionSecret, "scopeKind" | "profileId">):
  SecureSecretSummary["scope"] {
  return secret.scopeKind === "instance"
    ? { kind: "instance" }
    : { kind: "profile", profileId: secret.profileId ?? "" };
}

function defaultSecureSecretBinding(
  secretId: string,
  displayAlias: string,
): SecureSecretBinding {
  const readableAlias = displayAlias
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "VALUE";
  const stableSuffix = secretId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(-10) || "SECRET";
  return {
    deliveryKind: "environment",
    targetName: `FORGE_SECRET_${readableAlias}_${stableSuffix}`,
  };
}

function normalizeBindings(
  bindings: readonly SecureSecretBinding[],
  id: () => string,
): Array<{
  bindingId: string;
  deliveryKind: StoredBinding["deliveryKind"];
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
}> {
  if (bindings.length > 16) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  const seen = new Set<string>();
  return bindings.map((binding) => {
    validateBinding(binding);
    const key = bindingCollisionKey(binding);
    if (seen.has(key)) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    seen.add(key);
    return {
      bindingId: id(),
      deliveryKind: binding.deliveryKind,
      targetName: "targetName" in binding ? binding.targetName : null,
      targetPath: "targetPath" in binding ? binding.targetPath : null,
      fileMode: binding.deliveryKind === "file" ? binding.fileMode ?? 0o400 : null,
    };
  });
}

function toBindingInput(binding: StoredBinding): {
  bindingId: string;
  deliveryKind: StoredBinding["deliveryKind"];
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
} {
  return {
    bindingId: binding.bindingId,
    deliveryKind: binding.deliveryKind,
    targetName: binding.targetName,
    targetPath: binding.targetPath,
    fileMode: binding.fileMode,
  };
}

function validateBinding(binding: SecureSecretBinding): void {
  if (binding.deliveryKind === "ssh_agent") {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  if (binding.deliveryKind === "environment" || binding.deliveryKind === "askpass") {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(binding.targetName)
      || SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES.includes(
        binding.targetName as (typeof SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES)[number],
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
  }
  if (binding.deliveryKind === "file") {
    if (
      !binding.targetPath.startsWith(SECURE_FILE_ROOT)
      || binding.targetPath.includes("/../")
      || ![undefined, 0o400, 0o600].includes(binding.fileMode)
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
  }
}

function toPublicBinding(
  binding: StoredBinding | SecureSessionRequestedExposure,
): SecureSecretBinding {
  switch (binding.deliveryKind) {
    case "environment":
    case "askpass":
      return { deliveryKind: binding.deliveryKind, targetName: binding.targetName ?? "" };
    case "file":
      return {
        deliveryKind: "file",
        targetPath: binding.targetPath ?? "",
        ...(binding.fileMode === null ? {} : { fileMode: binding.fileMode }),
      };
    case "stdin":
      return { deliveryKind: "stdin" };
    case "ssh_agent":
      return { deliveryKind: "ssh_agent" };
  }
}

function toStoredExposure(binding: SecureSecretBinding): {
  deliveryKind: StoredBinding["deliveryKind"];
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
} {
  validateBinding(binding);
  return {
    deliveryKind: binding.deliveryKind,
    targetName: "targetName" in binding ? binding.targetName : null,
    targetPath: "targetPath" in binding ? binding.targetPath : null,
    fileMode: binding.deliveryKind === "file" ? binding.fileMode ?? 0o400 : null,
  };
}

function matchBindingIds(
  stored: readonly StoredBinding[],
  requested: readonly SecureSecretBinding[],
): string[] {
  if (requested.length < 1) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  const available = new Map(stored.map((binding) => [bindingKey(toPublicBinding(binding)), binding]));
  const seen = new Set<string>();
  return requested.map((binding) => {
    validateBinding(binding);
    const collisionKey = bindingCollisionKey(binding);
    if (seen.has(collisionKey)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    seen.add(collisionKey);
    const match = available.get(bindingKey(binding));
    if (!match) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    return match.bindingId;
  });
}

function matchRequestedBindingIds(
  stored: readonly StoredBinding[],
  requested: readonly SecureSessionRequestedExposure[],
): string[] {
  return matchBindingIds(stored, requested.map(toPublicBinding));
}

function assertSessionBindingCompatibility(
  store: SecureSessionStore,
  snapshot: StoredSnapshot,
  requestedBindingIds: readonly string[],
): void {
  assertSessionBindingCompatibilityForBatch(store, snapshot, [requestedBindingIds]);
}

function assertSessionBindingCompatibilityForBatch(
  store: SecureSessionStore,
  snapshot: StoredSnapshot | undefined,
  requestedBindingGroups: readonly (readonly string[])[],
): void {
  const activeKeys = new Set<string>();
  for (const lease of snapshot?.leases ?? []) {
    if (lease.state !== "active") continue;
    for (const bindingId of lease.bindingIds) {
      const binding = store.getBinding(bindingId);
      if (binding) {
        activeKeys.add(bindingCollisionKey(toPublicBinding(binding)));
      }
    }
  }
  for (const requestedBindingIds of requestedBindingGroups) {
    for (const bindingId of requestedBindingIds) {
      const binding = store.getBinding(bindingId);
      if (!binding) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      const key = bindingCollisionKey(toPublicBinding(binding));
      if (activeKeys.has(key)) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      activeKeys.add(key);
    }
  }
}

function bindingKey(binding: SecureSecretBinding): string {
  switch (binding.deliveryKind) {
    case "environment":
    case "askpass":
      return `${binding.deliveryKind}:${binding.targetName}`;
    case "file":
      return `file:${binding.targetPath}:${binding.fileMode ?? 0o400}`;
    case "stdin":
    case "ssh_agent":
      return binding.deliveryKind;
  }
}

function bindingCollisionKey(binding: SecureSecretBinding): string {
  switch (binding.deliveryKind) {
    case "environment":
    case "askpass":
      return `environment-name:${binding.targetName}`;
    case "file":
      return `file-path:${binding.targetPath}`;
    case "stdin":
    case "ssh_agent":
      return binding.deliveryKind;
  }
}

function samePublicBindings(
  left: readonly SecureSecretBinding[],
  right: readonly SecureSecretBinding[],
): boolean {
  return left.length === right.length
    && left.every((binding, index) => bindingKey(binding) === bindingKey(right[index]!));
}

function isVisibleTo(secret: SecureSessionSecret, profileId: string): boolean {
  return secret.scopeKind === "instance" || secret.profileId === profileId;
}

function expiresAt(
  input: { leaseKind: string; durationSeconds?: number | null; requestedDurationSeconds?: number | null },
  now: string,
): string | null {
  const duration = input.leaseKind === "timed"
    ? validateDuration(input.durationSeconds ?? input.requestedDurationSeconds)
    : null;
  return duration === null ? null : new Date(Date.parse(now) + duration * 1000).toISOString();
}

function validateDuration(value: number | null | undefined): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > SECURE_SECRET_MAX_TIMED_LEASE_SECONDS
  ) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return value as number;
}

function sourcePublicCode(code: SecureSourceError["code"]): SecureSessionsServiceErrorCode {
  switch (code) {
    case "SECURE_SOURCE_LOCKED":
      return "SECURE_SOURCE_LOCKED";
    case "SECURE_SOURCE_AUTH_REQUIRED":
      return "SECURE_PROVIDER_AUTH_REQUIRED";
    case "SECURE_SOURCE_NOT_FOUND":
      return "SECURE_SECRET_NOT_FOUND";
    case "SECURE_SOURCE_UNAVAILABLE":
    case "SECURE_SOURCE_TIMEOUT":
    case "SECURE_SOURCE_RESPONSE_INVALID":
      return "SECURE_SOURCE_UNAVAILABLE";
    default:
      return "SECURE_OPERATION_FAILED";
  }
}

function providerStatusForError(error: unknown): {
  status: SecureSessionProvider["status"];
  lastStatusCode: SecureSessionProvider["lastStatusCode"];
} {
  if (error instanceof SecureSourceError) {
    switch (error.code) {
      case "SECURE_SOURCE_LOCKED":
        return { status: "locked", lastStatusCode: "source_locked" };
      case "SECURE_SOURCE_AUTH_REQUIRED":
        return { status: "auth_required", lastStatusCode: "provider_auth_required" };
      case "SECURE_SOURCE_NOT_FOUND":
        return { status: "missing", lastStatusCode: "source_missing" };
      case "SECURE_SOURCE_UNAVAILABLE":
      case "SECURE_SOURCE_TIMEOUT":
        return { status: "unreachable", lastStatusCode: "source_unreachable" };
      default:
        return { status: "unreachable", lastStatusCode: "provider_error" };
    }
  }
  return { status: "unreachable", lastStatusCode: "provider_error" };
}
