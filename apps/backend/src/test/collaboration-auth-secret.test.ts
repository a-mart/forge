import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "../config.js";
import { getCollaborationAuthSecret } from "../collaboration/auth/auth-secret-service.js";
import { createTempConfig } from "../test-support/temp-config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env.FORGE_DATA_DIR;
  delete process.env.FORGE_RUNTIME_TARGET;
  delete process.env.FORGE_COLLABORATION_AUTH_SECRET;
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("collaboration auth secret service", () => {
  async function readPermissions(path: string): Promise<number | null> {
    if (process.platform === "win32") {
      return null;
    }

    return (await stat(path)).mode & 0o777;
  }

  it("returns the configured env-backed secret when FORGE_COLLABORATION_AUTH_SECRET is set", async () => {
    const root = await createTempRoot("forge-collaboration-auth-secret-env-");
    const dataDir = resolve(root, "data");

    process.env.FORGE_DATA_DIR = dataDir;
    process.env.FORGE_RUNTIME_TARGET = "collaboration-server";
    process.env.FORGE_COLLABORATION_AUTH_SECRET = "  env-secret-value  ";

    const config = createConfig();
    const secret = await getCollaborationAuthSecret(config);

    expect(secret).toBe("env-secret-value");
    expect(existsSync(config.paths.collaborationAuthSecretPath!)).toBe(false);
  });

  it("reads a persisted secret from disk when no env secret is configured", async () => {
    const handle = await createTempConfig({ runtimeTarget: "collaboration-server" });
    tempRoots.push(handle.tempRootDir);
    const secretPath = handle.config.paths.collaborationAuthSecretPath!;

    await mkdir(resolve(secretPath, ".."), { recursive: true });
    await writeFile(secretPath, "  persisted-secret-value\n", "utf8");

    await expect(getCollaborationAuthSecret(handle.config)).resolves.toBe("persisted-secret-value");
  });

  it("repairs persisted secrets to mode 0600", async () => {
    const handle = await createTempConfig({ runtimeTarget: "collaboration-server" });
    tempRoots.push(handle.tempRootDir);
    const secretPath = handle.config.paths.collaborationAuthSecretPath!;

    await mkdir(resolve(secretPath, ".."), { recursive: true });
    await writeFile(secretPath, "persisted-secret-value\n", { encoding: "utf8", mode: 0o644 });

    if (process.platform !== "win32") {
      await chmod(secretPath, 0o644);
      await expect(readPermissions(secretPath)).resolves.toBe(0o644);
    }

    await expect(getCollaborationAuthSecret(handle.config)).resolves.toBe("persisted-secret-value");
    await expect(readPermissions(secretPath)).resolves.toBe(process.platform === "win32" ? null : 0o600);
  });

  it("generates and persists a new secret when no env or file-backed secret exists", async () => {
    const handle = await createTempConfig({ runtimeTarget: "collaboration-server" });
    tempRoots.push(handle.tempRootDir);
    const secretPath = handle.config.paths.collaborationAuthSecretPath!;

    expect(existsSync(secretPath)).toBe(false);

    const secret = await getCollaborationAuthSecret(handle.config);
    const persistedSecret = await readFile(secretPath, "utf8");

    expect(existsSync(secretPath)).toBe(true);
    expect(secret).toBe(persistedSecret.trim());
    await expect(readPermissions(secretPath)).resolves.toBe(process.platform === "win32" ? null : 0o600);
  });

  it("rejects builder runtime configs", async () => {
    const handle = await createTempConfig({ runtimeTarget: "builder" });
    tempRoots.push(handle.tempRootDir);

    await expect(getCollaborationAuthSecret(handle.config)).rejects.toThrow(
      "Collaboration auth secret requested while collaboration server runtime is disabled",
    );
  });
});
