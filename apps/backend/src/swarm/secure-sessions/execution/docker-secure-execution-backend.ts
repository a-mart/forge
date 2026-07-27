import { Buffer } from "node:buffer";
import {
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { DockerCli, type DockerCliOptions } from "./docker-cli.js";
import {
  DOCKER_GUEST_EXECUTOR_SOURCE,
  DOCKER_HEARTBEAT_INTERVAL_MS,
  DOCKER_HEARTBEAT_PATH,
  DOCKER_KEEPALIVE_SOURCE,
} from "./docker-guest-executor.js";
import { encodeSecureExecutionFrame } from "./execution-frame.js";
import { GuardedOutputCollector } from "./guarded-output-collector.js";
import type {
  SecureExecutionAvailability,
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionResult,
  SecureExecutionTask,
  SecureOrphanRecoveryResult,
  SecureTaskSandbox,
} from "./secure-execution-backend.js";
import {
  SecureExecutionError,
  type SecureExecutionErrorCode,
} from "./secure-execution-error.js";

const DEFAULT_IMAGE = "forge-secure-runner:node22-v5";
const RUNNER_CONTRACT_LABEL =
  "com.forge.secure-execution.runner-contract";
const RUNNER_CONTRACT_VERSION = "5";
const SECRET_ROOT = "/run/forge-secure";
const HOST_HEARTBEAT_TARGET = DOCKER_HEARTBEAT_PATH;
const MANAGED_LABEL = "com.forge.secure-execution.managed";
const SCOPE_LABEL = "com.forge.secure-execution.scope";
const TASK_LABEL = "com.forge.secure-execution.task";
const WORKSPACE_LABEL = "com.forge.secure-execution.workspace";
const GIT_COMMON_LABEL = "com.forge.secure-execution.git-common";
const VERSION_LABEL = "com.forge.secure-execution.version";
const PROTOCOL_VERSION = "2";
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface DockerInspectMount {
  Type?: unknown;
  Source?: unknown;
  Destination?: unknown;
  RW?: unknown;
}

interface DockerInspect {
  Config?: {
    Cmd?: unknown;
    Image?: unknown;
    User?: unknown;
    WorkingDir?: unknown;
    Labels?: Record<string, unknown>;
  };
  HostConfig?: {
    CapDrop?: unknown;
    CapAdd?: unknown;
    Devices?: unknown;
    Init?: unknown;
    PidsLimit?: unknown;
    Privileged?: unknown;
    ReadonlyRootfs?: unknown;
    RestartPolicy?: {
      Name?: unknown;
    };
    SecurityOpt?: unknown;
    Tmpfs?: Record<string, unknown>;
  };
  Mounts?: DockerInspectMount[];
  State?: {
    Running?: unknown;
  };
}

interface TaskIdentity {
  name: string;
  taskHash: string;
  workspaceHash: string;
  workspacePath: string;
  guestWorkspacePath: string;
  gitCommonDir: string | null;
  guestGitCommonDir: string | null;
  guestGitDirectory: string | null;
  gitCommonHash: string;
  heartbeatPath: string;
}

interface HeartbeatState {
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  file: FileHandle;
  path: string;
}

export interface DockerSecureExecutionBackendOptions {
  image?: string;
  scope?: string;
  dockerCommand?: string;
  dockerEnvironment?: NodeJS.ProcessEnv;
  dockerControlPlaneTimeoutMs?: number;
  heartbeatRoot?: string;
  onDockerInvocation?: DockerCliOptions["onInvocation"];
  runAsUser?: {
    uid: number;
    gid: number;
  };
  /**
   * Defaults to true for Forge's runner and false for an explicit image
   * override, whose tool contract belongs to the embedding application.
   */
  requireImageContract?: boolean;
  platform?: NodeJS.Platform;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

async function readSmallRegularFile(filePath: string): Promise<string> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 4_096) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  return await readFile(filePath, "utf8");
}

