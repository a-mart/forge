import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import path from "node:path";
import type {
  BitwardenPasswordManagerSettings,
  GrantSecureSecretLeaseInput,
  GrantSecureSecretLeaseRequest,
  GrantSecureSecretLeasesRequest,
  ResolveSecureSecretAccessRequest,
  ResolveSecureSshHostTrustRequest,
  SecureSecretBinding,
  SecureSecretAutomaticGrantPolicy,
  SecureSecretCatalogChangedEvent,
  SecureSecretProjectDefaultSummary,
  SecureSecretProviderSummary,
  SecureSecretProviderTestResult,
  SecureSecretSummary,
  SecureSshTrustedHostSummary,
  SecureBrowserPrivateEntryChallenge,
  SecureBrowserSealedPrivateEntry,
  SecureSessionReadiness,
  SecureSessionProjectDefaultStatus,
  SecureSessionExecutionIncident,
  SecureSessionSnapshot as PublicSecureSessionSnapshot,
  SecureSessionSnapshotEvent,
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferRequest,
  ImportSecureVaultTransferResult,
  UpdateBitwardenPasswordManagerCollectionsResult,
} from "@forge/protocol";
import {
  SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
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
import { SecureExecutionError } from "./execution/secure-execution-error.js";
import { normalizeSshAgentKeyMaterial } from "./execution/ssh-agent-key-material.js";
import { SECURE_OUTPUT_QUARANTINE, SecureValueGuard } from "./redaction/secure-value-guard.js";
import type { SecureRuntimeBinding } from "./runtime/secure-runtime-binding.js";
import { supportsSecureRuntimeProvider } from "./runtime/secure-runtime-provider-policy.js";
import type { AgentDescriptor } from "../types.js";
import type {
  FulfillSecureAccessRequestInput,
  ApplySecureSessionProjectDefaultsInput,
  ImportBitwardenSecureSecretInput,
  ConnectBitwardenPasswordManagerInput,
  ConnectBitwardenSecureSecretProviderInput,
  CreateLocalSecureSecretInput,
  CreateBitwardenPasswordManagerSecretInput,
  CreateSecureSshTrustedHostInput,
  RequestSecureSecretAccessInput,
  RequestSecureSshHostTrustInput,
  ReplaceBitwardenPasswordManagerCollectionsInput,
  SecureSessionAgentView,
  StartSecureSessionInput,
  StopSecureSessionInput,
  UpdateBitwardenSecureSecretProviderCredentialInput,
  UpdateBitwardenPasswordManagerCliInput,
  UnlockBitwardenPasswordManagerInput,
  UpdateSecureSecretInput,
  UpdateSecureSshTrustedHostInput,
} from "./secure-sessions-api.js";
import {
  SecureVaultTransferError,
  createSecureVaultTransfer,
  withOpenSecureVaultTransfer,
  type OpenSecureVaultTransferItem,
  type SecureVaultTransferSourceItem,
} from "./secure-vault-transfer.js";
import {
  SecureSessionsServiceError,
  type SecureSessionsServiceErrorCode,
} from "./secure-sessions-error.js";
import type { SecureVaultCipher } from "./sources/electron-safe-storage-client.js";
import type {
  BitwardenPasswordManagerCollection,
  BitwardenPasswordManagerSource,
  BitwardenPasswordManagerStatus,
} from "./sources/bitwarden-password-manager-source.js";
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
  SecureSessionSshAliasConflictError,
} from "./storage/secure-session-store.js";
import { isExternalThreadDescriptor } from "../external-thread-compatibility.js";
import { isCodexPluginWorkerDescriptor } from "../codex-app-server/codex-plugin-scope-service.js";
import type {
  SecureSessionBinding as StoredBinding,
  SecureSessionBitwardenCollection,
  SecureSessionLease,
  SecureSessionProvider,
  SecureSessionProjectDefault,
  SecureSessionRequest,
  SecureSessionRequestedExposure,
  SecureSessionSecret,
  SecureSessionSnapshot as StoredSnapshot,
  SecureSessionSshTrustRequest,
  SecureSessionState,
} from "./storage/types.js";
import {
  buildSecureSshConfig,
  buildSecureSshKnownHosts,
  normalizeProposedSshTrustedHost,
  normalizeSshTrustedHostInput,
  SECURE_SSH_RESERVED_BINDING_PREFIX,
  toPublicSshTrustedHost,
} from "./ssh-trusted-host.js";

const LOCAL_PROVIDER_ID = "forge-local-keychain";
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const MAX_TRUSTED_BROWSER_PRIVATE_ENTRY_BYTES = 256 * 1024;
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
    }): Promise<{ refreshedEncryptedCredential?: Buffer } | void>;
  };
  bitwardenPasswordManagerSource: BitwardenPasswordManagerSource;
  probeBitwarden: () => Promise<boolean>;
  execution: SecureExecutionBackend;
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  listDescriptors: () => Iterable<AgentDescriptor>;
  listProfiles: () => Iterable<{
    profileId: string;
    archivedAt?: string;
    profileType?: "user" | "system";
  }>;
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
  getMaxProjectDefaults?: () => number;
}

interface ActiveSession {
  task: SecureExecutionTask;
  bindingGeneration: string;
  guard: SecureValueGuard | null;
  guardRequired: boolean;
  closed: boolean;
}

interface SecureRuntimeBindingIdentity {
  authoritySessionAgentId: string;
  bindingGeneration: string;
  callerAgentId: string;
  workerAssignmentId: string | null;
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

interface PreparedVaultTransferImportItem {
  item: OpenSecureVaultTransferItem;
  currentCiphertext: Buffer;
  replacementCiphertext: Buffer | null;
}

interface PreparedSecureBashExecution {
  store: SecureSessionStore;
  reserved: ReservedLease[];
  resolved: ResolvedSecureSecretBinding[];
  guard: SecureValueGuard;
  active: ActiveSession;
  authorityDescriptor: AgentDescriptor;
  callerAgentId: string;
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
  profileId: string;
}

export class SecureSessionsService {
  private storePromise: Promise<SecureSessionStore> | null = null;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly cachedLeaseSecrets = new Map<string, HostOnlySecret>();
  private readonly cachedLeaseOwners = new Map<string, string>();
  private readonly outputStates = new Map<string, SecureOutputState>();
  private readonly executionIncidents = new Map<
    string,
    SecureSessionExecutionIncident
  >();
  private readonly projectDefaultStatuses = new Map<
    string,
    Map<string, SecureSessionProjectDefaultStatus>
  >();
  private readonly sessionExpiryTimers = new Map<string, NodeJS.Timeout>();
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

  private maxProjectDefaults(): number {
    const configured = this.options.getMaxProjectDefaults?.();
    if (
      typeof configured !== "number"
      || !Number.isSafeInteger(configured)
    ) {
      return SECURE_SECRET_MAX_PROJECT_DEFAULTS;
    }
    return Math.min(
      SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
      Math.max(1, configured),
    );
  }

  async getOccupiedProjectDefaultCount(): Promise<number> {
    const store = await this.store();
    let occupied = 0;
    for (const { profileId, archivedAt, profileType } of this.options.listProfiles()) {
      if (archivedAt || profileType === "system") continue;
      occupied = Math.max(
        occupied,
        this.listEffectiveProjectDefaultsForProfile(store, profileId).length,
      );
    }
    return occupied;
  }

  async notifySecureSecretSettingsChanged(): Promise<void> {
    const store = await this.store();
    store.bumpCatalogRevision();
    this.emitCatalog(store);
  }

  async isSecurePrivateEntryAvailable(): Promise<boolean> {
    try {
      await this.options.cipher.status();
      return true;
    } catch {
      return false;
    }
  }

