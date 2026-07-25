import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteChannelSpecialist,
  deleteProfileSpecialist,
  deleteSharedSpecialist,
  DEFAULT_TIER_CONFIGS,
  generateRosterBlock,
  generateTierLensRosterBlock,
  invalidateSpecialistCache,
  normalizeSpecialistHandle,
  parseSpecialistFile,
  resolveLegacySpecialistRewrite,
  resolveCollaborationChannelRoster,
  resolveRoster,
  resolveSharedRoster,
  resolveTierConfigs,
  resolveWorkspaceRoster,
  saveChannelSpecialist,
  saveProfileSpecialist,
  saveSharedSpecialist,
  saveTierConfigs,
  seedBuiltins,
} from "../specialist-registry.js";
import { getBuiltinSpecialistsDir } from "../../agents/specialists/specialist-paths.js";
import { modelCatalogService } from "../../model-catalog-service.js";
import { writeModelOverrides } from "../../model-overrides.js";

function makeSpecialistMarkdown(options: {
  displayName: string;
  whenToUse: string;
  extraFrontmatter?: string[];
}): string {
  return [
    "---",
    `displayName: ${options.displayName}`,
    "color: '#2563eb'",
    "enabled: true",
    `whenToUse: ${options.whenToUse}`,
    "modelId: gpt-5.5",
    "provider: openai",
    "TargetSpace: [builder]",
    ...(options.extraFrontmatter ?? []),
    "---",
    "Specialist prompt body.",
  ].join("\n");
}

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

  it("normalizes legacy Cursor ACP specialist models at read time", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "legacy-cursor.md");
    const presetFilePath = join(root, "legacy-cursor-preset.md");
    await writeFile(filePath, [
      "---",
      "displayName: Legacy Cursor",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy Cursor work",
      "modelId: ' DEFAULT '",
      "provider: ' Cursor-ACP '",
      "reasoningLevel: x-high",
      "fallbackModelId: default",
      "fallbackProvider: cursor-acp",
      "fallbackReasoningLevel: none",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n"), "utf8");

    const parsed = await parseSpecialistFile(filePath);
    expect(parsed?.frontmatter).toMatchObject({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      reasoningLevel: "none",
      fallbackProvider: "cursor-sdk",
      fallbackModelId: "composer-2.5",
      fallbackReasoningLevel: "none",
    });

    await writeFile(presetFilePath, [
      "---",
      "displayName: Legacy Cursor Preset",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy Cursor preset work",
      "model: cursor-acp",
      "reasoningLevel: none",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n"), "utf8");

    expect((await parseSpecialistFile(presetFilePath))?.frontmatter).toMatchObject({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      reasoningLevel: "none",
    });
  });

  it("resolves workspace specialists without overriding global entries unless explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const workspaceDir = join(root, ".forge", "specialists");
    await mkdir(join(dataDir, "shared", "specialists"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const globalSpecialist = makeSpecialistMarkdown({ displayName: "Global Backend", whenToUse: "global backend" });
    const workspaceSpecialist = makeSpecialistMarkdown({ displayName: "Workspace Backend", whenToUse: "workspace backend" });
    const workspaceOverride = makeSpecialistMarkdown({
      displayName: "Workspace Reviewer",
      whenToUse: "workspace review",
      extraFrontmatter: ["forgePrecedence: override"],
    });
    await writeFile(join(dataDir, "shared", "specialists", "backend.md"), globalSpecialist);
    await writeFile(join(dataDir, "shared", "specialists", "reviewer.md"), makeSpecialistMarkdown({ displayName: "Global Reviewer", whenToUse: "global review" }));
    await writeFile(join(workspaceDir, "backend.md"), workspaceSpecialist);
    await writeFile(join(workspaceDir, "reviewer.md"), workspaceOverride);
    await writeFile(join(workspaceDir, "repo-only.md"), makeSpecialistMarkdown({ displayName: "Repo Only", whenToUse: "repo only" }));

    const roster = await resolveWorkspaceRoster("profile-a", dataDir, workspaceDir);
    const byId = new Map(roster.map((entry) => [entry.specialistId, entry]));

    expect(byId.get("backend")).toMatchObject({ displayName: "Global Backend", sourceKind: "global" });
    expect(byId.get("reviewer")).toMatchObject({
      displayName: "Workspace Reviewer",
      sourceKind: "workspace",
      shadowsGlobal: true,
      conflictWarning: "Repository specialist overrides inherited global specialist.",
    });
    expect(byId.get("repo-only")).toMatchObject({ displayName: "Repo Only", sourceKind: "workspace" });

    await writeFile(join(workspaceDir, "repo-only.md"), makeSpecialistMarkdown({
      displayName: "Repo Only Edited",
      whenToUse: "repo only edited",
    }));
    const refreshedRoster = await resolveWorkspaceRoster("profile-a", dataDir, workspaceDir);
    expect(refreshedRoster.find((entry) => entry.specialistId === "repo-only")).toMatchObject({
      displayName: "Repo Only Edited",
      whenToUse: "repo only edited",
    });
  });

  it("resolves and copies canonical builtin specialists through the agents module path", async () => {
    const builtinDir = getBuiltinSpecialistsDir();
    const files = await readdir(builtinDir);
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);

    expect(files).toContain("architect.md");
    expect(files).toContain("planner.md");
    expect(files).not.toContain("backend.md");
    await expect(readFile(join(dataDir, "shared", "specialists", "architect.md"), "utf8")).resolves.toContain(
      "defaultTier: max",
    );
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
        "modelId: gpt-5.5",
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
      modelId: "gpt-5.5",
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
        "modelId: gpt-5.5",
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

  it("parses exact TargetSpace frontmatter from inline array and scalar forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const arrayPath = join(root, "dual.md");
    const scalarPath = join(root, "collab.md");

    await writeFile(
      arrayPath,
      [
        "---",
        "displayName: Dual Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Dual-space tasks",
        "modelId: gpt-5.5",
        "TargetSpace: [builder, collaboration]",
        "---",
        "",
        "Dual body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      scalarPath,
      [
        "---",
        "displayName: Collab Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Collaboration tasks",
        "modelId: gpt-5.5",
        "TargetSpace: collaboration",
        "---",
        "",
        "Collab body.",
      ].join("\n"),
      "utf8",
    );

    expect((await parseSpecialistFile(arrayPath))?.frontmatter.targetSpace).toEqual(["builder", "collaboration"]);
    expect((await parseSpecialistFile(scalarPath))?.frontmatter.targetSpace).toEqual(["collaboration"]);
  });

  it("accepts legacy lowercase targetSpace frontmatter while preserving canonical TargetSpace precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const legacyPath = join(root, "legacy-lowercase.md");
    const bothPath = join(root, "both.md");

    await writeFile(
      legacyPath,
      [
        "---",
        "displayName: Legacy Lowercase Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Collaboration tasks",
        "modelId: gpt-5.5",
        "targetSpace: collaboration",
        "---",
        "",
        "Legacy lowercase body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      bothPath,
      [
        "---",
        "displayName: Canonical Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Canonical tasks",
        "modelId: gpt-5.5",
        "TargetSpace: builder",
        "targetSpace: collaboration",
        "---",
        "",
        "Canonical body.",
      ].join("\n"),
      "utf8",
    );

    expect((await parseSpecialistFile(legacyPath))?.frontmatter.targetSpace).toEqual(["collaboration"]);
    expect((await parseSpecialistFile(bothPath))?.frontmatter.targetSpace).toEqual(["builder"]);
  });

  it("defaults missing TargetSpace frontmatter to builder for legacy compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "legacy-target-space.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Legacy Target Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Legacy tasks",
        "modelId: gpt-5.5",
        "---",
        "",
        "Legacy body.",
      ].join("\n"),
      "utf8",
    );

    expect((await parseSpecialistFile(filePath))?.frontmatter.targetSpace).toEqual(["builder"]);
  });

  it("serializes exact TargetSpace frontmatter when saving", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "dual-specialist.md");

    await saveSharedSpecialist(dataDir, "dual-specialist", {
      displayName: "Dual Specialist",
      color: "#123abc",
      enabled: true,
      whenToUse: "Dual tasks",
      modelId: "gpt-5.4",
      targetSpace: ["builder", "collaboration"],
      promptBody: "Dual prompt body",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).toContain("TargetSpace: [builder, collaboration]");
    expect(markdown).not.toContain("targetSpace:");
  });

  it("roundtrips fallback, model routing, pinned, web search, and TargetSpace fields through markdown saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "full-routing.md");

    await saveSharedSpecialist(dataDir, "full-routing", {
      displayName: "Full Routing",
      color: "#123abc",
      enabled: true,
      whenToUse: "Exercise every routing field.",
      modelId: "grok-4",
      provider: "xai",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackReasoningLevel: "medium",
      pinned: true,
      webSearch: true,
      targetSpace: ["collaboration", "builder"],
      promptBody: "Full routing prompt body.",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).toContain('provider: "xai"');
    expect(markdown).toContain('reasoningLevel: "high"');
    expect(markdown).toContain('fallbackModelId: "gpt-5.4"');
    expect(markdown).toContain('fallbackProvider: "openai-codex"');
    expect(markdown).toContain('fallbackReasoningLevel: "medium"');
    expect(markdown).toContain("pinned: true");
    expect(markdown).toContain("webSearch: true");
    expect(markdown).toContain("TargetSpace: [collaboration, builder]");

    const parsed = await parseSpecialistFile(specialistPath);
    expect(parsed?.frontmatter).toMatchObject({
      provider: "xai",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackReasoningLevel: "medium",
      pinned: true,
      webSearch: true,
      targetSpace: ["collaboration", "builder"],
    });
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
        "modelId: gpt-5.5",
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
    expect(parsed?.frontmatter.modelId).toBe("gpt-5.5");
  });

  it("accepts legacy model frontmatter when it already contains an exact model id", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const filePath = join(root, "legacy-model-id.md");

    await writeFile(
      filePath,
      [
        "---",
        "displayName: Legacy Model Id Specialist",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Legacy explicit model tasks",
        "model: gpt-5.4",
        "reasoningLevel: high",
        "---",
        "",
        "Legacy explicit model prompt body.",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpecialistFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter).toMatchObject({
      modelId: "gpt-5.4",
      provider: "openai-codex",
      reasoningLevel: "high",
    });
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
        "claude-opus-4-7": {
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
      expect(parsed?.frontmatter.modelId).toBe("claude-opus-4-8");
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

  it("preserves omitted tier settings when saving a partial policy update", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveTierConfigs(dataDir, [
      { ...DEFAULT_TIER_CONFIGS.light, modelId: "custom-light-model", reasoningLevel: "low" },
      { ...DEFAULT_TIER_CONFIGS.max, modelId: "custom-max-model", reasoningLevel: "max" },
    ]);
    await saveTierConfigs(dataDir, [
      { ...DEFAULT_TIER_CONFIGS.fast, modelId: "updated-support-model", reasoningLevel: "medium" },
    ]);

    const reloaded = await resolveTierConfigs(dataDir);
    expect(reloaded.find((config) => config.tier === "light")?.modelId).toBe("custom-light-model");
    expect(reloaded.find((config) => config.tier === "max")?.modelId).toBe("custom-max-model");
    expect(reloaded.find((config) => config.tier === "fast")?.modelId).toBe("updated-support-model");
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
        "modelId: gpt-5.5",
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

  it("resolves roster entries by targetSpace and keeps target spaces cache-isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "builder-only.md"),
      [
        "---",
        "displayName: Builder Only",
        "color: '#111111'",
        "enabled: true",
        "whenToUse: Builder tasks",
        "modelId: gpt-5.5",
        "TargetSpace: builder",
        "---",
        "",
        "Builder prompt.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sharedDir, "collab-only.md"),
      [
        "---",
        "displayName: Collab Only",
        "color: '#222222'",
        "enabled: true",
        "whenToUse: Collaboration tasks",
        "modelId: gpt-5.5",
        "TargetSpace: collaboration",
        "---",
        "",
        "Collab prompt.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sharedDir, "dual.md"),
      [
        "---",
        "displayName: Dual",
        "color: '#333333'",
        "enabled: true",
        "whenToUse: Dual tasks",
        "modelId: gpt-5.5",
        "TargetSpace: [builder, collaboration]",
        "---",
        "",
        "Dual prompt.",
      ].join("\n"),
      "utf8",
    );

    expect((await resolveRoster("profile-a", dataDir, "builder")).map((entry) => entry.specialistId)).toEqual([
      "builder-only",
      "dual",
    ]);
    expect((await resolveRoster("profile-a", dataDir, "collaboration")).map((entry) => entry.specialistId)).toEqual([
      "collab-only",
      "dual",
    ]);
  });

  it("generates a roster block with only enabled and available specialists", () => {
    const markdown = generateRosterBlock([
      {
        specialistId: "domain-expert",
        displayName: "Domain Expert",
        color: "#2563eb",
        enabled: true,
        whenToUse: "Domain work",
        modelId: "gpt-5.5",
        provider: "openai-codex",
        reasoningLevel: "high",
        builtin: false,
        pinned: false,
        targetSpace: ["builder"],
        promptBody: "Prompt",
        sourceKind: "global",
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
        modelId: "gpt-5.5",
        provider: "openai-codex",
        builtin: false,
        pinned: false,
        targetSpace: ["builder"],
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
        targetSpace: ["builder"],
        promptBody: "Prompt",
        sourceKind: "global",
        available: false,
        availabilityCode: "invalid_model",
        availabilityMessage: "Unknown modelId: unknown",
        shadowsGlobal: false,
      },
    ]);

    expect(markdown).toContain("Execution policies");
    expect(markdown).toContain("`support`");
    expect(markdown).toContain("`routine`");
    expect(markdown).toContain("`deep`");
    expect(markdown).not.toContain("`light`");
    expect(markdown).not.toContain("`max`");
    expect(markdown).toContain("`domain-expert`");
    expect(markdown).toContain("Domain work");
    expect(markdown).toContain("Custom specialists (use `customSpecialist` instead of mode/policy)");
    expect(markdown).not.toContain("`disabled`");
    expect(markdown).not.toContain("`invalid`");
  });

  it("maps all legacy builtin specialist handles to tier/lens selections", () => {
    expect(resolveLegacySpecialistRewrite("architect")).toEqual({ tier: "max", lens: "architect" });
    expect(resolveLegacySpecialistRewrite("planner")).toEqual({ tier: "deep", lens: "planner" });
    expect(resolveLegacySpecialistRewrite("code-reviewer")).toEqual({ tier: "deep", lens: "code-reviewer" });
    expect(resolveLegacySpecialistRewrite("code-reviewer-2")).toEqual({ tier: "deep", lens: "code-reviewer-2" });
    expect(resolveLegacySpecialistRewrite("researcher")).toEqual({ tier: "standard", lens: "researcher" });
    expect(resolveLegacySpecialistRewrite("web-researcher")).toEqual({ tier: "standard", lens: "researcher" });
    expect(resolveLegacySpecialistRewrite("codex-plugin")).toEqual({ tier: "standard", lens: "codex-plugin" });
    expect(resolveLegacySpecialistRewrite("backend")).toEqual({ tier: "fast" });
    expect(resolveLegacySpecialistRewrite("frontend")).toEqual({ tier: "fast" });
    expect(resolveLegacySpecialistRewrite("doc-writer")).toEqual({ tier: "standard" });
    expect(resolveLegacySpecialistRewrite("scout")).toEqual({ tier: "light" });
    expect(resolveLegacySpecialistRewrite("cursor-builder")).toEqual({ tier: "fast" });
    expect(resolveLegacySpecialistRewrite("collab-planner")).toEqual({ tier: "deep" });
    expect(resolveLegacySpecialistRewrite("collab-reviewer")).toEqual({ tier: "deep" });
    expect(resolveLegacySpecialistRewrite("collab-doc-writer")).toEqual({ tier: "standard" });
    expect(resolveLegacySpecialistRewrite("collab-scout")).toEqual({ tier: "light" });
    expect(resolveLegacySpecialistRewrite("collab-researcher")).toEqual({ tier: "standard" });
    expect(resolveLegacySpecialistRewrite("custom-worker")).toBeUndefined();
  });

  it("generates a compact tier/lens roster block under the builtin token budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);
    const markdown = generateTierLensRosterBlock(await resolveSharedRoster(dataDir));

    expect(Math.ceil(markdown.length / 4)).toBeLessThanOrEqual(400);
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
        "modelId: gpt-5.5",
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

    expect(backend).toBeNull();

    expect(reviewerMarkdown).toContain("displayName: Custom Reviewer");

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));
    expect(architect).not.toBeNull();
  });

  it("seeds builtin lenses with default tiers instead of per-lens model defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);

    const roster = await resolveSharedRoster(dataDir);
    const byId = new Map(roster.map((entry) => [entry.specialistId, entry]));

    expect(byId.get("architect")).toMatchObject({
      defaultTier: "max",
    });
    expect(byId.get("architect")).not.toHaveProperty("modelId");
    expect(byId.get("architect")).not.toHaveProperty("provider");
    expect(byId.get("code-reviewer")).toMatchObject({
      defaultTier: "deep",
    });
    expect(byId.get("code-reviewer")).not.toHaveProperty("modelId");
    expect(byId.get("researcher")).toMatchObject({
      defaultTier: "standard",
    });
    expect(byId.get("researcher")).not.toHaveProperty("modelId");

    expect(byId.get("code-reviewer-2")).toMatchObject({
      defaultTier: "deep",
    });
    expect(byId.get("code-reviewer-2")).not.toHaveProperty("modelId");
    expect(byId.get("planner")).toMatchObject({
      defaultTier: "deep",
    });
    expect(byId.get("planner")).not.toHaveProperty("modelId");

    expect(byId.get("app-runtime")).toBeUndefined();
    expect(byId.get("cursor-builder")).toBeUndefined();
    expect(byId.get("web-researcher")).toBeUndefined();

    const rosterBlock = generateRosterBlock(roster);
    expect(rosterBlock).not.toContain("`cursor-builder`");
  });

  it("seeds the union of builder and collaboration builtins for collaboration-server runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir, { runtimeTarget: "collaboration-server" });

    const allRoster = await resolveSharedRoster(dataDir);
    const allHandles = allRoster.map((entry) => entry.specialistId).sort();
    const builderHandles = (await resolveSharedRoster(dataDir, "builder")).map((entry) => entry.specialistId).sort();
    const collaborationHandles = (await resolveSharedRoster(dataDir, "collaboration"))
      .map((entry) => entry.specialistId)
      .sort();

    expect(allHandles).toEqual([
      "architect",
      "code-reviewer",
      "code-reviewer-2",
      "codex-plugin",
      "planner",
      "researcher",
    ].sort());
    expect(builderHandles).toContain("architect");
    expect(builderHandles).toContain("codex-plugin");
    expect(builderHandles).not.toContain("collab-planner");
    expect(collaborationHandles).toEqual([
      "architect",
      "code-reviewer",
      "code-reviewer-2",
      "planner",
      "researcher",
    ].sort());
    expect(allHandles).not.toContain("collab-builder");
  });

  it("skips overwriting pinned builtin files during seeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    process.env.FORGE_DATA_DIR = dataDir;

    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "architect.md"),
      [
        "---",
        "displayName: My Pinned Architect",
        "color: '#010203'",
        "enabled: false",
        "whenToUse: Keep my custom architect prompt",
        "defaultTier: max",
        "builtin: true",
        "pinned: true",
        "---",
        "",
        "Do not overwrite this body.",
      ].join("\n"),
      "utf8",
    );

    await seedBuiltins(dataDir);

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));

    expect(architect).not.toBeNull();
    expect(architect?.frontmatter.displayName).toBe("My Pinned Architect");
    expect(architect?.frontmatter.defaultTier).toBe("max");
    expect(architect?.frontmatter.enabled).toBe(false);
    expect(architect?.frontmatter.pinned).toBe(true);
    expect(architect?.body).toContain("Do not overwrite this body.");
  });

  it("repairs malformed builtin files during seeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");

    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, "architect.md"), "not valid specialist markdown", "utf8");

    await seedBuiltins(dataDir);

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));
    expect(architect).not.toBeNull();
    expect(architect?.frontmatter.displayName).toBe("Architect");
    expect(architect?.frontmatter.builtin).toBe(true);
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
        "modelId: gpt-5.5",
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
      modelId: "gpt-5.5",
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
        "modelId: gpt-5.5",
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
    expect(markdown).toContain("Execution policies");
    expect(markdown).toContain("`support`");
    expect(markdown).toContain("`general`");
    expect(markdown).not.toContain("Lenses");
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
        "modelId: gpt-5.5",
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
        "modelId: gpt-5.5",
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
        "modelId: gpt-5.5",
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
      modelId: "gpt-5.5",
      reasoningLevel: "high",
      promptBody: "Custom prompt body",
    });

    let roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(true);

    await deleteProfileSpecialist(dataDir, "profile-a", "custom-worker");

    roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(false);
  });

  it("preserves behavior-mode identity for profile and channel overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-mode-override-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;
    await seedBuiltins(dataDir);

    await saveProfileSpecialist(dataDir, "profile-a", "planner", {
      displayName: "Profile Plan",
      color: "#7c3aed",
      enabled: true,
      whenToUse: "Plan for this profile.",
      modelId: "removed-mode-model",
      provider: "openai-codex",
      targetSpace: ["builder", "collaboration"],
      defaultTier: "deep",
      promptBody: "Profile planning instructions.",
    });

    const profileRoster = await resolveRoster("profile-a", dataDir, "builder");
    const profilePlan = profileRoster.find((entry) => entry.specialistId === "planner");
    expect(profilePlan).toMatchObject({ sourceKind: "profile", builtin: true, available: false });
    const profileBlock = generateRosterBlock(profileRoster);
    expect(profileBlock).toContain("`plan` (default deep)");
    expect(profileBlock).not.toContain("`planner`: Plan for this profile");

    await saveChannelSpecialist(dataDir, "channel-a", "planner", {
      displayName: "Channel Plan",
      color: "#7c3aed",
      enabled: true,
      whenToUse: "Plan for this channel.",
      defaultTier: "deep",
      promptBody: "Channel planning instructions.",
    });
    const channelRoster = await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-a",
      selectedGlobalHandles: ["planner"],
    });
    const channelPlan = channelRoster.find((entry) => entry.specialistId === "planner");
    expect(channelPlan).toMatchObject({ sourceKind: "channel", builtin: true });
    const channelBlock = generateRosterBlock(channelRoster);
    expect(channelBlock).toContain("`plan` (default deep)");
    expect(channelBlock).not.toContain("`planner`: Plan for this channel");
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
        "modelId: gpt-5.5",
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

  it("generates policy rows with the configured primary and fallback model", () => {
    const markdown = generateRosterBlock([], [{
      ...DEFAULT_TIER_CONFIGS.fast,
      modelId: "gpt-5.5",
      provider: "openai-codex",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.5",
      fallbackProvider: "openai-codex",
      fallbackReasoningLevel: "medium",
    }]);

    expect(markdown).toContain("`support`");
    expect(markdown).toContain("[codex/gpt-5.5 high");
    expect(markdown).toContain("-> fb codex/gpt-5.5 medium]");
    expect(markdown).toContain("[Secure Sessions]");
    expect(markdown).toContain("`requiresSecureRuntime=true`");
  });

  it("identifies secure fallback routing in execution policy rows", () => {
    const markdown = generateRosterBlock([], [{
      ...DEFAULT_TIER_CONFIGS.fast,
      provider: "cursor-sdk",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.5",
    }]);

    expect(markdown).toContain("[Secure Sessions via fallback]");
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
        targetSpace: ["builder"],
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

  it("keeps profile shadowing scoped by targetSpace", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    const profileDir = join(dataDir, "profiles", "profile-a", "specialists");
    await mkdir(sharedDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await writeFile(
      join(sharedDir, "worker.md"),
      [
        "---",
        "displayName: Shared Builder Worker",
        "color: '#2563eb'",
        "enabled: true",
        "whenToUse: Builder tasks",
        "modelId: gpt-5.5",
        "TargetSpace: builder",
        "---",
        "",
        "Shared builder body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(profileDir, "worker.md"),
      [
        "---",
        "displayName: Profile Collaboration Worker",
        "color: '#16a34a'",
        "enabled: true",
        "whenToUse: Collaboration tasks",
        "modelId: gpt-5.4",
        "TargetSpace: collaboration",
        "---",
        "",
        "Profile collaboration body.",
      ].join("\n"),
      "utf8",
    );

    const builderRoster = await resolveRoster("profile-a", dataDir, "builder");
    const collaborationRoster = await resolveRoster("profile-a", dataDir, "collaboration");

    expect(builderRoster).toHaveLength(1);
    expect(builderRoster[0]).toMatchObject({
      specialistId: "worker",
      sourceKind: "global",
      displayName: "Shared Builder Worker",
      shadowsGlobal: false,
      targetSpace: ["builder"],
    });
    expect(collaborationRoster).toHaveLength(1);
    expect(collaborationRoster[0]).toMatchObject({
      specialistId: "worker",
      sourceKind: "profile",
      displayName: "Profile Collaboration Worker",
      shadowsGlobal: false,
      targetSpace: ["collaboration"],
    });
  });

  it("resolves channel collaboration roster from selected globals plus channel-local shadowing", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveSharedSpecialist(dataDir, "global-collab", {
      displayName: "Global Collab",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Use globally in collaboration.",
      modelId: "gpt-5.5",
      provider: "openai",
      targetSpace: ["collaboration"],
      promptBody: "Global collab prompt.",
    });
    await saveSharedSpecialist(dataDir, "unselected-collab", {
      displayName: "Unselected Collab",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Not selected.",
      modelId: "gpt-5.5",
      provider: "openai",
      targetSpace: ["collaboration"],
      promptBody: "Unselected prompt.",
    });
    await saveChannelSpecialist(dataDir, "channel-a", "global-collab", {
      displayName: "Local Override",
      color: "#16a34a",
      enabled: true,
      whenToUse: "Use local override.",
      modelId: "gpt-5.5",
      provider: "openai",
      promptBody: "Channel-local prompt.",
    });
    await saveChannelSpecialist(dataDir, "channel-a", "local-only", {
      displayName: "Local Only",
      color: "#16a34a",
      enabled: true,
      whenToUse: "Use locally.",
      modelId: "gpt-5.5",
      provider: "openai",
      targetSpace: ["builder"],
      promptBody: "Local-only prompt.",
    });

    const roster = await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-a",
      selectedGlobalHandles: ["global-collab", "missing-collab"],
    });
    const byId = new Map(roster.map((entry) => [entry.specialistId, entry]));

    expect(roster.map((entry) => entry.specialistId)).toEqual(["global-collab", "local-only"]);
    expect(byId.get("global-collab")).toMatchObject({
      sourceKind: "channel",
      promptBody: "Channel-local prompt.",
      shadowsGlobal: true,
      targetSpace: ["collaboration"],
    });
    expect(byId.get("local-only")).toMatchObject({ sourceKind: "channel", targetSpace: ["collaboration"] });
    expect(byId.has("unselected-collab")).toBe(false);
  });

  it("normalizes and deduplicates selected global handles for collaboration channel rosters", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveSharedSpecialist(dataDir, "Global Collab", {
      displayName: "Global Collab",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Use globally in collaboration.",
      modelId: "gpt-5.5",
      targetSpace: ["collaboration"],
      promptBody: "Global collab prompt.",
    });
    await saveSharedSpecialist(dataDir, "Builder Only", {
      displayName: "Builder Only",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Use in builder only.",
      modelId: "gpt-5.5",
      targetSpace: ["builder"],
      promptBody: "Builder-only prompt.",
    });

    const roster = await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-a",
      selectedGlobalHandles: [" Global Collab ", "global-collab", "builder-only", "!!!"],
    });

    expect(roster.map((entry) => entry.specialistId)).toEqual(["global-collab"]);
    expect(roster[0]).toMatchObject({ sourceKind: "global", targetSpace: ["collaboration"] });
  });

  it("invalidates channel roster cache for channel-local mutations only", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await saveChannelSpecialist(dataDir, "channel-a", "local", {
      displayName: "Local A",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Use locally.",
      modelId: "gpt-5.5",
      provider: "openai",
      promptBody: "Local prompt A.",
    });
    await saveChannelSpecialist(dataDir, "channel-b", "local", {
      displayName: "Local B",
      color: "#2563eb",
      enabled: true,
      whenToUse: "Use locally.",
      modelId: "gpt-5.5",
      provider: "openai",
      promptBody: "Local prompt B.",
    });

    expect((await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-a",
      selectedGlobalHandles: [],
    })).map((entry) => entry.specialistId)).toEqual(["local"]);
    await deleteChannelSpecialist(dataDir, "channel-a", "local");

    expect(await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-a",
      selectedGlobalHandles: [],
    })).toEqual([]);
    expect((await resolveCollaborationChannelRoster(dataDir, {
      sessionAgentId: "channel-b",
      selectedGlobalHandles: [],
    })).map((entry) => entry.specialistId)).toEqual(["local"]);
  });

  it("rejects deleting builtins and missing shared specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");

    await seedBuiltins(dataDir);

    await expect(deleteSharedSpecialist(dataDir, "architect")).rejects.toThrow(
      "Cannot delete builtin specialist: architect",
    );
    await expect(deleteSharedSpecialist(dataDir, "backend")).rejects.toThrow(
      "Unknown specialist: backend",
    );
    await expect(deleteSharedSpecialist(dataDir, "missing-worker")).rejects.toThrow(
      "Unknown specialist: missing-worker",
    );
  });
});
