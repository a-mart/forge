export type SecureExecutionErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "CONTAINER_CONFLICT"
  | "EXECUTION_ABORTED"
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "GUARD_FAILED"
  | "IMAGE_UNAVAILABLE"
  | "INVALID_COMMAND"
  | "INVALID_DELIVERY"
  | "INVALID_TASK"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TASK_REVOKED"
  | "UNSUPPORTED_PLATFORM";

const SAFE_MESSAGES: Readonly<Record<SecureExecutionErrorCode, string>> = {
  BACKEND_UNAVAILABLE: "The secure execution backend is unavailable.",
  CONTAINER_CONFLICT: "The secure task sandbox failed its security validation.",
  EXECUTION_ABORTED: "Secure execution was aborted.",
  EXECUTION_FAILED: "Secure execution failed.",
  EXECUTION_TIMEOUT: "Secure execution timed out.",
  GUARD_FAILED: "Secure output filtering failed.",
  IMAGE_UNAVAILABLE: "The secure execution image is unavailable.",
  INVALID_COMMAND: "The secure execution command is invalid.",
  INVALID_DELIVERY: "The secure material delivery request is invalid.",
  INVALID_TASK: "The secure execution task is invalid.",
  OUTPUT_LIMIT_EXCEEDED: "Guarded secure execution output exceeded its limit.",
  TASK_REVOKED: "The secure task sandbox has been revoked.",
  UNSUPPORTED_PLATFORM: "The secure execution backend is unsupported on this platform.",
};

/**
 * Fixed-message errors prevent subprocess stderr, commands, paths, and secret
 * material from being reflected into logs or provider-visible tool results.
 */
export class SecureExecutionError extends Error {
  readonly code: SecureExecutionErrorCode;

  constructor(code: SecureExecutionErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "SecureExecutionError";
    this.code = code;
  }
}
