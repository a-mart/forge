export type SecureOutputStream = "stdout" | "stderr";

export interface SecureExecutionTask {
  /**
   * An opaque, non-secret task identifier. Concrete backends must not expose
   * the raw identifier through their provider's metadata.
   */
  taskId: string;
  /**
   * The canonical absolute host workspace. Sandboxes mount it directly;
   * Windows Docker Desktop uses a fixed Linux guest path and translates cwd.
   */
  workspacePath: string;
}

export interface SecureExecutionCommand {
  executable: string;
  args: readonly string[];
  /**
   * Defaults to the task workspace and must remain inside it.
   */
  cwd?: string;
}

export interface SecureEnvironmentDelivery {
  name: string;
  value: Uint8Array;
}

export interface SecureRamFileDelivery {
  /**
   * Matches the protocol file binding targetPath. Docker accepts only canonical
   * absolute paths below /run/forge-secure/bindings.
   */
  targetPath: string;
  value: Uint8Array;
  /**
   * Restricted to owner-only permissions. Defaults to 0o400.
   */
  fileMode?: 0o400 | 0o600;
  /**
   * When present, the guest sets this variable to the materialized file path.
   */
  pathEnvironmentVariable?: string;
}

export interface SecureAskpassDelivery {
  /**
   * Matches the protocol askpass binding targetName (for example
   * SSH_ASKPASS). The guest sets it to a fixed helper path; the value itself
   * remains in the secret tmpfs.
   */
  targetName: string;
  value: Uint8Array;
}

export interface SecureExecutionDelivery {
  environment?: readonly SecureEnvironmentDelivery[];
  ramFiles?: readonly SecureRamFileDelivery[];
  askpass?: readonly SecureAskpassDelivery[];
  /**
   * Explicit secret-bearing stdin for programs whose native interface reads a
   * credential from stdin. This is not a shell interpolation mechanism.
   */
  stdin?: Uint8Array;
}

export interface SecureOutputGuardInput {
  stream: SecureOutputStream;
  bytes: Uint8Array;
  /**
   * A final empty input lets a stateful guard release its buffered tail.
   */
  final: boolean;
}

/**
 * The backend never returns or publishes pre-guard output. Implementations
 * call this function before both result collection and onOutput.
 */
export type SecureOutputGuard = (
  input: SecureOutputGuardInput,
) => Uint8Array | Promise<Uint8Array>;

export interface GuardedSecureOutput {
  stream: SecureOutputStream;
  bytes: Uint8Array;
}

export interface SecureExecutionRequest {
  task: SecureExecutionTask;
  command: SecureExecutionCommand;
  delivery?: SecureExecutionDelivery;
  guardOutput: SecureOutputGuard;
  onOutput?: (output: GuardedSecureOutput) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Bounds retained, post-guard output. Streaming consumers can choose a lower
   * bound; the default is 16 MiB across stdout and stderr.
   */
  maxGuardedOutputBytes?: number;
}

export interface SecureExecutionResult {
  exitCode: number;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface SecureTaskSandbox {
  backend: string;
  /**
   * Provider-owned opaque identifier. It contains hashes, not the raw task id.
   */
  sandboxId: string;
}

export interface SecureExecutionAvailability {
  available: boolean;
  code:
    | "available"
    | "backend_unavailable"
    | "image_unavailable"
    | "unsupported_platform";
}

export interface SecureOrphanRecoveryResult {
  destroyedSandboxIds: readonly string[];
}

export interface SecureExecutionBackend {
  readonly kind: string;

  probe(): Promise<SecureExecutionAvailability>;

  /**
   * Installs Forge's owned local runner when the backend supports it. The
   * operation must remain on the same pinned local provider endpoint used for
   * execution and return only fixed availability metadata.
   */
  installRunner?(): Promise<SecureExecutionAvailability>;

  /**
   * Explicitly provisions (or re-authorizes after hard destroy) a persistent
   * task sandbox.
   */
  ensureTask(task: SecureExecutionTask): Promise<SecureTaskSandbox>;

  execute(request: SecureExecutionRequest): Promise<SecureExecutionResult>;

  /**
   * Immediately destroys the provider sandbox and invalidates execution until
   * ensureTask is explicitly called again. Returns true only when absence is
   * confirmed (including an already-absent sandbox); false means teardown
   * could not be confirmed and callers must remain fail-closed.
   */
  destroyTask(task: SecureExecutionTask): Promise<boolean>;

  /**
   * Removes managed provider sandboxes not represented by the supplied live
   * task set. Retained sandboxes are still revalidated before their next use.
   */
  recoverOrphans(
    liveTasks: readonly SecureExecutionTask[],
  ): Promise<SecureOrphanRecoveryResult>;
}
