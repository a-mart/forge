import type { AgentDescriptor } from "../../types.js";
import { SecureExecutionError } from "../execution/secure-execution-error.js";

export const SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE =
  "Secure Sessions are not supported by this runtime provider.";
export const SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE =
  "The Secure Session runtime could not be prepared.";
export const SECURE_RUNTIME_GUARD_FAILURE_MESSAGE =
  "Secure Session output could not be safely processed.";

export interface SecureRuntimeBashExecutionRequest {
  /**
   * The command still contains only model-visible text and opaque secret
   * references. Resolution and material delivery remain binding-owned.
   */
  command: string;
  cwd: string;
  /**
   * Exact display aliases for the already-granted secrets this command may
   * receive. An empty list keeps the command inside Secure Bash for SSH trust
   * or isolation without delivering secret material.
   */
  secretAliases: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Implementations must invoke this callback only with output that already
   * passed their stateful stream guard. Pi persists and publishes bytes
   * synchronously after this boundary.
   */
  onData(data: Uint8Array): void;
}

export interface SecureRuntimeBashExecutionResult {
  exitCode: number | null;
}

/**
 * Stateful output capability for host-side tools that remain available while
 * Secure Sessions grants are active. The implementation owns the registered
 * secret material; callers can only submit bytes and receive already-guarded
 * copies.
 */
export interface SecureRuntimeOutputGuard {
  write(data: Uint8Array): Uint8Array;
  close(): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * Backend-process-only capability for a single Secure Session lease.
 *
 * Implementations must not expose raw secret material through this interface.
 * guardValue must preserve the public shape of safe runtime values while
 * replacing or quarantining secret-bearing content.
 */
export interface SecureRuntimeBinding {
  /**
   * Backend lifecycle capability. Runtime ownership calls this before detach;
   * it is never exposed as an agent tool.
   */
  invalidate?(): void;
  executeBash(
    request: SecureRuntimeBashExecutionRequest,
  ): Promise<SecureRuntimeBashExecutionResult>;
  createOutputGuard(): SecureRuntimeOutputGuard;
  guardValue<T>(value: T): T;
}

export type GetSecureRuntimeBinding = (
  descriptor: AgentDescriptor,
  runtimeToken?: number,
) =>
  | SecureRuntimeBinding
  | undefined
  | Promise<SecureRuntimeBinding | undefined>;

export function guardSecureRuntimeValue<T>(
  binding: SecureRuntimeBinding,
  value: T,
): T {
  try {
    return binding.guardValue(value);
  } catch {
    throw new Error(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
  }
}

export function guardSecureRuntimeError(
  binding: SecureRuntimeBinding,
  error: unknown,
): Error {
  // SecureExecutionError is constructed only from Forge-owned codes whose
  // messages are fixed and value-free. Preserve that diagnostic even after a
  // timeout, abort, or backend failure. Attempting to guard the fixed error
  // through a binding that may be unavailable would replace the real cause
  // with the misleading generic output-filter failure.
  if (error instanceof SecureExecutionError) {
    const safeError = new SecureExecutionError(error.code);
    safeError.stack = undefined;
    return safeError;
  }

  const unsafeDetails =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : {
          name: "Error",
          message: typeof error === "string" ? error : "Secure Session tool execution failed.",
        };

  try {
    const guarded = binding.guardValue(unsafeDetails);
    if (
      guarded &&
      typeof guarded === "object" &&
      !Array.isArray(guarded) &&
      typeof guarded.message === "string"
    ) {
      const safeError = new Error(guarded.message);
      if (typeof guarded.name === "string" && guarded.name.trim().length > 0) {
        safeError.name = guarded.name;
      }
      if (typeof guarded.stack === "string") {
        safeError.stack = guarded.stack;
      }
      return safeError;
    }
  } catch {
    // Fall through to a fixed, non-secret error.
  }

  return new Error(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
}
