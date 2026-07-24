import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostOnlySecret, SecureSourceError, type SecureSecretResolution } from "./host-only-secret.js";
import type { SecureVaultCipher } from "./electron-safe-storage-client.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface BitwardenSecretRecord {
  readonly id: string;
  readonly material: HostOnlySecret;
  readonly revisionDate?: string;
}

export interface BitwardenSecretsClient {
  testConnection(input: {
    accessToken: Buffer;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<void>;
  getSecret(input: {
    secretId: string;
    accessToken: Buffer;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<BitwardenSecretRecord>;
}

/**
 * Host-side adapter for the official Bitwarden Secrets Manager CLI.
 *
 * The machine access token is provided only through the trusted child
 * environment. Secret values are captured in bounded memory and never sent to
 * the sandbox. A temporary isolated config root prevents reuse of or writes to
 * the user's normal bws state.
 */
export class BwsCommandClient implements BitwardenSecretsClient {
  constructor(
    private readonly executable = "bws",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async getSecret(input: {
    secretId: string;
    accessToken: Buffer;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<BitwardenSecretRecord> {
    if (!/^[0-9a-fA-F-]{16,128}$/.test(input.secretId)) {
      throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
    }

    const isolatedRoot = join(tmpdir(), `forge-bws-${randomUUID()}`);
    await mkdir(isolatedRoot, { mode: 0o700, recursive: false });
    try {
      const configFile = join(isolatedRoot, "config");
      await this.configureEndpoint(
        input.endpointOrigin,
        configFile,
        isolatedRoot,
        input.signal,
      );

      const args = [
        "secret",
        "get",
        input.secretId,
        ...(input.endpointOrigin ? ["--config-file", configFile] : []),
      ];
      const output = await this.run(args, input.accessToken, isolatedRoot, input.signal, {
        captureStdout: true,
        nonzeroCode: "SECURE_SOURCE_AUTH_REQUIRED",
      });
      return parseSecretRecord(output);
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  /**
   * Authenticates against Bitwarden without retrieving secret values.
   *
   * `project list --output none` is an official, read-only CLI operation. The
   * CLI performs the authenticated request but suppresses the returned project
   * metadata. Both output streams are still bounded and drained defensively.
   */
  async testConnection(input: {
    accessToken: Buffer;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<void> {
    const isolatedRoot = join(tmpdir(), `forge-bws-${randomUUID()}`);
    await mkdir(isolatedRoot, { mode: 0o700, recursive: false });
    try {
      const configFile = join(isolatedRoot, "config");
      await this.configureEndpoint(
        input.endpointOrigin,
        configFile,
        isolatedRoot,
        input.signal,
      );
      await this.run(
        [
          "project",
          "list",
          "--output",
          "none",
          ...(input.endpointOrigin ? ["--config-file", configFile] : []),
        ],
        input.accessToken,
        isolatedRoot,
        input.signal,
        {
          captureStdout: false,
          nonzeroCode: "SECURE_SOURCE_AUTH_REQUIRED",
        },
      );
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  async probe(): Promise<boolean> {
    const isolatedRoot = join(tmpdir(), `forge-bws-probe-${randomUUID()}`);
    try {
      await mkdir(isolatedRoot, { mode: 0o700, recursive: false });
      await this.run(["--version"], Buffer.alloc(0), isolatedRoot, undefined, {
        captureStdout: false,
        nonzeroCode: "SECURE_SOURCE_UNAVAILABLE",
      });
      return true;
    } catch {
      return false;
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  private async configureEndpoint(
    endpointOrigin: string | null | undefined,
    configFile: string,
    isolatedRoot: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!endpointOrigin) return;
    const endpoint = normalizeEndpoint(endpointOrigin);
    await this.run(
      ["config", "server-base", endpoint, "--config-file", configFile],
      Buffer.alloc(0),
      isolatedRoot,
      signal,
      {
        captureStdout: false,
        nonzeroCode: "SECURE_SOURCE_RESPONSE_INVALID",
      },
    );
  }

  private async run(
    args: string[],
    accessToken: Buffer,
    isolatedRoot: string,
    signal?: AbortSignal,
    options: {
      captureStdout: boolean;
      nonzeroCode:
        | "SECURE_SOURCE_AUTH_REQUIRED"
        | "SECURE_SOURCE_RESPONSE_INVALID"
        | "SECURE_SOURCE_UNAVAILABLE";
    } = {
      captureStdout: true,
      nonzeroCode: "SECURE_SOURCE_AUTH_REQUIRED",
    },
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: isolatedRoot,
          XDG_CONFIG_HOME: isolatedRoot,
          ...(accessToken.byteLength === 0
            ? {}
            : { BWS_ACCESS_TOKEN: accessToken.toString("utf8") }),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const abort = () => rejectSafe(new SecureSourceError("SECURE_SOURCE_UNAVAILABLE"));
      const wipeCapturedOutput = () => {
        for (const chunk of stdout) chunk.fill(0);
        stdout.length = 0;
      };
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      const rejectSafe = (error: SecureSourceError) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGKILL");
        wipeCapturedOutput();
        reject(error);
      };
      const timeout = setTimeout(
        () => rejectSafe(new SecureSourceError("SECURE_SOURCE_TIMEOUT")),
        this.timeoutMs,
      );
      timeout.unref?.();

      signal?.addEventListener("abort", abort, { once: true });

      const consumeOutput = (chunk: Buffer, capture: boolean) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_RESPONSE_BYTES) {
          rejectSafe(new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID"));
          return;
        }
        if (capture) stdout.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) =>
        consumeOutput(chunk, options.captureStdout),
      );
      // Drain stderr but never retain it: upstream errors may include credentials
      // or sensitive provider response bodies.
      child.stderr.on("data", (chunk: Buffer) => consumeOutput(chunk, false));
      child.once("error", () => rejectSafe(new SecureSourceError("SECURE_SOURCE_UNAVAILABLE")));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) {
          wipeCapturedOutput();
          reject(new SecureSourceError(options.nonzeroCode));
          return;
        }
        const output = Buffer.concat(stdout);
        wipeCapturedOutput();
        resolve(output);
      });
    });
  }
}

export class BitwardenBwsSecretSource {
  readonly kind = "bitwarden_secrets_manager" as const;

  constructor(
    private readonly cipher: SecureVaultCipher,
    private readonly client: BitwardenSecretsClient = new BwsCommandClient(),
  ) {}

  async testConnection(input: {
    encryptedCredential?: Uint8Array;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!input.encryptedCredential?.byteLength) {
      throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
    }

    const accessToken = await this.cipher.decrypt(input.encryptedCredential);
    try {
      await accessToken.withBytes(async (tokenBytes) => {
        await this.client.testConnection({
          accessToken: tokenBytes,
          endpointOrigin: input.endpointOrigin,
          signal: input.signal,
        });
      });
    } finally {
      accessToken.release();
    }
  }

  async resolve(input: {
    sourceLocator: string;
    encryptedCredential?: Uint8Array;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<SecureSecretResolution> {
    if (!input.encryptedCredential?.byteLength) {
      throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
    }

    const accessToken = await this.cipher.decrypt(input.encryptedCredential);
    try {
      return await accessToken.withBytes(async (tokenBytes) => {
        const record = await this.client.getSecret({
          secretId: input.sourceLocator,
          accessToken: tokenBytes,
          endpointOrigin: input.endpointOrigin,
          signal: input.signal,
        });
        return {
          material: record.material,
          sourceVersion: record.revisionDate ?? null,
          resolvedAt: new Date().toISOString(),
        };
      });
    } finally {
      accessToken.release();
    }
  }
}

function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return url.origin;
}

function parseSecretRecord(output: Buffer): BitwardenSecretRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  } finally {
    output.fill(0);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.value !== "string") {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const valueBytes = Buffer.from(record.value, "utf8");
  try {
    return {
      id: record.id,
      material: new HostOnlySecret(valueBytes),
      ...(typeof record.revisionDate === "string" ? { revisionDate: record.revisionDate } : {}),
    };
  } finally {
    valueBytes.fill(0);
  }
}