async function resolveExternalGitCommonDir(
  workspacePath: string,
): Promise<{ commonDirectory: string; gitDirectory: string } | null> {
  const dotGitPath = join(workspacePath, ".git");
  let dotGitStat;
  try {
    dotGitStat = await lstat(dotGitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SecureExecutionError("INVALID_TASK");
  }
  if (dotGitStat.isSymbolicLink()) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  if (dotGitStat.isDirectory()) {
    return null;
  }
  if (!dotGitStat.isFile()) {
    throw new SecureExecutionError("INVALID_TASK");
  }

  const pointer = (await readSmallRegularFile(dotGitPath)).trim();
  const match = /^gitdir:\s*(.+)$/u.exec(pointer);
  if (!match?.[1]) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  const gitDirectory = await realpath(resolve(workspacePath, match[1]));
  if (!(await stat(gitDirectory)).isDirectory()) {
    throw new SecureExecutionError("INVALID_TASK");
  }

  const reversePointer = (
    await readSmallRegularFile(join(gitDirectory, "gitdir"))
  ).trim();
  if (!reversePointer || reversePointer.includes("\0")) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  const reverseDotGitPath = await realpath(
    resolve(gitDirectory, reversePointer),
  );
  const canonicalDotGitPath = await realpath(dotGitPath);
  if (reverseDotGitPath !== canonicalDotGitPath) {
    throw new SecureExecutionError("INVALID_TASK");
  }

  const commonPointerPath = join(gitDirectory, "commondir");
  const commonPointer = (await readSmallRegularFile(commonPointerPath)).trim();
  if (!commonPointer || commonPointer.includes("\0")) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  const commonDirectory = await realpath(resolve(gitDirectory, commonPointer));
  if (
    !(await stat(commonDirectory)).isDirectory()
    || basename(commonDirectory) !== ".git"
    || commonDirectory.includes(",")
  ) {
    throw new SecureExecutionError("INVALID_TASK");
  }

  const worktreesRoot = join(commonDirectory, "worktrees");
  const relativeGitDirectory = relative(worktreesRoot, gitDirectory);
  if (
    !relativeGitDirectory
    || relativeGitDirectory.startsWith("..")
    || isAbsolute(relativeGitDirectory)
    || dirname(relativeGitDirectory) !== "."
  ) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  return isPathInside(workspacePath, commonDirectory)
    ? null
    : { commonDirectory, gitDirectory };
}

function defaultRunAsUser(): { uid: number; gid: number } {
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (
    hostUid !== undefined &&
    hostGid !== undefined &&
    hostUid > 0 &&
    hostGid >= 0
  ) {
    return { uid: hostUid, gid: hostGid };
  }
  return { uid: 65_532, gid: 65_532 };
}

function normalizeRunAsUser(
  user: DockerSecureExecutionBackendOptions["runAsUser"],
): { uid: number; gid: number } {
  const normalized = user ?? defaultRunAsUser();
  if (
    !Number.isSafeInteger(normalized.uid) ||
    normalized.uid <= 0 ||
    !Number.isSafeInteger(normalized.gid) ||
    normalized.gid < 0
  ) {
    throw new SecureExecutionError("INVALID_TASK");
  }
  return normalized;
}

function hasTmpfsOptions(
  value: unknown,
  required: readonly string[],
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const options = new Set(value.split(","));
  return required.every((option) => options.has(option));
}

export class DockerSecureExecutionBackend implements SecureExecutionBackend {
  readonly kind = "docker";

  private readonly image: string;
  private readonly scopeHash: string;
  private readonly cli: DockerCli;
  private readonly requireImageContract: boolean;
  private readonly runAsUser: { uid: number; gid: number };
  private readonly heartbeatRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly preparing = new Map<string, Promise<TaskIdentity>>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly fileDeliveryTails = new Map<string, Promise<void>>();
  private readonly revoked = new Set<string>();
  private readonly activeExecutions = new Map<
    string,
    Set<ChildProcessWithoutNullStreams>
  >();
  private readonly heartbeats = new Map<string, HeartbeatState>();
  private readonly heartbeatStarts = new Map<string, Promise<void>>();

  constructor(options: DockerSecureExecutionBackendOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.requireImageContract =
      options.requireImageContract ?? options.image === undefined;
    this.scopeHash = sha256(options.scope ?? "forge-local").slice(0, 16);
    this.runAsUser = normalizeRunAsUser(options.runAsUser);
    this.platform = options.platform ?? process.platform;
    this.heartbeatRoot = resolve(
      options.heartbeatRoot
        ?? join(tmpdir(), "forge-secure-heartbeats", this.scopeHash),
    );
    if (
      !isAbsolute(this.heartbeatRoot)
      || this.heartbeatRoot.includes("\0")
      || this.heartbeatRoot.includes(",")
    ) {
      throw new SecureExecutionError("INVALID_TASK");
    }
    this.cli = new DockerCli({
      command: options.dockerCommand,
      environment: options.dockerEnvironment,
      controlPlaneTimeoutMs: options.dockerControlPlaneTimeoutMs,
      onInvocation: options.onDockerInvocation,
      platform: this.platform,
    });
  }

  async probe(): Promise<SecureExecutionAvailability> {
    if (!(await this.cli.pinLocalEndpoint())) {
      return { available: false, code: "backend_unavailable" };
    }

    const version = await this.cli.run([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    if (version.exitCode !== 0 || version.stdout.byteLength === 0) {
      return { available: false, code: "backend_unavailable" };
    }

    const imageFormat = this.requireImageContract
      ? `{{index .Config.Labels "${RUNNER_CONTRACT_LABEL}"}}`
      : "{{.Id}}";
    const image = await this.cli.run([
      "image",
      "inspect",
      this.image,
      "--format",
      imageFormat,
    ]);
    if (
      image.exitCode !== 0 ||
      image.stdout.byteLength === 0 ||
      (this.requireImageContract &&
        image.stdout.toString("utf8").trim() !== RUNNER_CONTRACT_VERSION)
    ) {
      return { available: false, code: "image_unavailable" };
    }
    return { available: true, code: "available" };
  }

  async ensureTask(task: SecureExecutionTask): Promise<SecureTaskSandbox> {
    await this.requireLocalDockerEndpoint();
    const identity = await this.identifyTask(task);
    return await this.runLifecycleSerialized(identity.name, async () => {
      const prepared = await this.prepareTask(identity);
      this.revoked.delete(prepared.name);
      return { backend: this.kind, sandboxId: prepared.name };
    });
  }

  async execute(
    request: SecureExecutionRequest,
  ): Promise<SecureExecutionResult> {
    await this.requireLocalDockerEndpoint();
    const identity = await this.identifyTask(request.task);
    if (this.revoked.has(identity.name)) {
      throw new SecureExecutionError("TASK_REVOKED");
    }
    if (request.signal?.aborted) {
      await this.destroyIdentity(identity);
      throw new SecureExecutionError("EXECUTION_ABORTED");
    }

    await this.validateCommandCwd(request, identity);
    await this.runLifecycleSerialized(identity.name, async () => {
      if (this.revoked.has(identity.name)) {
        throw new SecureExecutionError("TASK_REVOKED");
      }
      await this.prepareTask(identity);
    });
    if (this.revoked.has(identity.name)) {
      throw new SecureExecutionError("TASK_REVOKED");
    }
    if (request.signal?.aborted) {
      await this.destroyIdentity(identity);
      throw new SecureExecutionError("EXECUTION_ABORTED");
    }
    const execute = async (): Promise<SecureExecutionResult> => {
      if (this.revoked.has(identity.name)) {
        throw new SecureExecutionError("TASK_REVOKED");
      }
      if (request.signal?.aborted) {
        await this.destroyIdentity(identity);
        throw new SecureExecutionError("EXECUTION_ABORTED");
      }
      return await this.executeInTask(identity, request);
    };
    // Environment, stdin, and askpass deliveries are execution-scoped and can
    // run concurrently. Public file bindings intentionally use stable paths,
    // so serialize only commands that materialize those paths; otherwise one
    // command's cleanup could remove a sibling's active file.
    return request.delivery?.ramFiles?.length
      ? await this.runFileDeliverySerialized(identity.name, execute)
      : await execute();
  }

  async destroyTask(task: SecureExecutionTask): Promise<boolean> {
    await this.requireLocalDockerEndpoint();
    const identity = this.identifyTaskForDestruction(task);
    return await this.destroyIdentity(identity);
  }

  async recoverOrphans(
    liveTasks: readonly SecureExecutionTask[],
  ): Promise<SecureOrphanRecoveryResult> {
    await this.requireLocalDockerEndpoint();
    const version = await this.cli.run([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    if (version.exitCode !== 0 || version.stdout.byteLength === 0) {
      throw new SecureExecutionError("BACKEND_UNAVAILABLE");
    }

    const liveIdentities = await Promise.all(
      liveTasks.map(async (task) => await this.identifyTask(task)),
    );
    const retainedNames = new Set(liveIdentities.map((identity) => identity.name));
    const listed = await this.cli.run([
      "ps",
      "-a",
      "--filter",
      `label=${MANAGED_LABEL}=true`,
      "--filter",
      `label=${SCOPE_LABEL}=${this.scopeHash}`,
      "--format",
      "{{.Names}}",
    ]);
    if (listed.exitCode !== 0) {
      throw new SecureExecutionError("BACKEND_UNAVAILABLE");
    }

    const names = listed.stdout
      .toString("utf8")
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean);
    const destroyedSandboxIds: string[] = [];
    for (const name of names) {
      if (retainedNames.has(name)) {
        continue;
      }
      const destroyed = await this.runLifecycleSerialized(name, async () => {
        this.revoked.add(name);
        return await this.destroyContainerByName(name);
      });
      if (destroyed) {
        destroyedSandboxIds.push(name);
      } else {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
    }
    for (const identity of liveIdentities) {
      await this.runLifecycleSerialized(identity.name, async () => {
        await this.prepareTask(identity);
        this.revoked.delete(identity.name);
      });
    }
    return { destroyedSandboxIds };
  }

  private async requireLocalDockerEndpoint(): Promise<void> {
    if (!(await this.cli.pinLocalEndpoint())) {
      throw new SecureExecutionError("BACKEND_UNAVAILABLE");
    }
  }

  private async identifyTask(task: SecureExecutionTask): Promise<TaskIdentity> {
    this.validateTaskShape(task);

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(task.workspacePath);
      const workspaceStat = await stat(canonicalPath);
      if (!workspaceStat.isDirectory()) {
        throw new SecureExecutionError("INVALID_TASK");
      }
    } catch {
      throw new SecureExecutionError("INVALID_TASK");
    }
    if (
      canonicalPath !== task.workspacePath ||
      resolve(task.workspacePath) !== task.workspacePath
    ) {
      throw new SecureExecutionError("INVALID_TASK");
    }

    const taskHash = sha256(task.taskId);
    const workspaceHash = sha256(canonicalPath);
    const externalGit = await resolveExternalGitCommonDir(canonicalPath);
    const gitCommonDir = externalGit?.commonDirectory ?? null;
    const guestWorkspacePath = this.platform === "win32"
      ? "/workspace"
      : canonicalPath;
    const guestGitCommonDir = gitCommonDir === null
      ? null
      : this.platform === "win32"
        ? "/forge-git-common"
        : gitCommonDir;
    const name = this.containerName(taskHash, workspaceHash);
    return {
      name,
      taskHash,
      workspaceHash,
      workspacePath: canonicalPath,
      guestWorkspacePath,
      gitCommonDir,
      guestGitCommonDir,
      guestGitDirectory: externalGit === null || this.platform !== "win32"
        ? null
        : posix.join("/forge-git-common", "worktrees", basename(externalGit.gitDirectory)),
      gitCommonHash: gitCommonDir === null ? "none" : sha256(gitCommonDir),
      heartbeatPath: this.heartbeatPath(name),
    };
  }

  private identifyTaskForDestruction(task: SecureExecutionTask): TaskIdentity {
    this.validateTaskShape(task);
    if (resolve(task.workspacePath) !== task.workspacePath) {
      throw new SecureExecutionError("INVALID_TASK");
    }
    const taskHash = sha256(task.taskId);
    const workspaceHash = sha256(task.workspacePath);
    const name = this.containerName(taskHash, workspaceHash);
    return {
      name,
      taskHash,
      workspaceHash,
      workspacePath: task.workspacePath,
      guestWorkspacePath: this.platform === "win32"
        ? "/workspace"
        : task.workspacePath,
      gitCommonDir: null,
      guestGitCommonDir: null,
      guestGitDirectory: null,
      gitCommonHash: "none",
      heartbeatPath: this.heartbeatPath(name),
    };
  }

  private validateTaskShape(task: SecureExecutionTask): void {
    if (
      !task
      || typeof task.taskId !== "string"
      || task.taskId.length === 0
      || task.taskId.length > 512
      || task.taskId.includes("\0")
      || typeof task.workspacePath !== "string"
      || !isAbsolute(task.workspacePath)
      || task.workspacePath.includes("\0")
      || task.workspacePath.includes(",")
    ) {
      throw new SecureExecutionError("INVALID_TASK");
    }
  }

  private containerName(taskHash: string, workspaceHash: string): string {
    return `forge-secure-${this.scopeHash.slice(0, 10)}-${sha256(
      `${taskHash}\0${workspaceHash}`,
    ).slice(0, 20)}`;
  }

  private heartbeatPath(name: string): string {
    return join(this.heartbeatRoot, name);
  }

  private async prepareTask(identity: TaskIdentity): Promise<TaskIdentity> {
    const pending = this.preparing.get(identity.name);
    if (pending) {
      return await pending;
    }

    const preparation = (async () => {
      await this.ensureHeartbeat(identity);
      try {
        return await this.prepareTaskWithoutLock(identity);
      } catch (error) {
        await this.stopHeartbeat(identity.name);
        throw error;
      }
    })();
    this.preparing.set(identity.name, preparation);
    try {
      return await preparation;
    } finally {
      if (this.preparing.get(identity.name) === preparation) {
        this.preparing.delete(identity.name);
      }
    }
  }

  private async prepareTaskWithoutLock(
    identity: TaskIdentity,
  ): Promise<TaskIdentity> {
    const existing = await this.inspectContainer(identity.name);
    if (existing) {
      this.validateContainer(existing, identity);
      if (existing.State?.Running !== true) {
        const started = await this.cli.run(["start", identity.name]);
        if (started.exitCode !== 0) {
          throw new SecureExecutionError("BACKEND_UNAVAILABLE");
        }
      }
      return identity;
    }

    const availability = await this.probe();
    this.assertAvailable(availability);
    const created = await this.cli.run(this.createContainerArgs(identity));
    if (created.exitCode !== 0) {
      const raced = await this.inspectContainer(identity.name);
      if (!raced) {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      this.validateContainer(raced, identity);
      if (raced.State?.Running !== true) {
        const started = await this.cli.run(["start", identity.name]);
        if (started.exitCode !== 0) {
          throw new SecureExecutionError("BACKEND_UNAVAILABLE");
        }
      }
      return identity;
    }

    try {
      const started = await this.cli.run(["start", identity.name]);
      if (started.exitCode !== 0) {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      const inspected = await this.inspectContainer(identity.name);
      if (!inspected) {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      this.validateContainer(inspected, identity);
      return identity;
    } catch (error) {
      await this.destroyContainerByName(identity.name);
      throw error;
    }
  }

  private async ensureHeartbeat(identity: TaskIdentity): Promise<void> {
    if (this.heartbeats.has(identity.name)) return;
    const pending = this.heartbeatStarts.get(identity.name);
    if (pending) return await pending;
    const starting = this.startHeartbeat(identity);
    this.heartbeatStarts.set(identity.name, starting);
    try {
      await starting;
    } finally {
      if (this.heartbeatStarts.get(identity.name) === starting) {
        this.heartbeatStarts.delete(identity.name);
      }
    }
  }

  private async startHeartbeat(identity: TaskIdentity): Promise<void> {
    const file = await this.openHeartbeatFile(identity.heartbeatPath);
    const state: HeartbeatState = {
      stopped: false,
      timer: null,
      file,
      path: identity.heartbeatPath,
    };
    this.heartbeats.set(identity.name, state);
    if (!(await this.pulseHeartbeat(state))) {
      await this.stopHeartbeat(identity.name, state);
      throw new SecureExecutionError("BACKEND_UNAVAILABLE");
    }
    this.scheduleHeartbeat(identity.name, state);
  }

  private scheduleHeartbeat(name: string, state: HeartbeatState): void {
    if (state.stopped || this.heartbeats.get(name) !== state) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void (async () => {
        const healthy = await this.pulseHeartbeat(state);
        if (state.stopped || this.heartbeats.get(name) !== state) return;
        if (!healthy) {
          this.revoked.add(name);
          await this.stopHeartbeat(name, state);
          await this.runLifecycleSerialized(
            name,
            async () => await this.destroyContainerByName(name),
          );
          return;
        }
        this.scheduleHeartbeat(name, state);
      })();
    }, DOCKER_HEARTBEAT_INTERVAL_MS);
    state.timer.unref?.();
  }

  private async openHeartbeatFile(filePath: string): Promise<FileHandle> {
    await mkdir(this.heartbeatRoot, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.heartbeatRoot);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new SecureExecutionError("BACKEND_UNAVAILABLE");
    }
    await chmod(this.heartbeatRoot, 0o700);

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let file: FileHandle;
    try {
      file = await open(
        filePath,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_RDWR
          | noFollow,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      const existing = await lstat(filePath);
      if (
        !existing.isFile()
        || existing.isSymbolicLink()
        || existing.nlink !== 1
        || (process.getuid !== undefined && existing.uid !== process.getuid())
      ) {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      file = await open(filePath, fsConstants.O_RDWR | noFollow);
    }
    try {
      const opened = await file.stat();
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || (process.getuid !== undefined && opened.uid !== process.getuid())
      ) {
        throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      }
      await file.chmod(0o600);
      return file;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  private async pulseHeartbeat(state: HeartbeatState): Promise<boolean> {
    try {
      const now = new Date();
      await state.file.utimes(now, now);
      return true;
    } catch {
      return false;
    }
  }

  private async stopHeartbeat(
    name: string,
    expected?: HeartbeatState,
  ): Promise<void> {
    const state = this.heartbeats.get(name);
    if (!state || (expected && state !== expected)) {
      if (!expected) {
        await rm(this.heartbeatPath(name), { force: true }).catch(() => undefined);
      }
      return;
    }
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    this.heartbeats.delete(name);
    await state.file.close().catch(() => undefined);
    await rm(state.path, { force: true }).catch(() => undefined);
  }

  private createContainerArgs(identity: TaskIdentity): string[] {
    const user = `${this.runAsUser.uid}:${this.runAsUser.gid}`;
    const secretTmpfs = `${SECRET_ROOT}:${[
      "rw",
      "noexec",
      "nosuid",
      "nodev",
      "size=17825792",
      "mode=0700",
      `uid=${this.runAsUser.uid}`,
      `gid=${this.runAsUser.gid}`,
    ].join(",")}`;
    const temporaryTmpfs = `/tmp:${[
      "rw",
      "exec",
      "nosuid",
      "nodev",
      "size=67108864",
      "mode=1777",
    ].join(",")}`;

    return [
      "create",
      "--name",
      identity.name,
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${SCOPE_LABEL}=${this.scopeHash}`,
      "--label",
      `${TASK_LABEL}=${identity.taskHash}`,
      "--label",
      `${WORKSPACE_LABEL}=${identity.workspaceHash}`,
      "--label",
      `${GIT_COMMON_LABEL}=${identity.gitCommonHash}`,
      "--label",
      `${VERSION_LABEL}=${PROTOCOL_VERSION}`,
      "--user",
      user,
      "--workdir",
      identity.guestWorkspacePath,
      "--read-only",
      "--restart",
      "no",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "256",
      "--init",
      "--tmpfs",
      secretTmpfs,
      "--tmpfs",
      temporaryTmpfs,
      "--mount",
      `type=bind,source=${identity.workspacePath},target=${identity.guestWorkspacePath}`,
      "--mount",
      `type=bind,source=${identity.heartbeatPath},target=${HOST_HEARTBEAT_TARGET},readonly`,
      ...(identity.gitCommonDir === null
        ? []
        : [
            "--mount",
            `type=bind,source=${identity.gitCommonDir},target=${identity.guestGitCommonDir}`,
          ]),
      this.image,
      "node",
      "-e",
      DOCKER_KEEPALIVE_SOURCE,
    ];
  }

  private async inspectContainer(name: string): Promise<DockerInspect | null> {
    const inspected = await this.cli.run(["container", "inspect", name]);
    if (inspected.exitCode !== 0) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(inspected.stdout.toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        return null;
      }
      return parsed[0] as DockerInspect;
    } catch {
      return null;
    }
  }

  private validateContainer(
    inspected: DockerInspect,
    identity: TaskIdentity,
  ): void {
    const labels = inspected.Config?.Labels;
    const capDrop = inspected.HostConfig?.CapDrop;
    const securityOptions = inspected.HostConfig?.SecurityOpt;
    const tmpfs = inspected.HostConfig?.Tmpfs;
    const mounts = inspected.Mounts ?? [];
    const bindMounts = mounts.filter((mount) => mount.Type === "bind");
    const workspaceMount = bindMounts.find(
      (mount) => mount.Destination === identity.guestWorkspacePath,
    );
    const heartbeatMount = bindMounts.find(
      (mount) => mount.Destination === HOST_HEARTBEAT_TARGET,
    );
    const gitCommonMount = identity.gitCommonDir === null
      ? undefined
      : bindMounts.find(
          (mount) => mount.Destination === identity.guestGitCommonDir,
        );
    const user = `${this.runAsUser.uid}:${this.runAsUser.gid}`;
    const expectedSecretTmpfs = [
      "rw",
      "noexec",
      "nosuid",
      "nodev",
      "size=17825792",
      `uid=${this.runAsUser.uid}`,
      `gid=${this.runAsUser.gid}`,
    ];
    const expectedTemporaryTmpfs = [
      "rw",
      "exec",
      "nosuid",
      "nodev",
      "size=67108864",
      "mode=1777",
    ];
    const allowedMounts = mounts.every(
      (mount) =>
        (mount.Type === "bind" &&
          mount.Source === identity.workspacePath &&
          mount.Destination === identity.guestWorkspacePath &&
          mount.RW === true) ||
        (mount.Type === "bind" &&
          mount.Source === identity.heartbeatPath &&
          mount.Destination === HOST_HEARTBEAT_TARGET &&
          mount.RW === false) ||
        (identity.gitCommonDir !== null &&
          mount.Type === "bind" &&
          mount.Source === identity.gitCommonDir &&
          mount.Destination === identity.guestGitCommonDir &&
          mount.RW === true) ||
        (mount.Type === "tmpfs" &&
          (mount.Destination === SECRET_ROOT ||
            mount.Destination === "/tmp")),
    );
    const capAdd = inspected.HostConfig?.CapAdd;
    const devices = inspected.HostConfig?.Devices;

    const valid =
      inspected.Config?.Image === this.image &&
      Array.isArray(inspected.Config?.Cmd) &&
      inspected.Config.Cmd.length === 3 &&
      inspected.Config.Cmd[0] === "node" &&
      inspected.Config.Cmd[1] === "-e" &&
      inspected.Config.Cmd[2] === DOCKER_KEEPALIVE_SOURCE &&
      inspected.Config?.User === user &&
      inspected.Config?.WorkingDir === identity.guestWorkspacePath &&
      labels?.[MANAGED_LABEL] === "true" &&
      labels?.[SCOPE_LABEL] === this.scopeHash &&
      labels?.[TASK_LABEL] === identity.taskHash &&
      labels?.[WORKSPACE_LABEL] === identity.workspaceHash &&
      labels?.[GIT_COMMON_LABEL] === identity.gitCommonHash &&
      labels?.[VERSION_LABEL] === PROTOCOL_VERSION &&
      (!this.requireImageContract ||
        labels?.[RUNNER_CONTRACT_LABEL] === RUNNER_CONTRACT_VERSION) &&
      inspected.HostConfig?.ReadonlyRootfs === true &&
      inspected.HostConfig?.Privileged === false &&
      inspected.HostConfig?.RestartPolicy?.Name === "no" &&
      inspected.HostConfig?.Init === true &&
      inspected.HostConfig?.PidsLimit === 256 &&
      Array.isArray(capDrop) &&
      capDrop.includes("ALL") &&
      (capAdd === null || (Array.isArray(capAdd) && capAdd.length === 0)) &&
      (devices === null || (Array.isArray(devices) && devices.length === 0)) &&
      Array.isArray(securityOptions) &&
      securityOptions.some(
        (option) =>
          option === "no-new-privileges" ||
          option === "no-new-privileges=true",
      ) &&
      tmpfs !== undefined &&
      hasTmpfsOptions(tmpfs[SECRET_ROOT], expectedSecretTmpfs) &&
      (String(tmpfs[SECRET_ROOT]).includes("mode=0700") ||
        String(tmpfs[SECRET_ROOT]).includes("mode=700")) &&
      hasTmpfsOptions(tmpfs["/tmp"], expectedTemporaryTmpfs) &&
      allowedMounts &&
      bindMounts.length === (identity.gitCommonDir === null ? 2 : 3) &&
      workspaceMount?.Source === identity.workspacePath &&
      workspaceMount.Destination === identity.guestWorkspacePath &&
      workspaceMount.RW === true &&
      heartbeatMount?.Source === identity.heartbeatPath &&
      heartbeatMount.Destination === HOST_HEARTBEAT_TARGET &&
      heartbeatMount.RW === false &&
      (identity.gitCommonDir === null ||
        (gitCommonMount?.Source === identity.gitCommonDir &&
          gitCommonMount.Destination === identity.guestGitCommonDir &&
          gitCommonMount.RW === true)) &&
      !mounts.some(
        (mount) =>
          mount.Source === "/var/run/docker.sock" ||
          mount.Destination === "/var/run/docker.sock",
      );

    if (!valid) {
      throw new SecureExecutionError("CONTAINER_CONFLICT");
    }
  }

  private assertAvailable(availability: SecureExecutionAvailability): void {
    if (availability.available) {
      return;
    }
    const errorByCode: Record<
      Exclude<SecureExecutionAvailability["code"], "available">,
      SecureExecutionErrorCode
    > = {
      backend_unavailable: "BACKEND_UNAVAILABLE",
      image_unavailable: "IMAGE_UNAVAILABLE",
      unsupported_platform: "UNSUPPORTED_PLATFORM",
    };
    throw new SecureExecutionError(
      errorByCode[
        availability.code as Exclude<
          SecureExecutionAvailability["code"],
          "available"
        >
      ],
    );
  }

  private async validateCommandCwd(
    request: SecureExecutionRequest,
    identity: TaskIdentity,
  ): Promise<void> {
    const cwd = request.command.cwd ?? identity.workspacePath;
    if (
      !isAbsolute(cwd) ||
      resolve(cwd) !== cwd ||
      !isPathInside(identity.workspacePath, cwd)
    ) {
      throw new SecureExecutionError("INVALID_COMMAND");
    }
    if (
      request.maxGuardedOutputBytes !== undefined &&
      (!Number.isSafeInteger(request.maxGuardedOutputBytes) ||
        request.maxGuardedOutputBytes <= 0)
    ) {
      throw new SecureExecutionError("INVALID_COMMAND");
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)
    ) {
      throw new SecureExecutionError("INVALID_COMMAND");
    }
  }

  private async executeInTask(
    identity: TaskIdentity,
    request: SecureExecutionRequest,
  ): Promise<SecureExecutionResult> {
    const hostCwd = request.command.cwd ?? identity.workspacePath;
    const relativeCwd = relative(identity.workspacePath, hostCwd)
      .split("\\")
      .join("/");
    const guestCwd = posix.join(identity.guestWorkspacePath, relativeCwd);
    const guestCommand = identity.guestGitDirectory === null
      ? { ...request.command, cwd: guestCwd }
      : {
          executable: "/usr/bin/env",
          args: [
            `GIT_DIR=${identity.guestGitDirectory}`,
            `GIT_COMMON_DIR=${identity.guestGitCommonDir}`,
            `GIT_WORK_TREE=${identity.guestWorkspacePath}`,
            request.command.executable,
            ...request.command.args,
          ],
          cwd: guestCwd,
        };
    const frame = encodeSecureExecutionFrame({
      executionId: randomBytes(12).toString("hex"),
      command: guestCommand,
      workspacePath: identity.guestWorkspacePath,
      delivery: request.delivery,
    });
    const child = this.cli.spawn([
      "exec",
      "-i",
      "--user",
      `${this.runAsUser.uid}:${this.runAsUser.gid}`,
      identity.name,
      "node",
      "-e",
      DOCKER_GUEST_EXECUTOR_SOURCE,
    ]);
    this.trackExecution(identity.name, child);

    let fatalError: SecureExecutionError | undefined;
    let destruction: Promise<boolean> | undefined;
    const failClosed = (error: SecureExecutionError): void => {
      if (fatalError) {
        return;
      }
      fatalError = error;
      destruction = this.destroyIdentity(identity).finally(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      });
    };

    const collector = new GuardedOutputCollector({
      guard: request.guardOutput,
      onOutput: request.onOutput,
      maxBytes: request.maxGuardedOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      onFailure: failClosed,
    });

    const consume = (
      stream: "stdout" | "stderr",
      chunk: Buffer,
    ): void => {
      const source = stream === "stdout" ? child.stdout : child.stderr;
      source.pause();
      void collector.accept(stream, chunk).finally(() => {
        if (!source.destroyed && !fatalError) {
          source.resume();
        }
      });
    };
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));

    const onAbort = (): void =>
      failClosed(new SecureExecutionError("EXECUTION_ABORTED"));
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort can race the docker-exec spawn and listener registration. Recheck
    // immediately after registration so that window cannot produce a
    // successful command result after the caller has cancelled it.
    if (request.signal?.aborted) {
      onAbort();
    }
    const timeout =
      request.timeoutMs !== undefined && request.timeoutMs > 0
        ? setTimeout(
            () => failClosed(new SecureExecutionError("EXECUTION_TIMEOUT")),
            request.timeoutMs,
          )
        : undefined;

    const outcome = new Promise<{ exitCode: number; signal: string | null }>(
      (resolveOutcome) => {
        child.once("error", () => {
          failClosed(new SecureExecutionError("EXECUTION_FAILED"));
          resolveOutcome({ exitCode: -1, signal: null });
        });
        child.once("close", (code, signal) => {
          resolveOutcome({ exitCode: code ?? -1, signal });
        });
      },
    );

    child.stdin.once("error", () => {
      failClosed(new SecureExecutionError("EXECUTION_FAILED"));
    });
    child.stdin.end(frame, () => frame.fill(0));

    try {
      const processOutcome = await outcome;
      let guarded: { stdout: Buffer; stderr: Buffer };
      try {
        guarded = await collector.finish();
      } catch {
        if (destruction) {
          await destruction;
        }
        throw fatalError ?? new SecureExecutionError("GUARD_FAILED");
      }
      if (destruction) {
        await destruction;
      }
      if (fatalError) {
        throw fatalError;
      }
      if (this.revoked.has(identity.name)) {
        throw new SecureExecutionError("TASK_REVOKED");
      }
      // Exit 125 is reserved for malformed frames and guest cleanup failures.
      // A command that deliberately chooses it is conservatively treated as
      // an executor integrity failure in secure mode.
      if (processOutcome.exitCode === 125) {
        await this.destroyIdentity(identity);
        throw new SecureExecutionError("EXECUTION_FAILED");
      }
      return {
        exitCode: processOutcome.exitCode,
        signal: processOutcome.signal,
        stdout: guarded.stdout,
        stderr: guarded.stderr,
      };
    } finally {
      frame.fill(0);
      if (timeout) {
        clearTimeout(timeout);
      }
      request.signal?.removeEventListener("abort", onAbort);
      this.untrackExecution(identity.name, child);
    }
  }

  private trackExecution(
    name: string,
    child: ChildProcessWithoutNullStreams,
  ): void {
    const executions =
      this.activeExecutions.get(name) ??
      new Set<ChildProcessWithoutNullStreams>();
    executions.add(child);
    this.activeExecutions.set(name, executions);
  }

  private async runFileDeliverySerialized<Result>(
    name: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.fileDeliveryTails.get(name) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.fileDeliveryTails.set(name, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.fileDeliveryTails.get(name) === tail) {
        this.fileDeliveryTails.delete(name);
      }
    }
  }

  private async runLifecycleSerialized<Result>(
    name: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.lifecycleTails.get(name) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.lifecycleTails.set(name, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.lifecycleTails.get(name) === tail) {
        this.lifecycleTails.delete(name);
      }
    }
  }

  private untrackExecution(
    name: string,
    child: ChildProcessWithoutNullStreams,
  ): void {
    const executions = this.activeExecutions.get(name);
    executions?.delete(child);
    if (executions?.size === 0) {
      this.activeExecutions.delete(name);
    }
  }

  private async destroyIdentity(identity: TaskIdentity): Promise<boolean> {
    return await this.runLifecycleSerialized(identity.name, async () => {
      this.revoked.add(identity.name);
      return await this.destroyContainerByName(identity.name);
    });
  }

  private async destroyContainerByName(name: string): Promise<boolean> {
    await this.stopHeartbeat(name);
    let removed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.cli.run(["rm", "-f", "--volumes", name]);
      if (result.exitCode === 0) {
        removed = true;
        break;
      }
    }
    const executions = this.activeExecutions.get(name);
    for (const child of executions ?? []) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    if (removed) {
      return true;
    }

    const listed = await this.cli.run([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${name}$`,
    ]);
    if (listed.exitCode !== 0) return false;
    return listed.stdout.toString("utf8").trim().length === 0;
  }
}

export const dockerSecureExecutionMetadata = Object.freeze({
  defaultImage: DEFAULT_IMAGE,
  managedLabel: MANAGED_LABEL,
  scopeLabel: SCOPE_LABEL,
  taskLabel: TASK_LABEL,
  workspaceLabel: WORKSPACE_LABEL,
  gitCommonLabel: GIT_COMMON_LABEL,
  versionLabel: VERSION_LABEL,
  protocolVersion: PROTOCOL_VERSION,
  runnerContractLabel: RUNNER_CONTRACT_LABEL,
  runnerContractVersion: RUNNER_CONTRACT_VERSION,
  secretRoot: SECRET_ROOT,
  hostHeartbeatTarget: HOST_HEARTBEAT_TARGET,
});
