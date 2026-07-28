import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { Buffer } from "node:buffer";

const DOCKER_ENVIRONMENT_ALLOWLIST = [
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_RUNTIME_DIR",
] as const;

const WINDOWS_LOCAL_DOCKER_ENDPOINTS = new Set([
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerdesktoplinuxengine",
]);

export interface DockerInvocation {
  args: readonly string[];
}

export interface DockerCliOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  onInvocation?: (invocation: DockerInvocation) => void;
  controlPlaneTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface DockerCliResult {
  exitCode: number;
  stdout: Buffer;
}

function defaultDockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of DOCKER_ENVIRONMENT_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export class DockerCli {
  private readonly command: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly onInvocation: DockerCliOptions["onInvocation"];
  private readonly controlPlaneTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private pinnedEndpoint: string | null = null;
  private endpointPinPromise: Promise<boolean> | null = null;

  constructor(options: DockerCliOptions = {}) {
    this.command = options.command ?? "docker";
    this.environment = options.environment ?? defaultDockerEnvironment();
    this.onInvocation = options.onInvocation;
    this.controlPlaneTimeoutMs =
      options.controlPlaneTimeoutMs !== undefined
      && Number.isFinite(options.controlPlaneTimeoutMs)
      && options.controlPlaneTimeoutMs > 0
        ? options.controlPlaneTimeoutMs
        : 5_000;
    this.platform = options.platform ?? process.platform;
  }

  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    const copiedArgs = this.pinnedEndpoint === null
      ? [...args]
      : ["--host", this.pinnedEndpoint, ...args];
    this.onInvocation?.({ args: copiedArgs });

    const spawnOptions: SpawnOptionsWithoutStdio = {
      env: this.environment,
      shell: false,
    };
    return spawn(this.command, copiedArgs, {
      ...spawnOptions,
      stdio: "pipe",
    });
  }

  /**
   * Resolve Docker's effective endpoint once, require an explicitly recognized
   * local endpoint, and pin every later invocation with an explicit --host
   * argument. This prevents a context or environment change from redirecting
   * secret-bearing exec stdin to a remote daemon after the initial availability
   * check.
   */
  async pinLocalEndpoint(): Promise<boolean> {
    if (this.pinnedEndpoint !== null) return true;
    this.endpointPinPromise ??= this.resolveAndPinLocalEndpoint();
    return await this.endpointPinPromise;
  }

  private async resolveAndPinLocalEndpoint(): Promise<boolean> {
    const configuredHost = this.environment.DOCKER_HOST;
    let endpoint = configuredHost;
    if (endpoint === undefined || endpoint.length === 0) {
      const inspected = await this.run([
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
      if (inspected.exitCode !== 0 || inspected.stdout.byteLength === 0) {
        return false;
      }
      try {
        const parsed: unknown = JSON.parse(
          inspected.stdout.toString("utf8").trim(),
        );
        if (typeof parsed !== "string") return false;
        endpoint = parsed;
      } catch {
        return false;
      }
    }
    if (!isLocalDockerEndpoint(endpoint, this.platform)) return false;
    this.pinnedEndpoint = endpoint;
    return true;
  }

  async run(
    args: readonly string[],
    maxStdoutBytes = 4 * 1024 * 1024,
  ): Promise<DockerCliResult> {
    const child = this.spawn(args);
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let exceeded = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (exceeded) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        exceeded = true;
        for (const retained of stdoutChunks) {
          retained.fill(0);
        }
        stdoutChunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    // Control-plane stderr is intentionally discarded. It is neither needed
    // for decisions nor safe to reflect into provider-visible errors.
    child.stderr.resume();

    let timedOut = false;
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const settle = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(code);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        for (const retained of stdoutChunks) retained.fill(0);
        stdoutChunks.length = 0;
        child.kill("SIGKILL");
        settle(-1);
      }, this.controlPlaneTimeoutMs);
      timeout.unref?.();
      child.once("error", () => settle(-1));
      child.once("close", (code) => settle(code ?? -1));
    });

    if (exceeded || timedOut) {
      return { exitCode: -1, stdout: Buffer.alloc(0) };
    }
    return { exitCode, stdout: Buffer.concat(stdoutChunks) };
  }
}

function isLocalDockerEndpoint(
  endpoint: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    return WINDOWS_LOCAL_DOCKER_ENDPOINTS.has(endpoint.toLowerCase());
  }
  if (
    endpoint.includes("\0")
    || endpoint.includes("%")
    || endpoint.includes("?")
    || endpoint.includes("#")
    || !endpoint.startsWith("unix:///")
  ) {
    return false;
  }
  const socketPath = endpoint.slice("unix://".length);
  return socketPath.startsWith("/") && !socketPath.includes("\n");
}
