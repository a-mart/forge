import type {
  ApplySecureSessionProjectDefaultsRequest,
  SecureSecretBinding,
  SecureSecretLeaseKind,
  SecureSecretRetention,
  SecureSecretScope,
} from "@forge/protocol";
import type {
  SecureSessionAgentView as ToolSecureSessionAgentView,
} from "./secure-session-tools.js";

export interface ConnectBitwardenSecureSecretProviderInput {
  displayName: string;
  serverOrigin: string;
  organizationId?: string;
  projectId?: string;
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedAccessToken: string;
}

export interface CreateLocalSecureSecretInput {
  displayAlias: string;
  displayName?: string;
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedMaterial: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface ImportBitwardenSecureSecretInput {
  /** Bitwarden's provider-side secret UUID. This is never projected publicly. */
  sourceLocator: string;
  displayAlias: string;
  displayName?: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface UpdateSecureSecretInput {
  displayAlias?: string;
  displayName?: string | null;
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedMaterial?: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface StartSecureSessionInput {
  baseRevision?: number;
}

export interface StopSecureSessionInput {
  baseRevision: number;
  stopProcesses: true;
}

export type ApplySecureSessionProjectDefaultsInput =
  ApplySecureSessionProjectDefaultsRequest;

export interface TeardownWorkerSecurePrincipalOptions {
  /**
   * Lifecycle deletion removes the persisted authority row. Callers may keep a
   * stopped row only when they need a public stopped snapshot during a larger
   * transition.
   */
  deleteState?: boolean;
  /** Internal lifecycle preparation keeps requests restorable until commit. */
  preservePendingRequests?: boolean;
}

export type FulfillSecureAccessRequestInput = {
  baseRevision: number;
  displayAlias: string;
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedMaterial: string;
  exposures: SecureSecretBinding[];
  /**
   * Session retention keeps the value ephemeral to the owning Builder
   * session. Saved retention persists it in the selected catalog scope.
   */
  retention: SecureSecretRetention;
  /**
   * Required for saved fulfillment. Session-retained values are always
   * constrained to the owning Builder profile regardless of renderer input.
   */
  scope?: SecureSecretScope;
  /**
   * User-authorized policy change. The backend always binds this to the
   * owning Builder profile; callers cannot select a different project here.
   */
  makeProjectDefault?: boolean;
} & (
  | { leaseKind: Exclude<SecureSecretLeaseKind, "timed"> }
  | { leaseKind: "timed"; durationSeconds: number }
);

export type RequestSecureSecretAccessInput = {
  displayAlias: string;
  exposures: SecureSecretBinding[];
  purposeSummary: string;
} & (
  | { leaseKind: Exclude<SecureSecretLeaseKind, "timed"> }
  | { leaseKind: "timed"; durationSeconds: number }
);

export type SecureSessionAgentView = ToolSecureSessionAgentView;
