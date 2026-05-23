import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
