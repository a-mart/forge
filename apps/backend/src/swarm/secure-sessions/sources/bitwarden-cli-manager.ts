import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Writable } from "node:stream";
import extractZip from "extract-zip";
import type {
  BitwardenPasswordManagerCliSource,
  BitwardenPasswordManagerCliSummary,
} from "@forge/protocol";
import {
  getBitwardenCliExecutablePath,
  getBitwardenCliVersionDir,
} from "../../storage/data-paths.js";
import { writeFileAtomic } from "../../../utils/atomic-files.js";
import { SecureSourceError } from "./host-only-secret.js";

export const FORGE_MANAGED_BITWARDEN_CLI_VERSION = "2026.8.0";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface ManagedCliAsset {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  fileName: string;
  sha256: string;
  executableName: string;
}

const MANAGED_CLI_ASSETS: readonly ManagedCliAsset[] = [
  {
    platform: "win32",
    arch: "x64",
    fileName: `bw-windows-${FORGE_MANAGED_BITWARDEN_CLI_VERSION}.zip`,
    sha256: "26a6bb9a88ca9eeaad9e59db1816dcceb3ce6cc80a30b33e1324b0642f4a0f32",
    executableName: "bw.exe",
  },
  {
    platform: "darwin",
    arch: "x64",
    fileName: `bw-macos-${FORGE_MANAGED_BITWARDEN_CLI_VERSION}.zip`,
    sha256: "c5d57f70d5394f8c348f6c3bf53683ad6d15e6acfe55e7c1e0a8f376482d8e71",
    executableName: "bw",
  },
  {
    platform: "darwin",
    arch: "arm64",
    fileName: `bw-macos-arm64-${FORGE_MANAGED_BITWARDEN_CLI_VERSION}.zip`,
    sha256: "73414942357644605eefd3f4afaf0b41b71772ad6574e8e3c72e0b6d237104c8",
    executableName: "bw",
  },
  {
    platform: "linux",
    arch: "x64",
    fileName: `bw-linux-${FORGE_MANAGED_BITWARDEN_CLI_VERSION}.zip`,
    sha256: "367f618e9fcccaac4980ec12c7bafd01df739b5f3cb1af31bc9045cf75eea1d6",
    executableName: "bw",
  },
  {
    platform: "linux",
    arch: "arm64",
    fileName: `bw-linux-arm64-${FORGE_MANAGED_BITWARDEN_CLI_VERSION}.zip`,
    sha256: "74d822a5dceda5896ed8fc07bc61925b29afd98d96a6a3e9e525ae556c3083a8",
    executableName: "bw",
  },
];

export interface BitwardenCliInvocation {
  executablePath: string;
  source: BitwardenPasswordManagerCliSource;
  platform: NodeJS.Platform;
  commandShell: string | null;
}

export interface BitwardenCliResolution {
  invocation: BitwardenCliInvocation | null;
  summary: BitwardenPasswordManagerCliSummary;
}

export interface BitwardenCliManagerOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  extractZipImpl?: typeof extractZip;
  managedAsset?: ManagedCliAsset | null;
  probeTimeoutMs?: number;
}

