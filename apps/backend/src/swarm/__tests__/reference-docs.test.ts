import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProfileReferencePath } from "../data-paths.js";
import {
  LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE,
  PROFILE_REFERENCE_INDEX_FILE,
  buildProfileReferenceIndexTemplate,
  ensureProfileReferenceDoc,
  ensureProfileReferenceIndex,
  migrateLegacyProfileKnowledgeToReferenceDoc,
  writeProfileReferenceDoc
} from "../reference-docs.js";

describe("reference-docs", () => {
  it("lazily creates the profile reference index", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const result = await ensureProfileReferenceIndex(dataDir, "feature-manager");
    const indexPath = getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE);
    const content = await readFile(indexPath, "utf8");

    expect(result).toEqual({
      path: indexPath,
      created: true
    });
    expect(content).toBe(buildProfileReferenceIndexTemplate("feature-manager"));
  });

  it("creates the index automatically before creating another reference doc", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const result = await ensureProfileReferenceDoc(dataDir, "feature-manager", "decisions.md");
    const docPath = getProfileReferencePath(dataDir, "feature-manager", "decisions.md");
    const indexPath = getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE);

    expect(result).toEqual({ path: docPath, created: true });
    await expect(readFile(indexPath, "utf8")).resolves.toContain("# feature-manager Reference Index");
    await expect(readFile(docPath, "utf8")).resolves.toContain("# feature-manager Decisions");
  });

  it("does not overwrite existing reference docs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const indexPath = getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE);
    const existingContent = "# Existing index\n";

    await ensureProfileReferenceIndex(dataDir, "feature-manager");
    await writeFile(indexPath, existingContent, "utf8");

    const result = await ensureProfileReferenceIndex(dataDir, "feature-manager");
    const content = await readFile(indexPath, "utf8");

    expect(result).toEqual({ path: indexPath, created: false });
    expect(content).toBe(existingContent);
  });

  it("migrates legacy profile knowledge into a seeded reference doc and index link", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const legacyPath = join(dataDir, "shared", "knowledge", "profiles", "feature-manager.md");
    const legacyContent = "# Project Knowledge: feature-manager\n\n## Architecture\n- legacy detail\n";

    await mkdir(join(dataDir, "shared", "knowledge", "profiles"), { recursive: true });
    await writeFile(legacyPath, legacyContent, "utf8");

    const migrated = await migrateLegacyProfileKnowledgeToReferenceDoc(dataDir, "feature-manager");
    const migratedDocPath = getProfileReferencePath(dataDir, "feature-manager", LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE);
    const migratedDoc = await readFile(migratedDocPath, "utf8");
    const indexContent = await readFile(
      getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE),
      "utf8"
    );

    expect(migrated).toEqual({
      sourcePath: legacyPath,
      path: migratedDocPath,
      created: true,
      updated: false
    });
    expect(migratedDoc).toContain("# feature-manager Legacy Profile Knowledge");
    expect(migratedDoc).toContain("## Legacy snapshot");
    expect(migratedDoc).toContain("legacy detail");
    expect(indexContent).toContain("## Migrated docs");
    expect(indexContent).toContain("./legacy-profile-knowledge.md");
  });

  it("is idempotent across repeated legacy migrations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const legacyPath = join(dataDir, "shared", "knowledge", "profiles", "feature-manager.md");
    await mkdir(join(dataDir, "shared", "knowledge", "profiles"), { recursive: true });
    await writeFile(legacyPath, "# Legacy\n\n- durable fact\n", "utf8");

    const first = await migrateLegacyProfileKnowledgeToReferenceDoc(dataDir, "feature-manager");
    const second = await migrateLegacyProfileKnowledgeToReferenceDoc(dataDir, "feature-manager");
    const indexContent = await readFile(
      getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE),
      "utf8"
    );

    expect(first?.created).toBe(true);
    expect(second).toEqual({
      sourcePath: legacyPath,
      path: getProfileReferencePath(dataDir, "feature-manager", LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE),
      created: false,
      updated: false
    });
    expect(indexContent.match(/## Migrated docs/g)).toHaveLength(1);
    expect(indexContent.match(/legacy-profile-knowledge\.md/g)).toHaveLength(1);
  });

  it("preserves custom index content when appending the migrated legacy link", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const legacyPath = join(dataDir, "shared", "knowledge", "profiles", "feature-manager.md");
    const indexPath = getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE);
    await mkdir(join(dataDir, "shared", "knowledge", "profiles"), { recursive: true });
    await writeFile(legacyPath, "# Legacy\n\n- durable fact\n", "utf8");
    await ensureProfileReferenceIndex(dataDir, "feature-manager");
    await writeFile(indexPath, "# feature-manager Reference Index\n\n## Custom docs\n- [Runbook](./runbook.md)\n", "utf8");

    await migrateLegacyProfileKnowledgeToReferenceDoc(dataDir, "feature-manager");
    const indexContent = await readFile(indexPath, "utf8");

    expect(indexContent).toContain("## Custom docs");
    expect(indexContent).toContain("[Runbook](./runbook.md)");
    expect(indexContent).toContain("## Migrated docs");
    expect(indexContent).toContain("[Legacy profile knowledge snapshot](./legacy-profile-knowledge.md)");
  });

  it("skips legacy migration when the profile knowledge file is missing or empty", async () => {
    const missingDataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    await expect(migrateLegacyProfileKnowledgeToReferenceDoc(missingDataDir, "feature-manager")).resolves.toBeNull();

    const emptyDataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const emptyLegacyPath = join(emptyDataDir, "shared", "knowledge", "profiles", "feature-manager.md");
    await mkdir(join(emptyDataDir, "shared", "knowledge", "profiles"), { recursive: true });
    await writeFile(emptyLegacyPath, "\n", "utf8");

    await expect(migrateLegacyProfileKnowledgeToReferenceDoc(emptyDataDir, "feature-manager")).resolves.toBeNull();
  });

  it("writes and updates reference docs without auto-overwriting unchanged content", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const first = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v1\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });
    const second = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v2\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });
    const third = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v2\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });

    expect(first).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: true,
      updated: false
    });
    expect(second).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: false,
      updated: true
    });
    expect(third).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: false,
      updated: false
    });
    await expect(
      readFile(getProfileReferencePath(dataDir, "feature-manager", "architecture.md"), "utf8")
    ).resolves.toContain("- v2");
  });

  it("uses exclusive create semantics when the same reference doc is provisioned concurrently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const results = await Promise.all([
      ensureProfileReferenceDoc(dataDir, "feature-manager", "architecture.md"),
      ensureProfileReferenceDoc(dataDir, "feature-manager", "architecture.md")
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    await expect(
      readFile(getProfileReferencePath(dataDir, "feature-manager", "architecture.md"), "utf8")
    ).resolves.toContain("# feature-manager Architecture");
  });

  it("rejects path traversal attempts in reference doc file names", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    await expect(
      ensureProfileReferenceDoc(dataDir, "feature-manager", "../../etc/passwd")
    ).rejects.toThrow(/Invalid path segment/);
  });
});
