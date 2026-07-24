import type {
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

export type FulfillSecureAccessRequestInput = {
  baseRevision: number;
  displayAlias: string;
  /** Electron safeStorage ciphertext encoded as canonical base64. */
  encryptedMaterial: string;
  exposures: SecureSecretBinding[];
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
