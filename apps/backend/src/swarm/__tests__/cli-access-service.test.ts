import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliAccessService, readCliApiKeyEnv } from "../cli-access-service.js";
import { getCliAccessFilePath } from "../data-paths.js";

const NOW = "2026-05-11T00:00:00.000Z";

async function makeService(options: { envApiKey?: string } = {}): Promise<{ dataDir: string; service: CliAccessService }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-cli-access-"));
  let counter = 0;
  const service = new CliAccessService({
    dataDir,
    envApiKey: options.envApiKey,
    now: () => NOW,
    generateId: () => {
      counter += 1;
      return `cli_key_${counter}`;
    },
    generateKeyBytes: () => Buffer.alloc(32, counter + 1),
  });

  return { dataDir, service };
}

describe("CliAccessService", () => {
  it("generates hash-only stored keys and authenticates bearer headers", async () => {
    const { dataDir, service } = await makeService();
    const generated = await service.generateKey({ name: "  Automation key  " });

    expect(generated.key).toEqual({
      id: "cli_key_1",
      name: "Automation key",
      createdAt: NOW,
    });
    expect(generated.plaintextKey).toMatch(/^forge_cli_/);

    const rawFile = await readFile(getCliAccessFilePath(dataDir), "utf8");
    expect(rawFile).not.toContain(generated.plaintextKey);
    expect(JSON.parse(rawFile) as unknown).toMatchObject({
      version: 1,
      keys: [{ id: "cli_key_1", name: "Automation key", createdAt: NOW }],
    });

    await expect(
      service.authenticateAuthorizationHeader(`Bearer ${generated.plaintextKey}`, "http")
    ).resolves.toEqual({ ok: true, keyId: "cli_key_1", source: "stored" });

    await expect(service.listKeys()).resolves.toEqual([
      {
        id: "cli_key_1",
        name: "Automation key",
        createdAt: NOW,
        lastUsedAt: NOW,
        lastUsedSource: "http",
      },
    ]);
  });

  it("rejects missing, malformed, invalid, and revoked bearer tokens", async () => {
    const { service } = await makeService();
    const generated = await service.generateKey();

    await expect(service.authenticateAuthorizationHeader(undefined, "http")).resolves.toMatchObject({
      ok: false,
      statusCode: 401,
      code: "missing_authorization",
    });
    await expect(service.authenticateAuthorizationHeader("Basic abc", "http")).resolves.toMatchObject({
      ok: false,
      statusCode: 401,
      code: "malformed_authorization",
    });
    await expect(service.authenticateAuthorizationHeader("Bearer wrong", "http")).resolves.toMatchObject({
      ok: false,
      statusCode: 401,
      code: "invalid_token",
    });

    await service.revokeKey(generated.key.id);
    await expect(
      service.authenticateAuthorizationHeader(`Bearer ${generated.plaintextKey}`, "http")
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      code: "revoked_token",
    });
  });

  it("rotates keys by revoking the old hash and displaying the new plaintext once", async () => {
    const { service } = await makeService();
    const first = await service.generateKey({ name: "Primary" });
    const rotated = await service.rotateKey({ keyId: first.key.id });

    expect(rotated?.key).toMatchObject({ id: "cli_key_2", name: "Primary", createdAt: NOW });
    expect(rotated?.plaintextKey).toMatch(/^forge_cli_/);
    expect(rotated?.plaintextKey).not.toBe(first.plaintextKey);

    await expect(service.authenticateAuthorizationHeader(`Bearer ${first.plaintextKey}`, "http")).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      code: "revoked_token",
    });
    await expect(
      service.authenticateAuthorizationHeader(`Bearer ${rotated?.plaintextKey ?? ""}`, "settings")
    ).resolves.toEqual({ ok: true, keyId: "cli_key_2", source: "stored" });
  });

  it("accepts an env-configured key without persisting it", async () => {
    const { dataDir, service } = await makeService({ envApiKey: " env-secret " });

    await expect(service.authenticateAuthorizationHeader("Bearer env-secret", "ws")).resolves.toEqual({
      ok: true,
      keyId: "env",
      source: "env",
    });
    await expect(service.listKeys()).resolves.toEqual([]);
    await expect(readFile(getCliAccessFilePath(dataDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves FORGE_CLI_API_KEY before legacy env names", () => {
    expect(readCliApiKeyEnv({ FORGE_CLI_API_KEY: " forge ", MIDDLEMAN_CLI_API_KEY: " legacy " })).toBe("forge");
    expect(readCliApiKeyEnv({ MIDDLEMAN_CLI_API_KEY: " legacy " })).toBe("legacy");
    expect(readCliApiKeyEnv({ FORGE_CLI_API_KEY: "   " })).toBeUndefined();
  });
});