export class BitwardenCliManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly extractZipImpl: typeof extractZip;
  private readonly probeTimeoutMs: number;

  constructor(private readonly options: BitwardenCliManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extractZipImpl = options.extractZipImpl ?? extractZip;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
  }

  async resolve(configuredExecutablePath: string | null): Promise<BitwardenCliResolution> {
    const asset = this.asset();
    if (configuredExecutablePath) {
      const configured = await this.inspectCandidate(
        configuredExecutablePath,
        "configured",
      );
      return configured ?? this.missingSummary(configuredExecutablePath, asset !== null);
    }

    if (asset) {
      const managedPath = getBitwardenCliExecutablePath(
        this.options.dataDir,
        FORGE_MANAGED_BITWARDEN_CLI_VERSION,
        this.platform,
      );
      const managed = await this.inspectCandidate(managedPath, "managed");
      if (managed) return managed;
    }

    for (const candidate of await this.systemCandidates()) {
      const system = await this.inspectCandidate(candidate, "system");
      if (system) return system;
    }
    return this.missingSummary(null, asset !== null);
  }

  async install(): Promise<BitwardenCliResolution> {
    const asset = this.asset();
    if (!asset) {
      return {
        invocation: null,
        summary: {
          state: "unsupported",
          source: null,
          executablePath: null,
          configuredExecutablePath: null,
          version: null,
          managedVersion: null,
          canInstall: false,
        },
      };
    }

    const targetDirectory = getBitwardenCliVersionDir(
      this.options.dataDir,
      FORGE_MANAGED_BITWARDEN_CLI_VERSION,
    );
    const targetPath = getBitwardenCliExecutablePath(
      this.options.dataDir,
      FORGE_MANAGED_BITWARDEN_CLI_VERSION,
      this.platform,
    );
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "forge-bitwarden-cli-"),
    );
    const zipPath = path.join(temporaryDirectory, asset.fileName);
    const extractedDirectory = path.join(temporaryDirectory, "extracted");
    try {
      await mkdir(extractedDirectory, { recursive: true });
      await this.download(asset, zipPath);
      await this.extractZipImpl(zipPath, { dir: extractedDirectory });
      const extractedPath = path.join(extractedDirectory, asset.executableName);
      const extractedStat = await stat(extractedPath);
      if (!extractedStat.isFile() || extractedStat.size < 1) {
        throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
      }
      await mkdir(targetDirectory, { recursive: true });
      const executableBytes = await readFile(extractedPath);
      try {
        await writeFileAtomic(targetPath, executableBytes, {
          mode: this.platform === "win32" ? 0o600 : 0o755,
        });
      } finally {
        executableBytes.fill(0);
      }
    } catch (error) {
      if (error instanceof SecureSourceError) throw error;
      throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
        .catch(() => undefined);
    }

    const installed = await this.inspectCandidate(targetPath, "managed");
    if (!installed) throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
    return installed;
  }

  private asset(): ManagedCliAsset | null {
    if (this.options.managedAsset !== undefined) {
      return this.options.managedAsset;
    }
    return MANAGED_CLI_ASSETS.find(
      (candidate) => candidate.platform === this.platform && candidate.arch === this.arch,
    ) ?? null;
  }

  private async download(asset: ManagedCliAsset, targetPath: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(
        `https://github.com/bitwarden/clients/releases/download/cli-v${FORGE_MANAGED_BITWARDEN_CLI_VERSION}/${asset.fileName}`,
        {
          headers: { "user-agent": "Forge Desktop" },
          redirect: "follow",
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      try {
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
        }
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== asset.sha256) {
          throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
        }
        await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
      } finally {
        bytes.fill(0);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async inspectCandidate(
    candidatePath: string,
    source: BitwardenPasswordManagerCliSource,
  ): Promise<BitwardenCliResolution | null> {
    const normalized = await normalizeExecutablePath(candidatePath, this.platform);
    if (!normalized) return null;
    const invocation = createBitwardenCliInvocation(
      normalized,
      source,
      this.platform,
      this.environment.ComSpec,
    );
    if (!invocation) return null;
    const version = await probeVersion(
      invocation,
      this.environment,
      this.probeTimeoutMs,
    );
    if (!version) return null;
    return {
      invocation,
      summary: {
        state: "ready",
        source,
        executablePath: normalized,
        configuredExecutablePath: source === "configured" ? candidatePath : null,
        version,
        managedVersion: FORGE_MANAGED_BITWARDEN_CLI_VERSION,
        canInstall: this.asset() !== null,
      },
    };
  }

  private missingSummary(
    configuredExecutablePath: string | null,
    canInstall: boolean,
  ): BitwardenCliResolution {
    return {
      invocation: null,
      summary: {
        state: canInstall ? "missing" : "unsupported",
        source: configuredExecutablePath ? "configured" : null,
        executablePath: null,
        configuredExecutablePath,
        version: null,
        managedVersion: canInstall ? FORGE_MANAGED_BITWARDEN_CLI_VERSION : null,
        canInstall,
      },
    };
  }

  private async systemCandidates(): Promise<string[]> {
    const pathApi = this.platform === "win32" ? path.win32 : path.posix;
    const pathValue = this.environment.PATH ?? this.environment.Path ?? "";
    const directories = pathValue.split(pathApi.delimiter).filter(Boolean);
    if (this.platform === "win32") {
      const systemDrive = this.environment.SystemDrive ?? "C:";
      directories.push(
        path.win32.join(systemDrive, "ProgramData", "chocolatey", "bin"),
      );
      if (this.environment.LOCALAPPDATA) {
        directories.push(
          path.win32.join(this.environment.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        );
      }
      if (this.environment.APPDATA) {
        directories.push(path.win32.join(this.environment.APPDATA, "npm"));
      }
    } else {
      directories.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
    }
    const names = this.platform === "win32"
      ? ["bw.exe", "bw.cmd", "bw.bat"]
      : ["bw"];
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const directory of directories) {
      for (const name of names) {
        const candidate = pathApi.join(directory, name);
        const key = this.platform === "win32" ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
    return candidates;
  }
}

export function spawnBitwardenCli(
  invocation: BitwardenCliInvocation,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: boolean;
  },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnBitwardenCli(
  invocation: BitwardenCliInvocation,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
  },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnBitwardenCli(
  invocation: BitwardenCliInvocation,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore" | "pipe", "pipe", "pipe"];
    windowsHide: boolean;
  },
): ChildProcessByStdio<Writable | null, Readable, Readable> {
  if (!invocation.commandShell) {
    return spawn(invocation.executablePath, [...args], options) as
      ChildProcessByStdio<Writable | null, Readable, Readable>;
  }
  const commandLine = windowsCommandLine(invocation.executablePath, args);
  return spawn(
    invocation.commandShell,
    ["/d", "/s", "/c", commandLine],
    options,
  ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
}

async function normalizeExecutablePath(
  candidatePath: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (!candidatePath || candidatePath.includes("\0")) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(candidatePath)) return null;
  try {
    await access(
      candidatePath,
      platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    const candidateStat = await stat(candidatePath);
    if (!candidateStat.isFile()) return null;
    return await realpath(candidatePath);
  } catch {
    return null;
  }
}

function createBitwardenCliInvocation(
  executablePath: string,
  source: BitwardenPasswordManagerCliSource,
  platform: NodeJS.Platform,
  commandShell: string | undefined,
): BitwardenCliInvocation | null {
  const extension = path.extname(executablePath).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { executablePath, source, platform, commandShell: null };
  }
  if (
    [...executablePath].some((character) => character.charCodeAt(0) < 32)
    || /["&|<>^%!]/u.test(executablePath)
  ) return null;
  return {
    executablePath,
    source,
    platform,
    commandShell: commandShell || "cmd.exe",
  };
}

async function probeVersion(
  invocation: BitwardenCliInvocation,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawnBitwardenCli(invocation, ["--version"], {
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const chunk of chunks) chunk.fill(0);
      resolve(version);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", () => undefined);
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (settled || code !== 0) {
        finish(null);
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8").trim();
      finish(VERSION_PATTERN.test(output) ? output : null);
    });
  });
}

function windowsCommandLine(
  executablePath: string,
  args: readonly string[],
): string {
  if (args.some((arg) => /[\r\n"&|<>^%!]/u.test(arg))) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return `""${executablePath}"${args.map((arg) => ` "${arg}"`).join("")}"`;
}
