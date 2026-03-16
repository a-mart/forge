import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface GitCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCliRunOptions {
  allowFailure?: boolean;
}

export interface GitCliOptions {
  cwd: string;
  gitBinary?: string;
  maxBufferBytes?: number;
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
          encoding: "utf8"
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

function normalizeExecError(error: unknown): GitCliResult {
  if (typeof error === "object" && error !== null) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };

    return {
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? String(error),
      exitCode: typeof typed.code === "number" ? typed.code : 1
    };
  }

  return {
    stdout: "",
    stderr: String(error),
    exitCode: 1
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
