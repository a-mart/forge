export type SecureSessionsServiceErrorCode =
  | "SECURE_BUILDER_ONLY"
  | "SECURE_PRIVATE_API_UNAVAILABLE"
  | "SECURE_REQUEST_INVALID"
  | "SECURE_SOURCE_LOCKED"
  | "SECURE_SOURCE_UNAVAILABLE"
  | "SECURE_PROVIDER_AUTH_REQUIRED"
  | "SECURE_PROJECT_DEFAULT_LIMIT_REACHED"
  | "SECURE_SECRET_ALIAS_CONFLICT"
  | "SECURE_SECRET_NOT_FOUND"
  | "SECURE_SSH_HOST_KEY_CONFLICT"
  | "SECURE_SSH_HOST_NOT_FOUND"
  | "SECURE_VAULT_TRANSFER_EMPTY"
  | "SECURE_VAULT_TRANSFER_INVALID"
  | "SECURE_VAULT_TRANSFER_MISMATCH"
  | "SECURE_STALE_REVISION"
  | "SECURE_OPERATION_FAILED";

/**
 * Public-facing Secure Sessions failures are deliberately value-free. Provider
 * exceptions and source locators must never cross this boundary.
 */
export class SecureSessionsServiceError extends Error {
  constructor(readonly code: SecureSessionsServiceErrorCode) {
    super(code);
    this.name = "SecureSessionsServiceError";
  }
}
