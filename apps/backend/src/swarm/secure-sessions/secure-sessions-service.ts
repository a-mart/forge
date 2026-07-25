import { randomUUID } from "node:crypto";
import type {
  AgentDescriptor,
  GrantSecureSecretLeaseInput,
  GrantSecureSecretLeaseRequest,
  GrantSecureSecretLeasesRequest,
  ResolveSecureSecretAccessRequest,
  SecureSecretBinding,
  SecureSecretCatalogChangedEvent,
  SecureSecretProjectDefaultSummary,
  SecureSecretProviderSummary,
  SecureSecretProviderTestResult,
  SecureSecretSummary,
  SecureSessionReadiness,
  SecureSessionProjectDefaultStatus,
  SecureSessionSnapshot as PublicSecureSessionSnapshot,
  SecureSessionSnapshotEvent,
} from "@forge/protocol";
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
} from "@forge/protocol";
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
  ApplySecureSessionProjectDefaultsInput,
  ImportBitwardenSecureSecretInput,
  ConnectBitwardenSecureSecretProviderInput,
  CreateLocalSecureSecretInput,
  RequestSecureSecretAccessInput,
  SecureSessionAgentView,
  StartSecureSessionInput,
  StopSecureSessionInput,
  TeardownWorkerSecurePrincipalOptions,
  UpdateBitwardenSecureSecretProviderCredentialInput,
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
  SecureSessionAliasConflictError,
  SecureSessionRequestExpiredError,
  SecureSessionRevisionConflictError,
  SecureSessionStore,
} from "./storage/secure-session-store.js";
import { isExternalThreadDescriptor } from "../external-thread-compatibility.js";
import { isCodexPluginWorkerDescriptor } from "../codex-app-server/codex-plugin-scope-service.js";
import type {
  SecureSessionBinding as StoredBinding,
  SecureSessionLease,
  SecureSessionProvider,
  SecureSessionRequest,
  SecureSessionRequestedExposure,
  SecureSessionSecret,
  SecureSessionSnapshot as StoredSnapshot,
  SecureSessionState,
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
  listDescriptors: () => Iterable<AgentDescriptor>;
  hasProfile: (profileId: string) => boolean;
  isProfileArchived: (profileId: string) => boolean;
  isSessionArchived: (agentId: string) => boolean;
  requireBuilderSession: (agentId: string, action: string) => AgentDescriptor;
  emitSnapshot: (event: SecureSessionSnapshotEvent) => void;
  emitCatalogChanged: (event: SecureSecretCatalogChangedEvent) => void;
  applyModeRuntimeRecycle: (
    sessionAgentId: string,
  ) => Promise<"recycled" | "deferred" | "none"> | "recycled" | "deferred" | "none";
  createValueGuard?: (values: readonly Uint8Array[]) => SecureValueGuard;
  now?: () => string;
  createId?: () => string;
}

interface ActiveSession {
  task: SecureExecutionTask;
  guard: SecureValueGuard | null;
  guardRequired: boolean;
  closed: boolean;
}

interface SecureRuntimeBindingIdentity {
  active: ActiveSession;
  workerAssignmentId: string | null;
  runtimeToken?: number;
  revoked: boolean;
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

interface PreparedProjectDefault {
  secretId: string;
  displayAlias: string;
  leaseId: string;
  bindingIds: string[];
  material: HostOnlySecret;
}

interface SecureSessionLifecycleFence {
  fenceId: string;
  profileId: string;
  sessionAgentIds: ReadonlySet<string>;
}

interface SecurePrincipal {
  descriptor: AgentDescriptor;
  manager: AgentDescriptor;
  profileId: string;
  principalKind: "manager" | "worker";
  workerAssignmentId: string | null;
}

export class SecureSessionsService {
  private storePromise: Promise<SecureSessionStore> | null = null;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly cachedLeaseSecrets = new Map<string, HostOnlySecret>();
  private readonly cachedLeaseOwners = new Map<string, string>();
  private readonly outputStates = new Map<string, SecureOutputState>();
  private readonly projectDefaultStatuses = new Map<
    string,
    Map<string, SecureSessionProjectDefaultStatus>
  >();
  private readonly leaseExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeExecutionCounts = new Map<string, number>();
  private readonly executionSettlers = new Map<string, Set<() => void>>();
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  private readonly bashExecutionTails = new Map<string, Promise<void>>();
  private readonly lifecycleFences = new Map<string, SecureSessionLifecycleFence>();
  private authorityMutationTail: Promise<void> = Promise.resolve();
  private startupRecoveryPromise: Promise<SecureOrphanRecoveryResult> | null = null;
  private startupRecoveryResult: SecureOrphanRecoveryResult | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(private readonly options: SecureSessionsServiceOptions) {}

  isTeamSecureMode(managerAgentId: string): boolean {
    const descriptor = this.options.getDescriptor(managerAgentId);
    if (!isBuilderManager(descriptor)) return false;
    const active = this.activeSessions.get(managerAgentId);
    return Boolean(active && !active.closed);
  }

  async listSecureSessionTeamSnapshots(
    managerAgentId: string,
  ): Promise<PublicSecureSessionSnapshot[]> {
    const manager = this.requireTeamManager(managerAgentId);
    const store = await this.store();
    const snapshots: PublicSecureSessionSnapshot[] = [];
    for (const stored of store.listPrincipalSnapshotsForManager(manager.agentId)) {
      const descriptor = this.options.getDescriptor(stored.state.sessionAgentId);
      if (!descriptor) continue;
      this.resolveSecurePrincipal(descriptor.agentId, {
        requireWorkerAssignment: false,
      });
      snapshots.push(this.toPublicSnapshot(store, stored));
    }
    return snapshots;
  }

