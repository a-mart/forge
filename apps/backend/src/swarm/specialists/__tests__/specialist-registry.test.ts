import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteProfileSpecialist,
  generateRosterBlock,
  invalidateSpecialistCache,
  normalizeSpecialistHandle,
  parseSpecialistFile,
  resolveRoster,
  saveProfileSpecialist,
  seedBuiltins,
} from "../specialist-registry.js";

describe("specialist-registry", () => {
  let originalForgeDataDir: string | undefined;
  let originalMiddlemanDataDir: string | undefined;

  beforeEach(() => {
    originalForgeDataDir = process.env.FORGE_DATA_DIR;
    originalMiddlemanDataDir = process.env.MIDDLEMAN_DATA_DIR;
    invalidateSpecialistCache();
  });

  afterEach(() => {
    if (originalForgeDataDir === undefined) {
      delete process.env.FORGE_DATA_DIR;
    } else {
      process.env.FORGE_DATA_DIR = originalForgeDataDir;
    }

    if (originalMiddlemanDataDir === undefined) {
      delete process.env.MIDDLEMAN_DATA_DIR;
    } else {
      process.env.MIDDLEMAN_DATA_DIR = originalMiddlemanDataDir;
    }

    invalidateSpecialistCache();
  });

  it("parses frontmatter and body from a specialist file", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "backend.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Backend Engineer",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Backend tasks",
        "model: pi-codex",
        "reasoningLevel: high",
        "builtin: true",
        "---",
        "",
        "You are a backend specialist.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter).toMatchObject({
      displayName: "Backend Engineer",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Backend tasks",
      model: "pi-codex",
      reasoningLevel: "high",
      builtin: true,
    });
    expect(parsed?.body).toContain("backend specialist");
  });

  it("resolves profile specialists over shared specialists and computes availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;

    const sharedDir = join(dataDir, "shared", "specialists");
    const profileDir = join(dataDir, "profiles", "profile-a", "specialists");

    await mkdir(sharedDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await writeFile(
      join(sharedDir, "backend.md"),
      [
        "---",
        "displayName: Shared Backend",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Shared backend",
        "model: pi-codex",
        "---",
        "",
        "Shared backend body.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(sharedDir, "invalid.md"),
      [
        "---",
        "displayName: Invalid Specialist",
        "color: '#111111'",
        "enabled: true",
        "whenToUse: Invalid model",
        "model: made-up-model",
        "---",
        "",
        "Invalid specialist body.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(profileDir, "backend.md"),
      [
        "---",
        "displayName: Profile Backend",
        "color: '#123456'",
        "enabled: true",
        "whenToUse: Profile backend",
        "model: pi-5.4",
        "---",
        "",
        "Profile backend body.",
      ].join("\n"),
      "utf8",
    );

    const roster = await resolveRoster("profile-a", dataDir);

    expect(roster.map((entry) => entry.specialistId)).toEqual(["backend", "invalid"]);

    expect(roster[0]).toMatchObject({
      specialistId: "backend",
      displayName: "Profile Backend",
      sourceKind: "profile",
      shadowsGlobal: true,
      model: "pi-5.4",
      availabilityCode: "ok",
      available: true,
    });

    expect(roster[1]).toMatchObject({
      specialistId: "invalid",
      sourceKind: "global",
      model: "made-up-model",
      availabilityCode: "invalid_model",
      available: false,
    });
  });

  it("generates a roster block with only enabled and available specialists", () => {
    const markdown = generateRosterBlock([
      {
        specialistId: "backend",
        displayName: "Backend Engineer",
        color: "#2563eb",
        enabled: true,
        whenToUse: "Backend work",
        model: "pi-codex",
        reasoningLevel: "high",
        builtin: true,
        promptBody: "Prompt",
        sourceKind: "builtin",
        available: true,
        availabilityCode: "ok",
        shadowsGlobal: false,
      },
      {
        specialistId: "disabled",
        displayName: "Disabled",
        color: "#222222",
        enabled: false,
        whenToUse: "Should be omitted (disabled)",
        model: "pi-codex",
        builtin: false,
        promptBody: "Prompt",
        sourceKind: "global",
        available: true,
        availabilityCode: "ok",
        shadowsGlobal: false,
      },
      {
        specialistId: "invalid",
        displayName: "Invalid",
        color: "#111111",
        enabled: true,
        whenToUse: "Should be omitted (unavailable)",
        model: "unknown",
        builtin: false,
        promptBody: "Prompt",
        sourceKind: "global",
        available: false,
        availabilityCode: "invalid_model",
        availabilityMessage: "Unknown model preset",
        shadowsGlobal: false,
      },
    ]);

    expect(markdown).toContain("Named specialist workers");
    expect(markdown).toContain("`backend`");
    expect(markdown).toContain("Backend work");
    expect(markdown).toContain("[pi-codex high]");
    expect(markdown).not.toContain("`disabled`");
    expect(markdown).not.toContain("`invalid`");
  });

  it("seeds builtins and preserves enabled state for existing builtin files", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;

    const sharedDir = join(dataDir, "shared", "specialists");
    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "backend.md"),
      [
        "---",
        "displayName: Legacy Backend",
        "color: '#000000'",
        "enabled: false",
        "whenToUse: Legacy",
        "model: pi-codex",
        "builtin: true",
        "---",
        "",
        "Legacy backend body.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(sharedDir, "reviewer.md"),
      [
        "---",
        "displayName: Custom Reviewer",
        "color: '#ffffff'",
        "enabled: true",
        "whenToUse: Custom",
        "model: pi-opus",
        "---",
        "",
        "Custom reviewer body.",
      ].join("\n"),
      "utf8",
    );

    await seedBuiltins(dataDir);

    const backend = await parseSpecialistFile(join(sharedDir, "backend.md"));
    const reviewerMarkdown = await readFile(join(sharedDir, "reviewer.md"), "utf8");

    expect(backend).not.toBeNull();
    expect(backend?.frontmatter.displayName).toBe("Backend Engineer");
    expect(backend?.frontmatter.enabled).toBe(false);
    expect(backend?.frontmatter.builtin).toBe(true);

    expect(reviewerMarkdown).toContain("displayName: Custom Reviewer");

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));
    expect(architect).not.toBeNull();
  });

  it("repairs malformed builtin files during seeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");

    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, "backend.md"), "not valid specialist markdown", "utf8");

    await seedBuiltins(dataDir);

    const backend = await parseSpecialistFile(join(sharedDir, "backend.md"));
    expect(backend).not.toBeNull();
    expect(backend?.frontmatter.displayName).toBe("Backend Engineer");
    expect(backend?.frontmatter.builtin).toBe(true);
  });

  it("isolates cached rosters by data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDirA = join(root, "data-a");
    const dataDirB = join(root, "data-b");
    const profileId = "profile-a";

    await mkdir(join(dataDirA, "shared", "specialists"), { recursive: true });
    await mkdir(join(dataDirB, "shared", "specialists"), { recursive: true });

    await writeFile(
      join(dataDirA, "shared", "specialists", "backend.md"),
      [
        "---",
        "displayName: Backend A",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Backend A",
        "model: pi-codex",
        "---",
        "",
        "Backend A body.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(dataDirB, "shared", "specialists", "backend.md"),
      [
        "---",
        "displayName: Backend B",
        "color: '#059669'",
        "enabled: true",
        "whenToUse: Backend B",
        "model: pi-5.4",
        "---",
        "",
        "Backend B body.",
      ].join("\n"),
      "utf8",
    );

    const rosterA = await resolveRoster(profileId, dataDirA);
    const rosterB = await resolveRoster(profileId, dataDirB);

    expect(rosterA[0]).toMatchObject({
      displayName: "Backend A",
      model: "pi-codex",
    });
    expect(rosterB[0]).toMatchObject({
      displayName: "Backend B",
      model: "pi-5.4",
    });
  });

  it("treats non-directory specialist paths as empty directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    const profileDirParent = join(dataDir, "profiles", "profile-a");

    await mkdir(sharedDir, { recursive: true });
    await mkdir(profileDirParent, { recursive: true });

    await writeFile(
      join(sharedDir, "backend.md"),
      [
        "---",
        "displayName: Shared Backend",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Shared backend",
        "model: pi-codex",
        "---",
        "",
        "Shared backend body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(profileDirParent, "specialists"), "not a directory", "utf8");

    const roster = await resolveRoster("profile-a", dataDir);

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ specialistId: "backend", sourceKind: "global" });
  });

  describe("normalizeSpecialistHandle", () => {
    it("lowercases and kebab-cases", () => {
      expect(normalizeSpecialistHandle("Backend Engineer")).toBe("backend-engineer");
    });

    it("strips leading/trailing hyphens", () => {
      expect(normalizeSpecialistHandle("--my-handle--")).toBe("my-handle");
    });

    it("collapses non-alphanumeric runs", () => {
      expect(normalizeSpecialistHandle("foo___bar!!!baz")).toBe("foo-bar-baz");
    });

    it("returns empty string for whitespace-only input", () => {
      expect(normalizeSpecialistHandle("   ")).toBe("");
    });
  });

  it("generates a compact message for an empty roster", () => {
    const markdown = generateRosterBlock([]);
    expect(markdown).toContain("none configured");
    expect(markdown).not.toContain("\n");
  });

  it("rejects files with missing frontmatter fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "incomplete.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Missing Color",
        "enabled: true",
        "whenToUse: Test",
        "model: pi-codex",
        "---",
        "",
        "Body text.",
      ].join("\n"),
      "utf8",
    );

    expect(await parseSpecialistFile(filePath)).toBeNull();
  });

  it("rejects files with invalid hex color", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "badcolor.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Bad Color",
        "color: red",
        "enabled: true",
        "whenToUse: Test",
        "model: pi-codex",
        "---",
        "",
        "Body text.",
      ].join("\n"),
      "utf8",
    );

    expect(await parseSpecialistFile(filePath)).toBeNull();
  });

  it("rejects files with empty body", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "nobody.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: No Body",
        "color: '#aabbcc'",
        "enabled: true",
        "whenToUse: Test",
        "model: pi-codex",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await parseSpecialistFile(filePath)).toBeNull();
  });

  it("saves and deletes profile specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;

    await saveProfileSpecialist(dataDir, "profile-a", "custom-worker", {
      displayName: "Custom Worker",
      color: "#abcdef",
      enabled: true,
      whenToUse: "Custom tasks",
      model: "pi-codex",
      reasoningLevel: "high",
      promptBody: "Custom prompt body",
    });

    let roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(true);

    await deleteProfileSpecialist(dataDir, "profile-a", "custom-worker");

    roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(false);
  });
});