  async createRemotePrivateEntryChallenge(
    deviceId: string,
  ): Promise<SecureBrowserPrivateEntryChallenge> {
    const createChallenge = this.options.cipher.createRemoteEntryChallenge;
    if (!createChallenge) {
      throw new SecureSessionsServiceError("SECURE_SOURCE_UNAVAILABLE");
    }
    try {
      return await createChallenge.call(
        this.options.cipher,
        remotePrivateEntryContext(deviceId),
      );
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async encryptRemotePrivateEntry(
    deviceId: string,
    sealedEntry: SecureBrowserSealedPrivateEntry,
  ): Promise<string> {
    const encryptRemoteEntry = this.options.cipher.encryptRemoteEntry;
    if (!encryptRemoteEntry) {
      throw new SecureSessionsServiceError("SECURE_SOURCE_UNAVAILABLE");
    }
    let encrypted: Buffer | null = null;
    try {
      encrypted = await encryptRemoteEntry.call(
        this.options.cipher,
        remotePrivateEntryContext(deviceId),
        sealedEntry,
      );
      return encrypted.toString("base64");
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encrypted?.fill(0);
    }
  }

  /**
   * Trusted HTTP browser entry is intentionally scoped to an approved browser
   * and reaches only the Electron-owned vault. The value never enters agent
   * state, normal tools, conversation history, or persisted catalog metadata.
   */
  async encryptTrustedBrowserPrivateEntry(
    encodedValue: string,
  ): Promise<string> {
    const plaintext = decodeTrustedBrowserPrivateEntry(encodedValue);
    let encrypted: Buffer | null = null;
    try {
      encrypted = await this.options.cipher.encrypt(plaintext);
      return encrypted.toString("base64");
    } catch (error) {
      throw this.publicError(error);
    } finally {
      plaintext.fill(0);
      encrypted?.fill(0);
    }
  }

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
    return [await this.getSecureSessionSnapshot(manager.agentId)];
  }

  async prepareWorkerForSecureTeam(workerAgentId: string): Promise<boolean> {
    const descriptor = this.options.getDescriptor(workerAgentId);
    if (!descriptor || !this.isEligibleSecureWorker(descriptor)) return false;
    const manager = this.options.getDescriptor(descriptor.managerId);
    if (!isBuilderManager(manager) || !this.isTeamSecureMode(manager.agentId)) {
      return false;
    }
    if (!isWorkspaceWithin(manager.cwd, descriptor.cwd)) return false;
    const active = this.activeSessions.get(manager.agentId);
    if (!active || active.closed) return false;
    const store = await this.store();
    const state = store.getSessionState(manager.agentId);
    return Boolean(
      state
      && state.executionMode === "secure"
      && state.environmentStatus === "ready",
    );
  }

  async advanceWorkerSecureAssignment(
    workerAgentId: string,
    assignmentId: string,
  ): Promise<void> {
    const normalizedAssignmentId = bounded(assignmentId, 256);
    const descriptor = this.options.getDescriptor(workerAgentId);
    if (!descriptor || !this.isEligibleSecureWorker(descriptor)) return;
    if (!this.isTeamSecureMode(descriptor.managerId)) return;
    if (
      descriptorWorkerAssignmentId(descriptor) !== normalizedAssignmentId
      || !isWorkspaceWithin(
        this.requireTeamManager(descriptor.managerId).cwd,
        descriptor.cwd,
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
  }

  private async cleanupLegacyWorkerSecurePrincipal(
    workerAgentId: string,
    options: {
      deleteState?: boolean;
      preservePendingRequests?: boolean;
    } = {},
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
            ? toLegacyWorkerTask(descriptor, state.workerAssignmentId)
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
        this.clearSessionExpiryTimer(workerAgentId);
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
    outcome: "archived" | "deleted" | "updated",
  ): Promise<void> {
    const normalizedFenceId = bounded(fenceId, 256);
    if (
      outcome !== "archived"
      && outcome !== "deleted"
      && outcome !== "updated"
    ) {
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
      // Password Manager sessions are intentionally process-memory-only. A
      // persisted "available" status can therefore never survive a Forge
      // restart, even though the collection selection and catalog metadata do.
      // Normalize it locally instead of invoking the CLI on the startup path.
      for (const provider of store.listProviders()) {
        if (
          provider.kind !== "bitwarden_password_manager"
          || (
            provider.status === "locked"
            && provider.lastStatusCode === "source_locked"
          )
        ) {
          continue;
        }
        store.updateProviderStatus({
          providerId: provider.providerId,
          status: "locked",
          lastStatusCode: "source_locked",
          lastVerifiedAt: this.now(),
        });
        catalogChanged = true;
      }
      const orphanedProfileIds = new Set<string>();
      for (const secret of store.listSecrets()) {
        if (secret.scopeKind !== "profile") continue;
        for (const profileId of secret.profileIds) {
          if (!this.options.hasProfile(profileId)) {
            orphanedProfileIds.add(profileId);
          }
        }
      }
      for (const projectDefault of store.listProjectDefaults()) {
        if (!this.options.hasProfile(projectDefault.profileId)) {
          orphanedProfileIds.add(projectDefault.profileId);
        }
      }
      for (const host of store.listSshTrustedHosts()) {
        if (!this.options.hasProfile(host.profileId)) {
          orphanedProfileIds.add(host.profileId);
        }
      }
      for (const profileId of orphanedProfileIds) {
        const deleted = store.deleteProjectSecretState(profileId);
        catalogChanged = (
          deleted.projectDefaultsDeleted > 0
          || deleted.secretsDeleted > 0
          || deleted.secretsUpdated > 0
          || deleted.trustedSshHostsDeleted > 0
        ) || catalogChanged;
      }
      for (const state of store.listSessionStates()) {
        store.revokeSessionLeases(state.sessionAgentId, "session_stopped");
        if (state.principalKind === "worker") {
          catalogChanged = this.deleteSessionSecrets(
            store,
            state.sessionAgentId,
          ) || catalogChanged;
          store.deleteSessionState(state.sessionAgentId);
          continue;
        }
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
        try {
          const store = await this.store();
          for (const state of store.listSessionStates()) {
            store.updateSessionRuntimeState({
              sessionAgentId: state.sessionAgentId,
              profileId: state.profileId,
              executionMode: "standard",
              environmentStatus: "degraded",
            });
          }
        } finally {
          this.startupRecoveryPromise = null;
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

  async exportSecureVaultTransfer(): Promise<ExportSecureVaultTransferResult> {
    return await this.withAuthorityMutation(async () => {
      const ownedCiphertexts: Buffer[] = [];
      try {
        await this.options.cipher.status();
        const store = await this.store();
        const items: SecureVaultTransferSourceItem[] = [];

        for (const secret of store.listSecrets()) {
          if (secret.retention !== "saved") continue;
          const provider = store.getProvider(secret.providerId);
          if (provider?.kind !== "local_keychain") continue;
          const encrypted = store.getEncryptedSecret(secret.secretId);
          const expectedCiphertext = encrypted?.encryptedMaterial ?? null;
          if (!encrypted || !expectedCiphertext) {
            encrypted?.encryptedMaterial?.fill(0);
            throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
          }
          ownedCiphertexts.push(expectedCiphertext);
          items.push({
            kind: "local_secret",
            recordId: secret.secretId,
            expectedCiphertext,
            resolveMaterial: async () => {
              const resolution = await this.options.localSource.resolve({
                sourceLocator: encrypted.sourceLocator,
                encryptedMaterial: expectedCiphertext,
              });
              resolution.refreshedEncryptedMaterial?.fill(0);
              return resolution.material;
            },
          });
        }

        for (const provider of store.listProviders()) {
          if (provider.kind !== "bitwarden_secrets_manager") continue;
          const config = store.getProviderBackendConfig(provider.providerId);
          if (!config) continue;
          ownedCiphertexts.push(config.encryptedAccessToken);
          items.push({
            kind: "provider_credential",
            recordId: provider.providerId,
            expectedCiphertext: config.encryptedAccessToken,
            resolveMaterial: async () => {
              const decrypted = await this.options.cipher.decrypt(
                config.encryptedAccessToken,
              );
              decrypted.reEncryptedCiphertext?.fill(0);
              return decrypted.material;
            },
          });
        }

        return await createSecureVaultTransfer(items, this.now());
      } catch (error) {
        throw this.publicError(error);
      } finally {
        for (const ciphertext of ownedCiphertexts) ciphertext.fill(0);
      }
    });
  }

  async importSecureVaultTransfer(
    input: ImportSecureVaultTransferRequest,
  ): Promise<ImportSecureVaultTransferResult> {
    return await this.withAuthorityMutation(async () => {
      try {
        await this.options.cipher.status();
        const store = await this.store();
        return await withOpenSecureVaultTransfer(
          input.bundle,
          input.transferCode,
          async (items) => await this.importOpenVaultTransferItems(store, items),
        );
      } catch (error) {
        throw this.publicError(error);
      }
    });
  }

  async listSecureSshTrustedHosts(): Promise<SecureSshTrustedHostSummary[]> {
    const store = await this.store();
    return store.listSshTrustedHosts()
      .filter((host) =>
        this.options.hasProfile(host.profileId)
        && !this.options.isProfileArchived(host.profileId)
      )
      .map(toPublicSshTrustedHost);
  }

  async createSecureSshTrustedHost(
    input: CreateSecureSshTrustedHostInput,
  ): Promise<SecureSshTrustedHostSummary> {
    return await this.withAuthorityMutation(async () => {
      const profileId = bounded(input.profileId, 256);
      this.requireActiveProfile(profileId);
      let normalized: ReturnType<typeof normalizeSshTrustedHostInput>;
      try {
        normalized = normalizeSshTrustedHostInput(input);
      } catch {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      try {
        const store = await this.store();
        const host = store.putSshTrustedHost({
          trustedHostId: this.id(),
          profileId,
          ...normalized,
        });
        this.emitCatalog(store);
        return toPublicSshTrustedHost(host);
      } catch (error) {
        throw this.publicError(error);
      }
    });
  }

  async updateSecureSshTrustedHost(
    trustedHostId: string,
    input: UpdateSecureSshTrustedHostInput,
  ): Promise<SecureSshTrustedHostSummary> {
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const existing = store.getSshTrustedHost(
        bounded(trustedHostId, 256),
      );
      if (!existing) {
        throw new SecureSessionsServiceError("SECURE_SSH_HOST_NOT_FOUND");
      }
      this.requireActiveProfile(existing.profileId);
      let normalized: ReturnType<typeof normalizeSshTrustedHostInput>;
      try {
        normalized = normalizeSshTrustedHostInput({
          alias: input.alias ?? existing.alias,
          hostName: input.hostName ?? existing.hostName,
          port: input.port ?? existing.port,
          username: input.username ?? existing.username,
          hostKey:
            input.hostKey
            ?? `${existing.hostKeyAlgorithm} ${existing.hostKeyBase64}`,
        });
      } catch {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      try {
        const host = store.putSshTrustedHost({
          trustedHostId: existing.trustedHostId,
          profileId: existing.profileId,
          ...normalized,
        });
        this.emitCatalog(store);
        return toPublicSshTrustedHost(host);
      } catch (error) {
        throw this.publicError(error);
      }
    });
  }

  async deleteSecureSshTrustedHost(trustedHostId: string): Promise<boolean> {
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const existing = store.getSshTrustedHost(
        bounded(trustedHostId, 256),
      );
      if (!existing) return false;
      this.requireActiveProfile(existing.profileId);
      const deleted = store.deleteSshTrustedHost(existing.trustedHostId);
      if (deleted) this.emitCatalog(store);
      return deleted;
    });
  }

  async getSecureSessionReadiness(): Promise<SecureSessionReadiness> {
    try {
      return this.toSecureSessionReadiness(
        await this.options.execution.probe(),
      );
    } catch {
      return { available: false, code: "backend_unavailable" };
    }
  }

  async installSecureRunner(): Promise<SecureSessionReadiness> {
    try {
      const installRunner = this.options.execution.installRunner;
      if (installRunner === undefined) {
        return { available: false, code: "unsupported_platform" };
      }
      return this.toSecureSessionReadiness(
        await installRunner.call(this.options.execution),
      );
    } catch {
      return { available: false, code: "image_unavailable" };
    }
  }

  private toSecureSessionReadiness(
    result: Awaited<ReturnType<SecureExecutionBackend["probe"]>>,
  ): SecureSessionReadiness {
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
        const testedCredential = await this.options.bitwardenSource.testConnection({
          encryptedCredential: encryptedAccessToken,
          endpointOrigin: serverOrigin,
        });
        try {
          const credentialToStore =
            testedCredential?.refreshedEncryptedCredential ?? encryptedAccessToken;
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
              encryptedAccessToken: credentialToStore,
            });
            config.encryptedAccessToken.fill(0);
          } catch (error) {
            store.deleteProvider(providerId);
            throw error;
          }
          this.emitCatalog(store);
          return toProviderSummary(provider);
        } finally {
          testedCredential?.refreshedEncryptedCredential?.fill(0);
        }
      });
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedAccessToken.fill(0);
    }
  }

  async connectBitwardenPasswordManager(
    input: ConnectBitwardenPasswordManagerInput,
  ): Promise<SecureSecretProviderSummary> {
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const existing = store.listProviders().find(
          (provider) => provider.kind === "bitwarden_password_manager",
        );
        const status = await this.options.bitwardenPasswordManagerSource.status(null);
        const providerStatus = passwordManagerProviderStatus(status.state);
        const provider = store.upsertProvider({
          providerId: existing?.providerId ?? this.id(),
          kind: "bitwarden_password_manager",
          displayName: bounded(input.displayName, 256),
          enabled: true,
          ...providerStatus,
          lastVerifiedAt: this.now(),
        });
        this.emitCatalog(store);
        return toProviderSummary(provider);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async getBitwardenPasswordManagerSettings(
    providerId: string,
  ): Promise<BitwardenPasswordManagerSettings> {
    try {
      const store = await this.store();
      const provider = store.getProvider(providerId);
      if (!provider || provider.kind !== "bitwarden_password_manager") {
        throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      }
      const cached = this.options.bitwardenPasswordManagerSource.getCachedMetadata(
        provider.cliExecutablePath,
      );
      if (provider.status === "available" && cached) {
        // Display metadata is not an authorization decision. Read current
        // selections from the store without queuing CLI work ahead of starts.
        return await this.buildBitwardenPasswordManagerSettings(
          store, providerId, cached.status, cached.collections,
        );
      }
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider || provider.kind !== "bitwarden_password_manager") {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        // Another reader or unlock may have populated metadata while queued.
        const cached = this.options.bitwardenPasswordManagerSource.getCachedMetadata(
          provider.cliExecutablePath,
        );
        if (provider.status === "available" && cached) {
          return await this.buildBitwardenPasswordManagerSettings(
            store, providerId, cached.status, cached.collections,
          );
        }
        const status = await this.options.bitwardenPasswordManagerSource.status(
          provider.cliExecutablePath,
        );
        const next = passwordManagerProviderStatus(status.state);
        if (
          provider.status !== next.status
          || provider.lastStatusCode !== next.lastStatusCode
        ) {
          store.updateProviderStatus({
            providerId,
            ...next,
            lastVerifiedAt: this.now(),
          });
          this.emitCatalog(store);
        }
        return await this.buildBitwardenPasswordManagerSettings(
          store,
          providerId,
          status,
        );
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async unlockBitwardenPasswordManager(
    providerId: string,
    input: UnlockBitwardenPasswordManagerInput,
  ): Promise<BitwardenPasswordManagerSettings> {
    const encryptedMasterPassword = decodeCiphertext(input.encryptedMasterPassword);
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider || provider.kind !== "bitwarden_password_manager") {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        const status = await this.options.bitwardenPasswordManagerSource.unlock(
          encryptedMasterPassword,
          provider.cliExecutablePath,
        );
        store.updateProviderStatus({
          providerId,
          status: "available",
          lastStatusCode: "ok",
          lastVerifiedAt: this.now(),
        });
        this.emitCatalog(store);
        return await this.buildBitwardenPasswordManagerSettings(
          store,
          providerId,
          status,
        );
      });
    } catch (error) {
      throw this.publicError(error);
    } finally {
      encryptedMasterPassword.fill(0);
    }
  }

