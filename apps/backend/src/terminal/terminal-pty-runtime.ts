import { accessSync, constants as fsConstants } from "node:fs";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { basename, delimiter, isAbsolute, win32 } from "node:path";
import { OutputBatcher } from "./output-batcher.js";

export interface TerminalPtyExitEvent {
  exitCode: number | null;
  exitSignal: number | null;
}

export interface TerminalPtySpawnRequest {
  shell?: string;
  shellArgs?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  onData: (chunk: Buffer) => void | Promise<void>;
  onExit: (event: TerminalPtyExitEvent) => void | Promise<void>;
}

export interface TerminalPtyHandle {
  pid: number;
  shell: string;
  shellArgs: string[];
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  dispose(): Promise<void>;
}

export interface TerminalPtyRuntime {
  isAvailable(): Promise<boolean>;
  spawnPty(request: TerminalPtySpawnRequest): Promise<TerminalPtyHandle>;
  resizePty(handle: TerminalPtyHandle, cols: number, rows: number): Promise<void>;
  killPty(handle: TerminalPtyHandle): Promise<void>;
  isTerminalDeadError(error: unknown): boolean;
  cleanupOrphanedProcesses(pids: number[]): Promise<number>;
}

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      useConpty?: boolean;
    },
  ) => {
    pid: number;
    onData(handler: (data: string) => void): void;
    onExit(handler: (event: { exitCode?: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
};

export class NodePtyRuntime implements TerminalPtyRuntime {
  private readonly outputBatchIntervalMs: number;
  private readonly defaultShell?: string;
  private nodePtyModulePromise: Promise<NodePtyModule | null> | null = null;

  constructor(options: { outputBatchIntervalMs: number; defaultShell?: string }) {
    this.outputBatchIntervalMs = options.outputBatchIntervalMs;
    this.defaultShell = options.defaultShell;
  }

  async isAvailable(): Promise<boolean> {
    const module = await this.loadNodePtyModule();
    return module !== null;
  }

  async spawnPty(request: TerminalPtySpawnRequest): Promise<TerminalPtyHandle> {
    const nodePty = await this.loadNodePtyModule();
    if (!nodePty) {
      throw createPtyUnavailableError();
    }

    const resolved = this.resolveShell(request.shell, request.shellArgs);
    const env = this.buildEnv(request.env);
    const ptyProcess = nodePty.spawn(resolved.shell, resolved.shellArgs, {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env,
      useConpty: process.platform === "win32",
    });

    const batcher = new OutputBatcher({
      intervalMs: this.outputBatchIntervalMs,
      onFlush: async (chunk) => {
        await request.onData(chunk);
      },
    });

    const stopBatcher = async (): Promise<void> => {
      try {
        await batcher.stop();
      } catch (error) {
        console.warn(`[terminal-pty] Failed to flush batched output for PTY ${ptyProcess.pid}: ${toErrorMessage(error)}`);
        throw error;
      }
    };

    ptyProcess.onData((data) => {
      batcher.push(Buffer.from(data, "utf8"));
    });

    ptyProcess.onExit((event) => {
      void (async () => {
        try {
          await stopBatcher();
        } catch {
          // Flush errors are logged in stopBatcher; still deliver the exit signal.
        }

        try {
          await request.onExit({
            exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
            exitSignal: typeof event.signal === "number" ? event.signal : null,
          });
        } catch (error) {
          console.warn(`[terminal-pty] PTY exit handler failed for ${ptyProcess.pid}: ${toErrorMessage(error)}`);
        }
      })();
    });

    return {
      pid: ptyProcess.pid,
      shell: resolved.shell,
      shellArgs: resolved.shellArgs,
      write: (data) => {
        ptyProcess.write(typeof data === "string" ? data : data.toString("utf8"));
      },
      resize: (cols, rows) => {
        ptyProcess.resize(cols, rows);
      },
      kill: (signal) => {
        ptyProcess.kill(signal);
      },
      dispose: () => stopBatcher(),
    };
  }

  async resizePty(handle: TerminalPtyHandle, cols: number, rows: number): Promise<void> {
    try {
      handle.resize(cols, rows);
    } catch (error) {
      if (this.isTerminalDeadError(error)) {
        return;
      }
      throw error;
    }
  }

  async killPty(handle: TerminalPtyHandle): Promise<void> {
    if (process.platform === "win32") {
      try {
        handle.kill();
      } catch {
        // Best effort; taskkill below is authoritative on Windows.
      }

      await this.killWindowsPid(handle.pid);
      await handle.dispose();
      return;
    }

    try {
      handle.kill("SIGHUP");
    } catch (error) {
      if (!this.isTerminalDeadError(error)) {
        console.warn(`[terminal-pty] Failed to send SIGHUP to PTY ${handle.pid}: ${toErrorMessage(error)}`);
      }
    }

    await delay(250);

    try {
      process.kill(handle.pid, 0);
      try {
        handle.kill("SIGKILL");
      } catch {
        process.kill(handle.pid, "SIGKILL");
      }
    } catch (error) {
      if (!isErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }

    await handle.dispose();
  }

  isTerminalDeadError(error: unknown): boolean {
    if (isErrnoCode(error, "EPIPE") || isErrnoCode(error, "ESRCH")) {
      return true;
    }

    const message = toErrorMessage(error).toLowerCase();
    return (
      message.includes("closed") ||
      message.includes("dead") ||
      message.includes("terminated") ||
      message.includes("exited") ||
      message.includes("not running")
    );
  }

  async cleanupOrphanedProcesses(pids: number[]): Promise<number> {
    if (process.platform !== "win32") {
      return 0;
    }

    let cleaned = 0;
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }

      try {
        await this.killWindowsPid(pid);
        cleaned += 1;
      } catch (error) {
        console.warn(`[terminal-pty] Failed to cleanup orphaned PTY pid ${pid}: ${toErrorMessage(error)}`);
      }
    }

    return cleaned;
  }

  private async loadNodePtyModule(): Promise<NodePtyModule | null> {
    if (!this.nodePtyModulePromise) {
      this.nodePtyModulePromise = import("node-pty")
        .then((module) => ((module.default ?? module) as NodePtyModule))
        .catch((error) => {
          console.warn(`[terminal-pty] node-pty unavailable: ${toErrorMessage(error)}`);
          return null;
        });
    }

    return this.nodePtyModulePromise;
  }

  private resolveShell(requestedShell?: string, requestedArgs?: string[]): {
    shell: string;
    shellArgs: string[];
  } {
    const explicitShell = requestedShell?.trim();
    const configuredShell = this.defaultShell?.trim();
    const shell = process.platform === "win32"
      ? this.resolveWindowsShell(explicitShell ?? configuredShell)
      : this.resolveUnixShell(explicitShell ?? configuredShell);

    return {
      shell,
      shellArgs: requestedArgs && requestedArgs.length > 0 ? [...requestedArgs] : defaultShellArgs(shell),
    };
  }

  private resolveWindowsShell(requestedShell?: string): string {
    const candidates = [
      requestedShell,
      process.env.FORGE_TERMINAL_DEFAULT_SHELL,
      process.env.MIDDLEMAN_TERMINAL_DEFAULT_SHELL,
      "pwsh.exe",
      "powershell.exe",
      process.env.COMSPEC,
      "cmd.exe",
    ];

    for (const candidate of candidates) {
      const resolved = resolveCommand(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return "cmd.exe";
  }

  private resolveUnixShell(requestedShell?: string): string {
    const candidates = [
      requestedShell,
      process.env.FORGE_TERMINAL_DEFAULT_SHELL,
      process.env.MIDDLEMAN_TERMINAL_DEFAULT_SHELL,
      process.env.SHELL,
      "/bin/bash",
      "/bin/sh",
    ];

    for (const candidate of candidates) {
      const resolved = resolveCommand(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return "/bin/sh";
  }

  private buildEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
    const merged = {
      ...process.env,
      ...env,
    };

    if (process.platform === "win32") {
      const normalized = normalizeWindowsEnv(merged);
      normalized.TERM = normalized.TERM || "xterm-256color";
      return normalized;
    }

    return Object.fromEntries(
      Object.entries({
        ...merged,
        TERM: merged.TERM ?? "xterm-256color",
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  private async killWindowsPid(pid: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });

      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
    });
  }
}

function resolveCommand(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
    try {
      accessSync(trimmed, fsConstants.X_OK);
      return trimmed;
    } catch {
      return undefined;
    }
  }

  const lookup = process.platform === "win32"
    ? spawnSync("where", [trimmed], { stdio: "ignore", windowsHide: true })
    : spawnSync("sh", ["-lc", `command -v ${shellQuote(trimmed)}`], { stdio: "ignore" });

  return lookup.status === 0 ? trimmed : undefined;
}

function defaultShellArgs(shell: string): string[] {
  const name = basename(shell).toLowerCase();
  if (name === "pwsh" || name === "pwsh.exe" || name === "powershell" || name === "powershell.exe") {
    return ["-NoLogo", "-NoProfile"];
  }

  if (name === "cmd" || name === "cmd.exe") {
    return [];
  }

  return ["-i"];
}

function normalizeWindowsEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized = new Map<string, [string, string]>();

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue;
    }

    const upperKey = key.toUpperCase();
    const canonicalKey = upperKey === "PATH" ? "Path" : key;
    normalized.set(upperKey, [canonicalKey, value]);
  }

  return Object.fromEntries(normalized.values());
}

function createPtyUnavailableError(): Error & { code: string } {
  const error = new Error("node-pty is not available") as Error & { code: string };
  error.code = "PTY_UNAVAILABLE";
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
