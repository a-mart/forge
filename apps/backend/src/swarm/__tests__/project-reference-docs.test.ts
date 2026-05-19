import { mkdir, symlink, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRepositoryReferenceDocs } from "../project-reference-docs.js";

describe("project reference docs", () => {
  it("lists markdown files deterministically without following symlinks and applies caps", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-reference-docs-"));
    const forgeDir = join(root, ".forge");
    const referenceDir = join(forgeDir, "reference");
    await mkdir(join(referenceDir, "nested"), { recursive: true });
    await writeFile(join(referenceDir, "b.md"), "b");
    await writeFile(join(referenceDir, "a.md"), "a");
    await writeFile(join(referenceDir, "nested", "c.md"), "c");
    await writeFile(join(referenceDir, "notes.txt"), "nope");
    await symlink(join(referenceDir, "a.md"), join(referenceDir, "linked.md"));

    const inventory = await listRepositoryReferenceDocs(forgeDir, { maxFiles: 2 });

    expect(inventory.rootDir).toBe(referenceDir);
    expect(inventory.files).toEqual(["a.md", "b.md"]);
    expect(inventory.truncated).toBe(true);
  });

  it("keeps large reference inventories bounded to maxFiles plus overflow detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-reference-docs-"));
    const forgeDir = join(root, ".forge");
    const referenceDir = join(forgeDir, "reference");
    await mkdir(join(referenceDir, "nested"), { recursive: true });

    for (let index = 0; index < 50; index += 1) {
      await writeFile(join(referenceDir, `doc-${String(index).padStart(3, "0")}.md`), `doc ${index}`);
      await writeFile(join(referenceDir, "nested", `nested-${String(index).padStart(3, "0")}.md`), `nested ${index}`);
    }

    const inventory = await listRepositoryReferenceDocs(forgeDir, { maxFiles: 10 });

    expect(inventory.files).toHaveLength(10);
    expect(inventory.truncated).toBe(true);
    expect(inventory.files).toEqual([
      "doc-000.md",
      "doc-001.md",
      "doc-002.md",
      "doc-003.md",
      "doc-004.md",
      "doc-005.md",
      "doc-006.md",
      "doc-007.md",
      "doc-008.md",
      "doc-009.md",
    ]);
  });
});
