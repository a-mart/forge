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
});
