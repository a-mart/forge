import type { SecureSecretAutomaticGrantPolicy } from "@forge/protocol";

export const SECURE_SESSION_PROVIDER_KINDS = ["local_keychain", "bitwarden_secrets_manager"] as const;
export type SecureSessionProviderKind = (typeof SECURE_SESSION_PROVIDER_KINDS)[number];

export const SECURE_SESSION_SOURCE_STATUSES = [
  "available",
  "locked",
  "auth_required",
  "unreachable",
  "missing",
  "disabled"
] as const;
export type SecureSessionSourceStatus = (typeof SECURE_SESSION_SOURCE_STATUSES)[number];

export const SECURE_SESSION_SOURCE_STATUS_CODES = [
  "ok",
  "source_locked",
  "provider_auth_required",
  "source_unreachable",
  "source_missing",
  "provider_disabled",
  "provider_error"
] as const;
export type SecureSessionSourceStatusCode = (typeof SECURE_SESSION_SOURCE_STATUS_CODES)[number];

export const SECURE_SESSION_SCOPE_KINDS = ["instance", "profile"] as const;
export type SecureSessionScopeKind = (typeof SECURE_SESSION_SCOPE_KINDS)[number];

export const SECURE_SESSION_RETENTIONS = ["saved", "session"] as const;
export type SecureSessionRetention = (typeof SECURE_SESSION_RETENTIONS)[number];

export const SECURE_SESSION_DELIVERY_KINDS = [
  "environment",
  "stdin",
  "file",
  "askpass",
  "ssh_agent"
] as const;
export type SecureSessionDeliveryKind = (typeof SECURE_SESSION_DELIVERY_KINDS)[number];

export const SECURE_SESSION_LEASE_KINDS = ["task", "timed", "one_use"] as const;
export type SecureSessionLeaseKind = (typeof SECURE_SESSION_LEASE_KINDS)[number];

export const SECURE_SESSION_LEASE_GRANT_SOURCES = [
  "manual",
  "access_request",
  "project_default"
] as const;
export type SecureSessionLeaseGrantSource =
  (typeof SECURE_SESSION_LEASE_GRANT_SOURCES)[number];

export const SECURE_SESSION_PRINCIPAL_KINDS = ["manager", "worker"] as const;
export type SecureSessionPrincipalKind = (typeof SECURE_SESSION_PRINCIPAL_KINDS)[number];

export const SECURE_SESSION_LEASE_STATES = ["active", "consumed", "revoked", "expired"] as const;
export type SecureSessionLeaseState = (typeof SECURE_SESSION_LEASE_STATES)[number];

export const SECURE_SESSION_REQUEST_STATES = ["pending", "approved", "denied", "cancelled"] as const;
export type SecureSessionRequestState = (typeof SECURE_SESSION_REQUEST_STATES)[number];

export const SECURE_SESSION_RESERVATION_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type SecureSessionReservationOutcome = (typeof SECURE_SESSION_RESERVATION_OUTCOMES)[number];

export const SECURE_SESSION_EXPOSURE_OUTCOMES = ["completed", "failed", "cancelled"] as const;
export type SecureSessionExposureOutcome = (typeof SECURE_SESSION_EXPOSURE_OUTCOMES)[number];

export const SECURE_SESSION_REVOCATION_REASONS = [
  "user",
  "session_archived",
  "session_stopped",
  "session_deleted",
  "binding_deleted",
  "secret_deleted",
  "provider_deleted",
  "policy_changed"
] as const;
export type SecureSessionRevocationReason = (typeof SECURE_SESSION_REVOCATION_REASONS)[number];

