import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanRepoProjectAgentDefinitions } from "../repo-project-agent-definitions.js";
import {
  rollbackWrittenRepoProjectAgentDefinition,
  writeRepoProjectAgentDefinition,
} from "../repo-project-agent-definition-writer.js";

const atomicWriteGate = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
}));

vi.mock("../../utils/atomic-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/atomic-files.js")>(
    "../../utils/atomic-files.js",
  );
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      await atomicWriteGate.wait;
      return actual.writeFileAtomic(...args);
    },
    writeJsonFileAtomic: async (...args: Parameters<typeof actual.writeJsonFileAtomic>) => {
      await atomicWriteGate.wait;
      return actual.writeJsonFileAtomic(...args);
    },
  };
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  atomicWriteGate.wait = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeRepoProjectAgentDefinition", () => {
  it("creates a valid exclusive definition and will create missing .forge/project-agents", async () => {
    const root = await makeTempDir("forge-repo-pa-write-");
    const forgeDir = join(root, ".forge");

    const written = await writeRepoProjectAgentDefinition({
      forgeDir,
      handle: "Docs Agent",
      displayName: "Docs Agent",
      whenToUse: "  Use for docs  ",
      capabilities: ["create_session"],
      prompt: "Maintain the docs.",
    });

    expect(written.definitionId).toBe("docs-agent");
    expect(written.definition.config).toMatchObject({
      version: 1,
      handle: "docs-agent",
      displayName: "Docs Agent",
      whenToUse: "Use for docs",
      capabilities: ["create_session"],
    });
    expect(await readFile(join(written.definitionDir, "prompt.md"), "utf8")).toBe("Maintain the docs.\n");
    expect(JSON.parse(await readFile(join(written.definitionDir, "config.json"), "utf8"))).toMatchObject({
      version: 1,
      handle: "docs-agent",
      whenToUse: "Use for docs",
    });
  });

  it("refuses to overwrite an existing definition and leaves it unchanged", async () => {
    const root = await makeTempDir("forge-repo-pa-exists-");
    const forgeDir = join(root, ".forge");
    const existingDir = join(forgeDir, "project-agents", "docs");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "prompt.md"), "Keep me.\n", "utf8");
    await writeFile(
      join(existingDir, "config.json"),
      JSON.stringify({ version: 1, handle: "docs", whenToUse: "Existing" }),
      "utf8",
    );

    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Replacement",
        prompt: "Overwrite me.",
      }),
    ).rejects.toThrow(/already exists/i);
    expect(await readFile(join(existingDir, "prompt.md"), "utf8")).toBe("Keep me.\n");
  });

  it("rejects a duplicate handle stored under a different definition id", async () => {
    const root = await makeTempDir("forge-repo-pa-duplicate-handle-");
    const forgeDir = join(root, ".forge");
    const existingDir = join(forgeDir, "project-agents", "legacy-docs");
    await mkdir(existingDir, { recursive: true });
    await writeFile(
      join(existingDir, "config.json"),
      JSON.stringify({ version: 1, handle: "docs", whenToUse: "Existing" }),
      "utf8",
    );
    await writeFile(join(existingDir, "prompt.md"), "Existing prompt.\n", "utf8");

    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Replacement prompt.",
      }),
    ).rejects.toThrow(/handle "docs" already exists/i);
    await expect(stat(join(forgeDir, "project-agents", "docs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects empty prompts and symlink traversal", async () => {
    const root = await makeTempDir("forge-repo-pa-reject-");
    const forgeDir = join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });

    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "   ",
      }),
    ).rejects.toThrow(/non-empty role instructions/i);

    const linkedParent = join(root, "linked-parent");
    await mkdir(linkedParent, { recursive: true });
    const linkedForge = join(linkedParent, ".forge");
    await symlink(forgeDir, linkedForge);
    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir: linkedForge,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Maintain the docs.",
      }),
    ).rejects.toThrow(/must not be a symlink/i);
  });

  it("keeps staged content outside the scanned project-agents root until publication", async () => {
    const root = await makeTempDir("forge-repo-pa-scan-stage-");
    const forgeDir = join(root, ".forge");
    let releaseWrites: (() => void) | undefined;
    atomicWriteGate.wait = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });

    const writing = writeRepoProjectAgentDefinition({
      forgeDir,
      handle: "docs",
      whenToUse: "Use for docs",
      prompt: "Maintain the docs.",
    });
    try {
      await vi.waitFor(async () => {
        const entries = await readdir(forgeDir);
        expect(entries.some((entry) => entry.startsWith(".project-agent-staging-docs-"))).toBe(true);
      });
      const inventoryWhileStaged = await scanRepoProjectAgentDefinitions(
        join(forgeDir, "project-agents"),
      );
      expect(inventoryWhileStaged.items).toEqual([]);
    } finally {
      releaseWrites?.();
    }

    const written = await writing;
    const inventoryAfterPublish = await scanRepoProjectAgentDefinitions(written.projectAgentsDir);
    expect(inventoryAfterPublish.items).toEqual([
      expect.objectContaining({ definitionId: "docs", status: "valid" }),
    ]);
  });

  it("publishes a complete definition and leaves no staging leftovers", async () => {
    const root = await makeTempDir("forge-repo-pa-stage-");
    const forgeDir = join(root, ".forge");
    const written = await writeRepoProjectAgentDefinition({
      forgeDir,
      handle: "docs",
      whenToUse: "Use for docs",
      prompt: "Maintain the docs.",
    });
    const entries = await readdir(forgeDir);
    expect(entries.some((entry) => entry.startsWith(".project-agent-staging-"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".lock"))).toBe(false);
    const inventory = await scanRepoProjectAgentDefinitions(written.projectAgentsDir);
    expect(inventory.items).toEqual([
      expect.objectContaining({ definitionId: "docs", status: "valid" }),
    ]);
    expect(await readFile(join(written.definitionDir, "config.json"), "utf8")).toContain('"handle": "docs"');
    expect(await readFile(join(written.definitionDir, "prompt.md"), "utf8")).toBe("Maintain the docs.\n");
  });

  it("serializes same-definition writers so only one complete definition remains", async () => {
    const root = await makeTempDir("forge-repo-pa-concurrent-");
    const forgeDir = join(root, ".forge");
    const results = await Promise.allSettled([
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "First prompt.",
      }),
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Second prompt.",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const inventory = await scanRepoProjectAgentDefinitions(join(forgeDir, "project-agents"));
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({ definitionId: "docs", status: "valid" });
    expect(await readFile(join(forgeDir, "project-agents", "docs", "prompt.md"), "utf8")).toMatch(/prompt\.\n$/);
  });

  it("rolls back only empty parents created by the write", async () => {
    const root = await makeTempDir("forge-repo-pa-parent-rollback-");
    const forgeDir = join(root, ".forge");
    const written = await writeRepoProjectAgentDefinition({
      forgeDir,
      handle: "docs",
      whenToUse: "Use for docs",
      prompt: "Maintain the docs.",
    });
    const keepPath = join(written.projectAgentsDir, "keep.txt");
    await writeFile(keepPath, "keep", "utf8");

    await rollbackWrittenRepoProjectAgentDefinition(written);

    expect(await readFile(keepPath, "utf8")).toBe("keep");
    await expect(stat(written.definitionDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(written.forgeDir)).isDirectory()).toBe(true);
  });

  it("cleans created empty parents when containment fails before publication", async () => {
    const root = await makeTempDir("forge-repo-pa-cleanup-");
    const otherRoot = await makeTempDir("forge-repo-pa-other-");
    const forgeDir = join(root, ".forge");
    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        containmentRoot: otherRoot,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Maintain the docs.",
      }),
    ).rejects.toThrow(/outside the detected Git repository root/i);
    await expect(stat(forgeDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(forgeDir, "project-agents", "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
