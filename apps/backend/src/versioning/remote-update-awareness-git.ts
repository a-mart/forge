import { createHash } from "node:crypto";
import { GitCli, normalizeGitCommandError, type GitCliRunOptions } from "./git-cli.js";
import {
  isValidGitRemoteNameShape,
  listRemoteNames,
  resolveGitCommonDirectory
} from "./git-source-control-helpers.js";
import type {
  RemoteUpdateGitObservation,
  RemoteUpdateObservationState,
  ResolvedRemoteUpdateTarget
} from "../swarm/remote-update-awareness/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FULL_OID_PATTERN = /^[0-9a-f]{40,64}$/;

export type RemoteUpdateGitErrorCode = Extract<
  RemoteUpdateObservationState,
  | "missing"
  | "unresolved"
  | "auth_error"
  | "transport_error"
  | "timeout"
  | "invalid_repository"
  | "ref_integrity_error"
  | "aborted"
>;

/** Public-safe error: it intentionally carries no command, path, URL, ref, OID, or output. */
export class RemoteUpdateGitError extends Error {
  readonly code: RemoteUpdateGitErrorCode;

  constructor(code: RemoteUpdateGitErrorCode) {
    super(remoteUpdateGitErrorMessage(code));
    this.name = "RemoteUpdateGitError";
    this.code = code;
  }
}

export interface ResolveRemoteUpdateTargetInput {
  cwd: string;
  remoteName: string;
  targetRef?: string;
  signal?: AbortSignal;
}

export interface ObserveRemoteUpdateInput {
  cwd: string;
  target: ResolvedRemoteUpdateTarget;
  previousTipOid?: string | null;
  signal?: AbortSignal;
}

export interface RemoteUpdateGitObserverOptions {
  gitFactory?: (cwd: string) => GitCli;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
}

export class RemoteUpdateGitObserver {
  private readonly gitFactory: (cwd: string) => GitCli;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;