export interface SecureSessionProvider {
  providerId: string;
  kind: SecureSessionProviderKind;
  displayName: string;
  enabled: boolean;
  status: SecureSessionSourceStatus;
  lastVerifiedAt: string | null;
  lastStatusCode: SecureSessionSourceStatusCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSecureSessionProviderInput {
  providerId: string;
  kind: SecureSessionProviderKind;
  displayName: string;
  enabled?: boolean;
  status?: SecureSessionSourceStatus;
  lastVerifiedAt?: string | null;
  lastStatusCode?: SecureSessionSourceStatusCode | null;
}

export interface SecureSessionProviderBackendConfig {
  providerId: string;
  serverOrigin: string;
  organizationId: string | null;
  projectId: string | null;
  /** Electron safeStorage ciphertext only. */
  encryptedAccessToken: Buffer;
}

export type UpsertSecureSessionProviderBackendConfigInput = SecureSessionProviderBackendConfig;

export interface ReplaceSecureSessionProviderBackendCredentialInput {
  providerId: string;
  /** Electron safeStorage ciphertext only. */
  encryptedAccessToken: Buffer;
  lastVerifiedAt: string;
}

export interface SecureSessionCatalogState {
  revision: number;
  updatedAt: string;
}

export interface SecureSessionSecret {
  secretId: string;
  providerId: string;
  displayAlias: string;
  displayName: string | null;
  scopeKind: SecureSessionScopeKind;
  profileId: string | null;
  retention: SecureSessionRetention;
  /** Backend-only provider locator; transport adapters must explicitly project public fields. */
  sourceLocator: string;
  bindings: SecureSessionBinding[];
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecureSessionProjectDefault {
  profileId: string;
  secretId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PutSecureSessionProjectDefaultInput {
  profileId: string;
  secretId: string;
}

export interface SecureSessionAllProjectDefault {
  secretId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReplaceSecureSessionAutomaticGrantPolicyInput {
  secretId: string;
  policy: SecureSecretAutomaticGrantPolicy;
}

export interface DeleteSecureSessionProjectStateResult {
  projectDefaultsDeleted: number;
  secretsDeleted: number;
}

export interface SecureSessionEncryptedSecret extends SecureSessionSecret {
  /** Electron safeStorage ciphertext, never plaintext and never included in list/snapshot APIs. */
  encryptedMaterial: Buffer | null;
}

export interface CreateSecureSessionSecretInput {
  secretId: string;
  providerId: string;
  displayAlias: string;
  displayName?: string | null;
  scopeKind: SecureSessionScopeKind;
  profileId?: string | null;
  retention: SecureSessionRetention;
  sourceLocator: string;
  /** Electron safeStorage ciphertext only; null is valid for remote-provider records. */
  encryptedMaterial?: Buffer | null;
}

export type UpdateSecureSessionSecretInput = CreateSecureSessionSecretInput;

export interface SecureSessionBinding {
  bindingId: string;
  secretId: string;
  deliveryKind: SecureSessionDeliveryKind;
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PutSecureSessionBindingInput {
  bindingId: string;
  secretId: string;
  deliveryKind: SecureSessionDeliveryKind;
  targetName?: string | null;
  targetPath?: string | null;
  fileMode?: number | null;
}

export interface SecureSessionExposureDescriptor {
  deliveryKind: SecureSessionDeliveryKind;
  targetName?: string | null;
  targetPath?: string | null;
  fileMode?: number | null;
}

export interface SecureSessionState {
  sessionAgentId: string;
  revision: number;
  forkedFromSessionAgentId: string | null;
  profileId: string;
  principalKind: SecureSessionPrincipalKind;
  ownerManagerAgentId: string | null;
  workerAssignmentId: string | null;
  executionMode: "standard" | "secure";
  environmentStatus: "stopped" | "starting" | "ready" | "degraded" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface SecureSessionLease {
  leaseId: string;
  sessionAgentId: string;
  secretId: string;
  requestId: string | null;
  grantSource: SecureSessionLeaseGrantSource;
  leaseKind: SecureSessionLeaseKind;
  state: SecureSessionLeaseState;
  bindingIds: string[];
  issuedRevision: number;
  updatedRevision: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  remainingUses: number | null;
  revokedAt: string | null;
  revocationReason: SecureSessionRevocationReason | null;
  oneUseOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecureSessionRequest {
  requestId: string;
  sessionAgentId: string;
  workerAssignmentId: string | null;
  secretId: string | null;
  displayAlias: string;
  requestedExposures: SecureSessionRequestedExposure[];
  leaseKind: SecureSessionLeaseKind;
  requestedLeaseKind: SecureSessionLeaseKind;
  requestedDurationSeconds: number | null;
  purposeSummary: string;
  requestedByAgentId: string;
  requestedByDisplayName: string;
  state: SecureSessionRequestState;
  requestedAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
}

export interface SecureSessionUseReservation {
  operationId: string;
  leaseId: string;
  sessionAgentId: string;
  reservedAt: string;
  completedAt: string | null;
  outcome: SecureSessionReservationOutcome | null;
}

export interface SecureSessionExposure {
  exposureId: string;
  operationId: string;
  bindingId: string;
  openedAt: string;
  closedAt: string | null;
  outcome: SecureSessionExposureOutcome | null;
}

export interface SecureSessionSnapshot {
  state: SecureSessionState;
  leases: SecureSessionLease[];
  requests: SecureSessionRequest[];
}

export interface SecureSessionMutationResult {
  changed: boolean;
  revision: number;
  snapshot: SecureSessionSnapshot;
}

export interface CreateSecureSessionLeaseInput {
  leaseId: string;
  sessionAgentId: string;
  secretId: string;
  bindingIds: readonly string[];
  leaseKind: SecureSessionLeaseKind;
  grantSource?: SecureSessionLeaseGrantSource;
  requestId?: string | null;
  baseRevision: number;
  expiresAt?: string | null;
}

export interface CreateSecureSessionLeaseGrantInput {
  leaseId: string;
  secretId: string;
  bindingIds: readonly string[];
  leaseKind: SecureSessionLeaseKind;
  grantSource?: SecureSessionLeaseGrantSource;
  requestId?: string | null;
  expiresAt?: string | null;
}

export interface CreateSecureSessionLeasesInput {
  sessionAgentId: string;
  baseRevision: number;
  grants: readonly CreateSecureSessionLeaseGrantInput[];
}

export interface RevokeSecureSessionLeaseInput {
  leaseId: string;
  sessionAgentId: string;
  baseRevision: number;
  reason: SecureSessionRevocationReason;
}

export interface ReserveSecureSessionLeaseUseInput {
  operationId: string;
  leaseId: string;
  sessionAgentId: string;
  now?: string;
}

export interface ReserveSecureSessionLeaseUseResult {
  reserved: boolean;
  idempotent: boolean;
  revision: number;
  reservation: SecureSessionUseReservation | null;
  snapshot: SecureSessionSnapshot;
}

export interface CompleteSecureSessionLeaseUseInput {
  operationId: string;
  outcome: SecureSessionReservationOutcome;
}

export interface CreateSecureSessionRequestInput {
  requestId: string;
  sessionAgentId: string;
  workerAssignmentId?: string | null;
  secretId?: string | null;
  displayAlias: string;
  requestedExposures: readonly SecureSessionExposureDescriptor[];
  requestedLeaseKind: SecureSessionLeaseKind;
  requestedDurationSeconds?: number | null;
  purposeSummary: string;
  requestedByAgentId: string;
  requestedByDisplayName: string;
  expiresAt?: string | null;
}

export interface ResolveSecureSessionRequestInput {
  requestId: string;
  baseRevision?: number;
  state: Exclude<SecureSessionRequestState, "pending">;
  selectedSecretId?: string | null;
}

export interface BeginSecureSessionExposureInput {
  exposureId: string;
  operationId: string;
  bindingId: string;
}

export interface CloseSecureSessionExposureInput {
  exposureId: string;
  outcome: SecureSessionExposureOutcome;
}

export interface SecureSessionAuditRecord {
  auditId: number;
  eventType: string;
  sessionAgentId: string | null;
  profileId: string | null;
  principalKind: SecureSessionPrincipalKind | null;
  ownerManagerAgentId: string | null;
  workerAssignmentId: string | null;
  providerId: string | null;
  secretId: string | null;
  bindingId: string | null;
  requestId: string | null;
  leaseId: string | null;
  operationId: string | null;
  outcome: string;
  occurredAt: string;
}

export interface SecureSessionRequestedExposure {
  deliveryKind: SecureSessionDeliveryKind;
  targetName: string | null;
  targetPath: string | null;
  fileMode: number | null;
}

export interface SecureSessionCatalogMutationResult<T> {
  record: T;
  catalog: SecureSessionCatalogState;
}

export interface SecureSessionSecretWithBindings {
  secret: SecureSessionSecret;
  bindings: SecureSessionBinding[];
  catalog: SecureSessionCatalogState;
}

export interface PutSecureSessionSecretWithBindingsInput {
  secret: CreateSecureSessionSecretInput;
  bindings: readonly Omit<PutSecureSessionBindingInput, "secretId">[];
}

export interface InitializeSecureSessionStateInput {
  profileId: string;
  principalKind?: SecureSessionPrincipalKind;
  ownerManagerAgentId?: string | null;
  workerAssignmentId?: string | null;
  executionMode?: SecureSessionState["executionMode"];
  environmentStatus?: SecureSessionState["environmentStatus"];
}

type InitializeSecureSessionPrincipalRuntimeInput = {
  profileId: string;
  executionMode?: SecureSessionState["executionMode"];
  environmentStatus?: SecureSessionState["environmentStatus"];
};

export type InitializeSecureSessionPrincipalInput =
  | (InitializeSecureSessionPrincipalRuntimeInput & {
      principalKind: "manager";
      ownerManagerAgentId?: null;
      workerAssignmentId?: null;
    })
  | (InitializeSecureSessionPrincipalRuntimeInput & {
      principalKind: "worker";
      ownerManagerAgentId: string;
      workerAssignmentId?: string | null;
    });

export interface UpdateSecureSessionRuntimeStateInput {
  sessionAgentId: string;
  baseRevision?: number;
  profileId?: string;
  executionMode?: SecureSessionState["executionMode"];
  environmentStatus?: SecureSessionState["environmentStatus"];
}

export interface UpdateSecureSessionWorkerAssignmentInput {
  sessionAgentId: string;
  workerAssignmentId: string;
  baseRevision?: number;
}