  async lockBitwardenPasswordManager(
    providerId: string,
  ): Promise<SecureSecretProviderSummary> {
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider || provider.kind !== "bitwarden_password_manager") {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        const secretIds = store.listSecrets(providerId).map(
          (secret) => secret.secretId,
        );
        this.assertSecretMutationLifecycleAvailable(store, secretIds);
        const initiallyAffected = this.captureAffectedLeases(store, secretIds);
        return await this.withSessionMutations(
          initiallyAffected.sessionIds,
          async () => {
            const affected = this.captureAffectedLeases(store, secretIds);
            await this.options.bitwardenPasswordManagerSource.lock()
              .catch(() => undefined);
            const updated = store.updateProviderStatus({
              providerId,
              status: "locked",
              lastStatusCode: "source_locked",
              lastVerifiedAt: this.now(),
              revokeLeases: true,
            });
            if (!updated) {
              throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
            }
            this.releaseLeases(affected.leaseIds);
            await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
            this.emitCatalog(store);
            this.emitSessionSnapshots(store, affected.sessionIds);
            return toProviderSummary(updated);
          },
        );
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async installBitwardenPasswordManagerCli(
    providerId: string,
  ): Promise<BitwardenPasswordManagerSettings> {
    return await this.mutateBitwardenPasswordManagerCli(
      providerId,
      null,
      async () => await this.options.bitwardenPasswordManagerSource.installCli(),
    );
  }

  async updateBitwardenPasswordManagerCli(
    providerId: string,
    input: UpdateBitwardenPasswordManagerCliInput,
  ): Promise<BitwardenPasswordManagerSettings> {
    const executablePath = input.executablePath === null
      ? null
      : bounded(input.executablePath, 4096);
    return await this.mutateBitwardenPasswordManagerCli(
      providerId,
      executablePath,
      async () => await this.options.bitwardenPasswordManagerSource.status(
        executablePath,
      ),
    );
  }

  async replaceBitwardenPasswordManagerCollections(
    providerId: string,
    input: ReplaceBitwardenPasswordManagerCollectionsInput,
  ): Promise<UpdateBitwardenPasswordManagerCollectionsResult> {
    const requestedIds = normalizeProviderIds(input.collectionIds, 64);
    return await this.withAuthorityMutation(async () => {
      const store = await this.store();
      const provider = store.getProvider(providerId);
      if (!provider || provider.kind !== "bitwarden_password_manager") {
        throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      }
      try {
        const status = await this.options.bitwardenPasswordManagerSource.status(
          provider.cliExecutablePath,
        );
        assertPasswordManagerAvailable(status.state);
        await this.options.bitwardenPasswordManagerSource.sync();
        const availableCollections =
          await this.options.bitwardenPasswordManagerSource.listCollections();
        const availableById = new Map(
          availableCollections.map((collection) => [collection.id, collection]),
        );
        const selectedCollections = requestedIds.map((collectionId) => {
          const collection = availableById.get(collectionId);
          if (!collection) {
            throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
          }
          return collection;
        });
        const items = requestedIds.length === 0
          ? []
          : await this.options.bitwardenPasswordManagerSource.listItems(requestedIds);
        const existingSecrets = store.listSecrets(providerId);
        this.assertSecretMutationLifecycleAvailable(
          store,
          existingSecrets.map((secret) => secret.secretId),
        );
        const initiallyAffected = this.captureAffectedLeases(
          store,
          existingSecrets.map((secret) => secret.secretId),
        );
        return await this.withSessionMutations(
          initiallyAffected.sessionIds,
          async () => {
            const affected = this.captureAffectedLeases(
              store,
              existingSecrets.map((secret) => secret.secretId),
            );
            let addedSecrets = 0;
            let removedSecrets = 0;
            store.withTransaction(() => {
              store.replaceBitwardenCollections({
                providerId,
                collections: selectedCollections.map((collection) => ({
                  collectionId: collection.id,
                  organizationId: collection.organizationId,
                  name: collection.name,
                })),
              });
              const itemIds = new Set(items.map((item) => item.id));
              for (const secret of existingSecrets) {
                if (itemIds.has(secret.sourceLocator)) continue;
                if (store.deleteSecret(secret.secretId)) removedSecrets += 1;
              }
              const existingByLocator = new Map(
                existingSecrets.map((secret) => [secret.sourceLocator, secret]),
              );
              const usedAliases = new Set(
                store.listSecrets().map((secret) => secret.displayAlias),
              );
              for (const item of items) {
                const existing = existingByLocator.get(item.id);
                if (existing) {
                  if (
                    existing.displayName !== item.name
                    || existing.username !== item.username
                  ) {
                    store.updateSecretWithBindings({
                      secret: {
                        secretId: existing.secretId,
                        providerId: existing.providerId,
                        displayAlias: existing.displayAlias,
                        displayName: item.name,
                        username: item.username,
                        note: existing.note,
                        scopeKind: existing.scopeKind,
                        profileId: existing.profileId,
                        profileIds: existing.profileIds,
                        retention: existing.retention,
                        sourceLocator: existing.sourceLocator,
                        encryptedMaterial: null,
                      },
                      bindings: existing.bindings.map(toBindingInput),
                    });
                  }
                  continue;
                }
                const secretId = this.id();
                const displayAlias = uniquePasswordManagerAlias(
                  item.name,
                  item.id,
                  usedAliases,
                );
                usedAliases.add(displayAlias);
                store.createSecretWithBindings({
                  secret: {
                    secretId,
                    providerId,
                    displayAlias,
                    displayName: item.name,
                    username: item.username,
                    note: null,
                    scopeKind: "instance",
                    profileId: null,
                    profileIds: [],
                    retention: "saved",
                    sourceLocator: item.id,
                    encryptedMaterial: null,
                  },
                  bindings: normalizeBindings(
                    [defaultSecureSecretBinding(secretId, displayAlias)],
                    this.id.bind(this),
                  ),
                });
                addedSecrets += 1;
              }
            });
            this.releaseLeases(affected.leaseIds);
            await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
            this.emitCatalog(store);
            this.emitSessionSnapshots(store, affected.sessionIds);
            return {
              settings: await this.buildBitwardenPasswordManagerSettings(
                store,
                providerId,
                status,
                availableCollections,
              ),
              addedSecrets,
              removedSecrets,
            };
          },
        );
      } catch (error) {
        if (error instanceof SecureSourceError) {
          const next = providerStatusForError(error);
          store.updateProviderStatus({
            providerId,
            ...next,
            lastVerifiedAt: this.now(),
          });
          this.emitCatalog(store);
        }
        throw this.publicError(error);
      }
    });
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
              try {
                if (
                  resolution.refreshedEncryptedMaterial
                  && encrypted.encryptedMaterial
                ) {
                  store.rotateEncryptedSecretMaterial({
                    secretId: encrypted.secretId,
                    expectedEncryptedMaterial: encrypted.encryptedMaterial,
                    encryptedMaterial: resolution.refreshedEncryptedMaterial,
                  });
                }
              } finally {
                resolution.refreshedEncryptedMaterial?.fill(0);
                resolution.material.release();
              }
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
        } else if (provider.kind === "bitwarden_secrets_manager") {
          const config = store.getProviderBackendConfig(providerId);
          if (!config) throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
          try {
            const testedCredential = await this.options.bitwardenSource.testConnection({
              encryptedCredential: config.encryptedAccessToken,
              endpointOrigin: config.serverOrigin,
            });
            try {
              if (testedCredential?.refreshedEncryptedCredential) {
                store.rotateProviderBackendCredential({
                  providerId,
                  expectedEncryptedAccessToken: config.encryptedAccessToken,
                  encryptedAccessToken:
                    testedCredential.refreshedEncryptedCredential,
                });
              }
            } finally {
              testedCredential?.refreshedEncryptedCredential?.fill(0);
            }
          } finally {
            config.encryptedAccessToken.fill(0);
          }
        } else {
          const passwordManagerStatus =
            await this.options.bitwardenPasswordManagerSource.status(
              provider.cliExecutablePath,
            );
          assertPasswordManagerAvailable(passwordManagerStatus.state);
          await this.options.bitwardenPasswordManagerSource.sync();
          await this.options.bitwardenPasswordManagerSource.listCollections();
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

        const testedCredential = await this.options.bitwardenSource.testConnection({
          encryptedCredential: encryptedAccessToken,
          endpointOrigin: config.serverOrigin,
        });
        const credentialToStore =
          testedCredential?.refreshedEncryptedCredential ?? encryptedAccessToken;

        try {
          const secretIds = store.listSecrets(providerId).map((secret) => secret.secretId);
          this.assertSecretMutationLifecycleAvailable(store, secretIds);
          const initiallyAffected = this.captureAffectedLeases(store, secretIds);
          return await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
            const affected = this.captureAffectedLeases(store, secretIds);
            const updated = store.replaceProviderBackendCredential({
              providerId,
              encryptedAccessToken: credentialToStore,
              lastVerifiedAt: this.now(),
            });
            this.releaseLeases(affected.leaseIds);
            await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
            this.emitCatalog(store);
            this.emitSessionSnapshots(store, affected.sessionIds);
            return toProviderSummary(updated);
          });
        } finally {
          testedCredential?.refreshedEncryptedCredential?.fill(0);
        }
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
      const provider = store.getProvider(providerId);
      const secretIds = store.listSecrets(providerId).map((secret) => secret.secretId);
      this.assertSecretMutationLifecycleAvailable(store, secretIds);
      const initiallyAffected = this.captureAffectedLeases(store, secretIds);
      await this.withSessionMutations(initiallyAffected.sessionIds, async () => {
        const affected = this.captureAffectedLeases(store, secretIds);
        if (provider?.kind === "bitwarden_password_manager") {
          await this.options.bitwardenPasswordManagerSource.lock().catch(() => undefined);
        }
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
        || !this.isAllProjectAutomaticGrantEligible(normalizedProfileId)
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      const store = await this.store();
      const secret = resolveVisibleSavedSecrets(store, normalizedProfileId)
        .find((candidate) => candidate.secretId === normalizedSecretId);
      const current = store.getAutomaticGrantPolicy(normalizedSecretId);
      if (!secret && current.kind === "none") {
        throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
      }
      if (current.kind === "all_projects") {
        if (!input.enabled) {
          throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
        }
        const effective = this.listEffectiveProjectDefaultsForProfile(
          store,
          normalizedProfileId,
        )
          .find((projectDefault) => projectDefault.secretId === normalizedSecretId);
        return effective ? toProjectDefaultSummary(effective) : null;
      }
      const currentProfileIds = current.kind === "projects"
        ? current.profileIds
        : [];
      const nextProfileIds = input.enabled
        ? [...new Set([...currentProfileIds, normalizedProfileId])]
        : currentProfileIds.filter((profileId) => profileId !== normalizedProfileId);
      await this.replaceSecureSecretAutomaticGrantPolicyUnlocked(
        normalizedSecretId,
        nextProfileIds.length === 0
          ? { kind: "none" }
          : { kind: "projects", profileIds: nextProfileIds },
      );
      if (!input.enabled) return null;
      const effective = this.listEffectiveProjectDefaultsForProfile(
        store,
        normalizedProfileId,
      )
        .find((projectDefault) => projectDefault.secretId === normalizedSecretId);
      return effective ? toProjectDefaultSummary(effective) : null;
    });
  }

  async replaceSecureSecretAutomaticGrantPolicy(
    secretId: string,
    policy: SecureSecretAutomaticGrantPolicy,
  ): Promise<SecureSecretSummary> {
    return await this.withAuthorityMutation(() =>
      this.replaceSecureSecretAutomaticGrantPolicyUnlocked(secretId, policy)
    );
  }

  private async replaceSecureSecretAutomaticGrantPolicyUnlocked(
    secretId: string,
    policy: SecureSecretAutomaticGrantPolicy,
  ): Promise<SecureSecretSummary> {
    const normalizedSecretId = bounded(secretId, 256);
    const store = await this.store();
    const secret = store.getSecret(normalizedSecretId);
    if (!secret || secret.retention !== "saved") {
      throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
    }
    const profiles = [...this.options.listProfiles()];
    const knownProfiles = new Map(
      profiles.map((profile) => [
        profile.profileId,
        profile,
      ]),
    );
      const userProjectProfiles = profiles.filter((profile) =>
        profile.profileType !== "system"
      );
      const activeProjectProfiles = userProjectProfiles.filter((profile) =>
        !profile.archivedAt
      );
    const requestedProfileIds = policy.kind === "projects"
      ? [...new Set(policy.profileIds)].sort()
      : [];
    if (
      policy.kind === "projects"
      && (
        requestedProfileIds.length !== policy.profileIds.length
        || requestedProfileIds.some((profileId) => {
          const profile = knownProfiles.get(profileId);
          return !profile || Boolean(profile.archivedAt)
            || profile.profileType === "system";
        })
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const normalizedPolicy: SecureSecretAutomaticGrantPolicy =
      policy.kind === "projects" && requestedProfileIds.length === 0
        ? { kind: "none" }
        : policy.kind === "projects"
          ? { kind: "projects", profileIds: requestedProfileIds }
          : policy;
    if (
      JSON.stringify(store.getAutomaticGrantPolicy(normalizedSecretId))
      === JSON.stringify(normalizedPolicy)
    ) {
      return this.toSecretSummary(store, secret);
    }
    if (
      secret.scopeKind === "profile"
      && (
        policy.kind === "all_projects"
        || requestedProfileIds.some(
          (profileId) => !secret.profileIds.includes(profileId)
        )
      )
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const targetProfileIds = policy.kind === "all_projects"
      ? userProjectProfiles.map(({ profileId }) => profileId)
      : requestedProfileIds;
    if (policy.kind === "all_projects") {
      if (
        store.listAllProjectDefaults()
          .filter((projectDefault) =>
            projectDefault.secretId !== normalizedSecretId
          ).length >= this.maxProjectDefaults()
      ) {
        throw new SecureSessionsServiceError(
          "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
        );
      }
      assertProjectDefaultBindingCompatibility(
        store,
        "__all_projects_policy__",
        normalizedSecretId,
        store.listBindings(normalizedSecretId).map(toPublicBinding),
      );
    }
    for (const profileId of targetProfileIds) {
      const effectiveWithoutSecret = this.listEffectiveProjectDefaultsForProfile(
        store,
        profileId,
      )
        .filter((projectDefault) => projectDefault.secretId !== normalizedSecretId);
      if (effectiveWithoutSecret.length >= this.maxProjectDefaults()) {
        throw new SecureSessionsServiceError(
          "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
        );
      }
      assertProjectDefaultBindingCompatibility(
        store,
        profileId,
        normalizedSecretId,
        store.listBindings(normalizedSecretId).map(toPublicBinding),
        this.listEffectiveProjectDefaultsForProfile(store, profileId),
      );
    }
    if (policy.kind === "projects") {
      for (const profileId of targetProfileIds) {
        this.assertProfileLifecycleAvailable(profileId);
      }
    } else {
      for (const { profileId } of activeProjectProfiles) {
        this.assertProfileLifecycleAvailable(profileId);
      }
    }
    const affected = captureProjectDefaultLeasesForSecret(
      store,
      normalizedSecretId,
    );
    return await this.withSessionMutations(affected.sessionIds, async () => {
      try {
        store.replaceAutomaticGrantPolicy({
          secretId: normalizedSecretId,
          policy: normalizedPolicy,
        });
      } catch (error) {
        throw this.publicError(error);
      }
      this.releaseLeases(affected.leaseIds);
      for (const sessionAgentId of affected.sessionIds) {
        this.projectDefaultStatuses.get(sessionAgentId)?.delete(normalizedSecretId);
      }
      await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
      this.emitCatalog(store);
      this.emitSessionSnapshots(store, affected.sessionIds);
      return this.toSecretSummary(store, store.getSecret(normalizedSecretId)!);
    });
  }

  async deleteSecureSecretProjectState(profileId: string): Promise<void> {
    await this.withAuthorityMutation(async () => {
      const normalizedProfileId = bounded(profileId, 256);
      const store = await this.store();
      const scopedSecretIds = store.listSecrets()
          .filter((secret) =>
            secret.scopeKind === "profile"
            && secret.profileIds.includes(normalizedProfileId)
          )
          .map((secret) => secret.secretId);
      const defaultSecretIds = this.listEffectiveProjectDefaultsForProfile(
        store,
        normalizedProfileId,
      )
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
          && result.secretsUpdated === 0
          && result.trustedSshHostsDeleted === 0
          && affected.leaseIds.length === 0
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
        assertDoesNotShadowConfiguredDefault(
          store,
          scope,
          displayAlias,
          undefined,
          (profileId) => this.isAllProjectAutomaticGrantEligible(profileId),
        );
        const result = store.createSecretWithBindings({
          secret: {
            secretId,
            providerId: LOCAL_PROVIDER_ID,
            displayAlias,
            displayName: optionalBounded(input.displayName, 256),
            username: optionalBounded(input.username, 512),
            note: optionalBounded(input.note, 2_000),
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

  async createBitwardenPasswordManagerSecret(
    providerId: string,
    input: CreateBitwardenPasswordManagerSecretInput,
  ): Promise<SecureSecretSummary> {
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        const collection = store.listBitwardenCollections(providerId)
          .find((candidate) => candidate.collectionId === input.collectionId);
        if (
          provider?.kind !== "bitwarden_password_manager"
          || !provider.enabled
          || provider.status !== "available"
          || !collection
        ) {
          throw new SecureSessionsServiceError("SECURE_SOURCE_UNAVAILABLE");
        }
        const secretId = this.id();
        const displayAlias = bounded(input.displayAlias, 256);
        const displayName = optionalBounded(input.displayName, 256);
        const username = optionalBounded(input.username, 512);
        const scope = toStoredScope(input.scope);
        this.requireExistingProfileScope(scope);
        this.assertScopeLifecycleAvailable(scope);
        assertDoesNotShadowConfiguredDefault(
          store,
          scope,
          displayAlias,
          undefined,
          (profileId) => this.isAllProjectAutomaticGrantEligible(profileId),
        );
        const material = (await this.options.localSource.resolve({
          sourceLocator: "local",
          encryptedMaterial,
        })).material;
        try {
          const item = await this.options.bitwardenPasswordManagerSource.createItem({
            name: displayName ?? displayAlias,
            username,
            collectionId: collection.collectionId,
            organizationId: collection.organizationId,
            material,
          });
          const result = store.createSecretWithBindings({
            secret: {
              secretId,
              providerId,
              displayAlias,
              displayName,
              username,
              note: optionalBounded(input.note, 2_000),
              ...scope,
              retention: "saved",
              sourceLocator: item.id,
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
        } finally {
          material.release();
        }
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
        assertDoesNotShadowConfiguredDefault(
          store,
          scope,
          displayAlias,
          undefined,
          (profileId) => this.isAllProjectAutomaticGrantEligible(profileId),
        );
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
          (profileId) => this.isAllProjectAutomaticGrantEligible(profileId),
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
        const policy = store.getAutomaticGrantPolicy(secretId);
        const projectDefaults = policy.kind === "all_projects"
          ? [...this.options.listProfiles()]
              .filter((profile) => profile.profileType !== "system")
              .map(({ profileId }) => ({ profileId }))
          : policy.kind === "projects"
            ? policy.profileIds.map((profileId) => ({ profileId }))
            : [];
        if (nextRetention === "saved") {
          if (policy.kind === "all_projects" && nextScope.scopeKind === "instance") {
            assertProjectDefaultBindingCompatibility(
              store,
              "__all_projects_policy__",
              secretId,
              nextBindings.map(bindingInputToPublicBinding),
            );
          }
          for (const { profileId } of projectDefaults.filter(({ profileId }) =>
            nextScope.scopeKind === "instance"
            || nextScope.profileIds.includes(profileId)
          )) {
            assertProjectDefaultBindingCompatibility(
              store,
              profileId,
              secretId,
              nextBindings.map(bindingInputToPublicBinding),
              this.listEffectiveProjectDefaultsForProfile(store, profileId),
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
              username: input.username === undefined
                ? existing.username
                : optionalBounded(input.username, 512),
              note: input.note === undefined
                ? existing.note
                : optionalBounded(input.note, 2_000),
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
    const authoritySessionAgentId = this.resolveSecurePrincipal(sessionAgentId, {
      requireWorkerAssignment: false,
    }).descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () =>
        await this.getSecureSessionSnapshotUnlocked(authoritySessionAgentId)
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
    sessionAgentId = descriptor.agentId;
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
      await this.options.execution.destroyTask(toManagerTask(descriptor)).catch(() => false);
      store.revokeSessionLeases(sessionAgentId, "policy_changed");
      snapshot = store.updateSessionRuntimeState({
        sessionAgentId,
        executionMode: "secure",
        environmentStatus: "failed",
      }).snapshot;
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, snapshot)));
    }
    this.scheduleSessionExpiry(store, sessionAgentId);
    return this.toPublicSnapshot(store, snapshot);
  }

  async startSecureSession(
    sessionAgentId: string,
    input: StartSecureSessionInput = {},
  ): Promise<PublicSecureSessionSnapshot> {
    const manager = this.requireTeamManager(sessionAgentId);
    const workers = this.listEligibleSecureWorkers(manager);
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(manager.agentId, async () => {
        const principal = managerPrincipal(manager);
        const wasActive = this.activeSessions.has(manager.agentId);
        try {
          const snapshot = await this.startSecurePrincipalUnlocked(
            principal,
            input,
            { recycleRuntime: true },
          );
          if (!wasActive) {
            for (const worker of workers) {
              // A worker already executing a turn cannot safely swap runtimes
              // mid-command. Its deferred recycle is a normal transition: the
              // current turn remains ordinary, and lifecycle acquisition must
              // apply the pending boundary before its next secure assignment.
              await this.options.applyModeRuntimeRecycle(worker.agentId);
            }
          }
          return snapshot;
        } catch (error) {
          if (!wasActive && this.activeSessions.has(manager.agentId)) {
            const store = await this.store();
            const state = store.getSessionState(manager.agentId);
            if (state) {
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
            await Promise.allSettled([
              this.options.applyModeRuntimeRecycle(manager.agentId),
              ...workers.map((worker) =>
                this.options.applyModeRuntimeRecycle(worker.agentId)
              ),
            ]);
          }
          throw this.publicError(error);
        }
      })
    );
  }

  private async startSecurePrincipalUnlocked(
    principal: SecurePrincipal,
    input: StartSecureSessionInput,
    options: {
      emitSnapshot?: boolean;
      attachProjectDefaults?: boolean;
      recycleRuntime?: boolean;
      bindingGeneration?: string;
    } = {},
  ): Promise<PublicSecureSessionSnapshot> {
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
    const task = toManagerTask(descriptor);
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
        bindingGeneration: options.bindingGeneration ?? this.id(),
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
      storedSnapshot = this.resolveRequestsSatisfiedByActiveLeases(
        store,
        storedSnapshot,
      );
      this.scheduleSessionExpiry(store, sessionAgentId);
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
      return await this.withSessionMutation(
        manager.agentId,
        async () => {
          requireRevision(
            store.getSnapshot(manager.agentId).state.revision,
            input.baseRevision,
          );
          return await this.applyProjectDefaultsToPrincipalUnlocked(
            store,
            managerPrincipal(manager),
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
    const principal = this.resolveSecurePrincipal(sessionAgentId);
    const manager = principal.descriptor;
    const workers = this.listEligibleSecureWorkers(manager);
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(
        manager.agentId,
        async () => {
          const stopped = await this.stopSecurePrincipalUnlocked(
            managerPrincipal(manager),
            input,
            { recycleRuntime: false },
          );
          await Promise.allSettled([
            this.options.applyModeRuntimeRecycle(manager.agentId),
            ...workers.map((worker) =>
              this.options.applyModeRuntimeRecycle(worker.agentId)
            ),
          ]);
          if (stopped.environmentStatus === "degraded") {
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
          return stopped;
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
    const task = active?.task ?? toManagerTask(descriptor);
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
    this.clearSessionExpiryTimer(sessionAgentId);
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
      await this.cleanupLegacyWorkerSecurePrincipal(workerState.sessionAgentId, {
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
      await this.cleanupLegacyWorkerSecurePrincipal(workerState.sessionAgentId, {
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
        this.clearSessionExpiryTimer(normalizedSessionAgentId);
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
    const authoritySessionAgentId = this.resolveSecurePrincipal(
      sessionAgentId,
    ).descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () =>
        await this.grantSecureSessionLeasesUnlocked(
          authoritySessionAgentId,
          input,
        )
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
      || new Set(input.grants.map(({ secretId }) => secretId)).size
        !== input.grants.length
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    if (input.grants.length > this.maxProjectDefaults()) {
      throw new SecureSessionsServiceError("SECURE_PROJECT_DEFAULT_LIMIT_REACHED");
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
      this.scheduleSessionExpiry(store, sessionAgentId);
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
    const authoritySessionAgentId = this.resolveSecurePrincipal(
      sessionAgentId,
    ).descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () =>
        await this.revokeSecureSessionLeaseUnlocked(
          authoritySessionAgentId,
          input,
        )
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
      this.scheduleSessionExpiry(store, sessionAgentId);
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
    const authoritySessionAgentId = this.resolveSecurePrincipal(
      sessionAgentId,
    ).descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () =>
        await this.resolveSecureAccessRequestUnlocked(
          authoritySessionAgentId,
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
    assertManagerRequestAuthority(request.workerAssignmentId);
    if (input.decision === "deny") {
      if (input.selectedSecretId !== undefined) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      const resolved = store.resolveRequest({ requestId, state: "denied" });
      this.scheduleSessionExpiry(store, sessionAgentId);
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
    const existingLease = findActiveEquivalentLease(
      store,
      snapshot,
      request.displayAlias,
      request.requestedExposures.map(toPublicBinding),
      selectedSecretId,
    );
    if (existingLease) {
      const resolved = store.resolveRequest({
        requestId,
        state: "approved",
        selectedSecretId,
      });
      this.scheduleSessionExpiry(store, sessionAgentId);
      const result = this.toPublicSnapshot(store, resolved);
      this.options.emitSnapshot(toSnapshotEvent(result));
      return result;
    }
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
      this.scheduleSessionExpiry(store, sessionAgentId);
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
    const authoritySessionAgentId = this.resolveSecurePrincipal(
      sessionAgentId,
    ).descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () =>
        await this.fulfillSecureAccessRequestUnlocked(
          authoritySessionAgentId,
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
    assertManagerRequestAuthority(request.workerAssignmentId);
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
    let scope: {
      scopeKind: "instance" | "profile";
      profileId: string | null;
      profileIds: string[];
    };
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
      scope = { scopeKind: "profile", profileId, profileIds: [profileId] };
    } else if (input.retention === "saved" && input.scope !== undefined) {
      scope = toStoredScope(input.scope);
      this.requireExistingProfileScope(scope);
      if (
        scope.scopeKind === "profile"
        && !scope.profileIds.includes(profileId)
      ) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
    } else {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }

    assertDoesNotShadowConfiguredDefault(
      store,
      scope,
      request.displayAlias,
      undefined,
      (candidateProfileId) =>
        this.isAllProjectAutomaticGrantEligible(candidateProfileId),
    );
    if (
      input.makeProjectDefault === true
      && this.listEffectiveProjectDefaultsForProfile(store, profileId).length
        >= this.maxProjectDefaults()
    ) {
      throw new SecureSessionsServiceError(
        "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
      );
    }
    const encryptedMaterial = decodeCiphertext(input.encryptedMaterial);
    const secretId = this.id();
    const destination = input.destination ?? { kind: "local" as const };
    if (input.retention === "session" && destination.kind !== "local") {
      encryptedMaterial.fill(0);
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    let providerId = LOCAL_PROVIDER_ID;
    let sourceLocator = input.retention === "session"
      ? `session:${sessionAgentId}`
      : "local";
    let bitwardenCollection: SecureSessionBitwardenCollection | null = null;
    if (destination.kind === "bitwarden_password_manager") {
      const provider = store.getProvider(destination.providerId);
      bitwardenCollection = store.listBitwardenCollections(destination.providerId)
        .find((collection) => collection.collectionId === destination.collectionId) ?? null;
      if (
        input.retention !== "saved"
        || provider?.kind !== "bitwarden_password_manager"
        || !provider.enabled
        || provider.status !== "available"
        || !bitwardenCollection
      ) {
        encryptedMaterial.fill(0);
        throw new SecureSessionsServiceError("SECURE_SOURCE_UNAVAILABLE");
      }
      providerId = provider.providerId;
    }
    const normalizedBindings = normalizeBindings(input.exposures, this.id.bind(this));
    assertPublicBindingCompatibility(store, snapshot, input.exposures);
    if (input.makeProjectDefault === true) {
      assertProjectDefaultBindingCompatibility(
        store,
        profileId,
        secretId,
        input.exposures,
        this.listEffectiveProjectDefaultsForProfile(store, profileId),
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
      if (destination.kind === "bitwarden_password_manager" && bitwardenCollection) {
        const createdItem = await this.options.bitwardenPasswordManagerSource.createItem({
          name: input.displayName ?? request.displayAlias,
          username: input.username ?? request.username,
          collectionId: bitwardenCollection.collectionId,
          organizationId: bitwardenCollection.organizationId,
          material,
        });
        sourceLocator = createdItem.id;
      }
      const lease = store.withTransaction(() => {
        if (destination.kind === "local") this.ensureLocalProvider(store);
        const created = store.createSecretWithBindings({
          secret: {
            secretId,
            providerId,
            displayAlias: request.displayAlias,
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...((input.username ?? request.username)
              ? { username: input.username ?? request.username }
              : {}),
            ...scope,
            retention: input.retention,
            sourceLocator,
            encryptedMaterial: destination.kind === "local" ? encryptedMaterial : null,
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
      this.scheduleSessionExpiry(store, sessionAgentId);
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
        ...(lease.username ? { username: lease.username } : {}),
        leaseKind: lease.leaseKind,
        exposures: lease.exposures,
        status: lease.status,
        expiresAt: lease.expiresAt,
        lastUsedAt: lease.lastUsedAt,
        remainingUses: lease.remainingUses,
      })),
      pendingRequests: snapshot.pendingRequests.map((request) => ({
        displayAlias: request.displayAlias,
        ...(request.username ? { username: request.username } : {}),
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
        ...(secret.username ? { username: secret.username } : {}),
        bindings: secret.bindings,
      })),
      trustedSshHosts: snapshot.trustedSshHosts?.map((host) => ({
        alias: host.alias,
        hostName: host.hostName,
        port: host.port,
        username: host.username,
        hostKeyAlgorithm: host.hostKeyAlgorithm,
        hostKeyFingerprint: host.hostKeyFingerprint,
      })) ?? [],
      pendingSshTrustRequests:
        snapshot.pendingSshTrustRequests?.map((request) => ({
          alias: request.alias,
          hostName: request.hostName,
          port: request.port,
          username: request.username,
          hostKeyAlgorithm: request.hostKeyAlgorithm,
          hostKeyFingerprint: request.hostKeyFingerprint,
          purposeSummary: request.purposeSummary,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        })) ?? [],
      updatedAt: snapshot.updatedAt,
    };
  }

  async requestSecureSecretAccess(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSecretAccessInput,
  ): Promise<"requested" | "already_requested" | "already_granted"> {
    bounded(toolCallId, 256);
    const caller = this.options.getDescriptor(callerAgentId);
    if (!caller) {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    const principal = this.resolveSecurePrincipal(callerAgentId);
    const authoritySessionAgentId = principal.descriptor.agentId;
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(authoritySessionAgentId, async () => {
        const currentPrincipal = this.resolveSecurePrincipal(callerAgentId);
        return await this.requestSecureSecretAccessUnlocked(
          currentPrincipal,
          caller,
          input,
        );
      })
    );
  }

  private async requestSecureSecretAccessUnlocked(
    principal: SecurePrincipal,
    requestedBy: AgentDescriptor,
    input: RequestSecureSecretAccessInput,
  ): Promise<"requested" | "already_requested" | "already_granted"> {
    const store = await this.store();
    const sessionAgentId = principal.descriptor.agentId;
    const state = store.initializePrincipalState(
      sessionAgentId,
      principalStateInput(principal),
    );
    assertPrincipalStateMatches(principal, state);
    await this.expireAndPublish(store, sessionAgentId);
    const displayAlias = bounded(input.displayAlias, 256);
    const requestedExposures = input.exposures.map(toStoredExposure);
    const requestedDurationSeconds = input.leaseKind === "timed"
      ? validateDuration(input.durationSeconds)
      : null;
    const secret = resolveVisibleSavedSecretByAlias(
      store,
      principal.profileId,
      displayAlias,
    );
    if (secret) matchBindingIds(store.listBindings(secret.secretId), input.exposures);
    const current = store.getSnapshot(sessionAgentId);
    if (findActiveEquivalentLease(
      store,
      current,
      displayAlias,
      input.exposures,
    )) {
      return "already_granted";
    }
    if (current.requests.some((request) =>
      request.displayAlias === displayAlias
      && request.requestedLeaseKind === input.leaseKind
      && request.requestedDurationSeconds === requestedDurationSeconds
      && sameBindingSets(
        request.requestedExposures.map(toPublicBinding),
        input.exposures,
      )
    )) {
      return "already_requested";
    }
    try {
      const snapshot = store.createRequest({
        requestId: this.id(),
        sessionAgentId,
        workerAssignmentId: null,
        secretId: secret?.secretId ?? null,
        displayAlias,
        username: secret?.username ?? input.username ?? null,
        requestedExposures,
        requestedLeaseKind: input.leaseKind,
        requestedDurationSeconds,
        purposeSummary: bounded(input.purposeSummary, 2000),
        requestedByAgentId: requestedBy.agentId,
        requestedByDisplayName: bounded(requestedBy.displayName, 256),
        expiresAt: new Date(Date.parse(this.now()) + REQUEST_TTL_MS).toISOString(),
      });
      this.scheduleSessionExpiry(store, sessionAgentId);
      this.options.emitSnapshot(toSnapshotEvent(this.toPublicSnapshot(store, snapshot)));
      return "requested";
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async requestSecureSshHostTrust(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSshHostTrustInput,
  ): Promise<"trusted" | "requested"> {
    bounded(toolCallId, 256);
    const requestedBy = this.options.getDescriptor(callerAgentId);
    if (!requestedBy) {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    const principal = this.resolveSecurePrincipal(callerAgentId);
    let normalized: ReturnType<typeof normalizeProposedSshTrustedHost>;
    try {
      normalized = normalizeProposedSshTrustedHost(input);
    } catch {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(
        principal.descriptor.agentId,
        async () => {
          const currentPrincipal = this.resolveSecurePrincipal(callerAgentId);
          const store = await this.store();
          const sessionAgentId = currentPrincipal.descriptor.agentId;
          const state = store.initializePrincipalState(
            sessionAgentId,
            principalStateInput(currentPrincipal),
          );
          assertPrincipalStateMatches(currentPrincipal, state);
          const duplicatePendingRequest = store.getSnapshot(sessionAgentId)
            .sshTrustRequests.some((request) =>
              request.alias === normalized.alias
              && request.hostName === normalized.hostName
              && request.port === normalized.port
              && request.username === normalized.username
              && request.hostKeyAlgorithm === normalized.hostKeyAlgorithm
              && request.hostKeyBase64 === normalized.hostKeyBase64
            );
          if (duplicatePendingRequest) return "requested";
          const existing = store.getSshTrustedHostByAlias(
            currentPrincipal.profileId,
            normalized.alias,
          );
          if (
            existing
            && existing.hostName === normalized.hostName
            && existing.port === normalized.port
            && existing.username === normalized.username
            && existing.hostKeyAlgorithm === normalized.hostKeyAlgorithm
            && existing.hostKeyBase64 === normalized.hostKeyBase64
          ) {
            return "trusted";
          }
          try {
            const snapshot = store.createSshTrustRequest({
              requestId: this.id(),
              sessionAgentId,
              profileId: currentPrincipal.profileId,
              ...normalized,
              purposeSummary: bounded(input.purposeSummary, 2000),
              requestedByAgentId: requestedBy.agentId,
              requestedByDisplayName: bounded(requestedBy.displayName, 256),
              expiresAt: new Date(
                Date.parse(this.now()) + REQUEST_TTL_MS,
              ).toISOString(),
            });
            this.scheduleSessionExpiry(store, sessionAgentId);
            this.options.emitSnapshot(
              toSnapshotEvent(this.toPublicSnapshot(store, snapshot)),
            );
            return "requested";
          } catch (error) {
            throw this.publicError(error);
          }
        },
      )
    );
  }

  async resolveSecureSshHostTrustRequest(
    sessionAgentId: string,
    input: ResolveSecureSshHostTrustRequest,
  ): Promise<PublicSecureSessionSnapshot> {
    const descriptor = this.options.requireBuilderSession(
      sessionAgentId,
      "resolve SSH host trust",
    );
    const principal = this.resolveSecurePrincipal(descriptor.agentId);
    const authoritySessionAgentId = principal.descriptor.agentId;
    if (authoritySessionAgentId !== sessionAgentId) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    return await this.withAuthorityMutation(async () =>
      await this.withSessionMutation(sessionAgentId, async () => {
        const store = await this.store();
        await this.expireAndPublish(store, sessionAgentId);
        const request = store.getSshTrustRequest(
          bounded(input.requestId, 256),
        );
        if (!request || request.sessionAgentId !== sessionAgentId) {
          throw new SecureSessionsServiceError("SECURE_SSH_HOST_NOT_FOUND");
        }
        if (
          store.getSnapshot(sessionAgentId).state.revision
          !== input.baseRevision
        ) {
          throw new SecureSessionsServiceError("SECURE_STALE_REVISION");
        }
        try {
          const snapshot = store.withTransaction(() => {
            if (input.decision === "approve") {
              const existing = store.getSshTrustedHostByAlias(
                request.profileId,
                request.alias,
              );
              if (
                existing
                && (
                  existing.hostName !== request.hostName
                  || existing.port !== request.port
                  || existing.username !== request.username
                  || existing.hostKeyAlgorithm !== request.hostKeyAlgorithm
                  || existing.hostKeyBase64 !== request.hostKeyBase64
                )
              ) {
                throw new SecureSessionsServiceError(
                  "SECURE_SSH_HOST_KEY_CONFLICT",
                );
              }
              store.putSshTrustedHost({
                trustedHostId: existing?.trustedHostId ?? this.id(),
                profileId: request.profileId,
                alias: request.alias,
                hostName: request.hostName,
                port: request.port,
                username: request.username,
                hostKeyAlgorithm: request.hostKeyAlgorithm,
                hostKeyBase64: request.hostKeyBase64,
                hostKeyFingerprint: request.hostKeyFingerprint,
              });
            }
            return store.resolveSshTrustRequest({
              requestId: request.requestId,
              baseRevision: input.baseRevision,
              state: input.decision === "approve" ? "approved" : "denied",
            });
          });
          if (input.decision === "approve") this.emitCatalog(store);
          this.scheduleSessionExpiry(store, sessionAgentId);
          const result = this.toPublicSnapshot(store, snapshot);
          this.options.emitSnapshot(toSnapshotEvent(result));
          return result;
        } catch (error) {
          throw this.publicError(error);
        }
      })
    );
  }

  getSecureRuntimeBinding(
    descriptor: AgentDescriptor,
    _runtimeToken?: number,
  ): SecureRuntimeBinding | undefined {
    let principal: SecurePrincipal;
    try {
      principal = this.resolveSecurePrincipal(descriptor.agentId);
    } catch {
      return undefined;
    }
    const authoritySessionAgentId = principal.descriptor.agentId;
    const active = this.activeSessions.get(authoritySessionAgentId);
    if (!active || active.closed) return undefined;
    const workerAssignmentId = descriptorWorkerAssignmentId(descriptor);
    if (descriptor.role === "worker" && workerAssignmentId === null) {
      return undefined;
    }
    const identity: SecureRuntimeBindingIdentity = {
      authoritySessionAgentId,
      bindingGeneration: active.bindingGeneration,
      callerAgentId: descriptor.agentId,
      workerAssignmentId,
      revoked: false,
    };
    const assertCurrentBinding = (): ActiveSession => {
      const current = this.activeSessions.get(authoritySessionAgentId);
      const currentCaller = this.options.getDescriptor(descriptor.agentId);
      const currentManager = this.options.getDescriptor(authoritySessionAgentId);
      const currentAssignmentId = currentCaller
        ? descriptorWorkerAssignmentId(currentCaller)
        : null;
      if (
        identity.revoked
        || !current
        || current.bindingGeneration !== identity.bindingGeneration
        || current.closed
        || !currentCaller
        || !isBuilderManager(currentManager)
        || current.task.taskId !== authoritySessionAgentId
        || path.resolve(current.task.workspacePath) !== path.resolve(currentManager.cwd)
        || currentCaller.cwd !== descriptor.cwd
        || !isWorkspaceWithin(currentManager.cwd, currentCaller.cwd)
        || currentAssignmentId !== identity.workerAssignmentId
        || (
          currentCaller.role === "worker"
          && (
            !this.isEligibleSecureWorker(currentCaller)
            || currentCaller.managerId !== authoritySessionAgentId
          )
        )
        || (
          currentCaller.role === "manager"
          && currentCaller.agentId !== authoritySessionAgentId
        )
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
      createOutputGuard: () => {
        const current = assertCurrentBinding();
        if (current.guardRequired && !current.guard) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        const capturedGuard = current.guard;
        const capturedGuardRequired = current.guardRequired;
        const stream = capturedGuard?.createStream();
        let closed = false;
        const assertGuardStillCurrent = () => {
          const next = assertCurrentBinding();
          if (
            next.guard !== capturedGuard
            || next.guardRequired !== capturedGuardRequired
          ) {
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
        };
        return {
          write: (data: Uint8Array): Uint8Array => {
            if (closed) {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            }
            assertGuardStillCurrent();
            return stream ? stream.write(data) : Buffer.from(data);
          },
          close: async (): Promise<Uint8Array> => {
            if (closed) {
              throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
            }
            try {
              assertGuardStillCurrent();
              if (!stream) return Buffer.alloc(0);
              const tail = stream.end();
              if (stream.didQuarantine()) {
                await this.recordHostOutputQuarantine(identity);
              }
              return tail;
            } finally {
              closed = true;
              stream?.dispose();
            }
          },
          dispose: () => {
            if (closed) return;
            closed = true;
            stream?.dispose();
          },
        };
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

  private async recordHostOutputQuarantine(
    identity: SecureRuntimeBindingIdentity,
  ): Promise<void> {
    const current = this.activeSessions.get(identity.authoritySessionAgentId);
    if (
      identity.revoked
      || !current
      || current.closed
      || current.bindingGeneration !== identity.bindingGeneration
    ) {
      return;
    }
    const previous = this.outputStates.get(identity.authoritySessionAgentId);
    if (previous?.outputState === "quarantined") return;

    const store = await this.store();
    const latest = this.activeSessions.get(identity.authoritySessionAgentId);
    if (
      identity.revoked
      || latest !== current
      || latest?.closed
      || latest?.bindingGeneration !== identity.bindingGeneration
    ) {
      return;
    }
    const snapshot = store.getSnapshot(identity.authoritySessionAgentId);
    if (
      snapshot.state.executionMode !== "secure"
      || snapshot.state.environmentStatus !== "ready"
    ) {
      return;
    }
    this.outputStates.set(identity.authoritySessionAgentId, {
      outputState: "quarantined",
      outputStateCode: "SECURE_OUTPUT_QUARANTINED",
    });
    this.options.emitSnapshot(toSnapshotEvent(
      this.toPublicSnapshot(store, snapshot),
    ));
  }

  async closeSecureSessions(): Promise<void> {
    if (this.closed) return;
    this.closePromise ??= this.performCloseSecureSessions();
    await this.closePromise;
  }

  private async performCloseSecureSessions(): Promise<void> {
    this.closing = true;
    for (const timer of this.sessionExpiryTimers.values()) clearTimeout(timer);
    this.sessionExpiryTimers.clear();

    // Every mutation admitted before `closing` became true owns a tail. Drain
    // those operations before taking the final active-task snapshot so a
    // start/rebuild cannot publish a new container after the shutdown sweep.
    await Promise.allSettled([
      this.authorityMutationTail,
      ...this.sessionMutationTails.values(),
    ]);
    if (this.startupRecoveryPromise) {
      await Promise.allSettled([this.startupRecoveryPromise]);
    }

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
    this.executionIncidents.clear();
    this.projectDefaultStatuses.clear();
    await store?.close().catch(() => undefined);
    try {
      this.options.cipher.dispose?.();
    } catch {
      // Shutdown cleanup remains best effort after every task is destroyed.
    }
    this.options.bitwardenPasswordManagerSource.dispose();
    this.closed = true;
  }

  private async executeSecureBash(
    descriptor: AgentDescriptor,
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
    identity: SecureRuntimeBindingIdentity,
  ): Promise<{ exitCode: number | null }> {
    return await this.withSessionBashExecution(descriptor.agentId, async () => {
      const authoritySessionAgentId = identity.authoritySessionAgentId;
      let executionStarted = false;
      try {
        const prepared = await this.withAuthorityMutation(async () =>
          await this.withSessionMutation(
            authoritySessionAgentId,
            async () => {
              const result = await this.prepareSecureBashExecution(
                descriptor,
                request,
                identity,
              );
              this.beginSessionExecution(authoritySessionAgentId);
              executionStarted = true;
              return result;
            },
          )
        );
        return await this.runPreparedSecureBashExecution(request, prepared);
      } finally {
        if (executionStarted) {
          this.endSessionExecution(authoritySessionAgentId);
        }
      }
    });
  }

  private async prepareSecureBashExecution(
    descriptor: AgentDescriptor,
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
    identity: SecureRuntimeBindingIdentity,
  ): Promise<PreparedSecureBashExecution> {
    const principal = this.resolveSecurePrincipal(descriptor.agentId);
    const authorityDescriptor = principal.descriptor;
    const sessionAgentId = authorityDescriptor.agentId;
    const store = await this.store();
    await this.expireAndPublish(store, sessionAgentId);
    const stored = store.getSnapshot(sessionAgentId);
    const active = this.activeSessions.get(sessionAgentId);
    const currentCaller = this.options.getDescriptor(descriptor.agentId);
    assertPrincipalStateMatches(principal, stored.state);
    if (
      stored.state.executionMode !== "secure"
      || stored.state.environmentStatus !== "ready"
      || !active
      || active.bindingGeneration !== identity.bindingGeneration
      || identity.revoked
      || active.closed
      || identity.authoritySessionAgentId !== sessionAgentId
      || identity.callerAgentId !== descriptor.agentId
      || !currentCaller
      || currentCaller.cwd !== descriptor.cwd
      || !isWorkspaceWithin(authorityDescriptor.cwd, currentCaller.cwd)
      || descriptorWorkerAssignmentId(currentCaller)
        !== identity.workerAssignmentId
      || (
        currentCaller.role === "worker"
        && !this.isEligibleSecureWorker(currentCaller)
      )
      || active.task.taskId !== sessionAgentId
    ) {
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    const activeLeases = this.selectCommandLeases(
      store,
      stored.leases.filter((lease) => lease.state === "active"),
      request.secretAliases,
    );
    const reserved: ReservedLease[] = [];
    const resolved: ResolvedSecureSecretBinding[] = [];
    let guard: SecureValueGuard | null = null;
    try {
      for (const lease of activeLeases) {
        const operationId = this.id();
        const reservation = store.reserveLeaseUse({
          operationId,
          leaseId: lease.leaseId,
          sessionAgentId,
          now: this.now(),
        });
        if (!reservation.reserved) {
          throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
        }
        reserved.push({ lease, operationId, exposureIds: [] });
      }
      resolved.push(...await this.resolveDeliveries(store, reserved));
      if (active.guardRequired && !active.guard) {
        await this.ensureGuardForActiveLeases(store, sessionAgentId);
      }
      guard = await this.buildCachedLeaseGuard(sessionAgentId, resolved);
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
      return {
        store,
        reserved,
        resolved,
        guard,
        active,
        authorityDescriptor,
        callerAgentId: descriptor.agentId,
      };
    } catch (error) {
      this.completeReservations(
        store,
        reserved,
        request.signal?.aborted ? "cancelled" : "failed",
      );
      if (!(error instanceof SecureSessionsServiceError && error.code === "SECURE_REQUEST_INVALID")) {
        await this.failClosedSession(store, authorityDescriptor);
      }
      guard?.dispose();
      for (const item of resolved) item.value.fill(0);
      throw this.publicError(error);
    }
  }

  private selectCommandLeases(
    store: SecureSessionStore,
    activeLeases: readonly SecureSessionLease[],
    requestedAliases: readonly string[],
  ): SecureSessionLease[] {
    if (
      !Array.isArray(requestedAliases)
      || requestedAliases.length > activeLeases.length
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    const leasesByAlias = new Map<string, SecureSessionLease[]>();
    for (const lease of activeLeases) {
      const secret = store.getSecret(lease.secretId);
      if (!secret) continue;
      const matching = leasesByAlias.get(secret.displayAlias) ?? [];
      matching.push(lease);
      leasesByAlias.set(secret.displayAlias, matching);
    }
    const selected: SecureSessionLease[] = [];
    const seen = new Set<string>();
    for (const rawAlias of requestedAliases) {
      const alias = bounded(rawAlias, 256);
      const matching = leasesByAlias.get(alias);
      if (seen.has(alias) || matching?.length !== 1) {
        throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      }
      seen.add(alias);
      selected.push(matching[0]!);
    }
    return selected;
  }

  private async runPreparedSecureBashExecution(
    request: Parameters<SecureRuntimeBinding["executeBash"]>[0],
    prepared: PreparedSecureBashExecution,
  ): Promise<{ exitCode: number | null }> {
    const {
      store,
      reserved,
      resolved,
      guard,
      active,
      authorityDescriptor,
      callerAgentId,
    } = prepared;
    const sessionAgentId = authorityDescriptor.agentId;
    try {
      const delivery = createExecutionDeliveryFromBindings(resolved);
      const trustedSshHosts = store.listSshTrustedHosts(
        requireProfileId(authorityDescriptor),
      );
      if (trustedSshHosts.length > 0) {
        delivery.sshTrust = {
          config: Buffer.from(
            buildSecureSshConfig(trustedSshHosts),
            "utf8",
          ),
          knownHosts: Buffer.from(
            buildSecureSshKnownHosts(trustedSshHosts),
            "utf8",
          ),
        };
      }
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
      this.scheduleSessionExpiry(store, sessionAgentId);
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
      const commandLocalInterruption =
        error instanceof SecureExecutionError
        && (error.code === "EXECUTION_ABORTED" || error.code === "EXECUTION_TIMEOUT");
      if (commandLocalInterruption) {
        this.executionIncidents.set(sessionAgentId, {
          code: error.code,
          agentId: callerAgentId,
          occurredAt: this.now(),
        });
        this.scheduleSessionExpiry(store, sessionAgentId);
        this.options.emitSnapshot(toSnapshotEvent(
          this.toPublicSnapshot(store, store.getSnapshot(sessionAgentId)),
        ));
      } else if (
        !(error instanceof SecureSessionsServiceError && error.code === "SECURE_REQUEST_INVALID")
        && this.activeSessions.get(sessionAgentId) === active
        && !active.closed
      ) {
        await this.failClosedSession(store, authorityDescriptor);
      }
      throw this.publicError(error);
    } finally {
      guard.dispose();
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
    const configured = this.listEffectiveProjectDefaultsForProfile(store, profileId);
    const effectiveSecretIds = new Set(
      resolveVisibleSavedSecrets(store, profileId).map((secret) => secret.secretId),
    );
    const snapshot = store.getSnapshot(sessionAgentId);
    const occupiedBindingKeys = activeBindingCollisionKeys(store, snapshot);
    const statuses = new Map<string, SecureSessionProjectDefaultStatus>();
    this.projectDefaultStatuses.set(sessionAgentId, statuses);
    const prepared: PreparedProjectDefault[] = [];
    if (configured.length > this.maxProjectDefaults()) {
      for (const projectDefault of configured) {
        const secret = store.getSecret(projectDefault.secretId);
        statuses.set(projectDefault.secretId, {
          secretId: projectDefault.secretId,
          displayAlias: secret?.displayAlias ?? "unavailable",
          ...(secret?.username ? { username: secret.username } : {}),
          state: "conflict",
          statusCode: "binding_conflict",
        });
      }
      return prepared;
    }
    try {
      for (const projectDefault of configured) {
        const secret = store.getSecret(projectDefault.secretId);
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
        const publicBindings = bindings.map(toPublicBinding);
        const activeEquivalentTaskLease = findActiveEquivalentLease(
          store,
          snapshot,
          secret.displayAlias,
          publicBindings,
          secret.secretId,
          "task",
        );
        if (activeEquivalentTaskLease) {
          statuses.set(projectDefault.secretId, {
            secretId: projectDefault.secretId,
            displayAlias: secret.displayAlias,
            state: "active",
            statusCode: "ok",
          });
          continue;
        }
        const hasActiveAliasConflict = activeLeasesForAlias(
          store,
          snapshot,
          secret.displayAlias,
        ).length > 0;
        const bindingKeys = publicBindings.flatMap((binding) => {
          const key = bindingCollisionKey(binding);
          return key === null ? [] : [key];
        });
        if (
          bindings.length === 0
          || hasActiveAliasConflict
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
        this.scheduleSessionExpiry(store, sessionAgentId);
      }

      storedSnapshot = this.resolveRequestsSatisfiedByActiveLeases(
        store,
        storedSnapshot,
      );

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

  private resolveRequestsSatisfiedByActiveLeases(
    store: SecureSessionStore,
    snapshot: StoredSnapshot,
  ): StoredSnapshot {
    const expired = store.expireRequests(
      this.now(),
      snapshot.state.sessionAgentId,
    );
    let current = expired.at(-1)?.snapshot ?? snapshot;
    for (const request of current.requests) {
      const lease = findActiveEquivalentLease(
        store,
        current,
        request.displayAlias,
        request.requestedExposures.map(toPublicBinding),
        request.secretId,
      );
      if (!lease) continue;
      try {
        current = store.resolveRequest({
          requestId: request.requestId,
          state: "approved",
          selectedSecretId: lease.secretId,
        });
      } catch (error) {
        if (!(error instanceof SecureSessionRequestExpiredError)) throw error;
        const racedExpiration = store.expireRequests(
          this.now(),
          snapshot.state.sessionAgentId,
        );
        current = racedExpiration.at(-1)?.snapshot
          ?? store.getSnapshot(snapshot.state.sessionAgentId);
      }
    }
    return current;
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
        try {
          if (resolution.refreshedEncryptedMaterial && secret.encryptedMaterial) {
            store.rotateEncryptedSecretMaterial({
              secretId,
              expectedEncryptedMaterial: secret.encryptedMaterial,
              encryptedMaterial: resolution.refreshedEncryptedMaterial,
            });
          }
          this.markProviderResolutionSucceeded(store, provider);
          return resolution.material;
        } catch (error) {
          resolution.material.release();
          throw error;
        } finally {
          resolution.refreshedEncryptedMaterial?.fill(0);
        }
      }
      if (provider.kind === "bitwarden_password_manager") {
        const selectedCollections = store.listBitwardenCollections(
          provider.providerId,
        );
        if (selectedCollections.length === 0) {
          throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
        }
        const resolution = await this.options.bitwardenPasswordManagerSource.resolve({
          sourceLocator: secret.sourceLocator,
          allowedCollectionIds: selectedCollections.map(
            (collection) => collection.collectionId,
          ),
        });
        try {
          this.markProviderResolutionSucceeded(store, provider);
          return resolution.material;
        } catch (error) {
          resolution.material.release();
          throw error;
        }
      }
      const config = store.getProviderBackendConfig(provider.providerId);
      if (!config) throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
      providerCredential = config.encryptedAccessToken;
      const resolution = await this.options.bitwardenSource.resolve({
        sourceLocator: secret.sourceLocator,
        encryptedCredential: config.encryptedAccessToken,
        endpointOrigin: config.serverOrigin,
      });
      try {
        if (resolution.refreshedEncryptedCredential) {
          store.rotateProviderBackendCredential({
            providerId: provider.providerId,
            expectedEncryptedAccessToken: config.encryptedAccessToken,
            encryptedAccessToken: resolution.refreshedEncryptedCredential,
          });
        }
        this.markProviderResolutionSucceeded(store, provider);
        return resolution.material;
      } catch (error) {
        resolution.material.release();
        throw error;
      } finally {
        resolution.refreshedEncryptedCredential?.fill(0);
      }
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

  private async buildBitwardenPasswordManagerSettings(
    store: SecureSessionStore,
    providerId: string,
    providedStatus?: BitwardenPasswordManagerStatus,
    providedCollections?: readonly BitwardenPasswordManagerCollection[],
  ): Promise<BitwardenPasswordManagerSettings> {
    const status = providedStatus
      ?? await this.options.bitwardenPasswordManagerSource.status(
        store.getProvider(providerId)?.cliExecutablePath ?? null,
      );
    const selected = store.listBitwardenCollections(providerId);
    let available: readonly BitwardenPasswordManagerCollection[] = [];
    if (status.state === "available") {
      if (providedCollections) {
        available = providedCollections;
      } else {
        // Reading settings (also used by the save dialog) must not sync the
        // vault under the shared authority queue. Explicit refresh/save does.
        available = await this.options.bitwardenPasswordManagerSource.listCollections();
      }
    }
    const collections = new Map<string, {
      collectionId: string;
      organizationId: string;
      name: string;
      selected: boolean;
    }>();
    for (const collection of available) {
      collections.set(collection.id, {
        collectionId: collection.id,
        organizationId: collection.organizationId,
        name: collection.name,
        selected: false,
      });
    }
    for (const collection of selected) {
      collections.set(collection.collectionId, {
        collectionId: collection.collectionId,
        organizationId: collection.organizationId,
        name: collection.name,
        selected: true,
      });
    }
    return {
      providerId,
      accountEmail: status.accountEmail,
      serverUrl: status.serverUrl,
      cli: {
        ...status.cli,
        configuredExecutablePath:
          store.getProvider(providerId)?.cliExecutablePath ?? null,
      },
      collections: [...collections.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
        || left.collectionId.localeCompare(right.collectionId)
      ),
    };
  }

  private async mutateBitwardenPasswordManagerCli(
    providerId: string,
    executablePath: string | null,
    inspect: () => Promise<BitwardenPasswordManagerStatus>,
  ): Promise<BitwardenPasswordManagerSettings> {
    try {
      return await this.withAuthorityMutation(async () => {
        const store = await this.store();
        const provider = store.getProvider(providerId);
        if (!provider || provider.kind !== "bitwarden_password_manager") {
          throw new SecureSessionsServiceError("SECURE_SECRET_NOT_FOUND");
        }
        const secretIds = store.listSecrets(providerId).map(
          (secret) => secret.secretId,
        );
        this.assertSecretMutationLifecycleAvailable(store, secretIds);
        const initiallyAffected = this.captureAffectedLeases(store, secretIds);
        return await this.withSessionMutations(
          initiallyAffected.sessionIds,
          async () => {
            const affected = this.captureAffectedLeases(store, secretIds);
            await this.options.bitwardenPasswordManagerSource.lock()
              .catch(() => undefined);
            store.updateBitwardenPasswordManagerCliPath(
              providerId,
              executablePath,
            );
            this.releaseLeases(affected.leaseIds);
            await this.reconcileAfterLeaseLoss(store, affected.sessionIds);
            let status: BitwardenPasswordManagerStatus;
            try {
              status = await inspect();
            } catch (error) {
              store.updateProviderStatus({
                providerId,
                status: "unreachable",
                lastStatusCode: "source_unreachable",
                lastVerifiedAt: this.now(),
              });
              this.emitCatalog(store);
              this.emitSessionSnapshots(store, affected.sessionIds);
              throw error;
            }
            store.updateProviderStatus({
              providerId,
              ...passwordManagerProviderStatus(status.state),
              lastVerifiedAt: this.now(),
            });
            this.emitCatalog(store);
            this.emitSessionSnapshots(store, affected.sessionIds);
            return await this.buildBitwardenPasswordManagerSettings(
              store,
              providerId,
              status,
            );
          },
        );
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  private markProviderResolutionSucceeded(
    store: SecureSessionStore,
    provider: SecureSessionProvider,
  ): void {
    if (
      provider.status === "available"
      && provider.lastStatusCode === "ok"
    ) {
      return;
    }
    const updated = store.updateProviderStatus({
      providerId: provider.providerId,
      status: "available",
      lastStatusCode: "ok",
      lastVerifiedAt: this.now(),
    });
    if (updated) {
      this.emitCatalog(store);
    }
  }

  private async rebuildGuard(sessionAgentId: string): Promise<SecureValueGuard> {
    const guard = await this.buildCachedLeaseGuard(sessionAgentId);
    const active = this.activeSessions.get(sessionAgentId);
    if (!active) {
      guard.dispose();
      throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
    }
    active.guard?.dispose();
    active.guard = guard;
    active.guardRequired = true;
    return guard;
  }

  private async buildCachedLeaseGuard(
    sessionAgentId: string,
    resolved: readonly ResolvedSecureSecretBinding[] = [],
  ): Promise<SecureValueGuard> {
    const values: Buffer[] = [];
    try {
      for (const [leaseId, secret] of this.cachedLeaseSecrets) {
        if (this.cachedLeaseOwners.get(leaseId) !== sessionAgentId) continue;
        if (!secret.released) {
          await secret.withBytes((bytes) => values.push(Buffer.from(bytes)));
        }
      }
      for (const item of resolved) {
        if (item.binding.deliveryKind !== "ssh_agent") continue;
        const normalized = normalizeSshAgentKeyMaterial(item.value);
        if (normalized.equals(item.value)) {
          normalized.fill(0);
          continue;
        }
        values.push(normalized);
      }
      return this.createValueGuard(values);
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
    const task = this.activeSessions.get(descriptor.agentId)?.task
      ?? toManagerTask(descriptor);
    const destroyed = await this.options.execution
      .destroyTask(task ?? {
        taskId: descriptor.agentId,
        workspacePath: descriptor.cwd,
      })
      .catch(() => false);
    store.revokeSessionLeases(descriptor.agentId, "policy_changed");
    this.clearSessionExpiryTimer(descriptor.agentId);
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
      this.scheduleSessionExpiry(store, mutation.snapshot.state.sessionAgentId);
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
    for (const mutation of store.expireSshTrustRequests(
      this.now(),
      sessionAgentId,
    )) {
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
      this.clearSessionExpiryTimer(sessionAgentId);
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
    this.clearSessionExpiryTimer(sessionAgentId);
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

    // Retire this exact environment before its process tree is destroyed. The
    // manager-session binding generation survives the rebuild, but an
    // execution completing concurrently must not republish this closed
    // environment object after its replacement is ready.
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
        bindingGeneration: active.bindingGeneration,
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

  private scheduleSessionExpiry(
    store: SecureSessionStore,
    sessionAgentId: string,
  ): void {
    this.clearSessionExpiryTimer(sessionAgentId);
    if (this.closing || this.closed) {
      return;
    }
    const snapshot = store.getSnapshot(sessionAgentId);
    const expirations = [
      ...(this.activeSessions.has(sessionAgentId)
        ? snapshot.leases
            .filter((lease) =>
              lease.state === "active" && lease.expiresAt !== null
            )
            .map((lease) => Date.parse(lease.expiresAt!))
        : []),
      ...snapshot.requests
        .filter((request) => request.expiresAt !== null)
        .map((request) => Date.parse(request.expiresAt!))
        .filter(Number.isFinite),
      ...snapshot.sshTrustRequests
        .filter((request) => request.expiresAt !== null)
        .map((request) => Date.parse(request.expiresAt!))
        .filter(Number.isFinite),
    ].filter(Number.isFinite);
    if (expirations.length === 0) {
      return;
    }
    const nextExpiration = Math.min(...expirations);
    const delayMs = Math.max(
      0,
      Math.min(2_147_483_647, nextExpiration - Date.parse(this.now())),
    );
    const timer = setTimeout(() => {
      if (this.sessionExpiryTimers.get(sessionAgentId) !== timer) {
        return;
      }
      this.sessionExpiryTimers.delete(sessionAgentId);
      void this.expireSessionFromTimer(sessionAgentId);
    }, delayMs);
    timer.unref?.();
    this.sessionExpiryTimers.set(sessionAgentId, timer);
  }

  private async expireSessionFromTimer(sessionAgentId: string): Promise<void> {
    if (this.closing || this.closed) return;
    try {
      const store = await this.store();
      await this.withAuthorityMutation(async () =>
        await this.withSessionMutation(sessionAgentId, async () => {
          await this.expireAndPublish(store, sessionAgentId);
          this.scheduleSessionExpiry(store, sessionAgentId);
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

  private clearSessionExpiryTimer(sessionAgentId: string): void {
    const timer = this.sessionExpiryTimers.get(sessionAgentId);
    if (timer) clearTimeout(timer);
    this.sessionExpiryTimers.delete(sessionAgentId);
  }

  private toPublicSnapshot(
    store: SecureSessionStore,
    snapshot: StoredSnapshot,
  ): PublicSecureSessionSnapshot {
    const outputState = this.outputStates.get(snapshot.state.sessionAgentId) ?? {
      outputState: "clear" as const,
      outputStateCode: null,
    };
    const lastExecutionIncident = this.executionIncidents.get(
      snapshot.state.sessionAgentId,
    );
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
          ...(secret?.username ? { username: secret.username } : {}),
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
        ...(request.username ? { username: request.username } : {}),
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
      trustedSshHosts: store.listSshTrustedHosts(snapshot.state.profileId)
        .map(toPublicSshTrustedHost),
      pendingSshTrustRequests: snapshot.sshTrustRequests.map((request) =>
        toPublicSshTrustRequest(request)
      ),
      projectDefaults: this.listEffectiveProjectDefaultsForProfile(
        store,
        snapshot.state.profileId,
      )
        .map((projectDefault) => {
          const secret = store.getSecret(projectDefault.secretId);
          const recorded = this.projectDefaultStatuses
            .get(snapshot.state.sessionAgentId)
            ?.get(projectDefault.secretId);
          const bindings = secret
            ? store.listBindings(secret.secretId).map(toPublicBinding)
            : [];
          const activeAliasLeases = secret
            ? activeLeasesForAlias(store, snapshot, secret.displayAlias)
            : [];
          const active = Boolean(
            secret
            && bindings.length > 0
            && findActiveEquivalentLease(
              store,
              snapshot,
              secret.displayAlias,
              bindings,
              secret.secretId,
              "task",
            )
          );
          if (activeAliasLeases.length > 0 && !active) {
            return {
              secretId: projectDefault.secretId,
              displayAlias: secret?.displayAlias ?? "unavailable",
              state: "conflict",
              statusCode: "binding_conflict",
            };
          }
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
      ...(lastExecutionIncident
        ? { lastExecutionIncident }
        : {}),
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
      username: secret.username,
      note: secret.note,
      scope: toPublicScope(secret),
      retention: secret.retention,
      bindings: store.listBindings(secret.secretId).map(toPublicBinding),
      automaticGrantPolicy: store.getAutomaticGrantPolicy(secret.secretId),
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
        profileId: requireProfileId(manager),
      };
    }
    if (!this.isEligibleSecureWorker(descriptor)) {
      throw new SecureSessionsServiceError("SECURE_BUILDER_ONLY");
    }
    const manager = this.requireTeamManager(descriptor.managerId, options);
    if (
      descriptor.profileId !== manager.profileId
      || !isWorkspaceWithin(manager.cwd, descriptor.cwd)
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
      descriptor: manager,
      profileId: requireProfileId(manager),
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
      || !supportsSecureRuntimeProvider(descriptor.model.provider)
    ) {
      return false;
    }
    const manager = this.options.getDescriptor(descriptor.managerId);
    return isBuilderManager(manager)
      && manager.profileId === descriptor.profileId
      && !manager.archivedAt
      && isWorkspaceWithin(manager.cwd, descriptor.cwd);
  }

  private listEligibleSecureWorkers(
    manager: AgentDescriptor,
  ): AgentDescriptor[] {
    const workers: AgentDescriptor[] = [];
    for (const descriptor of this.options.listDescriptors()) {
      if (
        descriptor.managerId !== manager.agentId
        || !this.isEligibleSecureWorker(descriptor)
      ) {
        continue;
      }
      workers.push(descriptor);
    }
    return workers;
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
    profileIds: string[];
  }): void {
    if (scope.scopeKind === "profile") {
      for (const profileId of scope.profileIds) {
        this.assertProfileLifecycleAvailable(profileId);
      }
    }
  }

  private listEffectiveProjectDefaultsForProfile(
    store: SecureSessionStore,
    profileId: string,
  ): SecureSessionProjectDefault[] {
    const profile = [...this.options.listProfiles()]
      .find((candidate) => candidate.profileId === profileId);
    return profile && profile.profileType !== "system"
      ? store.listEffectiveProjectDefaults(profileId)
      : store.listProjectDefaults(profileId);
  }

  private isAllProjectAutomaticGrantEligible(profileId: string): boolean {
    const profile = [...this.options.listProfiles()]
      .find((candidate) => candidate.profileId === profileId);
    return Boolean(profile && profile.profileType !== "system");
  }

  private assertSecretMutationLifecycleAvailable(
    store: SecureSessionStore,
    secretIds: readonly string[],
  ): void {
    const wanted = new Set(secretIds);
    const profileIds = new Set<string>();
    for (const secretId of wanted) {
      const secret = store.getSecret(secretId);
      if (secret?.scopeKind === "profile") {
        for (const profileId of secret.profileIds) {
          profileIds.add(profileId);
        }
      }
    }
    for (const projectDefault of store.listProjectDefaults()) {
      if (wanted.has(projectDefault.secretId)) {
        profileIds.add(projectDefault.profileId);
      }
    }
    if (
      store.listAllProjectDefaults()
        .some((projectDefault) => wanted.has(projectDefault.secretId))
    ) {
      for (const { profileId, archivedAt, profileType } of this.options.listProfiles()) {
        if (archivedAt || profileType === "system") continue;
        profileIds.add(profileId);
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
    profileIds: string[];
  }): void {
    if (
      scope.scopeKind === "profile"
      && (
        scope.profileIds.length === 0
        || scope.profileIds.some((profileId) => !this.options.hasProfile(profileId))
      )
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
    this.executionIncidents.delete(sessionAgentId);
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
      const activeBeforeLeaseLoss = this.activeSessions.get(sessionAgentId);
      const hadActiveEnvironment = activeBeforeLeaseLoss !== undefined;
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
            bindingGeneration: activeBeforeLeaseLoss.bindingGeneration,
          },
        );
      }
      this.scheduleSessionExpiry(store, sessionAgentId);
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

  private async importOpenVaultTransferItems(
    store: SecureSessionStore,
    items: readonly OpenSecureVaultTransferItem[],
  ): Promise<ImportSecureVaultTransferResult> {
    const prepared: PreparedVaultTransferImportItem[] = [];
    let localSecretCount = 0;
    let providerCredentialCount = 0;
    try {
      for (const item of items) {
        let currentCiphertext: Buffer | null = null;
        if (item.kind === "local_secret") {
          const secret = store.getEncryptedSecret(item.recordId);
          const provider = secret
            ? store.getProvider(secret.providerId)
            : null;
          if (
            !secret
            || secret.retention !== "saved"
            || provider?.kind !== "local_keychain"
            || !secret.encryptedMaterial
          ) {
            secret?.encryptedMaterial?.fill(0);
            throw new SecureSessionsServiceError(
              "SECURE_VAULT_TRANSFER_MISMATCH",
            );
          }
          currentCiphertext = secret.encryptedMaterial;
          localSecretCount += 1;
        } else {
          const provider = store.getProvider(item.recordId);
          const config = provider?.kind === "bitwarden_secrets_manager"
            ? store.getProviderBackendConfig(item.recordId)
            : null;
          if (!config) {
            throw new SecureSessionsServiceError(
              "SECURE_VAULT_TRANSFER_MISMATCH",
            );
          }
          currentCiphertext = config.encryptedAccessToken;
          providerCredentialCount += 1;
        }
        if (!ciphertextMatchesDigest(
          currentCiphertext,
          item.expectedCiphertextDigest,
        )) {
          currentCiphertext.fill(0);
          throw new SecureSessionsServiceError(
            "SECURE_VAULT_TRANSFER_MISMATCH",
          );
        }
        prepared.push({
          item,
          currentCiphertext,
          replacementCiphertext: null,
        });
      }

      for (const entry of prepared) {
        entry.replacementCiphertext = await this.options.cipher.encrypt(
          entry.item.material,
        );
      }

      store.withTransaction(() => {
        for (const entry of prepared) {
          const replacement = entry.replacementCiphertext;
          if (!replacement) {
            throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
          }
          const updated = entry.item.kind === "local_secret"
            ? store.rotateEncryptedSecretMaterial({
                secretId: entry.item.recordId,
                expectedEncryptedMaterial: entry.currentCiphertext,
                encryptedMaterial: replacement,
              })
            : store.rotateProviderBackendCredential({
                providerId: entry.item.recordId,
                expectedEncryptedAccessToken: entry.currentCiphertext,
                encryptedAccessToken: replacement,
              });
          if (!updated) {
            throw new SecureSessionsServiceError(
              "SECURE_VAULT_TRANSFER_MISMATCH",
            );
          }
        }
      });

      return {
        importedItemCount: items.length,
        localSecretCount,
        providerCredentialCount,
      };
    } finally {
      for (const entry of prepared) {
        entry.currentCiphertext.fill(0);
        entry.replacementCiphertext?.fill(0);
      }
    }
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

  private requireActiveProfile(profileId: string): void {
    if (
      !this.options.hasProfile(profileId)
      || this.options.isProfileArchived(profileId)
    ) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
  }

  private createValueGuard(values: readonly Uint8Array[]): SecureValueGuard {
    return this.options.createValueGuard?.(values) ?? new SecureValueGuard(values);
  }

  private publicError(
    error: unknown,
  ): SecureSessionsServiceError | SecureExecutionError {
    if (error instanceof SecureExecutionError) return error;
    if (error instanceof SecureSessionsServiceError) return error;
    if (error instanceof SecureSessionRevisionConflictError) {
      return new SecureSessionsServiceError("SECURE_STALE_REVISION");
    }
    if (error instanceof SecureSessionAliasConflictError) {
      return new SecureSessionsServiceError("SECURE_SECRET_ALIAS_CONFLICT");
    }
    if (error instanceof SecureSessionSshAliasConflictError) {
      return new SecureSessionsServiceError("SECURE_SSH_HOST_KEY_CONFLICT");
    }
    if (error instanceof SecureSessionRequestExpiredError) {
      return new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    if (error instanceof SecureVaultTransferError) {
      return new SecureSessionsServiceError(
        error.code === "empty"
          ? "SECURE_VAULT_TRANSFER_EMPTY"
          : "SECURE_VAULT_TRANSFER_INVALID",
      );
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

function ciphertextMatchesDigest(
  ciphertext: Uint8Array,
  expectedDigest: Uint8Array,
): boolean {
  const actualDigest = createHash("sha256").update(ciphertext).digest();
  try {
    return expectedDigest.byteLength === actualDigest.byteLength
      && timingSafeEqual(expectedDigest, actualDigest);
  } finally {
    actualDigest.fill(0);
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

function toPublicSshTrustRequest(request: SecureSessionSshTrustRequest) {
  return {
    requestId: request.requestId,
    alias: request.alias,
    hostName: request.hostName,
    port: request.port,
    username: request.username,
    hostKeyAlgorithm: request.hostKeyAlgorithm,
    hostKeyFingerprint: request.hostKeyFingerprint,
    purposeSummary: request.purposeSummary,
    requestedByAgentId: request.requestedByAgentId,
    requestedByDisplayName: request.requestedByDisplayName,
    createdAt: request.requestedAt,
    expiresAt: request.expiresAt,
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

function managerPrincipal(manager: AgentDescriptor): SecurePrincipal {
  return {
    descriptor: manager,
    profileId: requireProfileId(manager),
  };
}

function toManagerTask(descriptor: AgentDescriptor): SecureExecutionTask {
  if (!isBuilderManager(descriptor)) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
  return {
    taskId: descriptor.agentId,
    workspacePath: descriptor.cwd,
  };
}

function toLegacyWorkerTask(
  descriptor: AgentDescriptor,
  workerAssignmentId: string,
): SecureExecutionTask {
  if (descriptor.role !== "worker") {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
  return {
    taskId: workerTaskId(descriptor.agentId, workerAssignmentId),
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

function isWorkspaceWithin(
  managerWorkspacePath: string,
  workerWorkspacePath: string,
): boolean {
  const managerPath = path.resolve(managerWorkspacePath);
  const workerPath = path.resolve(workerWorkspacePath);
  const relative = path.relative(managerPath, workerPath);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  if (state.workerAssignmentId !== null) {
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
    || state.principalKind !== "manager"
    || state.ownerManagerAgentId !== null
  ) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
}

function assertManagerRequestAuthority(
  workerAssignmentId: SecureSessionRequest["workerAssignmentId"],
): void {
  if (workerAssignmentId !== null) {
    throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
  }
}

function principalStateInput(
  principal: SecurePrincipal,
): Parameters<SecureSessionStore["initializePrincipalState"]>[1] {
  return {
    profileId: principal.profileId,
    principalKind: "manager",
    ownerManagerAgentId: null,
    workerAssignmentId: null,
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

function remotePrivateEntryContext(deviceId: string): string {
  return `secure-browser:${bounded(deviceId, 256)}`;
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
  profileIds: string[];
} {
  if (!scope || scope.kind === "instance") {
    return { scopeKind: "instance", profileId: null, profileIds: [] };
  }
  const profileIds = scope.kind === "profile"
    ? [bounded(scope.profileId, 256)]
    : [...new Set(scope.profileIds.map((profileId) => bounded(profileId, 256)))]
        .sort();
  if (profileIds.length === 0) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return {
    scopeKind: "profile",
    profileId: profileIds[0]!,
    profileIds,
  };
}

function toPublicScope(
  secret: Pick<SecureSessionSecret, "scopeKind" | "profileId" | "profileIds">,
):
  SecureSecretSummary["scope"] {
  if (secret.scopeKind === "instance") return { kind: "instance" };
  return secret.profileIds.length === 1
    ? { kind: "profile", profileId: secret.profileIds[0]! }
    : { kind: "profiles", profileIds: [...secret.profileIds] };
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
    const key = bindingCollisionKey(binding) ?? bindingKey(binding);
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
      || binding.targetPath.startsWith(SECURE_SSH_RESERVED_BINDING_PREFIX)
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
    const collisionKey = bindingCollisionKey(binding) ?? bindingKey(binding);
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
        const key = bindingCollisionKey(toPublicBinding(binding));
        if (key !== null) activeKeys.add(key);
      }
    }
  }
  for (const requestedBindingIds of requestedBindingGroups) {
    for (const bindingId of requestedBindingIds) {
      const binding = store.getBinding(bindingId);
      if (!binding) throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
      const key = bindingCollisionKey(toPublicBinding(binding));
      if (key === null) continue;
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
      if (binding) {
        const key = bindingCollisionKey(toPublicBinding(binding));
        if (key !== null) result.add(key);
      }
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
  const requestedBindings = new Set<string>();
  for (const binding of requested) {
    validateBinding(binding);
    const bindingKeyValue = bindingKey(binding);
    if (requestedBindings.has(bindingKeyValue)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    requestedBindings.add(bindingKeyValue);
    const key = bindingCollisionKey(binding);
    if (key === null) continue;
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
  configuredDefaults: readonly SecureSessionProjectDefault[] =
    store.listEffectiveProjectDefaults(profileId),
): void {
  const occupied = new Set<string>();
  for (const projectDefault of configuredDefaults) {
    if (projectDefault.secretId === proposedSecretId) continue;
    const secret = store.getSecret(projectDefault.secretId);
    if (!secret || secret.retention !== "saved" || !isVisibleTo(secret, profileId)) {
      continue;
    }
    for (const binding of store.listBindings(secret.secretId)) {
      const key = bindingCollisionKey(toPublicBinding(binding));
      if (key !== null) occupied.add(key);
    }
  }
  const proposed = new Set<string>();
  const proposedBindingsSeen = new Set<string>();
  for (const binding of proposedBindings) {
    validateBinding(binding);
    const bindingKeyValue = bindingKey(binding);
    if (proposedBindingsSeen.has(bindingKeyValue)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    proposedBindingsSeen.add(bindingKeyValue);
    const key = bindingCollisionKey(binding);
    if (key === null) continue;
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

function captureProjectDefaultLeasesForSecret(
  store: SecureSessionStore,
  secretId: string,
): { leaseIds: string[]; sessionIds: string[] } {
  const leaseIds: string[] = [];
  const sessionIds = new Set<string>();
  for (const state of store.listSessionStates()) {
    for (const lease of store.getSnapshot(state.sessionAgentId).leases) {
      if (
        lease.state !== "active"
        || lease.secretId !== secretId
        || lease.grantSource !== "project_default"
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

function bindingCollisionKey(binding: SecureSecretBinding): string | null {
  switch (binding.deliveryKind) {
    case "environment":
    case "askpass":
      return `environment-name:${binding.targetName}`;
    case "file":
      return `file-path:${binding.targetPath}`;
    case "stdin":
      return binding.deliveryKind;
    case "ssh_agent":
      // Multiple private keys intentionally share one execution-local agent.
      return null;
  }
}

function samePublicBindings(
  left: readonly SecureSecretBinding[],
  right: readonly SecureSecretBinding[],
): boolean {
  return left.length === right.length
    && left.every((binding, index) => bindingKey(binding) === bindingKey(right[index]!));
}

function sameBindingSets(
  left: readonly SecureSecretBinding[],
  right: readonly SecureSecretBinding[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(bindingKey).sort();
  const rightKeys = right.map(bindingKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function findActiveEquivalentLease(
  store: SecureSessionStore,
  snapshot: StoredSnapshot,
  displayAlias: string,
  bindings: readonly SecureSecretBinding[],
  secretId?: string | null,
  leaseKind?: SecureSessionLease["leaseKind"],
): SecureSessionLease | null {
  const activeAliasLeases = activeLeasesForAlias(store, snapshot, displayAlias);
  if (activeAliasLeases.length !== 1) return null;
  const [lease] = activeAliasLeases;
  if (
    !lease
    || (leaseKind !== undefined && lease.leaseKind !== leaseKind)
    || (
      lease.leaseKind === "one_use"
      && (lease.remainingUses !== 1 || lease.oneUseOperationId !== null)
    )
    || (secretId !== undefined && secretId !== null && lease.secretId !== secretId)
  ) {
    return null;
  }
  return sameBindingSets(
      lease.bindingIds.map((bindingId) => {
        const binding = store.getBinding(bindingId);
        if (!binding) {
          throw new SecureSessionsServiceError("SECURE_OPERATION_FAILED");
        }
        return toPublicBinding(binding);
      }),
      bindings,
    )
    ? lease
    : null;
}

function activeLeasesForAlias(
  store: SecureSessionStore,
  snapshot: StoredSnapshot,
  displayAlias: string,
): SecureSessionLease[] {
  return snapshot.leases.filter((lease) =>
    lease.state === "active"
    && store.getSecret(lease.secretId)?.displayAlias === displayAlias
  );
}

function isVisibleTo(secret: SecureSessionSecret, profileId: string): boolean {
  return secret.scopeKind === "instance" || secret.profileIds.includes(profileId);
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
      && secret.profileIds.includes(profileId)
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
  scope: {
    scopeKind: "instance" | "profile";
    profileId: string | null;
    profileIds: string[];
  },
  displayAlias: string,
  excludedSecretId?: string,
  allProjectsEligibleByProfileId: (
    profileId: string,
  ) => boolean = () => true,
): void {
  if (scope.scopeKind !== "profile") return;
  const shadowed = store.listSecrets().find((secret) =>
    secret.secretId !== excludedSecretId
    && secret.scopeKind === "instance"
    && secret.retention === "saved"
    && secret.displayAlias === displayAlias
  );
  if (!shadowed) return;
  for (const profileId of scope.profileIds) {
    const configured = allProjectsEligibleByProfileId(profileId)
      ? store.listEffectiveProjectDefaults(profileId)
      : store.listProjectDefaults(profileId);
    if (configured.some(
      (projectDefault) => projectDefault.secretId === shadowed.secretId
    )) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
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

function decodeTrustedBrowserPrivateEntry(value: string): Buffer {
  const maxEncodedLength = Math.ceil(
    MAX_TRUSTED_BROWSER_PRIVATE_ENTRY_BYTES / 3,
  ) * 4;
  if (!value || value.length > maxEncodedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0
    || decoded.byteLength > MAX_TRUSTED_BROWSER_PRIVATE_ENTRY_BYTES
    || decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return decoded;
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

function passwordManagerProviderStatus(
  state: BitwardenPasswordManagerStatus["state"],
): Pick<SecureSessionProvider, "status" | "lastStatusCode"> {
  switch (state) {
    case "available":
      return { status: "available", lastStatusCode: "ok" };
    case "locked":
      return { status: "locked", lastStatusCode: "source_locked" };
    case "unauthenticated":
      return {
        status: "auth_required",
        lastStatusCode: "provider_auth_required",
      };
    case "unavailable":
      return { status: "unreachable", lastStatusCode: "source_unreachable" };
  }
}

function assertPasswordManagerAvailable(
  state: BitwardenPasswordManagerStatus["state"],
): void {
  switch (state) {
    case "available":
      return;
    case "locked":
      throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    case "unauthenticated":
      throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
    case "unavailable":
      throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
  }
}

function normalizeProviderIds(values: readonly string[], maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !/^[0-9a-fA-F-]{16,128}$/.test(value)) {
      throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new SecureSessionsServiceError("SECURE_REQUEST_INVALID");
  }
  return normalized.sort();
}

function uniquePasswordManagerAlias(
  itemName: string,
  itemId: string,
  usedAliases: ReadonlySet<string>,
): string {
  const readable = itemName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180) || "secret";
  const suffix = itemId.replaceAll("-", "").slice(0, 8).toLowerCase();
  const base = `bitwarden/${readable}-${suffix}`;
  if (!usedAliases.has(base)) return base;
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!usedAliases.has(candidate)) return candidate;
  }
  throw new SecureSessionsServiceError("SECURE_SECRET_ALIAS_CONFLICT");
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
