import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface GitCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitCliRunOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
}

interface GitCliOptions {
  cwd: string;
  gitBinary?: string;
  maxBufferBytes?: number;
}

export type GitCommandErrorClassification =
  | "success"
  | "not_a_repository"
  | "auth"
  | "network"
  | "conflict"
  | "ref_not_found"
  | "timeout"
  | "unknown";

export interface NormalizedGitCommandError {
  classification: GitCommandErrorClassification;
  exitCode: number;
  command: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  message: string;
}

export class GitCli {
  private readonly cwd: string;
  private readonly gitBinary: string;
  private readonly maxBufferBytes: number;

  constructor(options: GitCliOptions) {
    this.cwd = options.cwd;
    this.gitBinary = options.gitBinary ?? "git";
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  async run(args: string[], options?: GitCliRunOptions): Promise<GitCliResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await execFileAsync(this.gitBinary, args, {
          cwd: this.cwd,
          maxBuffer: this.maxBufferBytes,
          encoding: "utf8",
          timeout: options?.timeoutMs
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0
        };
      } catch (error) {
        const normalized = normalizeExecError(error);
        if (options?.allowFailure) {
          return normalized;
        }

        if (isExecTimeout(error, normalized)) {
          throw new Error(`git ${args.join(" ")} timed out`);
        }

        if (attempt < 3 && isTransientGitFailure(normalized)) {
          await delay(attempt * 100);
          continue;
        }

        throw new Error(
          `git ${args.join(" ")} failed (${normalized.exitCode}): ${normalized.stderr || normalized.stdout || "unknown error"}`
        );
      }
    }

    throw new Error(`git ${args.join(" ")} failed after retries`);
  }
}

export function normalizeGitCommandError(
  args: string[],
  result: GitCliResult
): NormalizedGitCommandError {
  const haystack = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const command = `git ${args.join(" ")}`;
  const stdoutExcerpt = excerpt(result.stdout);
  const stderrExcerpt = excerpt(result.stderr);
  const message = stderrExcerpt || stdoutExcerpt || "unknown git error";

  let classification: GitCommandErrorClassification = "unknown";
  if (result.exitCode === 0) {
    classification = "success";
  } else if (isTimeoutResult(haystack, result.exitCode)) {
    classification = "timeout";
  } else if (
    haystack.includes("not a git repository") ||
    haystack.includes("not a git repo")
  ) {
    classification = "not_a_repository";
  } else if (
    haystack.includes("authentication failed") ||
    haystack.includes("permission denied (publickey)") ||
    haystack.includes("could not read from remote")
  ) {
    classification = "auth";
  } else if (
    haystack.includes("could not resolve host") ||
    haystack.includes("connection refused") ||
    haystack.includes("network is unreachable")
  ) {
    classification = "network";
  } else if (
    haystack.includes("merge conflict") ||
    haystack.includes("unmerged files") ||
    haystack.includes("would be overwritten by merge")
  ) {
    classification = "conflict";
  } else if (
    haystack.includes("unknown revision") ||
    haystack.includes("bad object") ||
    haystack.includes("did not match any file")
  ) {
    classification = "ref_not_found";
  }

  return {
    classification,
    exitCode: result.exitCode,
    command,
    stdoutExcerpt,
    stderrExcerpt,
    message
  };
}

function normalizeExecError(error: unknown): GitCliResult {
  if (typeof error === "object" && error !== null) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string;
    };

    const stderr = typed.stderr?.trim().length
      ? typed.stderr
      : isExecTimeout(error, { stdout: "", stderr: "", exitCode: 1 })
        ? "git command timed out"
        : String(error);

    return {
      stdout: typed.stdout ?? "",
      stderr,
      exitCode: typeof typed.code === "number" ? typed.code : 1
    };
  }

  return {
    stdout: "",
    stderr: String(error),
    exitCode: 1
  };
}

function isExecTimeout(error: unknown, normalized: GitCliResult): boolean {
  if (typeof error === "object" && error !== null) {
    const typed = error as {
      killed?: boolean;
      signal?: string;
      code?: string | number;
    };

    if (typed.killed && typed.signal === "SIGTERM") {
      return true;
    }

    if (typed.code === "ETIMEDOUT") {
      return true;
    }
  }

  return isTimeoutResult(`${normalized.stderr}\n${normalized.stdout}`.toLowerCase(), normalized.exitCode);
}

function isTimeoutResult(haystack: string, exitCode: number): boolean {
  return (
    haystack.includes("timed out") ||
    haystack.includes("etimedout") ||
    exitCode === -1 ||
    exitCode === 124
  );
}

function isTransientGitFailure(result: GitCliResult): boolean {
  const haystack = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    haystack.includes("index.lock") ||
    haystack.includes("could not lock") ||
    haystack.includes("permission denied") ||
    haystack.includes("resource busy") ||
    haystack.includes("device or resource busy") ||
    haystack.includes("ebusy") ||
    haystack.includes("eperm")
  );
}

function excerpt(value: string, maxLength = 400): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
