import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canaryNeedles,
  scanDirectory,
  scanNamedBytes,
} from "../../../../../scripts/secure-sessions-e2e/privacy-safe-scan.js";
import {
  BitwardenBwsSecretSource,
  BwsCommandClient,
} from "../secure-sessions/sources/bitwarden-bws-source.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import {
  HostOnlySecret,
  SecureSourceError,
} from "../secure-sessions/sources/host-only-secret.js";
import { LocalEncryptedSecretSource } from "../secure-sessions/sources/local-encrypted-source.js";

const cleanups: Array<() => Promise<unknown>> = [];

function makeCanary(): Buffer {
  return Buffer.from(
    `Forge provider/${randomBytes(17).toString("hex")}?"\\end`,
    "utf8",
  );
}

function publicErrorEvidence(error: unknown): Buffer {
  if (!(error instanceof Error)) {
    return Buffer.from("non-error");
  }
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  return Buffer.from(
    JSON.stringify({
      name: error.name,
      message: error.message,
      code,
      string: String(error),
    }),
  );
}

function unavailableCipher(): SecureVaultCipher {
  const unavailable = async (): Promise<never> => {
    throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
  };
  return {
    status: unavailable,
    encrypt: unavailable,
    decrypt: unavailable,
  };
}

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  await Promise.allSettled(pending.map(async (cleanup) => await cleanup()));
});

describe("secure session provider error e2e containment", () => {
  it("does not expose provider stderr, credentials, or released host-only material", async () => {
    const canary = makeCanary();
    const needles = canaryNeedles(canary);
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-secure-e2e-provider-"),
    );
    const fakeBws = join(temporaryRoot, "fake-bws");
    await writeFile(
      fakeBws,
      [
        "#!/bin/sh",
        'printf "%s" "$BWS_ACCESS_TOKEN" >&2',
        'printf "%s" "provider rejected request" >&2',
        "exit 9",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeBws, 0o700);
    cleanups.push(
      async () => {
        canary.fill(0);
        for (const needle of needles) {
          needle.fill(0);
        }
      },
      async () => await rm(temporaryRoot, { recursive: true, force: true }),
    );

    let commandError: unknown;
    try {
      await new BwsCommandClient(fakeBws, 5_000).getSecret({
        secretId: "e325ea69-a3ab-4dff-836f-b02e013fe530",
        accessToken: canary,
      });
    } catch (error) {
      commandError = error;
    }
    expect(commandError).toMatchObject({
      code: "SECURE_SOURCE_AUTH_REQUIRED",
    } satisfies Partial<SecureSourceError>);

    const localSource = new LocalEncryptedSecretSource(unavailableCipher());
    let localError: unknown;
    try {
      await localSource.resolve({ sourceLocator: "missing" });
    } catch (error) {
      localError = error;
    }
    expect(localError).toMatchObject({
      code: "SECURE_SOURCE_NOT_FOUND",
    } satisfies Partial<SecureSourceError>);

    const bitwardenSource = new BitwardenBwsSecretSource(
      unavailableCipher(),
    );
    let credentialError: unknown;
    try {
      await bitwardenSource.resolve({
        sourceLocator: "e325ea69-a3ab-4dff-836f-b02e013fe530",
      });
    } catch (error) {
      credentialError = error;
    }
    expect(credentialError).toMatchObject({
      code: "SECURE_SOURCE_AUTH_REQUIRED",
    } satisfies Partial<SecureSourceError>);

    const hostOnly = new HostOnlySecret(canary);
    expect(() => JSON.stringify(hostOnly)).toThrow(
      "SECURE_SECRET_SERIALIZATION_BLOCKED",
    );
    hostOnly.release();
    let releasedError: unknown;
    try {
      await hostOnly.withBytes(() => "unreachable");
    } catch (error) {
      releasedError = error;
    }
    expect(releasedError).toMatchObject({
      code: "SECURE_SECRET_RELEASED",
    } satisfies Partial<SecureSourceError>);

    const publicReport = scanNamedBytes(
      [
        { path: "bws-error", bytes: publicErrorEvidence(commandError) },
        { path: "local-error", bytes: publicErrorEvidence(localError) },
        {
          path: "credential-error",
          bytes: publicErrorEvidence(credentialError),
        },
        {
          path: "released-error",
          bytes: publicErrorEvidence(releasedError),
        },
      ],
      needles,
    );
    const filesystemReport = await scanDirectory(temporaryRoot, needles);
    expect(publicReport.totalMatches).toBe(0);
    expect(publicReport.matches).toEqual([]);
    expect(filesystemReport.totalMatches).toBe(0);
    expect(filesystemReport.matches).toEqual([]);
  });
});
