import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRepoProjectAgentDefinitions } from "../repo-project-agent-definitions.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repo project agent definitions", () => {
  it("parses valid definitions with flat markdown references and deterministic signatures", async () => {
    const root = await makeTempDir("forge-repo-pa-");
    const definitionDir = join(root, "docs-agent");
    await mkdir(join(definitionDir, "reference"), { recursive: true });
    await writeFile(
      join(definitionDir, "config.json"),
      `${JSON.stringify({ version: 1, handle: "docs-agent", displayName: "Docs Agent", whenToUse: "Use for docs", capabilities: ["create_session"], model: { provider: "openai", modelId: "gpt-5.1-codex-max", thinkingLevel: "medium" } }, null, 2)}\n`,
      "utf-8"
    );
    await writeFile(join(definitionDir, "prompt.md"), "You maintain docs.\n", "utf-8");
    await writeFile(join(definitionDir, "reference", "guide.md"), "# Guide\n", "utf-8");

    const first = await scanRepoProjectAgentDefinitions(root);
    const second = await scanRepoProjectAgentDefinitions(root);

    expect(first.exists).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      definitionId: "docs-agent",
      handle: "docs-agent",
      status: "valid",
      displayName: "Docs Agent",
      whenToUse: "Use for docs",
      requestedCapabilities: ["create_session"],
      recommendedModel: { provider: "openai", modelId: "gpt-5.1-codex-max", thinkingLevel: "medium" },
      problems: []
    });
    expect(first.items[0].signature).toMatch(/^[a-f0-9]{64}$/);
    expect(second.items[0].signature).toBe(first.items[0].signature);
    expect(first.definitions[0].prompt).toBe("You maintain docs.\n");
    expect(first.definitions[0].referenceDocs.map((doc) => doc.path)).toEqual(["guide.md"]);
  });

  it("normalizes legacy Cursor ACP recommended models", async () => {
    const root = await makeTempDir("forge-repo-pa-cursor-acp-");
    const definitionDir = join(root, "cursor-agent");
    await mkdir(definitionDir, { recursive: true });
    await writeFile(
      join(definitionDir, "config.json"),
      JSON.stringify({ version: 1, handle: "cursor-agent", whenToUse: "Use Cursor", model: { provider: "cursor-acp", modelId: "default", thinkingLevel: "xhigh" } }),
      "utf-8"
    );
    await writeFile(join(definitionDir, "prompt.md"), "Use Cursor SDK.\n", "utf-8");

    const inventory = await scanRepoProjectAgentDefinitions(root);

    expect(inventory.items[0].recommendedModel).toEqual({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "high"
    });
    expect(inventory.definitions[0].config.model).toEqual(inventory.items[0].recommendedModel);
  });

  it("includes invalid entries with diagnostics instead of failing the scan", async () => {
    const root = await makeTempDir("forge-repo-pa-invalid-");
    const validDir = join(root, "valid-agent");
    const invalidDir = join(root, "Bad Agent");
    await mkdir(validDir, { recursive: true });
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(validDir, "config.json"), JSON.stringify({ version: 1, handle: "valid-agent", whenToUse: "Valid" }), "utf-8");
    await writeFile(join(validDir, "prompt.md"), "Valid prompt", "utf-8");
    await writeFile(join(invalidDir, "config.json"), JSON.stringify({ version: 1, handle: "Bad Agent", whenToUse: "", capabilities: ["unknown"] }), "utf-8");
    await writeFile(join(invalidDir, "prompt.md"), "   ", "utf-8");

    const inventory = await scanRepoProjectAgentDefinitions(root);

    expect(inventory.items.map((item) => [item.definitionId, item.status])).toEqual([
      ["Bad Agent", "invalid"],
      ["valid-agent", "valid"]
    ]);
    const invalid = inventory.items[0];
    expect(invalid.problems.map((problem) => problem.code)).toEqual(expect.arrayContaining([
      "definitionId_unsanitized",
      "handle_unsanitized",
      "when_to_use_required",
      "capability_unknown",
      "prompt_empty"
    ]));
    expect(inventory.definitions.map((definition) => definition.definitionId)).toEqual(["valid-agent"]);
  });

  it("rejects definition and reference symlinks with diagnostics", async () => {
    const root = await makeTempDir("forge-repo-pa-symlink-");
    const targetDir = join(root, "target");
    const linkedDir = join(root, "linked-agent");
    await mkdir(join(targetDir, "reference"), { recursive: true });
    await writeFile(join(targetDir, "config.json"), JSON.stringify({ version: 1, handle: "target", whenToUse: "Target" }), "utf-8");
    await writeFile(join(targetDir, "prompt.md"), "Target prompt", "utf-8");
    await writeFile(join(targetDir, "reference", "guide.md"), "# Guide", "utf-8");
    await symlink(targetDir, linkedDir, "dir");
    await symlink(join(targetDir, "reference", "guide.md"), join(targetDir, "reference", "linked.md"));

    const inventory = await scanRepoProjectAgentDefinitions(root);

    const linked = inventory.items.find((item) => item.definitionId === "linked-agent");
    expect(linked?.status).toBe("invalid");
    expect(linked?.problems.map((problem) => problem.code)).toContain("definition_symlink");
    const target = inventory.items.find((item) => item.definitionId === "target");
    expect(target?.status).toBe("invalid");
    expect(target?.problems.map((problem) => problem.code)).toContain("reference_symlink");
  });

  it("marks duplicate repo project-agent handles as conflicts and changes signatures", async () => {
    const root = await makeTempDir("forge-repo-pa-duplicates-");
    const firstDir = join(root, "docs-one");
    const secondDir = join(root, "docs-two");
    await mkdir(firstDir, { recursive: true });
    await writeFile(join(firstDir, "config.json"), JSON.stringify({ version: 1, handle: "shared-docs", whenToUse: "Docs one" }), "utf-8");
    await writeFile(join(firstDir, "prompt.md"), "First prompt", "utf-8");
    const before = await scanRepoProjectAgentDefinitions(root);

    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, "config.json"), JSON.stringify({ version: 1, handle: "shared-docs", whenToUse: "Docs two" }), "utf-8");
    await writeFile(join(secondDir, "prompt.md"), "Second prompt", "utf-8");
    const after = await scanRepoProjectAgentDefinitions(root);

    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ definitionId: "docs-one", status: "valid" });
    expect(after.items.map((item) => [item.definitionId, item.status])).toEqual([
      ["docs-one", "conflict"],
      ["docs-two", "conflict"]
    ]);
    expect(after.items.flatMap((item) => item.problems.map((problem) => problem.code))).toEqual([
      "repo_project_agent_handle_conflict",
      "repo_project_agent_handle_conflict"
    ]);
    expect(after.definitions).toEqual([]);
    expect(after.items.find((item) => item.definitionId === "docs-one")?.signature).not.toBe(before.items[0].signature);
  });

  it("surfaces root readdir failures as inventory problems", async () => {
    const root = await makeTempDir("forge-repo-pa-root-readdir-");
    await chmod(root, 0o000);
    try {
      const inventory = await scanRepoProjectAgentDefinitions(root);
      expect(inventory.exists).toBe(true);
      expect(inventory.problems?.map((problem) => problem.code)).toContain("directory_readdir_failed");
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("surfaces reference readdir failures as definition problems", async () => {
    const root = await makeTempDir("forge-repo-pa-reference-readdir-");
    const definitionDir = join(root, "docs");
    const referenceDir = join(definitionDir, "reference");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(definitionDir, "config.json"), JSON.stringify({ version: 1, handle: "docs", whenToUse: "Docs" }), "utf-8");
    await writeFile(join(definitionDir, "prompt.md"), "Prompt", "utf-8");
    await chmod(referenceDir, 0o000);
    try {
      const inventory = await scanRepoProjectAgentDefinitions(root);
      expect(inventory.items[0].status).toBe("invalid");
      expect(inventory.items[0].problems.map((problem) => problem.code)).toContain("directory_readdir_failed");
      expect(inventory.definitions).toEqual([]);
    } finally {
      await chmod(referenceDir, 0o700);
    }
  });

  it("surfaces unreadable config, prompt, and reference files as definition problems", async () => {
    const root = await makeTempDir("forge-repo-pa-unreadable-files-");
    const configDir = join(root, "bad-config");
    const promptDir = join(root, "bad-prompt");
    const referenceDir = join(root, "bad-reference", "reference");
    await mkdir(configDir, { recursive: true });
    await mkdir(promptDir, { recursive: true });
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({ version: 1, handle: "bad-config", whenToUse: "Docs" }), "utf-8");
    await writeFile(join(configDir, "prompt.md"), "Prompt", "utf-8");
    await writeFile(join(promptDir, "config.json"), JSON.stringify({ version: 1, handle: "bad-prompt", whenToUse: "Docs" }), "utf-8");
    await writeFile(join(promptDir, "prompt.md"), "Prompt", "utf-8");
    await writeFile(join(root, "bad-reference", "config.json"), JSON.stringify({ version: 1, handle: "bad-reference", whenToUse: "Docs" }), "utf-8");
    await writeFile(join(root, "bad-reference", "prompt.md"), "Prompt", "utf-8");
    await writeFile(join(referenceDir, "guide.md"), "# Guide", "utf-8");

    await chmod(join(configDir, "config.json"), 0o000);
    await chmod(join(promptDir, "prompt.md"), 0o000);
    await chmod(join(referenceDir, "guide.md"), 0o000);
    try {
      const inventory = await scanRepoProjectAgentDefinitions(root);
      expect(inventory.items.map((item) => [item.definitionId, item.status])).toEqual([
        ["bad-config", "invalid"],
        ["bad-prompt", "invalid"],
        ["bad-reference", "invalid"]
      ]);
      for (const item of inventory.items) {
        expect(item.problems.map((problem) => problem.code)).toContain("file_read_failed");
      }
      expect(inventory.definitions).toEqual([]);
    } finally {
      await chmod(join(configDir, "config.json"), 0o600).catch(() => undefined);
      await chmod(join(promptDir, "prompt.md"), 0o600).catch(() => undefined);
      await chmod(join(referenceDir, "guide.md"), 0o600).catch(() => undefined);
    }
  });

  it("changes the signature when definition content changes", async () => {
    const root = await makeTempDir("forge-repo-pa-signature-");
    const definitionDir = join(root, "docs");
    await mkdir(definitionDir, { recursive: true });
    await writeFile(join(definitionDir, "config.json"), JSON.stringify({ version: 1, handle: "docs", whenToUse: "Docs" }), "utf-8");
    await writeFile(join(definitionDir, "prompt.md"), "First prompt", "utf-8");
    const before = await scanRepoProjectAgentDefinitions(root);

    await writeFile(join(definitionDir, "prompt.md"), "Second prompt", "utf-8");
    const after = await scanRepoProjectAgentDefinitions(root);

    expect(after.items[0].signature).not.toBe(before.items[0].signature);
  });
});
