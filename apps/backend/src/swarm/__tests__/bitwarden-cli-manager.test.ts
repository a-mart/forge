import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BitwardenCliManager,
  FORGE_MANAGED_BITWARDEN_CLI_VERSION,
} from "../secure-sessions/sources/bitwarden-cli-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("BitwardenCliManager", () => {
  it("prefers a working configured executable and reports safe diagnostics", async () => {
    const root = await temporaryRoot();
    const executable = await fakeCli(path.join(root, "custom", "bw"));
    const manager = new BitwardenCliManager({
      dataDir: path.join(root, "data"),
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: "" },
    });

    const result = await manager.resolve(executable);
    const canonicalExecutable = await realpath(executable);

    expect(result.summary).toMatchObject({
      state: "ready",
      source: "configured",
      executablePath: canonicalExecutable,
      configuredExecutablePath: executable,
      version: "2026.8.0",
      managedVersion: FORGE_MANAGED_BITWARDEN_CLI_VERSION,
      canInstall: true,
    });
    expect(result.invocation?.commandShell).toBeNull();
  });

  it("does not silently bypass an invalid configured path with a system CLI", async () => {
    const root = await temporaryRoot();
    const systemCli = await fakeCli(path.join(root, "bin", "bw"));
    const manager = new BitwardenCliManager({
      dataDir: path.join(root, "data"),
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: path.dirname(systemCli) },
    });

    const result = await manager.resolve(path.join(root, "missing", "bw"));

    expect(result.invocation).toBeNull();
    expect(result.summary).toMatchObject({
      state: "missing",
      source: "configured",
      configuredExecutablePath: path.join(root, "missing", "bw"),
    });
  });

  it("installs a checksum-verified managed executable without global PATH changes", async () => {
    const root = await temporaryRoot();
    const archive = Buffer.from("synthetic-verified-archive");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    let downloaded = false;
    const manager = new BitwardenCliManager({
      dataDir: path.join(root, "data"),
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: "" },
      managedAsset: {
        platform: "darwin",
        arch: "arm64",
        fileName: "synthetic.zip",
        sha256,
        executableName: "bw",
      },
      fetchImpl: async () => {
        downloaded = true;
        return new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.byteLength) },
        });
      },
      extractZipImpl: async (_zipPath, options) => {
        await fakeCli(path.join(options.dir, "bw"));
      },
    });

    const installed = await manager.install();

    expect(downloaded).toBe(true);
    expect(installed.summary).toMatchObject({
      state: "ready",
      source: "managed",
      version: "2026.8.0",
    });
    expect(installed.summary.executablePath).toContain(
      path.join("bitwarden-cli", FORGE_MANAGED_BITWARDEN_CLI_VERSION, "bw"),
    );
    await expect(manager.resolve(null)).resolves.toMatchObject({
      summary: { state: "ready", source: "managed" },
    });
  });

  it("fails closed when a managed download does not match its pinned checksum", async () => {
    const root = await temporaryRoot();
    const manager = new BitwardenCliManager({
      dataDir: path.join(root, "data"),
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: "" },
      managedAsset: {
        platform: "darwin",
        arch: "arm64",
        fileName: "synthetic.zip",
        sha256: "0".repeat(64),
        executableName: "bw",
      },
      fetchImpl: async () => new Response("tampered", { status: 200 }),
      extractZipImpl: async () => undefined,
    });

    await expect(manager.install()).rejects.toMatchObject({
      code: "SECURE_SOURCE_RESPONSE_INVALID",
    });
  });

  it("reports unsupported automatic installation without blocking custom discovery", async () => {
    const root = await temporaryRoot();
    const manager = new BitwardenCliManager({
      dataDir: path.join(root, "data"),
      platform: "win32",
      arch: "arm64",
      environment: { PATH: "", SystemDrive: "Z:" },
    });

    await expect(manager.resolve(null)).resolves.toMatchObject({
      invocation: null,
      summary: {
        state: "unsupported",
        canInstall: false,
        managedVersion: null,
      },
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-bw-cli-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function fakeCli(executablePath: string): Promise<string> {
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(
    executablePath,
    "#!/bin/sh\nprintf '2026.8.0\\n'\n",
    "utf8",
  );
  await chmod(executablePath, 0o755);
  return executablePath;
}
