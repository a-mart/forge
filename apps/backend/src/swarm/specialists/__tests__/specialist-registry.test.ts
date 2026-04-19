import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteProfileSpecialist,
  deleteSharedSpecialist,
  generateRosterBlock,
  invalidateSpecialistCache,
  normalizeSpecialistHandle,
  parseSpecialistFile,
  resolveRoster,
  resolveSharedRoster,
  saveProfileSpecialist,
  saveSharedSpecialist,
  seedBuiltins,
} from "../specialist-registry.js";
import { modelCatalogService } from "../../model-catalog-service.js";
import { writeModelOverrides } from "../../model-overrides.js";

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
        "modelId: gpt-5.3-codex",
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
      modelId: "gpt-5.3-codex",
      reasoningLevel: "high",
      builtin: true,
    });
    expect(parsed?.body).toContain("backend specialist");
  });

  it("parses pinned frontmatter when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "pinned.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Pinned Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Keep customizations",
        "modelId: gpt-5.3-codex",
        "builtin: true",
        "pinned: true",
        "---",
        "",
        "Pinned body.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.pinned).toBe(true);
  });

  it("parses webSearch frontmatter when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "web-search.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Research Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Live web research",
        "modelId: grok-4",
        "webSearch: true",
        "---",
        "",
        "Research body.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.webSearch).toBe(true);
  });

  it("defaults webSearch frontmatter to false when omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "default-web-search.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Standard Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: General tasks",
        "modelId: gpt-5.3-codex",
        "---",
        "",
        "Standard body.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.webSearch).toBe(false);
  });

  it("migrates legacy preset-based frontmatter to modelId", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "legacy.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Legacy Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Legacy tasks",
        "model: pi-codex",
        "reasoningLevel: high",
        "---",
        "",
        "Legacy prompt body.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.modelId).toBe("gpt-5.3-codex");
  });

  it("maps legacy preset-based frontmatter through the effective family default when overrides disable the builtin default", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const filePath = join(root, "legacy-opus.md");

    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-opus-4-6": {
          enabled: false,
        },
      },
    });
    await modelCatalogService.loadOverrides(dataDir);

    try {
      await writeFile(
        filePath,
        [
          "---",
          "displayName: Legacy Specialist",
          "color: '#2563eb'",
          "enabled: true",
          "whenToUse: Legacy tasks",
          "model: pi-opus",
          "reasoningLevel: high",
          "---",
          "",
          "Legacy prompt body.",
        ].join("\n"),
        "utf8",
      );

      const parsed = await parseSpecialistFile(filePath);
      expect(parsed).not.toBeNull();
      expect(parsed?.frontmatter.modelId).toBe("claude-sonnet-4-5-20250929");
    } finally {
      await modelCatalogService.loadOverrides(join(root, "reset-data"));
    }
  });

  it("serializes pinned frontmatter when saving", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "pinned-specialist.md");

    await saveSharedSpecialist(dataDir, "pinned-specialist", {
      displayName: "Pinned Specialist",
      color: "#123abc",
      enabled: true,
      whenToUse: "Pinned tasks",
      modelId: "gpt-5.4",
      pinned: true,
      promptBody: "Pinned prompt body",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).toContain("pinned: true");
  });

  it("serializes webSearch frontmatter when enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "research.md");

    await saveSharedSpecialist(dataDir, "research", {
      displayName: "Research Specialist",
      color: "#123abc",
      enabled: true,
      whenToUse: "Research tasks",
      modelId: "grok-4",
      webSearch: true,
      promptBody: "Research prompt body",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).toContain("webSearch: true");
  });

  it("omits webSearch frontmatter when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "standard.md");

    await saveSharedSpecialist(dataDir, "standard", {
      displayName: "Standard Specialist",
      color: "#123abc",
      enabled: true,
      whenToUse: "Standard tasks",
      modelId: "gpt-5.4",
      webSearch: false,
      promptBody: "Standard prompt body",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).not.toContain("webSearch:");
  });

  it("coerces webSearch to false when saving a non-Grok specialist", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "non-grok.md");

    await saveSharedSpecialist(dataDir, "non-grok", {
      displayName: "Non Grok Specialist",
      color: "#123abc",
      enabled: true,
      whenToUse: "Standard tasks",
      modelId: "gpt-5.4",
      webSearch: true,
      promptBody: "Standard prompt body",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).not.toContain("webSearch:");
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
        "modelId: gpt-5.3-codex",
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
        "modelId: made-up-model",
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
        "modelId: gpt-5.4",
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
      modelId: "gpt-5.4",
      availabilityCode: "ok",
      available: true,
    });

    expect(roster[1]).toMatchObject({
      specialistId: "invalid",
      sourceKind: "global",
      modelId: "made-up-model",
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
        modelId: "gpt-5.3-codex",
        provider: "openai-codex",
        reasoningLevel: "high",
        builtin: true,
        pinned: false,
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
        modelId: "gpt-5.3-codex",
        provider: "openai-codex",
        builtin: false,
        pinned: false,
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
        modelId: "unknown",
        provider: "unknown",
        builtin: false,
        pinned: false,
        promptBody: "Prompt",
        sourceKind: "global",
        available: false,
        availabilityCode: "invalid_model",
        availabilityMessage: "Unknown modelId: unknown",
        shadowsGlobal: false,
      },
    ]);

    expect(markdown).toContain("Named specialist workers");
    expect(markdown).toContain("`backend`");
    expect(markdown).toContain("Backend work");
    expect(markdown).toContain("[openai-codex/gpt-5.3-codex high]");
    expect(markdown).not.toContain("`disabled`");
    expect(markdown).not.toContain("`invalid`");
  });

  it("seeds builtins and preserves enabled and pinned state for non-pinned builtin files", async () => {
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
        "modelId: gpt-5.3-codex",
        "builtin: true",
        "pinned: false",
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
        "modelId: claude-opus-4-6",
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
    expect(backend?.frontmatter.pinned).toBe(false);

    expect(reviewerMarkdown).toContain("displayName: Custom Reviewer");

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));
    expect(architect).not.toBeNull();
  });

  it("seeds builtin fallback models with cross-vendor matches for OpenAI and Anthropic specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);

    const roster = await resolveSharedRoster(dataDir);
    const byId = new Map(roster.map((entry) => [entry.specialistId, entry]));

    expect(byId.get("architect")).toMatchObject({
      provider: "openai-codex",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-opus-4-6",
      fallbackReasoningLevel: "high",
    });
    expect(byId.get("backend")).toMatchObject({
      provider: "openai-codex",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-opus-4-6",
      fallbackReasoningLevel: "high",
    });
    expect(byId.get("code-reviewer")).toMatchObject({
      provider: "openai-codex",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-opus-4-6",
      fallbackReasoningLevel: "high",
    });
    expect(byId.get("researcher")).toMatchObject({
      provider: "openai-codex",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-sonnet-4-5-20250929",
    });
    expect(byId.get("scout")).toMatchObject({
      provider: "openai-codex",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-haiku-4-5-20251001",
      fallbackReasoningLevel: "low",
    });

    expect(byId.get("code-reviewer-2")).toMatchObject({
      provider: "anthropic",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4",
      fallbackReasoningLevel: "high",
    });
    expect(byId.get("doc-writer")).toMatchObject({
      provider: "anthropic",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "medium",
    });
    expect(byId.get("frontend")).toMatchObject({
      provider: "anthropic",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4",
      fallbackReasoningLevel: "high",
    });
    expect(byId.get("planner")).toMatchObject({
      provider: "anthropic",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4",
      fallbackReasoningLevel: "high",
    });

    expect(byId.get("app-runtime")).toMatchObject({
      provider: "openai-codex-app-server",
      modelId: "default",
      fallbackModelId: undefined,
    });
    expect(byId.get("cursor-builder")).toMatchObject({
      provider: "cursor-acp",
      modelId: "default",
      reasoningLevel: "medium",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4",
      fallbackReasoningLevel: "high",
      enabled: false,
      builtin: true,
      sourceKind: "builtin",
    });
    expect(byId.get("web-researcher")).toMatchObject({
      provider: "xai",
      fallbackProvider: "xai",
      fallbackModelId: "grok-4",
    });

    const rosterBlock = generateRosterBlock(roster);
    expect(rosterBlock).not.toContain("`cursor-builder`");
  });

  it("skips overwriting pinned builtin files during seeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    process.env.FORGE_DATA_DIR = dataDir;

    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "backend.md"),
      [
        "---",
        "displayName: My Pinned Backend",
        "color: '#010203'",
        "enabled: false",
        "whenToUse: Keep my custom backend prompt",
        "modelId: gpt-5.4",
        "builtin: true",
        "pinned: true",
        "---",
        "",
        "Do not overwrite this body.",
      ].join("\n"),
      "utf8",
    );

    await seedBuiltins(dataDir);

    const backend = await parseSpecialistFile(join(sharedDir, "backend.md"));

    expect(backend).not.toBeNull();
    expect(backend?.frontmatter.displayName).toBe("My Pinned Backend");
    expect(backend?.frontmatter.modelId).toBe("gpt-5.4");
    expect(backend?.frontmatter.enabled).toBe(false);
    expect(backend?.frontmatter.pinned).toBe(true);
    expect(backend?.body).toContain("Do not overwrite this body.");
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
        "modelId: gpt-5.3-codex",
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
        "modelId: gpt-5.4",
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
      modelId: "gpt-5.3-codex",
    });
    expect(rosterB[0]).toMatchObject({
      displayName: "Backend B",
      modelId: "gpt-5.4",
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
        "modelId: gpt-5.3-codex",
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
        "modelId: gpt-5.3-codex",
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
        "modelId: gpt-5.3-codex",
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
        "modelId: gpt-5.3-codex",
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
      modelId: "gpt-5.3-codex",
      reasoningLevel: "high",
      promptBody: "Custom prompt body",
    });

    let roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(true);

    await deleteProfileSpecialist(dataDir, "profile-a", "custom-worker");

    roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(false);
  });

  it("saves shared specialists and exposes them through the shared roster", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveSharedSpecialist(dataDir, "global-worker", {
      displayName: "Global Worker",
      color: "#123abc",
      enabled: true,
      whenToUse: "Shared tasks",
      modelId: "gpt-5.4",
      reasoningLevel: "medium",
      promptBody: "Shared prompt body",
    });

    const roster = await resolveSharedRoster(dataDir);
    expect(roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specialistId: "global-worker",
          sourceKind: "global",
          modelId: "gpt-5.4",
          reasoningLevel: "medium",
        }),
      ]),
    );
  });

  it("includes webSearch in resolved roster entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveSharedSpecialist(dataDir, "research-worker", {
      displayName: "Research Worker",
      color: "#123abc",
      enabled: true,
      whenToUse: "Shared research tasks",
      modelId: "grok-4",
      webSearch: true,
      promptBody: "Shared research prompt body",
    });

    const roster = await resolveSharedRoster(dataDir);
    expect(roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specialistId: "research-worker",
          webSearch: true,
        }),
      ]),
    );
  });

  it("coerces webSearch to false in resolved roster entries for non-Grok specialist files", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");

    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(sharedDir, "non-grok.md"),
      [
        "---",
        "displayName: Non Grok Specialist",
        "color: '#123abc'",
        "enabled: true",
        "whenToUse: Standard tasks",
        "modelId: gpt-5.4",
        "webSearch: true",
        "---",
        "",
        "Standard prompt body",
      ].join("\n"),
      "utf8",
    );

    const roster = await resolveSharedRoster(dataDir);
    expect(roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specialistId: "non-grok",
          webSearch: false,
        }),
      ]),
    );
  });

  it("rejects deleting missing profile specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await expect(deleteProfileSpecialist(dataDir, "profile-a", "missing-worker")).rejects.toThrow(
      "Unknown specialist: missing-worker",
    );
  });

  it("marks specialist unavailable when fallback model is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    process.env.FORGE_DATA_DIR = dataDir;

    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "worker.md"),
      [
        "---",
        "displayName: Worker",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: General tasks",
        "modelId: gpt-5.3-codex",
        "fallbackModelId: nonexistent-model",
        "fallbackReasoningLevel: high",
        "---",
        "",
        "Worker body.",
      ].join("\n"),
      "utf8",
    );

    const roster = await resolveRoster("profile-a", dataDir);

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      specialistId: "worker",
      available: false,
      availabilityCode: "invalid_model",
      availabilityMessage: "Unknown fallbackModelId: nonexistent-model",
    });
  });

  it("generates roster block with fallback model info", () => {
    const markdown = generateRosterBlock([
      {
        specialistId: "backend",
        displayName: "Backend Engineer",
        color: "#2563eb",
        enabled: true,
        whenToUse: "Backend work",
        modelId: "gpt-5.3-codex",
        provider: "openai-codex",
        reasoningLevel: "high",
        fallbackModelId: "claude-opus-4-6",
        fallbackProvider: "anthropic",
        fallbackReasoningLevel: "medium",
        builtin: true,
        pinned: false,
        promptBody: "Prompt",
        sourceKind: "builtin",
        available: true,
        availabilityCode: "ok",
        shadowsGlobal: false,
      },
    ]);

    expect(markdown).toContain("`backend`");
    expect(markdown).toContain("[openai-codex/gpt-5.3-codex high");
    expect(markdown).toContain("-> fallback anthropic/claude-opus-4-6 medium]");
  });

  it("adds a web search tag to roster entries when enabled", () => {
    const markdown = generateRosterBlock([
      {
        specialistId: "research",
        displayName: "Research Specialist",
        color: "#2563eb",
        enabled: true,
        whenToUse: "Web research",
        modelId: "grok-4",
        provider: "xai",
        reasoningLevel: "medium",
        builtin: false,
        pinned: false,
        webSearch: true,
        promptBody: "Prompt",
        sourceKind: "global",
        available: true,
        availabilityCode: "ok",
        shadowsGlobal: false,
      },
    ]);

    expect(markdown).toContain("[web search]");
  });

  it("returns null for legacy migration with unknown preset name", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "unknown-preset.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Unknown Preset",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Unknown tasks",
        "model: pi-nonexistent",
        "reasoningLevel: high",
        "---",
        "",
        "Unknown preset body.",
      ].join("\n"),
      "utf8",
    );

    expect(await parseSpecialistFile(filePath)).toBeNull();
  });

  it("rejects deleting builtins and missing shared specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);

    await expect(deleteSharedSpecialist(dataDir, "backend")).rejects.toThrow(
      "Cannot delete builtin specialist: backend",
    );
    await expect(deleteSharedSpecialist(dataDir, "missing-worker")).rejects.toThrow(
      "Unknown specialist: missing-worker",
    );
  });
});
