import type {
  ApplySecureSessionProjectDefaultsRequest,
  CreateSecureSshTrustedHostRequest,
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferRequest,
  ImportSecureVaultTransferResult,
  RequestSecureSshHostTrustRequest,
  SecureSecretBinding,
  SecureSecretLeaseKind,
  SecureSecretRetention,
  SecureSecretScope,
  UpdateSecureSshTrustedHostRequest,
} from "@forge/protocol";

export type {
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferRequest,
  ImportSecureVaultTransferResult,
};
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

export interface UpdateBitwardenSecureSecretProviderCredentialInput {
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedAccessToken: string;
}

export interface ConnectBitwardenPasswordManagerInput {
  displayName: string;
}

export interface UnlockBitwardenPasswordManagerInput {
  /** Ephemeral Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedMasterPassword: string;
}

export interface ReplaceBitwardenPasswordManagerCollectionsInput {
  collectionIds: string[];
}

export interface CreateLocalSecureSecretInput {
  displayAlias: string;
  displayName?: string;
  note?: string;
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
  note?: string | null;
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

export type FulfillSecureAccessRequestInput = {
  baseRevision: number;
  displayAlias: string;
  displayName?: string;
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

export type CreateSecureSshTrustedHostInput =
  CreateSecureSshTrustedHostRequest;

export type UpdateSecureSshTrustedHostInput =
  UpdateSecureSshTrustedHostRequest;

export type RequestSecureSshHostTrustInput =
  RequestSecureSshHostTrustRequest;

export type SecureSessionAgentView = ToolSecureSessionAgentView;
