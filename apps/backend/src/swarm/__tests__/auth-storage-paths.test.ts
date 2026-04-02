import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCanonicalAuthFilePath } from "../auth-storage-paths.js";
import type { SwarmConfig } from "../types.js";

function createConfig(root: string): SwarmConfig {
  return {
    paths: {
      sharedDir: join(root, "shared"),
      sharedAuthFile: join(root, "shared", "config", "auth", "auth.json"),
      authFile: join(root, "auth", "auth.json"),
    },
  } as unknown as SwarmConfig;
}

describe("auth-storage-paths", () => {
  it("copies auth from the old shared-flat path to the canonical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-storage-paths-"));
    const config = createConfig(root);
    const oldSharedPath = join(root, "shared", "auth", "auth.json");

    await mkdir(join(root, "shared", "auth"), { recursive: true });
    await writeFile(oldSharedPath, '{"provider":"anthropic"}\n', "utf8");

    const canonicalPath = await ensureCanonicalAuthFilePath(config);

    expect(canonicalPath).toBe(config.paths.sharedAuthFile);
    await expect(readFile(canonicalPath, "utf8")).resolves.toContain("anthropic");
  });

  it("falls back to the legacy flat-root auth path when old shared-flat auth is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-storage-paths-legacy-"));
    const config = createConfig(root);

    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(config.paths.authFile, '{"provider":"openai-codex"}\n', "utf8");

    const canonicalPath = await ensureCanonicalAuthFilePath(config);

    expect(canonicalPath).toBe(config.paths.sharedAuthFile);
    await expect(readFile(canonicalPath, "utf8")).resolves.toContain("openai-codex");
  });

  it("prefers the canonical auth file when all tiers exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-storage-paths-canonical-"));
    const config = createConfig(root);
    const oldSharedPath = join(root, "shared", "auth", "auth.json");

    await mkdir(join(root, "shared", "config", "auth"), { recursive: true });
    await mkdir(join(root, "shared", "auth"), { recursive: true });
    await mkdir(join(root, "auth"), { recursive: true });

    await writeFile(config.paths.sharedAuthFile, '{"provider":"canonical"}\n', "utf8");
    await writeFile(oldSharedPath, '{"provider":"old-shared"}\n', "utf8");
    await writeFile(config.paths.authFile, '{"provider":"legacy"}\n', "utf8");

    const canonicalPath = await ensureCanonicalAuthFilePath(config);

    expect(canonicalPath).toBe(config.paths.sharedAuthFile);
    await expect(readFile(config.paths.sharedAuthFile, "utf8")).resolves.toContain("canonical");
  });
});