  async prepareWorkerForSecureTeam(workerAgentId: string): Promise<boolean> {
    const descriptor = this.options.getDescriptor(workerAgentId);
    if (!descriptor || !this.isEligibleSecureWorker(descriptor)) return false;
    if (!this.isTeamSecureMode(descriptor.managerId)) return false;
    const principal = this.resolveSecurePrincipal(workerAgentId, {
      requireWorkerAssignment: false,
    });
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(workerAgentId, async () => {
        const store = await this.store();
        const existing = store.getSessionState(workerAgentId);
        const state = existing
          ?? store.initializePrincipalState(
            workerAgentId,
            principalStateInput(principal),
          );
        assertPrincipalOwnerMatches(principal, state);
        if (
          existing
          && state.workerAssignmentId !== principal.workerAssignmentId
        ) {
          return;
        }
        await this.startSecurePrincipalUnlocked(principal, {}, {
          recycleRuntime: false,
        });
      });
    });
    return true;
  }

  async advanceWorkerSecureAssignment(
    workerAgentId: string,
    assignmentId: string,
  ): Promise<void> {
    const normalizedAssignmentId = bounded(assignmentId, 256);
    const descriptor = this.options.getDescriptor(workerAgentId);
    if (!descriptor || !this.isEligibleSecureWorker(descriptor)) return;
    if (!this.isTeamSecureMode(descriptor.managerId)) return;
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(workerAgentId, async () => {
        const principal = this.resolveSecurePrincipal(workerAgentId, {
          requireWorkerAssignment: false,
        });
        if (principal.workerAssignmentId !== normalizedAssignmentId) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        const store = await this.store();
        let before = store.getSessionState(workerAgentId)
          ?? store.initializePrincipalState(
            workerAgentId,
            principalStateInput(principal),
          );
        if (
          before.principalKind !== "worker"
          || before.ownerManagerAgentId !== principal.manager.agentId
          || before.profileId !== principal.profileId
        ) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        if (
          before.workerAssignmentId === null
          && before.executionMode === "standard"
        ) {
          await this.startUnassignedWorkerPrincipalUnlocked(
            { ...principal, workerAssignmentId: null },
            {},
            { recycleRuntime: false },
          );
          before = store.getSessionState(workerAgentId)!;
        }
        if (before.workerAssignmentId === normalizedAssignmentId) {
          if (
            !this.activeSessions.has(workerAgentId)
            && before.environmentStatus !== "ready"
          ) {
            await this.startSecurePrincipalUnlocked(principal, {}, {
              recycleRuntime: false,
            });
          }
          return;
        }

        const oldActive = this.activeSessions.get(workerAgentId);
        const oldTask = oldActive?.task
          ?? (before.workerAssignmentId
            ? toTask(principal.descriptor, before.workerAssignmentId)
            : undefined);
        if (oldActive) oldActive.closed = true;
        let destroyed = true;
        if (
          oldActive
          || before.environmentStatus !== "stopped"
        ) {
          destroyed = oldTask
            ? await this.options.execution.destroyTask(oldTask).catch(() => false)
            : false;
        }
        this.releaseSession(workerAgentId);
        await this.waitForSessionExecutionsToSettle(workerAgentId);
        if (!destroyed) {
          const degraded = store.updateSessionRuntimeState({
            sessionAgentId: workerAgentId,
            executionMode: "secure",
            environmentStatus: "degraded",
          });
          this.options.emitSnapshot(toSnapshotEvent(
            this.toPublicSnapshot(store, degraded.snapshot),
          ));
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }

        const previousActiveLeaseIds = new Set(
          store.getSnapshot(workerAgentId).leases
            .filter((lease) => lease.state === "active")
            .map((lease) => lease.leaseId),
        );
        const advanced = store.updateWorkerAssignment({
          sessionAgentId: workerAgentId,
          workerAssignmentId: normalizedAssignmentId,
        });
        const currentActiveLeaseIds = new Set(
          advanced.snapshot.leases
            .filter((lease) => lease.state === "active")
            .map((lease) => lease.leaseId),
        );
        this.releaseLeases(
          [...previousActiveLeaseIds].filter((leaseId) => !currentActiveLeaseIds.has(leaseId)),
        );

        const task = toTask(descriptor, normalizedAssignmentId);
        try {
          await this.options.execution.ensureTask(task);
          this.activeSessions.set(workerAgentId, {
            task,
            guard: null,
            guardRequired: advanced.snapshot.leases.some((lease) => lease.state === "active"),
            closed: false,
          });
          this.outputStates.set(workerAgentId, {
            outputState: "clear",
            outputStateCode: null,
          });
          const ready = store.updateSessionRuntimeState({
            sessionAgentId: workerAgentId,
            executionMode: "secure",
            environmentStatus: "ready",
          });
          if (ready.snapshot.leases.some((lease) => lease.state === "active")) {
            await this.ensureGuardForActiveLeases(store, workerAgentId);
          }
          this.scheduleLeaseExpiry(store, workerAgentId);
          this.options.emitSnapshot(toSnapshotEvent(
            this.toPublicSnapshot(store, ready.snapshot),
          ));
        } catch (error) {
          await this.options.execution.destroyTask(task).catch(() => false);
          await this.failClosedSession(store, descriptor);
          throw this.publicError(error);
        }
      });
    });
  }

  async abortWorkerSecureAssignment(
    workerAgentId: string,
    assignmentId: string,
  ): Promise<void> {
    const normalizedAssignmentId = bounded(assignmentId, 256);
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(workerAgentId, async () => {
        const store = await this.store();
        const state = store.listSessionStates().find(
          (candidate) => candidate.sessionAgentId === workerAgentId,
        );
        if (
          !state
          || state.principalKind !== "worker"
          || state.workerAssignmentId !== normalizedAssignmentId
        ) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        const descriptor = this.options.getDescriptor(workerAgentId);
        const active = this.activeSessions.get(workerAgentId);
        const task = active?.task
          ?? (descriptor
            ? toTask(descriptor, normalizedAssignmentId)
            : undefined);
        if (!task || task.taskId !== workerTaskId(workerAgentId, normalizedAssignmentId)) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        if (active) active.closed = true;
        const destroyed = await this.options.execution
          .destroyTask(task)
          .catch(() => false);
        this.releaseSession(workerAgentId);
        await this.waitForSessionExecutionsToSettle(workerAgentId);
        this.clearLeaseExpiryTimer(workerAgentId);
        this.outputStates.delete(workerAgentId);
        this.projectDefaultStatuses.delete(workerAgentId);
        const runtime = store.updateSessionRuntimeState({
          sessionAgentId: workerAgentId,
          executionMode: "secure",
          environmentStatus: destroyed ? "stopped" : "degraded",
        });
        this.options.emitSnapshot(
          toSnapshotEvent(this.toPublicSnapshot(store, runtime.snapshot)),
        );
        if (!destroyed) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
      });
    });
  }

  async teardownWorkerSecurePrincipal(
    workerAgentId: string,
    options: TeardownWorkerSecurePrincipalOptions = {},
  ): Promise<void> {
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(workerAgentId, async () => {
        const store = await this.store();
        const state = store.listSessionStates().find(
          (candidate) => candidate.sessionAgentId === workerAgentId,
        );
        if (!state || state.principalKind !== "worker") return;
        const descriptor = this.options.getDescriptor(workerAgentId);
        const active = this.activeSessions.get(workerAgentId);
        const hasRuntimeEvidence = Boolean(
          active
          || state.executionMode === "secure"
          || state.environmentStatus !== "stopped",
        );
        const task = active?.task
          ?? (descriptor && hasRuntimeEvidence && state.workerAssignmentId
            ? toTask(descriptor, state.workerAssignmentId)
            : undefined);
        if (active) active.closed = true;
        const destroyed = task
          ? await this.options.execution.destroyTask(task).catch(() => false)
          : !hasRuntimeEvidence;
        this.releaseSession(workerAgentId);
        await this.waitForSessionExecutionsToSettle(workerAgentId);
        if (options.preservePendingRequests !== true) {
          for (const request of store.getSnapshot(workerAgentId).requests) {
            store.resolveRequest({
              requestId: request.requestId,
              state: "cancelled",
            });
          }
        }
        store.revokeSessionLeases(workerAgentId, "session_stopped");
        this.clearLeaseExpiryTimer(workerAgentId);
        this.outputStates.delete(workerAgentId);
        this.projectDefaultStatuses.delete(workerAgentId);
        if (!destroyed) {
          const degraded = store.updateSessionRuntimeState({
            sessionAgentId: workerAgentId,
            executionMode: "secure",
            environmentStatus: "degraded",
          });
          this.options.emitSnapshot(
            toSnapshotEvent(this.toPublicSnapshot(store, degraded.snapshot)),
          );
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        if (options.deleteState !== false) {
          if (this.deleteSessionSecrets(store, workerAgentId)) this.emitCatalog(store);
          store.deleteSessionState(workerAgentId);
          return;
        }
        const stopped = store.updateSessionRuntimeState({
          sessionAgentId: workerAgentId,
          executionMode: "standard",
          environmentStatus: "stopped",
        });
        if (descriptor) {
          this.options.emitSnapshot(toSnapshotEvent(
            this.toPublicSnapshot(store, stopped.snapshot),
          ));
        }
      });
    });
  }

  /**
   * Fences secure-session authority while the owning lifecycle coordinator
   * tears down a task or project. The durable archived callbacks remain the
   * authority after a successful archive; this in-memory fence only closes the
   * transition race.
   */
  async beginSecureSessionLifecycleFence(
    profileId: string,
    sessionAgentIds: readonly string[],
  ): Promise<string> {
    const normalizedProfileId = bounded(profileId, 256);
    const normalizedSessionAgentIds = [...new Set(
      sessionAgentIds.map((agentId) => bounded(agentId, 256)),
    )];
    this.validateLifecycleFenceTarget(
      normalizedProfileId,
      normalizedSessionAgentIds,
    );
    const fenceId = this.id();
    return await this.withAuthorityMutation(async () => {
      this.validateLifecycleFenceTarget(
        normalizedProfileId,
        normalizedSessionAgentIds,
      );
      this.assertProfileLifecycleAvailable(normalizedProfileId);
      for (const sessionAgentId of normalizedSessionAgentIds) {
        this.assertSessionLifecycleAvailable(
          sessionAgentId,
          normalizedProfileId,
        );
      }
      this.lifecycleFences.set(fenceId, {
        fenceId,
        profileId: normalizedProfileId,
        sessionAgentIds: new Set(normalizedSessionAgentIds),
      });
      return fenceId;
    });
  }

  async cancelSecureSessionLifecycleFence(fenceId: string): Promise<void> {
    const normalizedFenceId = bounded(fenceId, 256);
    await this.withAuthorityMutation(async () => {
      if (!this.lifecycleFences.delete(normalizedFenceId)) {
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
    });
  }

  async completeSecureSessionLifecycleFence(
    fenceId: string,
    outcome: "archived" | "deleted",
  ): Promise<void> {
    const normalizedFenceId = bounded(fenceId, 256);
    if (outcome !== "archived" && outcome !== "deleted") {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    await this.withAuthorityMutation(async () => {
      if (!this.lifecycleFences.delete(normalizedFenceId)) {
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
    });
  }

  async clearSecureSessionLifecycleFenceForRestore(
    profileId: string,
    sessionAgentIds: readonly string[],
  ): Promise<void> {
    const normalizedProfileId = bounded(profileId, 256);
    const restoredSessionAgentIds = new Set(
      sessionAgentIds.map((agentId) => bounded(agentId, 256)),
    );
    if (restoredSessionAgentIds.size === 0) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    await this.withAuthorityMutation(async () => {
      for (const [fenceId, fence] of this.lifecycleFences) {
        if (
          fence.profileId === normalizedProfileId
          && [...fence.sessionAgentIds].every((agentId) =>
            restoredSessionAgentIds.has(agentId)
          )
        ) {
          this.lifecycleFences.delete(fenceId);
        }
      }
    });
  }

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
      const orphanedProfileIds = new Set<string>();
      for (const secret of store.listSecrets()) {
        if (
          secret.scopeKind === "profile"
          && secret.profileId
          && !this.options.hasProfile(secret.profileId)
        ) {
          orphanedProfileIds.add(secret.profileId);
        }
      }
      for (const projectDefault of store.listProjectDefaults()) {
        if (!this.options.hasProfile(projectDefault.profileId)) {
          orphanedProfileIds.add(projectDefault.profileId);
        }
      }
      for (const profileId of orphanedProfileIds) {
        const deleted = store.deleteProjectSecretState(profileId);
        catalogChanged = (
          deleted.projectDefaultsDeleted > 0
          || deleted.secretsDeleted > 0
        ) || catalogChanged;
      }
      for (const state of store.listSessionStates()) {
        store.revokeSessionLeases(state.sessionAgentId, "session_stopped");
        if (
          !this.options.getDescriptor(state.sessionAgentId)
          || !this.options.hasProfile(state.profileId)
        ) {
          catalogChanged = this.deleteSessionSecrets(
            store,
            state.sessionAgentId,
          ) || catalogChanged;
          store.deleteSessionState(state.sessionAgentId);
          continue;
        }
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

  async getSecureSessionReadiness(): Promise<SecureSessionReadiness> {
    try {
      const result = await this.options.execution.probe();
      switch (result.code) {
        case "available":
          return result.available
            ? { available: true, code: "available" }
            : { available: false, code: "backend_unavailable" };
        case "backend_unavailable":
        case "image_unavailable":
        case "unsupported_platform":
          return { available: false, code: result.code };
        default:
          return { available: false, code: "backend_unavailable" };
      }
    } catch {
      return { available: false, code: "backend_unavailable" };
    }
  }

  async connectBitwardenSecureSecretProvider(
    input: ConnectBitwardenSecureSecretProviderInput,
  ): Promise<SecureSecretProviderSummary> {
    const serverOrigin = normalizeHttpsOrigin(input.serverOrigin);
    const encryptedAccessToken = decodeCiphertext(input.encryptedAccessToken);
    const providerId = this.options.createId?.() ?? randomUUID();
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
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
          const config = store.upsertProviderBackendConfig({
            providerId,
            serverOrigin,
            organizationId: optionalBounded(input.organizationId, 256),
            projectId: optionalBounded(input.projectId, 256),
            encryptedAccessToken,
          });
          config.encryptedAccessToken.fill(0);
        } catch (error) {
          store.deleteProvider(providerId);
          throw error;
        }
        this.emitCatalog(store);
        return toProviderSummary(provider);
      });
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedAccessToken.fill(0);
    }
  }

  async testSecureSecretProvider(providerId: string): Promise<SecureSecretProviderTestResult> {
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const provider = store.getProvider(providerId);
      if (!provider) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      const providerSecrets = store.listSecrets(providerId);
      this.assertSecretMutationLifecycleAvailable(
        store,
        providerSecrets.map((secret) => secret.secretId),
      );
      let status: SecureSessionProvider["status"] = "available";
      let lastStatusCode: SecureSessionProvider["lastStatusCode"] = "ok";
      let code: SecureSecretProviderTestResult["code"] = "ok";
      const affectedSecrets: SecureSecretProviderTestResult["affectedSecrets"] = [];
      try {
        if (provider.kind === "local_keychain") {
          await this.options.cipher.status();
          let firstError: unknown;
          for (const secret of providerSecrets) {
            if (secret.retention !== "saved") continue;
            const encrypted = store.getEncryptedSecret(secret.secretId);
            try {
              if (!encrypted) throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
              const resolution = await this.options.localSource.resolve({
                sourceLocator: encrypted.sourceLocator,
                encryptedMaterial: encrypted.encryptedMaterial ?? undefined,
              });
              resolution.material.release();
            } catch (error) {
              firstError ??= error;
              affectedSecrets.push({
                secretId: secret.secretId,
                displayAlias: secret.displayAlias,
              });
            } finally {
              encrypted?.encryptedMaterial?.fill(0);
            }
          }
          if (firstError) {
            code = "local_secret_decrypt_failed";
            ({ status, lastStatusCode } = providerStatusForError(firstError));
          }
        } else {
          const config = store.getProviderBackendConfig(providerId);
          if (!config) throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
          try {
            await this.options.bitwardenSource.testConnection({
              encryptedCredential: config.encryptedAccessToken,
              endpointOrigin: config.serverOrigin,
            });
          } finally {
            config.encryptedAccessToken.fill(0);
          }
        }
      } catch (error) {
        code = "provider_unavailable";
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
      return {
        provider: toProviderSummary(tested),
        code,
        affectedSecrets,
      };
    });
  }

  async updateBitwardenSecureSecretProviderCredential(
    providerId: string,
    input: UpdateBitwardenSecureSecretProviderCredentialInput,
  ): Promise<SecureSecretProviderSummary> {
    const encryptedAccessToken = decodeCiphertext(input.encryptedAccessToken);
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        if (provider.kind !== "bitwarden_secrets_manager") {
          throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
        }
        const config = store.getProviderBackendConfig(providerId);
        if (!config) throw new SecureSessionsServiceError("SECURE_PROVIDER_AUTH_REQUIRED");
        config.encryptedAccessToken.fill(0);

        await this.options.bitwardenSource.testConnection({
          encryptedCredential: encryptedAccessToken,
          endpointOrigin: config.serverOrigin,
        });

        const secretIds = store.listSecrets(providerId).map((secret) => secret.secretId);
        this.assertSecretMutationLifecycleAvailable(store, secretIds);
        const initiallyAffected = this.captureAffectedLeases(store, secretIds);
        return await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
          const affected = this.captureAffectedLeases(store, secretIds);
          const updated = store.replaceProviderBackendCredential({
            providerId,
            encryptedAccessToken,
            lastVerifiedAt: this.now(),
          });
          this.releaseLeases(affected.leaseIds);
          await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
          this.emitCatalog(store);
          this.emitSessionSnapshots(store, affected.sessionIds);
          return toProviderSummary(updated);
        });
      });
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedAccessToken.fill(0);
    }
  }

  async deleteSecureSecretProvider(providerId: string): Promise<void> {
    await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const secretIds = store.listSecrets(providerId).map((secret) => secret.secretId);
      this.assertSecretMutationLifecycleAvailable(store, secretIds);
      const initiallyAffected = this.captureAffectedLeases(store, secretIds);
      await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
        const affected = this.captureAffectedLeases(store, secretIds);
        if (!store.deleteProvider(providerId)) {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        this.releaseLeases(affected.leaseIds);
        await this.reconcileAfterLeaseLoss(
          store,
          affected.sessionIds,
        );
        this.emitCatalog(store);
        this.emitSessionSnapshots(store, affected.sessionIds);
      });
    });
  }

  async listSecureSecrets(): Promise<SecureSecretSummary[]> {
    const store = await this.store();
    return this.listPublicSecrets(store);
  }

  async listSecureSecretProjectDefaults(
    profileId?: string,
  ): Promise<SecureSecretProjectDefaultSummary[]> {
    const normalizedProfileId = profileId === undefined
      ? undefined
      : bounded(profileId, 256);
    if (
      normalizedProfileId !== undefined
      && !this.options.hasProfile(normalizedProfileId)
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    return store.listProjectDefaults(normalizedProfileId).map(toProjectDefaultSummary);
  }

  async setSecureSecretProjectDefault(
    secretId: string,
    input: { profileId: string; enabled: boolean },
  ): Promise<SecureSecretProjectDefaultSummary | null> {
    return await this.withAuthorityMutation(async () => {
      const normalizedProfileId = bounded(input.profileId, 256);
      const normalizedSecretId = bounded(secretId, 256);
      if (
        typeof input.enabled !== "boolean"
        || !this.options.hasProfile(normalizedProfileId)
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      const store = await this.store();
      this.assertProfileLifecycleAvailable(normalizedProfileId);
      const existingDefault = store.listProjectDefaults(normalizedProfileId)
        .find((projectDefault) => projectDefault.secretId === normalizedSecretId);
      const secret = resolveVisibleSavedSecrets(store, normalizedProfileId)
        .find((candidate) => candidate.secretId === normalizedSecretId);
      if (!secret && !(input.enabled === false && existingDefault)) {
        throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      }
      if (input.enabled) {
        if (
          !existingDefault
          && store.listProjectDefaults(normalizedProfileId).length
            >= SECURE_SECRET_MAX_PROJECT_DEFAULTS
        ) {
          throw new SecureSessionsServiceError(
            "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
          );
        }
        assertProjectDefaultBindingCompatibility(
          store,
          normalizedProfileId,
          normalizedSecretId,
          store.listBindings(normalizedSecretId).map(toPublicBinding),
        );
        const created = store.putProjectDefault({
          profileId: normalizedProfileId,
          secretId: normalizedSecretId,
        });
        this.emitCatalog(store);
        return toProjectDefaultSummary(created);
      }

      const affected = captureProjectDefaultLeases(
        store,
        normalizedProfileId,
        [normalizedSecretId],
      );
      return await this.withSessionMutations(affected.sessionIds, async () => {
        if (!store.deleteProjectDefault(normalizedProfileId, normalizedSecretId)) {
          return null;
        }
        this.releaseLeases(affected.leaseIds);
        for (const sessionAgentId of affected.sessionIds) {
          this.projectDefaultStatuses.get(sessionAgentId)?.delete(normalizedSecretId);
        }
        await this.reconcileAfterLeaseLoss(
          store,
          affected.sessionIds,
        );
        this.emitCatalog(store);
        this.emitSessionSnapshots(store, affected.sessionIds);
        return null;
      });
    });
  }

  async deleteSecureSecretProjectState(profileId: string): Promise<void> {
    await this.withAuthorityMutation(async () => {
      const normalizedProfileId = bounded(profileId, 256);
      const store = await this.store();
      const scopedSecretIds = store.listSecrets()
          .filter((secret) =>
            secret.scopeKind === "profile" && secret.profileId === normalizedProfileId
          )
          .map((secret) => secret.secretId);
      const defaultSecretIds = store.listProjectDefaults(normalizedProfileId)
        .map((projectDefault) => projectDefault.secretId);
      const affectedDefaults = captureProjectDefaultLeases(
        store,
        normalizedProfileId,
        defaultSecretIds,
      );
      const affectedScopedSecrets = captureProjectDefaultLeases(
        store,
        normalizedProfileId,
        scopedSecretIds,
        { includeAllSecretLeases: true },
      );
      const affected = {
        leaseIds: [...new Set([
          ...affectedDefaults.leaseIds,
          ...affectedScopedSecrets.leaseIds,
        ])],
        sessionIds: [...new Set([
          ...affectedDefaults.sessionIds,
          ...affectedScopedSecrets.sessionIds,
        ])],
      };
      await this.withSessionMutations(affected.sessionIds, async () => {
        const result = store.deleteProjectSecretState(normalizedProfileId);
        if (
          result.projectDefaultsDeleted === 0
          && result.secretsDeleted === 0
        ) {
          return;
        }
        this.releaseLeases(affected.leaseIds);
        for (const sessionAgentId of affected.sessionIds) {
          this.projectDefaultStatuses.delete(sessionAgentId);
        }
        await this.deactivateAffectedSessions(store, affected.sessionIds);
        this.emitCatalog(store);
        this.emitSessionSnapshots(store, affected.sessionIds);
      });
    });
  }

  async createLocalSecureSecret(input: CreateLocalSecureSecretInput): Promise<SecureSecretSummary> {
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        this.ensureLocalProvider(store);
        const secretId = this.id();
        const displayAlias = bounded(input.displayAlias, 256);
        const scope = toStoredScope(input.scope);
        this.requireExistingProfileScope(scope);
        this.assertScopeLifecycleAvailable(scope);
        assertDoesNotShadowConfiguredDefault(store, scope, displayAlias);
        const result = store.createSecretWithBindings({
          secret: {
            secretId,
            providerId: LOCAL_PROVIDER_ID,
            displayAlias,
            displayName: optionalBounded(input.displayName, 256),
            ...scope,
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
      });
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
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider || provider.kind !== "bitwarden_secrets_manager") {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        const secretId = this.id();
        const displayAlias = bounded(input.displayAlias, 256);
        const scope = toStoredScope(input.scope);
        this.requireExistingProfileScope(scope);
        this.assertScopeLifecycleAvailable(scope);
        assertDoesNotShadowConfiguredDefault(store, scope, displayAlias);
        const result = store.createSecretWithBindings({
          secret: {
            secretId,
            providerId,
            displayAlias,
            displayName: optionalBounded(input.displayName, 256),
            ...scope,
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
      });
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
      this.assertSecretMutationLifecycleAvailable(store, [secretId]);
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
        const nextScope = toStoredScope(input.scope ?? toPublicScope(existing));
        this.requireExistingProfileScope(nextScope);
        this.assertScopeLifecycleAvailable(nextScope);
        assertDoesNotShadowConfiguredDefault(
          store,
          nextScope,
          nextDisplayAlias,
          secretId,
        );
        const existingBindings = store.listBindings(secretId);
        const nextBindings = input.bindings === undefined && existingBindings.length > 0
          ? existingBindings.map(toBindingInput)
          : normalizeBindings(
              input.bindings?.length
                ? input.bindings
                : [defaultSecureSecretBinding(secretId, nextDisplayAlias)],
              this.id.bind(this),
            );
        const nextRetention = input.retention ?? existing.retention;
        const projectDefaults = store.listProjectDefaults()
          .filter((projectDefault) => projectDefault.secretId === secretId);
        if (nextRetention === "saved") {
          for (const { profileId } of projectDefaults.filter(({ profileId }) =>
            nextScope.scopeKind === "instance" || nextScope.profileId === profileId
          )) {
            assertProjectDefaultBindingCompatibility(
              store,
              profileId,
              secretId,
              nextBindings.map(bindingInputToPublicBinding),
            );
          }
        }
        try {
          const result = store.updateSecretWithBindings({
            secret: {
              secretId,
              providerId: existing.providerId,
              displayAlias: nextDisplayAlias,
              displayName: input.displayName === undefined
                ? existing.displayName
                : optionalBounded(input.displayName, 256),
              ...nextScope,
              retention: nextRetention,
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
      this.assertSecretMutationLifecycleAvailable(store, [secretId]);
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
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () =>
        await this.getSecureSessionSnapshotUnlocked(sessionAgentId)
      )
    );
  }

  private async getSecureSessionSnapshotUnlocked(
    sessionAgentId: string,
  ): Promise<PublicSecureSessionSnapshot> {
    const principal = this.resolveSecurePrincipal(sessionAgentId, {
      requireWorkerAssignment: false,
    });
    const descriptor = principal.descriptor;
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const existing = store.getSessionState(sessionAgentId);
    if (existing) {
      assertPrincipalOwnerMatches(principal, existing);
    } else {
      store.initializePrincipalState(
        sessionAgentId,
        principalStateInput(principal),
      );
    }
    let snapshot = store.getSnapshot(sessionAgentId);
    if (
      snapshot.state.executionMode === "secure"
      && snapshot.state.environmentStatus === "ready"
      && !this.activeSessions.has(sessionAgentId)
    ) {
      const task = principal.principalKind === "worker"
        && snapshot.state.workerAssignmentId === null
        ? undefined
        : toTask(descriptor, snapshot.state.workerAssignmentId);
      if (task) {
        await this.options.execution.destroyTask(task).catch(() => false);
      }
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
    const manager = this.requireTeamManager(sessionAgentId);
    const principals = this.listCurrentSecureTeamPrincipals(manager);
    if (principals.some(
      (principal) =>
        principal.principalKind === "worker"
        && principal.descriptor.status === "streaming",
    )) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutations(
        principals.map(({ descriptor }) => descriptor.agentId),
        async () => {
          const activated: SecurePrincipal[] = [];
          try {
            let managerSnapshot: PublicSecureSessionSnapshot | null = null;
            for (const principal of principals) {
              const wasActive = this.activeSessions.has(
                principal.descriptor.agentId,
              );
              const snapshot = await this.startSecurePrincipalUnlocked(
                principal,
                principal.principalKind === "manager" ? input : {},
                { recycleRuntime: true },
              );
              if (!wasActive) activated.push(principal);
              if (principal.principalKind === "manager") {
                managerSnapshot = snapshot;
              }
            }
            if (!managerSnapshot) {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            }
            return managerSnapshot;
          } catch (error) {
            for (const principal of activated.reverse()) {
              const store = await this.store();
              const state = store.getSessionState(principal.descriptor.agentId);
              if (!state) continue;
              await this.stopSecurePrincipalUnlocked(
                principal,
                {
                  baseRevision: state.revision,
                  stopProcesses: true,
                },
                {
                  preserveSessionSecrets: true,
                  recycleRuntime: false,
                },
              ).catch(() => undefined);
            }
            throw this.publicError(error);
          }
        },
      )
    );
  }

  private async startSecurePrincipalUnlocked(
    principal: SecurePrincipal,
    input: StartSecureSessionInput,
    options: {
      emitSnapshot?: boolean;
      attachProjectDefaults?: boolean;
      recycleRuntime?: boolean;
    } = {},
  ): Promise<PublicSecureSessionSnapshot> {
    if (
      principal.principalKind === "worker"
      && principal.workerAssignmentId === null
    ) {
      return await this.startUnassignedWorkerPrincipalUnlocked(
        principal,
        input,
        options,
      );
    }
    const descriptor = principal.descriptor;
    const sessionAgentId = descriptor.agentId;
    const store = await this.store();
    const initial = store.initializePrincipalState(
      sessionAgentId,
      principalStateInput(principal),
    );
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
    const task = toTask(descriptor, principal.workerAssignmentId);
    if (
      !existingActive
      && (
        initial.environmentStatus === "degraded"
        || initial.environmentStatus === "failed"
        || (
          initial.executionMode === "secure"
          && initial.environmentStatus === "ready"
        )
      )
    ) {
      const destroyed = await this.options.execution
        .destroyTask(task)
        .catch(() => false);
      if (!destroyed) {
        const degraded = store.updateSessionRuntimeState({
          sessionAgentId,
          profileId: principal.profileId,
          executionMode: "secure",
          environmentStatus: "degraded",
        });
        this.options.emitSnapshot(
          toSnapshotEvent(this.toPublicSnapshot(store, degraded.snapshot)),
        );
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
      store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: principal.profileId,
        executionMode: "secure",
        environmentStatus: "stopped",
      });
    }
    const bindingWasActive = this.activeSessions.has(sessionAgentId);
    let activationDeferred = false;
    let preparedProjectDefaults: PreparedProjectDefault[] = [];
    let projectDefaultMaterialsTransferred = false;
    try {
      await this.initializeSecureSessions();
      if (options.attachProjectDefaults !== false) {
        preparedProjectDefaults = await this.prepareProjectDefaultsForStart(
          store,
          descriptor,
        );
      } else {
        this.projectDefaultStatuses.delete(sessionAgentId);
      }
      await this.options.execution.ensureTask(task);
      const current = store.getSnapshot(sessionAgentId);
      if (input.baseRevision !== undefined) requireRevision(current.state.revision, input.baseRevision);
      const runtime = store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: principal.profileId,
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
      let storedSnapshot = runtime.snapshot;
      if (preparedProjectDefaults.length > 0) {
        const created = store.createLeases({
          sessionAgentId,
          baseRevision: storedSnapshot.state.revision,
          grants: preparedProjectDefaults.map((prepared) => ({
            leaseId: prepared.leaseId,
            secretId: prepared.secretId,
            bindingIds: prepared.bindingIds,
            leaseKind: "task",
            grantSource: "project_default",
            expiresAt: null,
          })),
        });
        for (const prepared of preparedProjectDefaults) {
          this.cachedLeaseSecrets.set(prepared.leaseId, prepared.material);
          this.cachedLeaseOwners.set(prepared.leaseId, sessionAgentId);
          this.setProjectDefaultStatus(sessionAgentId, {
            secretId: prepared.secretId,
            displayAlias: prepared.displayAlias,
            state: "active",
            statusCode: "ok",
          });
        }
        projectDefaultMaterialsTransferred = true;
        storedSnapshot = created.snapshot;
      }
      if (storedSnapshot.leases.some((lease) => lease.state === "active")) {
        await this.ensureGuardForActiveLeases(store, sessionAgentId);
      }
      this.scheduleLeaseExpiry(store, sessionAgentId);
      const snapshot = this.toPublicSnapshot(store, storedSnapshot);
      if (runtime.changed || preparedProjectDefaults.length > 0 || !bindingWasActive) {
        if (options.recycleRuntime !== false) {
          const recycle = await this.options.applyModeRuntimeRecycle(sessionAgentId);
          if (recycle === "deferred") {
            activationDeferred = true;
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
        }
        if (options.emitSnapshot !== false) {
          this.options.emitSnapshot(toSnapshotEvent(snapshot));
        }
      }
      return snapshot;
    } catch (error) {
      const destroyed = await this.options.execution
        .destroyTask(task)
        .catch(() => false);
      store.revokeSessionLeases(sessionAgentId, "policy_changed");
      this.releaseSession(sessionAgentId);
      this.outputStates.delete(sessionAgentId);
      this.projectDefaultStatuses.delete(sessionAgentId);
      const failed = store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: principal.profileId,
        executionMode: activationDeferred ? "standard" : "secure",
        environmentStatus: activationDeferred
          ? "stopped"
          : destroyed
            ? "failed"
            : "degraded",
      });
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, failed.snapshot)));
      throw this.publicError(error);
    } finally {
      if (!projectDefaultMaterialsTransferred) {
        for (const prepared of preparedProjectDefaults) {
          prepared.material.release();
        }
      }
    }
  }

  private async startUnassignedWorkerPrincipalUnlocked(
    principal: SecurePrincipal,
    input: StartSecureSessionInput,
    options: {
      emitSnapshot?: boolean;
      attachProjectDefaults?: boolean;
      recycleRuntime?: boolean;
    },
  ): Promise<PublicSecureSessionSnapshot> {
    const sessionAgentId = principal.descriptor.agentId;
    const store = await this.store();
    const initial = store.initializePrincipalState(
      sessionAgentId,
      principalStateInput(principal),
    );
    if (input.baseRevision !== undefined) {
      requireRevision(initial.revision, input.baseRevision);
    }
    if (
      initial.executionMode === "secure"
      && initial.environmentStatus === "stopped"
      && !this.activeSessions.has(sessionAgentId)
    ) {
      return this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId));
    }
    const staleActive = this.activeSessions.get(sessionAgentId);
    if (staleActive) {
      staleActive.closed = true;
      const destroyed = await this.options.execution
        .destroyTask(staleActive.task)
        .catch(() => false);
      this.releaseSession(sessionAgentId);
      await this.waitForSessionExecutionsToSettle(sessionAgentId);
      if (!destroyed) {
        const degraded = store.updateSessionRuntimeState({
          sessionAgentId,
          executionMode: "secure",
          environmentStatus: "degraded",
        });
        this.options.emitSnapshot(
          toSnapshotEvent(this.toPublicSnapshot(store, degraded.snapshot)),
        );
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
    }
    let preparedProjectDefaults: PreparedProjectDefault[] = [];
    let materialsTransferred = false;
    try {
      await this.initializeSecureSessions();
      if (options.attachProjectDefaults !== false) {
        preparedProjectDefaults = await this.prepareProjectDefaultsForStart(
          store,
          principal.descriptor,
        );
      }
      let storedSnapshot = store.updateSessionRuntimeState({
        sessionAgentId,
        profileId: principal.profileId,
        executionMode: "secure",
        environmentStatus: "stopped",
      }).snapshot;
      if (preparedProjectDefaults.length > 0) {
        const created = store.createLeases({
          sessionAgentId,
          baseRevision: storedSnapshot.state.revision,
          grants: preparedProjectDefaults.map((prepared) => ({
            leaseId: prepared.leaseId,
            secretId: prepared.secretId,
            bindingIds: prepared.bindingIds,
            leaseKind: "task",
            grantSource: "project_default",
            expiresAt: null,
          })),
        });
        for (const prepared of preparedProjectDefaults) {
          this.cachedLeaseSecrets.set(prepared.leaseId, prepared.material);
          this.cachedLeaseOwners.set(prepared.leaseId, sessionAgentId);
          this.setProjectDefaultStatus(sessionAgentId, {
            secretId: prepared.secretId,
            displayAlias: prepared.displayAlias,
            state: "active",
            statusCode: "ok",
          });
        }
        materialsTransferred = true;
        storedSnapshot = created.snapshot;
      }
      this.outputStates.set(sessionAgentId, {
        outputState: "clear",
        outputStateCode: null,
      });
      if (options.recycleRuntime !== false) {
        const recycle = await this.options.applyModeRuntimeRecycle(sessionAgentId);
        if (recycle === "deferred") {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
      }
      const snapshot = this.toPublicSnapshot(store, storedSnapshot);
      if (options.emitSnapshot !== false) {
        this.options.emitSnapshot(toSnapshotEvent(snapshot));
      }
      return snapshot;
    } catch (error) {
      store.revokeSessionLeases(sessionAgentId, "policy_changed");
      this.releaseSession(sessionAgentId);
      this.outputStates.delete(sessionAgentId);
      this.projectDefaultStatuses.delete(sessionAgentId);
      const failed = store.updateSessionRuntimeState({
        sessionAgentId,
        executionMode: "secure",
        environmentStatus: "failed",
      });
      this.options.emitSnapshot(
        toSnapshotEvent(this.toPublicSnapshot(store, failed.snapshot)),
      );
      throw this.publicError(error);
    } finally {
      if (!materialsTransferred) {
        for (const prepared of preparedProjectDefaults) {
          prepared.material.release();
        }
      }
    }
  }

  async applySecureSessionProjectDefaults(
    sessionAgentId: string,
    input: ApplySecureSessionProjectDefaultsInput,
  ): Promise<PublicSecureSessionSnapshot> {
    const manager = this.requireTeamManager(sessionAgentId);
    if (!this.isTeamSecureMode(manager.agentId)) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const managerSnapshot = store.getSnapshot(manager.agentId);
      requireRevision(managerSnapshot.state.revision, input.baseRevision);
      const principals = this.listApplicableProjectDefaultPrincipals(
        store,
        manager,
      );
      return await this.withSessionMutations(
        principals.map(({ descriptor }) => descriptor.agentId),
        async () => {
          requireRevision(
            store.getSnapshot(manager.agentId).state.revision,
            input.baseRevision,
          );
          for (const principal of principals) {
            await this.applyProjectDefaultsToPrincipalUnlocked(
              store,
              principal,
            );
          }
          return this.toPublicSnapshot(
            store,
            store.getSnapshot(manager.agentId),
          );
        },
      );
    });
  }

  async stopSecureSession(
    sessionAgentId: string,
    input: StopSecureSessionInput,
  ): Promise<PublicSecureSessionSnapshot> {
    if (input.stopProcesses !== true) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const descriptor = this.options.getDescriptor(sessionAgentId);
    if (descriptor?.role === "worker") {
      return await this.withAuthorityMutation(async () =>
        await this.withSessionMutation(sessionAgentId, async () => {
          const principal = this.resolveSecurePrincipal(sessionAgentId);
          const stopped = await this.stopSecurePrincipalUnlocked(
            principal,
            input,
          );
          if (stopped.environmentStatus === "degraded") {
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
          return stopped;
        })
      );
    }
    const manager = this.requireTeamManager(sessionAgentId);
    const store = await this.store();
    const persistedWorkers = store.getSessionState(manager.agentId)
      ? store.listPrincipalStatesForManager(manager.agentId)
        .filter((state) => state.principalKind === "worker")
      : [];
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutations(
        [manager.agentId, ...persistedWorkers.map(({ sessionAgentId: id }) => id)],
        async () => {
          for (const state of persistedWorkers) {
            const descriptor = this.options.getDescriptor(state.sessionAgentId);
            if (!descriptor || !this.isEligibleSecureWorker(descriptor)) {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            }
            const principal = this.resolveSecurePrincipal(descriptor.agentId, {
              requireWorkerAssignment: false,
            });
            const stopped = await this.stopSecurePrincipalUnlocked(
              principal,
              {
                baseRevision: state.revision,
                stopProcesses: true,
              },
              { recycleRuntime: false },
            );
            if (stopped.environmentStatus === "degraded") {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            }
          }
          const principal = this.resolveSecurePrincipal(manager.agentId);
          return await this.stopSecurePrincipalUnlocked(principal, input);
        },
      )
    );
  }

  private async stopSecurePrincipalUnlocked(
    principal: SecurePrincipal,
    input: StopSecureSessionInput,
    options: {
      allowLifecycleBlocked?: boolean;
      preserveSessionSecrets?: boolean;
      preservePendingRequests?: boolean;
      recycleRuntime?: boolean;
    } = {},
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = principal.descriptor;
    const sessionAgentId = descriptor.agentId;
    if (input.stopProcesses !== true) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    const before = store.initializePrincipalState(
      sessionAgentId,
      principalStateInput(principal),
    );
    requireNonFutureRevision(before.revision, input.baseRevision);
    const active = this.activeSessions.get(sessionAgentId);
    const task = active?.task
      ?? (
        principal.principalKind === "worker"
        && before.workerAssignmentId === null
          ? undefined
          : toTask(descriptor, before.workerAssignmentId)
      );
    if (active) active.closed = true;
    let destroyFailed = false;
    if (task) {
      try {
        destroyFailed = !(await this.options.execution.destroyTask(task));
      } catch {
        destroyFailed = true;
      }
    }
    this.releaseSession(sessionAgentId);
    await this.waitForSessionExecutionsToSettle(sessionAgentId);
    if (options.preservePendingRequests !== true) {
      for (const request of store.getSnapshot(sessionAgentId).requests) {
        store.resolveRequest({
          requestId: request.requestId,
          state: "cancelled",
        });
      }
    }
    const revoke = store.revokeSessionLeases(sessionAgentId, "session_stopped");
    this.clearLeaseExpiryTimer(sessionAgentId);
    this.outputStates.delete(sessionAgentId);
    this.projectDefaultStatuses.delete(sessionAgentId);
    if (
      options.preserveSessionSecrets !== true
      && this.deleteSessionSecrets(store, sessionAgentId)
    ) {
      this.emitCatalog(store);
    }
    const runtime = store.updateSessionRuntimeState({
      sessionAgentId,
      profileId: principal.profileId,
      executionMode: "standard",
      environmentStatus: destroyFailed ? "degraded" : "stopped",
    });
    const snapshot = this.toPublicSnapshot(store, runtime.snapshot);
    if (revoke.changed || runtime.changed) {
      this.options.emitSnapshot(toSnapshotEvent(snapshot));
      if (options.recycleRuntime !== false) {
        await this.options.applyModeRuntimeRecycle(sessionAgentId);
      }
    }
    return snapshot;
  }

  async stopSecureSessionForLifecycle(
    sessionAgentId: string,
    options: { deleteState?: boolean } = {},
  ): Promise<void> {
    const descriptor = this.options.getDescriptor(sessionAgentId);
    if (!isBuilderManager(descriptor)) return;
    const store = await this.store();
    const managerState = store.getSessionState(sessionAgentId);
    const workerStates = managerState
      ? store.listPrincipalStatesForManager(sessionAgentId)
        .filter((state) => state.principalKind === "worker")
      : [];
    for (const workerState of workerStates) {
      await this.teardownWorkerSecurePrincipal(workerState.sessionAgentId, {
        deleteState: options.deleteState,
      });
    }
    await this.withSessionMutation(sessionAgentId, async () => {
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
          const stopped = await this.stopSecurePrincipalUnlocked(
            this.resolveSecurePrincipal(sessionAgentId, {
              allowLifecycleBlocked: true,
            }),
            {
            baseRevision: snapshot.state.revision,
            stopProcesses: true,
            },
            {
              allowLifecycleBlocked: true,
              preservePendingRequests: true,
            },
          );
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

  async prepareSecureSessionForDeletion(sessionAgentId: string): Promise<void> {
    const descriptor = this.options.getDescriptor(sessionAgentId);
    if (!isBuilderManager(descriptor)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    const managerState = store.getSessionState(sessionAgentId);
    const workerStates = managerState
      ? store.listPrincipalStatesForManager(sessionAgentId)
        .filter((state) => state.principalKind === "worker")
      : [];
    for (const workerState of workerStates) {
      await this.teardownWorkerSecurePrincipal(workerState.sessionAgentId, {
        deleteState: false,
        preservePendingRequests: true,
      });
    }
    await this.withSessionMutation(sessionAgentId, async () => {
      const persistedState = store.listSessionStates().find(
        (state) => state.sessionAgentId === sessionAgentId,
      );
      const hasActiveEnvironment = this.activeSessions.has(sessionAgentId);
      if (!persistedState && !hasActiveEnvironment) return;
      const snapshot = store.getSnapshot(sessionAgentId);
      const hasActiveLease = snapshot.leases.some((lease) => lease.state === "active");
      if (
        hasActiveEnvironment
        || hasActiveLease
        || snapshot.state.executionMode === "secure"
        || snapshot.state.environmentStatus !== "stopped"
      ) {
        await this.initializeSecureSessions();
        const stopped = await this.stopSecurePrincipalUnlocked(
          this.resolveSecurePrincipal(sessionAgentId, {
            allowLifecycleBlocked: true,
          }),
          {
          baseRevision: snapshot.state.revision,
          stopProcesses: true,
          },
          {
            allowLifecycleBlocked: true,
            preservePendingRequests: true,
            preserveSessionSecrets: true,
          },
        );
        if (stopped.environmentStatus === "degraded") {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
      }
    });
  }

  async deleteSecureSessionStateAfterCoreDeletion(
    sessionAgentId: string,
  ): Promise<void> {
    const normalizedSessionAgentId = bounded(sessionAgentId, 256);
    await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(normalizedSessionAgentId, async () => {
        const store = await this.store();
        const catalogChanged = this.deleteSessionSecrets(
          store,
          normalizedSessionAgentId,
        );
        store.deleteSessionState(normalizedSessionAgentId);
        this.releaseSession(normalizedSessionAgentId);
        this.outputStates.delete(normalizedSessionAgentId);
        this.projectDefaultStatuses.delete(normalizedSessionAgentId);
        this.clearLeaseExpiryTimer(normalizedSessionAgentId);
        if (catalogChanged) this.emitCatalog(store);
      })
    );
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
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const descriptor = principal.descriptor;
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
    if (initialState) assertPrincipalStateMatches(principal, initialState);
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
      store.initializePrincipalState(
        sessionAgentId,
        principalStateInput(principal),
      );
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
          grantSource: "manual" as const,
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
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () =>
        await this.revokeSecureSessionLeaseUnlocked(sessionAgentId, input)
      )
    );
  }

  private async revokeSecureSessionLeaseUnlocked(
    sessionAgentId: string,
    input: { baseRevision: number; leaseId: string },
  ): Promise<PublicSecureSessionSnapshot> {
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const store = await this.store();
    try {
      const current = store.getSnapshot(sessionAgentId);
      assertPrincipalStateMatches(principal, current.state);
      requireNonFutureRevision(current.state.revision, input.baseRevision);
      const result = store.revokeLease({
        sessionAgentId,
        leaseId: input.leaseId,
        baseRevision: current.state.revision,
        reason: "user",
      });
      this.releaseLeases([input.leaseId]);
      if (result.changed) {
        await this.reconcileAfterLeaseLoss(store, [sessionAgentId]);
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
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const descriptor = principal.descriptor;
    if (input.requestId !== requestId) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const snapshot = store.getSnapshot(sessionAgentId);
    assertPrincipalStateMatches(principal, snapshot.state);
    requireRevision(snapshot.state.revision, input.baseRevision);
    const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
    if (!request) throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    assertRequestAssignmentMatches(principal, request.workerAssignmentId);
    if (input.decision === "deny") {
      if (input.selectedSecretId !== undefined) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      const resolved = store.resolveRequest({ requestId, state: "denied" });
      const result = this.toPublicSnapshot(store, resolved);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    }
    if (request.secretId && input.selectedSecretId !== undefined) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const selectedSecretId = request.secretId ?? input.selectedSecretId;
    if (!selectedSecretId) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const profileId = requireProfileId(descriptor);
    const secret = resolveVisibleSavedSecretByAlias(
      store,
      profileId,
      request.displayAlias,
    );
    if (!secret || secret.secretId !== selectedSecretId) {
      throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    }
    const bindingIds = matchRequestedBindingIds(
      store.listBindings(secret.secretId),
      request.requestedExposures,
    );
    assertSessionBindingCompatibility(store, snapshot, bindingIds);
    const material = await this.resolveSecretMaterial(store, secret.secretId);
    const leaseId = this.id();
    let leaseCreated = false;
    try {
      const requiresCleanEnvironment = this.activeSessions.has(sessionAgentId);
      await this.ensureSecureEnvironment(store, descriptor);
      if (requiresCleanEnvironment) {
        await this.rebuildEnvironmentForNewLease(store, descriptor);
      }
      const current = store.getSnapshot(sessionAgentId);
      assertSessionBindingCompatibility(store, current, bindingIds);
      const lease = store.createLease({
        leaseId,
        sessionAgentId,
        secretId: secret.secretId,
        requestId,
        bindingIds,
        leaseKind: request.requestedLeaseKind,
        grantSource: "access_request",
        baseRevision: current.state.revision,
        expiresAt: expiresAt({
          leaseKind: request.requestedLeaseKind,
          requestedDurationSeconds: request.requestedDurationSeconds,
        }, this.now()),
      });
      leaseCreated = true;
      this.cachedLeaseSecrets.set(leaseId, material);
      this.cachedLeaseOwners.set(leaseId, sessionAgentId);
      await this.ensureGuardForActiveLeases(store, sessionAgentId);
      this.scheduleLeaseExpiry(store, sessionAgentId);
      const result = this.toPublicSnapshot(store, lease.snapshot);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    } catch (error) {
      if (leaseCreated) {
        await this.failClosedSession(store, descriptor);
      } else {
        material.release();
      }
      throw this.publicError(error);
    }
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
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const descriptor = principal.descriptor;
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const snapshot = store.getSnapshot(sessionAgentId);
    assertPrincipalStateMatches(principal, snapshot.state);
    requireRevision(snapshot.state.revision, input.baseRevision);
    const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.secretId !== null || request.displayAlias !== input.displayAlias) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    assertRequestAssignmentMatches(principal, request.workerAssignmentId);
    if (!samePublicBindings(request.requestedExposures.map(toPublicBinding), input.exposures)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    if (
      request.requestedLeaseKind !== input.leaseKind
      || (
        input.leaseKind === "timed"
        && request.requestedDurationSeconds !== input.durationSeconds
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const profileId = requireProfileId(descriptor);
    let scope: { scopeKind: "instance" | "profile"; profileId: string | null };
    if (input.retention === "session") {
      if (
        input.makeProjectDefault === true
        || (
          input.scope !== undefined
          && (
            input.scope.kind !== "profile"
            || input.scope.profileId !== profileId
          )
        )
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      scope = { scopeKind: "profile", profileId };
    } else if (input.retention === "saved" && input.scope !== undefined) {
      scope = toStoredScope(input.scope);
      this.requireExistingProfileScope(scope);
      if (scope.scopeKind === "profile" && scope.profileId !== profileId) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
    } else {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }

    assertDoesNotShadowConfiguredDefault(
      store,
      scope,
      request.displayAlias,
    );
    if (
      input.makeProjectDefault === true
      && store.listProjectDefaults(profileId).length
        >= SECURE_SECRET_MAX_PROJECT_DEFAULTS
    ) {
      throw new SecureSessionsServiceError(
        "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
      );
    }
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    const secretId = this.id();
    const sourceLocator = input.retention === "session"
      ? `session:${sessionAgentId}`
      : "local";
    const normalizedBindings = normalizeBindings(input.exposures, this.id.bind(this));
    assertPublicBindingCompatibility(store, snapshot, input.exposures);
    if (input.makeProjectDefault === true) {
      assertProjectDefaultBindingCompatibility(
        store,
        profileId,
        secretId,
        input.exposures,
      );
    }
    let material: HostOnlySecret | null = null;
    let prospectiveGuard: SecureValueGuard | null = null;
    let leaseCreated = false;
    try {
      material = (await this.options.localSource.resolve({
        sourceLocator,
        encryptedMaterial,
      })).material;
      const requiresCleanEnvironment = this.activeSessions.has(sessionAgentId);
      await this.ensureSecureEnvironment(store, descriptor);
      if (requiresCleanEnvironment) {
        await this.rebuildEnvironmentForNewLease(store, descriptor);
      }
      const current = store.getSnapshot(sessionAgentId);
      assertPublicBindingCompatibility(store, current, input.exposures);
      if (current.leases.some((lease) => lease.state === "active")) {
        await this.ensureGuardForActiveLeases(store, sessionAgentId);
      }
      prospectiveGuard = await this.buildProspectiveGuard(
        sessionAgentId,
        material,
      );
      const active = this.activeSessions.get(sessionAgentId);
      if (!active || active.closed) {
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
      const leaseId = this.id();
      const lease = store.withTransaction(() => {
        this.ensureLocalProvider(store);
        const created = store.createSecretWithBindings({
          secret: {
            secretId,
            providerId: LOCAL_PROVIDER_ID,
            displayAlias: request.displayAlias,
            ...scope,
            retention: input.retention,
            sourceLocator,
            encryptedMaterial,
          },
          bindings: normalizedBindings,
        });
        if (input.makeProjectDefault === true) {
          store.putProjectDefault({ profileId, secretId });
        }
        return store.createLease({
          leaseId,
          sessionAgentId,
          secretId,
          requestId,
          bindingIds: created.bindings.map(({ bindingId }) => bindingId),
          leaseKind: input.leaseKind,
          grantSource: "access_request",
          baseRevision: store.getSnapshot(sessionAgentId).state.revision,
          expiresAt: expiresAt(input, this.now()),
        });
      });
      leaseCreated = true;
      this.cachedLeaseSecrets.set(leaseId, material);
      this.cachedLeaseOwners.set(leaseId, sessionAgentId);
      material = null;
      active.guard?.dispose();
      active.guard = prospectiveGuard;
      active.guardRequired = true;
      prospectiveGuard = null;
      this.scheduleLeaseExpiry(store, sessionAgentId);
      this.emitCatalog(store);
      const result = this.toPublicSnapshot(store, lease.snapshot);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    } catch (error) {
      if (leaseCreated) {
        await this.failClosedSession(store, descriptor);
      }
      throw this.publicError(error);
    } finally {
      prospectiveGuard?.dispose();
      material?.release();
      encryptedMaterial.fill(0);
    }
  }

  async getSecureSessionAgentView(callerAgentId: string): Promise<SecureSessionAgentView> {
    const principal = this.resolveSecurePrincipal(callerAgentId);
    const store = await this.store();
    const snapshot = await this.getSecureSessionSnapshot(principal.descriptor.agentId);
    const secrets = resolveVisibleSavedSecrets(store, principal.profileId)
      .map((secret) => this.toSecretSummary(store, secret))
      .filter((secret) => secret.available);
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
    this.resolveSecurePrincipal(callerAgentId);
    await this.withAuthorityMutation(async () => {
      await this.withSessionMutation(callerAgentId, async () => {
        const currentPrincipal = this.resolveSecurePrincipal(callerAgentId);
        await this.requestSecureSecretAccessUnlocked(
          currentPrincipal,
          input,
        );
      });
    });
  }

  private async requestSecureSecretAccessUnlocked(
    principal: SecurePrincipal,
    input: RequestSecureSecretAccessInput,
  ): Promise<void> {
    const store = await this.store();
    const sessionAgentId = principal.descriptor.agentId;
    const state = store.initializePrincipalState(
      sessionAgentId,
      principalStateInput(principal),
    );
    assertPrincipalStateMatches(principal, state);
    const secret = resolveVisibleSavedSecretByAlias(
      store,
      principal.profileId,
      bounded(input.displayAlias, 256),
    );
    if (secret) matchBindingIds(store.listBindings(secret.secretId), input.exposures);
    try {
      const snapshot = store.createRequest({
        requestId: this.id(),
        sessionAgentId,
        workerAssignmentId: principal.workerAssignmentId,
        secretId: secret?.secretId ?? null,
        displayAlias: bounded(input.displayAlias, 256),
        requestedExposures: input.exposures.map(toStoredExposure),
        requestedLeaseKind: input.leaseKind,
        requestedDurationSeconds: input.leaseKind === "timed"
          ? validateDuration(input.durationSeconds)
          : null,
        purposeSummary: bounded(input.purposeSummary, 2000),
        requestedByAgentId: principal.descriptor.agentId,
        requestedByDisplayName: bounded(principal.descriptor.displayName, 256),
        expiresAt: new Date(Date.parse(this.now()) + REQUEST_TTL_MS).toISOString(),
      });
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, snapshot)));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  getSecureRuntimeBinding(
    descriptor: AgentDescriptor,
    runtimeToken?: number,
  ): SecureRuntimeBinding | undefined {
    let principal: SecurePrincipal;
    try {
      principal = this.resolveSecurePrincipal(descriptor.agentId);
    } catch {
      return undefined;
    }
    const active = this.activeSessions.get(descriptor.agentId);
    if (!active || active.closed) return undefined;
    if (
      principal.principalKind === "worker"
      && active.task.taskId !== workerTaskId(
        descriptor.agentId,
        principal.workerAssignmentId!,
      )
    ) {
      return undefined;
    }
    const identity: SecureRuntimeBindingIdentity = {
      active,
      workerAssignmentId: principal.workerAssignmentId,
      runtimeToken,
      revoked: false,
    };
    const assertCurrentBinding = (): ActiveSession => {
      const current = this.activeSessions.get(descriptor.agentId);
      const currentDescriptor = this.options.getDescriptor(descriptor.agentId);
      const currentAssignmentId = currentDescriptor
        ? descriptorWorkerAssignmentId(currentDescriptor)
        : null;
      if (
        identity.revoked
        || !current
        || current !== identity.active
        || current.closed
        || currentAssignmentId !== identity.workerAssignmentId
      ) {
        throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
      }
      return current;
    };
    return {
      invalidate: () => {
        identity.revoked = true;
      },
      executeBash: (request) => {
        assertCurrentBinding();
        return this.executeSecureBash(descriptor, request, identity);
      },
      guardValue: <T>(value: T): T => {
        const current = assertCurrentBinding();
        if (
          current.guardRequired && !current.guard
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
    this.projectDefaultStatuses.clear();
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
    identity: SecureRuntimeBindingIdentity,
  ): Promise<{ exitCode: number | null }> {
    return await this.withSessionBashExecution(descriptor.agentId, async () => {
      let executionStarted = false;
      try {
        const prepared = await this.withAuthorityMutation(async () =>
          await this.withSessionMutation(
            descriptor.agentId,
            async () => {
              const result = await this.prepareSecureBashExecution(
                descriptor,
                request,
                identity,
              );
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
    identity: SecureRuntimeBindingIdentity,
  ): Promise<PreparedSecureBashExecution> {
    const sessionAgentId = descriptor.agentId;
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const stored = store.getSnapshot(sessionAgentId);
    const active = this.activeSessions.get(sessionAgentId);
    assertPrincipalStateMatches(principal, stored.state);
    if (
      stored.state.executionMode !== "secure"
      || stored.state.environmentStatus !== "ready"
      || !active
      || active !== identity.active
      || identity.revoked
      || active.closed
      || principal.workerAssignmentId !== identity.workerAssignmentId
      || (
        principal.principalKind === "worker"
        && active.task.taskId !== workerTaskId(
          sessionAgentId,
          principal.workerAssignmentId!,
        )
      )
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
        task: active.task,
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
      if (
        consumedOneUseLease
        && this.activeSessions.get(sessionAgentId) === active
        && !active.closed
      ) {
        await this.withAuthorityMutation(async () =>
          await this.withSessionMutation(sessionAgentId, async () =>
            await this.reconcileAfterLeaseLoss(
              store,
              [sessionAgentId],
              { waitForExecutions: false },
            )
          )
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

  private async prepareProjectDefaultsForStart(
    store: SecureSessionStore,
    descriptor: AgentDescriptor,
  ): Promise<PreparedProjectDefault[]> {
    const sessionAgentId = descriptor.agentId;
    const profileId = requireProfileId(descriptor);
    const configured = store.listProjectDefaults(profileId);
    const effectiveSecretIds = new Set(
      resolveVisibleSavedSecrets(store, profileId).map((secret) => secret.secretId),
    );
    const snapshot = store.getSnapshot(sessionAgentId);
    const occupiedBindingKeys = activeBindingCollisionKeys(store, snapshot);
    const statuses = new Map<string, SecureSessionProjectDefaultStatus>();
    this.projectDefaultStatuses.set(sessionAgentId, statuses);
    const prepared: PreparedProjectDefault[] = [];
    if (configured.length > SECURE_SECRET_MAX_PROJECT_DEFAULTS) {
      for (const projectDefault of configured) {
        const secret = store.getSecret(projectDefault.secretId);
        statuses.set(projectDefault.secretId, {
          secretId: projectDefault.secretId,
          displayAlias: secret?.displayAlias ?? "unavailable",
          state: "conflict",
          statusCode: "binding_conflict",
        });
      }
      return prepared;
    }
    try {
      for (const projectDefault of configured) {
        const secret = store.getSecret(projectDefault.secretId);
        const activeLease = snapshot.leases.find((lease) =>
          lease.state === "active"
          && lease.secretId === projectDefault.secretId
          && lease.grantSource === "project_default"
        );
        if (activeLease && secret) {
          statuses.set(projectDefault.secretId, {
            secretId: projectDefault.secretId,
            displayAlias: secret.displayAlias,
            state: "active",
            statusCode: "ok",
          });
          continue;
        }
        if (
          !secret
          || secret.retention !== "saved"
          || !effectiveSecretIds.has(secret.secretId)
        ) {
          statuses.set(projectDefault.secretId, {
            secretId: projectDefault.secretId,
            displayAlias: secret?.displayAlias ?? "unavailable",
            state: "conflict",
            statusCode: "binding_conflict",
          });
          continue;
        }
        const bindings = store.listBindings(secret.secretId);
        const bindingKeys = bindings.map((binding) =>
          bindingCollisionKey(toPublicBinding(binding))
        );
        if (
          bindings.length === 0
          || new Set(bindingKeys).size !== bindingKeys.length
          || bindingKeys.some((key) => occupiedBindingKeys.has(key))
        ) {
          statuses.set(secret.secretId, {
            secretId: secret.secretId,
            displayAlias: secret.displayAlias,
            state: "conflict",
            statusCode: "binding_conflict",
          });
          continue;
        }
        let material: HostOnlySecret;
        try {
          material = await this.resolveSecretMaterial(store, secret.secretId);
        } catch {
          statuses.set(secret.secretId, {
            secretId: secret.secretId,
            displayAlias: secret.displayAlias,
            state: "unavailable",
            statusCode: "source_unavailable",
          });
          continue;
        }
        for (const key of bindingKeys) occupiedBindingKeys.add(key);
        prepared.push({
          secretId: secret.secretId,
          displayAlias: secret.displayAlias,
          leaseId: this.id(),
          bindingIds: bindings.map((binding) => binding.bindingId),
          material,
        });
        statuses.set(secret.secretId, {
          secretId: secret.secretId,
          displayAlias: secret.displayAlias,
          state: "configured",
          statusCode: "ok",
        });
      }
      return prepared;
    } catch (error) {
      for (const item of prepared) item.material.release();
      throw error;
    }
  }

  private async applyProjectDefaultsToPrincipalUnlocked(
    store: SecureSessionStore,
    principal: SecurePrincipal,
  ): Promise<PublicSecureSessionSnapshot> {
    const sessionAgentId = principal.descriptor.agentId;
    const before = store.getSnapshot(sessionAgentId);
    assertPrincipalOwnerMatches(principal, before.state);
    const active = this.activeSessions.get(sessionAgentId);
    if (
      before.state.executionMode !== "secure"
      || (
        before.state.environmentStatus === "ready"
        && (!active || active.closed)
      )
      || (
        before.state.environmentStatus === "stopped"
        && active !== undefined
      )
      || !["ready", "stopped"].includes(before.state.environmentStatus)
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }

    const prepared = await this.prepareProjectDefaultsForStart(
      store,
      principal.descriptor,
    );
    let materialsTransferred = false;
    let environmentRebuilt = false;
    let failedClosed = false;
    try {
      if (prepared.length > 0 && active) {
        await this.rebuildEnvironmentForNewLease(
          store,
          principal.descriptor,
        );
        environmentRebuilt = true;
      }

      let storedSnapshot = store.getSnapshot(sessionAgentId);
      if (prepared.length > 0) {
        const created = store.createLeases({
          sessionAgentId,
          baseRevision: storedSnapshot.state.revision,
          grants: prepared.map((item) => ({
            leaseId: item.leaseId,
            secretId: item.secretId,
            bindingIds: item.bindingIds,
            leaseKind: "task",
            grantSource: "project_default",
            expiresAt: null,
          })),
        });
        for (const item of prepared) {
          this.cachedLeaseSecrets.set(item.leaseId, item.material);
          this.cachedLeaseOwners.set(item.leaseId, sessionAgentId);
          this.setProjectDefaultStatus(sessionAgentId, {
            secretId: item.secretId,
            displayAlias: item.displayAlias,
            state: "active",
            statusCode: "ok",
          });
        }
        materialsTransferred = true;
        storedSnapshot = created.snapshot;
        if (active) {
          try {
            await this.ensureGuardForActiveLeases(store, sessionAgentId);
          } catch (error) {
            failedClosed = true;
            await this.failClosedSession(store, principal.descriptor);
            throw error;
          }
        }
        this.scheduleLeaseExpiry(store, sessionAgentId);
      }

      const snapshot = this.toPublicSnapshot(store, storedSnapshot);
      this.options.emitSnapshot(toSnapshotEvent(snapshot));
      return snapshot;
    } catch (error) {
      if (environmentRebuilt && !failedClosed) {
        await this.failClosedSession(store, principal.descriptor);
        failedClosed = true;
      }
      if (!failedClosed) {
        this.options.emitSnapshot(toSnapshotEvent(
          this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId)),
        ));
      }
      throw this.publicError(error);
    } finally {
      if (!materialsTransferred) {
        for (const item of prepared) item.material.release();
      }
    }
  }

  private setProjectDefaultStatus(
    sessionAgentId: string,
    status: SecureSessionProjectDefaultStatus,
  ): void {
    const statuses = this.projectDefaultStatuses.get(sessionAgentId) ?? new Map();
    statuses.set(status.secretId, status);
    this.projectDefaultStatuses.set(sessionAgentId, statuses);
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
    let providerCredential: Buffer | null = null;
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
      providerCredential = config.encryptedAccessToken;
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
      providerCredential?.fill(0);
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
      const guard = this.createValueGuard(values);
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

  private async buildProspectiveGuard(
    sessionAgentId: string,
    additional: HostOnlySecret,
  ): Promise<SecureValueGuard> {
    const values: Buffer[] = [];
    try {
      for (const [leaseId, secret] of this.cachedLeaseSecrets) {
        if (this.cachedLeaseOwners.get(leaseId) !== sessionAgentId) continue;
        if (!secret.released) {
          await secret.withBytes((bytes) => values.push(Buffer.from(bytes)));
        }
      }
      await additional.withBytes((bytes) => values.push(Buffer.from(bytes)));
      return this.createValueGuard(values);
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
    const state = store.getSnapshot(descriptor.agentId).state;
    const task = this.activeSessions.get(descriptor.agentId)?.task
      ?? (
        state.principalKind === "worker"
        && state.workerAssignmentId === null
          ? undefined
          : toTask(descriptor, state.workerAssignmentId)
      );
    const destroyed = await this.options.execution
      .destroyTask(task ?? {
        taskId: descriptor.agentId,
        workspacePath: descriptor.cwd,
      })
      .catch(() => false);
    store.revokeSessionLeases(descriptor.agentId, "policy_changed");
    this.clearLeaseExpiryTimer(descriptor.agentId);
    this.releaseSession(descriptor.agentId);
    this.projectDefaultStatuses.delete(descriptor.agentId);
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
      await this.reconcileAfterLeaseLoss(
        store,
        [mutation.snapshot.state.sessionAgentId],
      );
      this.scheduleLeaseExpiry(store, mutation.snapshot.state.sessionAgentId);
      this.options.emitSnapshot(toSnapshotEvent(
        this.toPublicSnapshot(
          store,
          store.getSnapshot(mutation.snapshot.state.sessionAgentId),
        ),
      ));
    }
    for (const mutation of store.expireRequests(this.now(), sessionAgentId)) {
      this.options.emitSnapshot(toSnapshotEvent(
        this.toPublicSnapshot(store, mutation.snapshot),
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
      await this.withAuthorityMutation(async () =>
        await this.withSessionMutation(sessionAgentId, async () => {
          await this.expireAndPublish(store, sessionAgentId);
          this.scheduleLeaseExpiry(store, sessionAgentId);
        })
      );
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
      principalKind: snapshot.state.principalKind,
      ownerManagerAgentId: snapshot.state.ownerManagerAgentId,
      workerAssignmentId: snapshot.state.workerAssignmentId,
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
          grantSource: lease.grantSource,
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
        workerAssignmentId: request.workerAssignmentId,
        createdAt: request.requestedAt,
        expiresAt: request.expiresAt,
      })),
      projectDefaults: store.listProjectDefaults(snapshot.state.profileId)
        .map((projectDefault) => {
          const secret = store.getSecret(projectDefault.secretId);
          const recorded = this.projectDefaultStatuses
            .get(snapshot.state.sessionAgentId)
            ?.get(projectDefault.secretId);
          const active = snapshot.leases.some((lease) =>
            lease.state === "active"
            && lease.secretId === projectDefault.secretId
            && lease.grantSource === "project_default"
          );
          if (recorded && recorded.state !== "active") return recorded;
          if (recorded?.state === "active" && !active) {
            return {
              secretId: projectDefault.secretId,
              displayAlias: recorded.displayAlias,
              state: "configured",
              statusCode: "ok",
            };
          }
          if (recorded) return recorded;
          return {
            secretId: projectDefault.secretId,
            displayAlias: secret?.displayAlias ?? "unavailable",
            state: active ? "active" : "configured",
            statusCode: "ok",
          };
        }),
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

  private resolveSecurePrincipal(
    sessionAgentId: string,
    options: {
      allowLifecycleBlocked?: boolean;
      requireWorkerAssignment?: boolean;
    } = {},
  ): SecurePrincipal {
    const descriptor = this.options.getDescriptor(sessionAgentId);
    if (!descriptor) {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    if (isBuilderManager(descriptor)) {
      const manager = this.requireTeamManager(sessionAgentId, options);
      return {
        descriptor: manager,
        manager,
        profileId: requireProfileId(manager),
        principalKind: "manager",
        workerAssignmentId: null,
      };
    }
    if (!this.isEligibleSecureWorker(descriptor)) {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    const manager = this.requireTeamManager(descriptor.managerId, options);
    if (
      !this.isTeamSecureMode(manager.agentId)
      || descriptor.profileId !== manager.profileId
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    if (!options.allowLifecycleBlocked) {
      this.assertSessionLifecycleAvailable(
        descriptor.agentId,
        requireProfileId(manager),
        manager.agentId,
      );
    }
    const workerAssignmentId = descriptorWorkerAssignmentId(descriptor);
    if (
      options.requireWorkerAssignment !== false
      && workerAssignmentId === null
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    return {
      descriptor,
      manager,
      profileId: requireProfileId(manager),
      principalKind: "worker",
      workerAssignmentId,
    };
  }

  private requireTeamManager(
    sessionAgentId: string,
    options: { allowLifecycleBlocked?: boolean } = {},
  ): AgentDescriptor {
    let descriptor: AgentDescriptor;
    try {
      descriptor = this.options.requireBuilderSession(
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
    } catch {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    if (!options.allowLifecycleBlocked) {
      this.assertSessionLifecycleAvailable(
        sessionAgentId,
        requireProfileId(descriptor),
      );
    }
    return descriptor;
  }

  private isEligibleSecureWorker(descriptor: AgentDescriptor): boolean {
    if (
      descriptor.role !== "worker"
      || descriptor.archivedAt
      || descriptor.sessionSurface === "collab"
      || descriptor.collab
      || !descriptor.profileId
      || isExternalThreadDescriptor(descriptor)
      || isCodexPluginWorkerDescriptor(descriptor)
      || ["claude-sdk", "cursor-sdk", "cursor-acp"].includes(
        descriptor.model.provider,
      )
    ) {
      return false;
    }
    const manager = this.options.getDescriptor(descriptor.managerId);
    return isBuilderManager(manager)
      && manager.profileId === descriptor.profileId
      && !manager.archivedAt;
  }

  private listCurrentSecureTeamPrincipals(
    manager: AgentDescriptor,
  ): SecurePrincipal[] {
    const principals: SecurePrincipal[] = [{
      descriptor: manager,
      manager,
      profileId: requireProfileId(manager),
      principalKind: "manager",
      workerAssignmentId: null,
    }];
    for (const descriptor of this.options.listDescriptors()) {
      if (
        descriptor.managerId !== manager.agentId
        || !this.isEligibleSecureWorker(descriptor)
      ) {
        continue;
      }
      const workerAssignmentId = descriptorWorkerAssignmentId(descriptor);
      principals.push({
        descriptor,
        manager,
        profileId: requireProfileId(manager),
        principalKind: "worker",
        workerAssignmentId,
      });
    }
    return principals;
  }

  private listApplicableProjectDefaultPrincipals(
    store: SecureSessionStore,
    manager: AgentDescriptor,
  ): SecurePrincipal[] {
    const principals: SecurePrincipal[] = [];
    for (const state of store.listPrincipalStatesForManager(manager.agentId)) {
      if (state.executionMode !== "secure") continue;
      if (state.sessionAgentId === manager.agentId) {
        const active = this.activeSessions.get(manager.agentId);
        if (
          state.principalKind !== "manager"
          || state.environmentStatus !== "ready"
          || !active
          || active.closed
        ) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        principals.push({
          descriptor: manager,
          manager,
          profileId: requireProfileId(manager),
          principalKind: "manager",
          workerAssignmentId: null,
        });
        continue;
      }

      const descriptor = this.options.getDescriptor(state.sessionAgentId);
      if (
        !descriptor
        || !this.isEligibleSecureWorker(descriptor)
        || state.principalKind !== "worker"
        || state.ownerManagerAgentId !== manager.agentId
        || state.profileId !== manager.profileId
      ) {
        continue;
      }
      const active = this.activeSessions.get(descriptor.agentId);
      if (state.environmentStatus === "ready") {
        if (
          !active
          || active.closed
          || state.workerAssignmentId === null
          || active.task.taskId !== workerTaskId(
            descriptor.agentId,
            state.workerAssignmentId,
          )
          || descriptorWorkerAssignmentId(descriptor)
            !== state.workerAssignmentId
        ) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
      } else if (
        state.environmentStatus !== "stopped"
        || active
      ) {
        continue;
      }
      principals.push({
        descriptor,
        manager,
        profileId: requireProfileId(manager),
        principalKind: "worker",
        workerAssignmentId: state.workerAssignmentId,
      });
    }
    if (
      principals.length === 0
      || principals[0]?.descriptor.agentId !== manager.agentId
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    return principals;
  }

  private validateLifecycleFenceTarget(
    profileId: string,
    sessionAgentIds: readonly string[],
  ): void {
    if (!this.options.hasProfile(profileId) || sessionAgentIds.length === 0) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    this.assertProfileLifecycleAvailable(profileId);
    for (const sessionAgentId of sessionAgentIds) {
      const descriptor = this.options.getDescriptor(sessionAgentId);
      if (
        !descriptor
        || descriptor.role !== "manager"
        || descriptor.managerId !== descriptor.agentId
        || descriptor.profileId !== profileId
        || descriptor.sessionSurface === "collab"
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      this.assertSessionLifecycleAvailable(sessionAgentId, profileId);
    }
  }

  private assertProfileLifecycleAvailable(profileId: string): void {
    let archived: boolean;
    try {
      archived = this.options.isProfileArchived(profileId);
    } catch {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    if (
      archived
      || [...this.lifecycleFences.values()]
        .some((fence) => fence.profileId === profileId)
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
  }

  private assertSessionLifecycleAvailable(
    sessionAgentId: string,
    profileId: string,
    ownerManagerAgentId?: string,
  ): void {
    let archived: boolean;
    try {
      archived = this.options.isSessionArchived(sessionAgentId);
    } catch {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    if (
      archived
      || [...this.lifecycleFences.values()].some((fence) =>
        fence.profileId === profileId
        || fence.sessionAgentIds.has(sessionAgentId)
        || (
          ownerManagerAgentId !== undefined
          && fence.sessionAgentIds.has(ownerManagerAgentId)
        )
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    this.assertProfileLifecycleAvailable(profileId);
  }

  private assertScopeLifecycleAvailable(scope: {
    scopeKind: "instance" | "profile";
    profileId: string | null;
  }): void {
    if (scope.scopeKind === "profile" && scope.profileId) {
      this.assertProfileLifecycleAvailable(scope.profileId);
    }
  }

  private assertSecretMutationLifecycleAvailable(
    store: SecureSessionStore,
    secretIds: readonly string[],
  ): void {
    const wanted = new Set(secretIds);
    const profileIds = new Set<string>();
    for (const secretId of wanted) {
      const secret = store.getSecret(secretId);
      if (secret?.scopeKind === "profile" && secret.profileId) {
        profileIds.add(secret.profileId);
      }
    }
    for (const projectDefault of store.listProjectDefaults()) {
      if (wanted.has(projectDefault.secretId)) {
        profileIds.add(projectDefault.profileId);
      }
    }
    for (const profileId of profileIds) {
      this.assertProfileLifecycleAvailable(profileId);
    }
    for (const state of store.listSessionStates()) {
      if (!store.getSnapshot(state.sessionAgentId).leases.some((lease) =>
        lease.state === "active" && wanted.has(lease.secretId)
      )) {
        continue;
      }
      this.assertSessionLifecycleAvailable(
        state.sessionAgentId,
        state.profileId,
      );
    }
  }

  private requireExistingProfileScope(scope: {
    scopeKind: "instance" | "profile";
    profileId: string | null;
  }): void {
    if (
      scope.scopeKind === "profile"
      && (!scope.profileId || !this.options.hasProfile(scope.profileId))
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
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
    await this.reconcileAfterLeaseLoss(store, sessionIds);
  }

  private async reconcileAfterLeaseLoss(
    store: SecureSessionStore,
    sessionIds: readonly string[],
    options: { waitForExecutions?: boolean } = {},
  ): Promise<void> {
    for (const sessionAgentId of new Set(sessionIds)) {
      const hadActiveEnvironment = this.activeSessions.has(sessionAgentId);
      const hasRemainingAuthority = store.getSnapshot(sessionAgentId).leases
        .some((lease) => lease.state === "active");
      await this.deactivateEnvironmentAfterLeaseLoss(
        store,
        sessionAgentId,
        !hadActiveEnvironment || !hasRemainingAuthority,
        options.waitForExecutions,
      );
      if (hadActiveEnvironment && hasRemainingAuthority) {
        const state = store.getSnapshot(sessionAgentId).state;
        await this.startSecurePrincipalUnlocked(
          this.resolveSecurePrincipal(sessionAgentId),
          { baseRevision: state.revision },
          {
            emitSnapshot: false,
            attachProjectDefaults: false,
            recycleRuntime: false,
          },
        );
      }
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
    // The enclosing approval/grant operation already validated its caller
    // revision while holding authority and session serialization. Startup
    // recovery may legitimately normalize the persisted runtime row, so an
    // internal activation must not reinterpret that recovery-only revision as
    // a concurrent user mutation.
    await this.startSecurePrincipalUnlocked(
      this.resolveSecurePrincipal(descriptor.agentId),
      {},
      options,
    );
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

  private createValueGuard(values: readonly Uint8Array[]): SecureValueGuard {
    return this.options.createValueGuard?.(values) ?? new SecureValueGuard(values);
  }

  private publicError(error: unknown): SecureSessionsServiceError {
    if (error instanceof SecureSessionsServiceError) return error;
    if (error instanceof SecureSessionRevisionConflictError) {
      return new SecureSessionsServiceError("SECURE_STALE_REVISION");
    }
    if (error instanceof SecureSessionAliasConflictError) {
      return new SecureSessionsServiceError("SECURE_SECRET_ALIAS_CONFLICT");
    }
    if (error instanceof SecureSessionRequestExpiredError) {
      return new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
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

function toProjectDefaultSummary(input: {
  profileId: string;
  secretId: string;
  createdAt: string;
  updatedAt: string;
}): SecureSecretProjectDefaultSummary {
  return {
    profileId: input.profileId,
    secretId: input.secretId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function toSnapshotEvent(snapshot: PublicSecureSessionSnapshot): SecureSessionSnapshotEvent {
  return { type: "secure_session_snapshot", ...snapshot };
}

function toTask(
  descriptor: AgentDescriptor,
  workerAssignmentId: string | null = descriptorWorkerAssignmentId(descriptor),
): SecureExecutionTask {
  return {
    taskId: descriptor.role === "worker"
      ? workerTaskId(
          descriptor.agentId,
          workerAssignmentId
            ?? (() => {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            })(),
        )
      : descriptor.agentId,
    workspacePath: descriptor.cwd,
  };
}

function workerTaskId(workerAgentId: string, assignmentId: string): string {
  return `${workerAgentId}::${assignmentId}`;
}

function descriptorWorkerAssignmentId(
  descriptor: AgentDescriptor,
): string | null {
  if (descriptor.role !== "worker") return null;
  const context = (descriptor as AgentDescriptor & {
    workerParentContext?: { assignmentId?: unknown; completedAt?: unknown };
  }).workerParentContext;
  return typeof context?.assignmentId === "string"
    && context.assignmentId.trim().length > 0
    && context.completedAt === undefined
    ? context.assignmentId
    : null;
}

function isBuilderManager(
  descriptor: AgentDescriptor | undefined,
): descriptor is AgentDescriptor & { role: "manager"; profileId: string } {
  return Boolean(
    descriptor
    && descriptor.role === "manager"
    && descriptor.managerId === descriptor.agentId
    && descriptor.profileId
    && !descriptor.archivedAt
    && descriptor.sessionSurface !== "collab"
    && !descriptor.collab
    && !isExternalThreadDescriptor(descriptor),
  );
}

function assertPrincipalStateMatches(
  principal: SecurePrincipal,
  state: SecureSessionState,
): void {
  assertPrincipalOwnerMatches(principal, state);
  if (
    state.workerAssignmentId !== principal.workerAssignmentId
  ) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
}

function assertPrincipalOwnerMatches(
  principal: SecurePrincipal,
  state: SecureSessionState,
): void {
  if (
    state.sessionAgentId !== principal.descriptor.agentId
    || state.profileId !== principal.profileId
    || state.principalKind !== principal.principalKind
    || state.ownerManagerAgentId !== (
      principal.principalKind === "manager"
        ? null
        : principal.manager.agentId
    )
  ) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
}

function assertRequestAssignmentMatches(
  principal: SecurePrincipal,
  workerAssignmentId: SecureSessionRequest["workerAssignmentId"],
): void {
  if (workerAssignmentId !== principal.workerAssignmentId) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
}

function principalStateInput(
  principal: SecurePrincipal,
): Parameters<SecureSessionStore["initializePrincipalState"]>[1] {
  return principal.principalKind === "manager"
    ? {
        profileId: principal.profileId,
        principalKind: "manager",
        ownerManagerAgentId: null,
        workerAssignmentId: null,
        executionMode: "standard",
        environmentStatus: "stopped",
      }
    : {
        profileId: principal.profileId,
        principalKind: "worker",
        ownerManagerAgentId: principal.manager.agentId,
        workerAssignmentId: principal.workerAssignmentId,
        executionMode: "standard",
        environmentStatus: "stopped",
      };
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

function bindingInputToPublicBinding(binding: {
  deliveryKind: StoredBinding["deliveryKind"];
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
}): SecureSecretBinding {
  return toPublicBinding(binding as SecureSessionRequestedExposure);
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

function activeBindingCollisionKeys(
  store: SecureSessionStore,
  snapshot: StoredSnapshot,
): Set<string> {
  const result = new Set<string>();
  for (const lease of snapshot.leases) {
    if (lease.state !== "active") continue;
    for (const bindingId of lease.bindingIds) {
      const binding = store.getBinding(bindingId);
      if (binding) result.add(bindingCollisionKey(toPublicBinding(binding)));
    }
  }
  return result;
}

function assertPublicBindingCompatibility(
  store: SecureSessionStore,
  snapshot: StoredSnapshot,
  requested: readonly SecureSecretBinding[],
): void {
  const occupied = activeBindingCollisionKeys(store, snapshot);
  const proposed = new Set<string>();
  for (const binding of requested) {
    validateBinding(binding);
    const key = bindingCollisionKey(binding);
    if (occupied.has(key) || proposed.has(key)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    proposed.add(key);
  }
}

function assertProjectDefaultBindingCompatibility(
  store: SecureSessionStore,
  profileId: string,
  proposedSecretId: string,
  proposedBindings: readonly SecureSecretBinding[],
): void {
  const occupied = new Set<string>();
  for (const projectDefault of store.listProjectDefaults(profileId)) {
    if (projectDefault.secretId === proposedSecretId) continue;
    const secret = store.getSecret(projectDefault.secretId);
    if (!secret || secret.retention !== "saved" || !isVisibleTo(secret, profileId)) {
      continue;
    }
    for (const binding of store.listBindings(secret.secretId)) {
      occupied.add(bindingCollisionKey(toPublicBinding(binding)));
    }
  }
  const proposed = new Set<string>();
  for (const binding of proposedBindings) {
    validateBinding(binding);
    const key = bindingCollisionKey(binding);
    if (occupied.has(key) || proposed.has(key)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    proposed.add(key);
  }
}

function captureProjectDefaultLeases(
  store: SecureSessionStore,
  profileId: string,
  secretIds: readonly string[],
  options: { includeAllSecretLeases?: boolean } = {},
): { leaseIds: string[]; sessionIds: string[] } {
  const wanted = new Set(secretIds);
  const leaseIds: string[] = [];
  const sessionIds = new Set<string>();
  for (const state of store.listSessionStates()) {
    if (state.profileId !== profileId) continue;
    for (const lease of store.getSnapshot(state.sessionAgentId).leases) {
      if (
        lease.state !== "active"
        || !wanted.has(lease.secretId)
        || (!options.includeAllSecretLeases && lease.grantSource !== "project_default")
      ) {
        continue;
      }
      leaseIds.push(lease.leaseId);
      sessionIds.add(state.sessionAgentId);
    }
  }
  return { leaseIds, sessionIds: [...sessionIds] };
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

/**
 * Resolves the catalog that one project may name. A project-scoped secret is
 * an intentional override of an instance-scoped secret with the same alias.
 * The model sees one deterministic delivery recipe, never two ambiguous
 * candidates.
 */
function resolveVisibleSavedSecrets(
  store: SecureSessionStore,
  profileId: string,
): SecureSessionSecret[] {
  const byAlias = new Map<string, SecureSessionSecret>();
  for (const secret of store.listSecrets()) {
    if (secret.retention !== "saved" || !isVisibleTo(secret, profileId)) {
      continue;
    }
    const existing = byAlias.get(secret.displayAlias);
    if (!existing || (
      secret.scopeKind === "profile"
      && secret.profileId === profileId
      && existing.scopeKind === "instance"
    )) {
      byAlias.set(secret.displayAlias, secret);
    }
  }
  return [...byAlias.values()];
}

function resolveVisibleSavedSecretByAlias(
  store: SecureSessionStore,
  profileId: string,
  displayAlias: string,
): SecureSessionSecret | null {
  return resolveVisibleSavedSecrets(store, profileId)
    .find((secret) => secret.displayAlias === displayAlias) ?? null;
}

function assertDoesNotShadowConfiguredDefault(
  store: SecureSessionStore,
  scope: { scopeKind: "instance" | "profile"; profileId: string | null },
  displayAlias: string,
  excludedSecretId?: string,
): void {
  if (scope.scopeKind !== "profile" || !scope.profileId) return;
  const shadowed = store.listSecrets().find((secret) =>
    secret.secretId !== excludedSecretId
    && secret.scopeKind === "instance"
    && secret.retention === "saved"
    && secret.displayAlias === displayAlias
  );
  if (
    shadowed
    && store.listProjectDefaults(scope.profileId)
      .some((projectDefault) => projectDefault.secretId === shadowed.secretId)
  ) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
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