  constructor(options: RemoteUpdateGitObserverOptions = {}) {
    this.gitFactory = options.gitFactory ?? ((cwd) => new GitCli({ cwd }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async resolveTarget(input: ResolveRemoteUpdateTargetInput): Promise<ResolvedRemoteUpdateTarget> {
    const remoteName = input.remoteName.trim();
    if (!isValidGitRemoteNameShape(remoteName)) {
      throw new RemoteUpdateGitError("unresolved");
    }

    const git = this.gitFactory(input.cwd);
    const commonDir = await resolveGitCommonDirectory(git, input.cwd);
    if (!commonDir) {
      throw new RemoteUpdateGitError("invalid_repository");
    }

    const remotes = await listRemoteNames(git);
    if (!remotes.includes(remoteName)) {
      throw new RemoteUpdateGitError("unresolved");
    }

    const remoteFingerprint = await this.resolveRemoteFingerprint(git, remoteName, input.signal);
    const targetRef = input.targetRef
      ? await this.validateTargetRef(git, input.targetRef, input.signal)
      : await this.resolveDefaultTargetRef(git, remoteName, input.signal);
    const branch = targetRef.slice("refs/heads/".length);
    const destinationRef = `refs/remotes/${remoteName}/${branch}` as const;
    const monitorKey = sha256([commonDir, remoteFingerprint, remoteName, targetRef].join("\0"));

    return {
      commonDir,
      monitorKey,
      remoteName,
      remoteFingerprint,
      targetRef,
      destinationRef
    };
  }

  async observe(input: ObserveRemoteUpdateInput): Promise<RemoteUpdateGitObservation> {
    const git = this.gitFactory(input.cwd);
    const target = input.target;
    await this.validateTargetRef(git, target.targetRef, input.signal);
    const expectedDestination = destinationFor(target.remoteName, target.targetRef);
    if (target.destinationRef !== expectedDestination) {
      throw new RemoteUpdateGitError("ref_integrity_error");
    }

    const refspec = `+${target.targetRef}:${target.destinationRef}`;
    const fetch = await git.run([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--",
      target.remoteName,
      refspec
    ], this.commandOptions(input.signal));

    if (fetch.exitCode !== 0) {
      throw classifySafeGitFailure(["fetch"], fetch, input.signal);
    }

    const verify = await git.run(
      ["rev-parse", "--verify", "--end-of-options", `${target.destinationRef}^{commit}`],
      this.commandOptions(input.signal)
    );
    const tipOid = verify.stdout.trim().toLowerCase();
    if (verify.exitCode !== 0 || !FULL_OID_PATTERN.test(tipOid)) {
      throw new RemoteUpdateGitError("ref_integrity_error");
    }

    const state = await this.classifyTopology(git, tipOid, input.previousTipOid, input.signal);
    return { state, tipOid, observedAt: this.now().toISOString() };
  }

  private async resolveRemoteFingerprint(
    git: GitCli,
    remoteName: string,
    signal?: AbortSignal
  ): Promise<string> {
    const result = await git.run(
      ["remote", "get-url", "--all", "--", remoteName],
      this.commandOptions(signal)
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw classifySafeGitFailure(["remote"], result, signal, "unresolved");
    }

    const urls = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
    return sha256(urls.join("\0"));
  }

  private async resolveDefaultTargetRef(
    git: GitCli,
    remoteName: string,
    signal?: AbortSignal
  ): Promise<`refs/heads/${string}`> {
    const local = await git.run(
      ["symbolic-ref", "-q", `refs/remotes/${remoteName}/HEAD`],
      this.commandOptions(signal)
    );
    if (local.exitCode === 0) {
      const prefix = `refs/remotes/${remoteName}/`;
      const symbolic = local.stdout.trim();
      if (symbolic.startsWith(prefix) && symbolic.length > prefix.length) {
        return this.validateTargetRef(git, `refs/heads/${symbolic.slice(prefix.length)}`, signal);
      }
    }

    const advertised = await git.run(
      ["ls-remote", "--symref", "--", remoteName, "HEAD"],
      this.commandOptions(signal)
    );
    if (advertised.exitCode !== 0) {
      throw classifySafeGitFailure(["ls-remote"], advertised, signal, "unresolved");
    }

    const match = advertised.stdout
      .split("\n")
      .map((line) => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/.exec(line.trim()))
      .find((candidate) => candidate !== null);
    if (!match?.[1]) {
      throw new RemoteUpdateGitError("unresolved");
    }

    return this.validateTargetRef(git, match[1], signal);
  }

  private async validateTargetRef(
    git: GitCli,
    value: string,
    signal?: AbortSignal
  ): Promise<`refs/heads/${string}`> {
    const targetRef = value.trim();
    if (!targetRef.startsWith("refs/heads/") || targetRef === "refs/heads/HEAD") {
      throw new RemoteUpdateGitError("unresolved");
    }

    const valid = await git.run(["check-ref-format", targetRef], this.commandOptions(signal));
    if (valid.exitCode !== 0) {
      throw new RemoteUpdateGitError("unresolved");
    }
    return targetRef as `refs/heads/${string}`;
  }

  private async classifyTopology(
    git: GitCli,
    remoteTip: string,
    previousTip: string | null | undefined,
    signal?: AbortSignal
  ): Promise<RemoteUpdateObservationState> {
    const headSymbolic = await git.run(["symbolic-ref", "-q", "HEAD"], this.commandOptions(signal));
    if (headSymbolic.exitCode !== 0) {
      return "detached";
    }

    const localResult = await git.run(
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      this.commandOptions(signal)
    );
    const localTip = localResult.stdout.trim().toLowerCase();
    if (localResult.exitCode !== 0 || !FULL_OID_PATTERN.test(localTip)) {
      throw new RemoteUpdateGitError("invalid_repository");
    }

    const shallow = await git.run(["rev-parse", "--is-shallow-repository"], this.commandOptions(signal));
    if (shallow.exitCode !== 0 || shallow.stdout.trim() === "true") {
      return "unknown";
    }

    if (previousTip && previousTip !== remoteTip && FULL_OID_PATTERN.test(previousTip)) {
      const priorToCurrent = await isAncestor(git, previousTip, remoteTip, this.commandOptions(signal));
      if (priorToCurrent !== true) {
        return priorToCurrent === null ? "unknown" : "rewound";
      }
    }

    if (localTip === remoteTip) {
      return "equal";
    }

    const localToRemote = await isAncestor(git, localTip, remoteTip, this.commandOptions(signal));
    const remoteToLocal = await isAncestor(git, remoteTip, localTip, this.commandOptions(signal));
    if (localToRemote === null || remoteToLocal === null) {
      return "unknown";
    }
    if (localToRemote) {
      return "remote_ahead";
    }
    if (remoteToLocal) {
      return "local_ahead";
    }
    return "diverged";
  }

  private commandOptions(signal?: AbortSignal): GitCliRunOptions {
    return {
      allowFailure: true,
      timeoutMs: this.timeoutMs,
      maxBufferBytes: this.maxOutputBytes,
      signal,
      nonInteractive: true
    };
  }
}

async function isAncestor(
  git: GitCli,
  ancestor: string,
  descendant: string,
  options: GitCliRunOptions
): Promise<boolean | null> {
  const result = await git.run(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    options
  );
  return result.exitCode === 0 ? true : result.exitCode === 1 ? false : null;
}

function destinationFor(remoteName: string, targetRef: `refs/heads/${string}`): string {
  return `refs/remotes/${remoteName}/${targetRef.slice("refs/heads/".length)}`;
}

function classifySafeGitFailure(
  args: string[],
  result: { stdout: string; stderr: string; exitCode: number },
  signal?: AbortSignal,
  fallback: RemoteUpdateGitErrorCode = "transport_error"
): RemoteUpdateGitError {
  if (signal?.aborted) {
    return new RemoteUpdateGitError("aborted");
  }
  const normalized = normalizeGitCommandError(args, result);
  switch (normalized.classification) {
    case "aborted":
      return new RemoteUpdateGitError("aborted");
    case "timeout":
      return new RemoteUpdateGitError("timeout");
    case "auth":
      return new RemoteUpdateGitError("auth_error");
    case "network":
      return new RemoteUpdateGitError("transport_error");
    case "not_a_repository":
      return new RemoteUpdateGitError("invalid_repository");
    case "ref_not_found":
      return new RemoteUpdateGitError("missing");
    default:
      return new RemoteUpdateGitError(fallback);
  }
}

function remoteUpdateGitErrorMessage(code: RemoteUpdateGitErrorCode): string {
  switch (code) {
    case "missing": return "The configured remote ref is missing.";
    case "unresolved": return "The remote update target could not be resolved.";
    case "auth_error": return "Remote authentication failed.";
    case "transport_error": return "The remote could not be reached.";
    case "timeout": return "The remote observation timed out.";
    case "invalid_repository": return "The project is not an accessible Git repository.";
    case "ref_integrity_error": return "The fetched ref could not be verified.";
    case "aborted": return "The remote observation was cancelled.";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
