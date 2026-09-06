import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORGE_MODEL_CATALOG,
  MANAGER_SELECTION_CATALOG_LIMITS,
  getOpenRouterModelOverrideKey,
  type ManagerModelSurface,
  type OpenRouterModelEntry,
} from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClientCommand } from "../../ws/ws-command-parser.js";
import { buildManagerSelectionCatalog } from "../catalog/manager-selection-catalog.js";
import {
  evaluateExactManagerModelSelection,
  resolveExactManagerModelSelection,
} from "../catalog/manager-model-selection.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { writeModelOverrides } from "../model-overrides.js";
import { writeOpenRouterModels } from "../openrouter-models.js";
import { validateAgentDescriptor } from "../swarm-manager-utils.js";

const ALL_AVAILABLE = new Map<string, boolean>([
  ["openai-codex", true],
  ["anthropic", true],
  ["xai", true],
  ["openrouter", true],
  ["cursor-sdk", true],
]);

function openRouterEntry(
  modelId: string,
  overrides: Partial<OpenRouterModelEntry> = {},
): OpenRouterModelEntry {
  return {
    modelId,
    displayName: `OpenRouter ${modelId}`,
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsReasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
    inputModes: ["text"],
    supportsTools: true,
    addedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function parseJsonCommand(payload: unknown) {
  return parseClientCommand(Buffer.from(JSON.stringify(payload), "utf8"));
}

function baseDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "manager-1",
    managerId: "manager-1",
    displayName: "Manager",
    role: "manager",
    status: "idle",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" },
    sessionFile: "/tmp/session.jsonl",
    ...overrides,
  };
}

describe.sequential("manager selection catalog projection", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-manager-selection-catalog-"));
    modelCatalogService.setXaiOAuthDiscoveredModels(null);
    await writeModelOverrides(dataDir, { version: 1, overrides: {} });
    await writeOpenRouterModels(dataDir, { version: 1, models: {} });
    await modelCatalogService.loadOverrides(dataDir);
  });

  afterEach(async () => {
    modelCatalogService.setXaiOAuthDiscoveredModels(null);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("projects exact Fable 5.1, Astra, Adaptive, bounded defaults, and no runtime-only metadata", () => {
    const first = buildManagerSelectionCatalog(ALL_AVAILABLE);
    const second = buildManagerSelectionCatalog(ALL_AVAILABLE);

    expect(first.version).toBe(1);
    expect(first.revision).toBe(second.revision);
    expect(first.revision).toMatch(/^msc-v1-[a-f0-9]{64}$/);
    expect(first.revision.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxRevisionLength);
    expect(first.models.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxModels);
    expect(first.workModes.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxWorkModes);

    expect(first.models.find((model) =>
      model.provider === "anthropic" && model.modelId === "claude-fable-5-1"
    )).toMatchObject({
      providerLabel: "Anthropic",
      label: "Claude Fable 5.1",
      familyId: "pi-fable",
      defaultReasoningId: "high",
      reasoningOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
      surfaces: { create: { selectable: true }, change: { selectable: true } },
    });
    expect(first.models.find((model) => model.modelId === "gpt-6-astra")?.surfaces.create).toEqual({
      selectable: true,
    });
    expect(first.workModes.find((mode) => mode.id === "adaptive")).toMatchObject({
      label: "Adaptive",
      selectable: true,
    });
    expect(first.workModes.find((mode) => mode.id === "adaptive")?.description).toContain(
      "Starts directly; delegates when",
    );
    expect(first.defaults).toEqual({
      createManagerModel: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        reasoningId: "xhigh",
      },
      workModeId: "delegation_first",
    });
    const defaultSelection = first.defaults.createManagerModel;
    const defaultModel = first.models.find((model) =>
      model.provider === defaultSelection?.provider && model.modelId === defaultSelection.modelId
    );
    expect(defaultModel?.surfaces.create?.selectable).toBe(true);
    expect(defaultModel?.reasoningOptions.some((reasoning) =>
      reasoning.id === defaultSelection?.reasoningId
    )).toBe(true);
    expect(first.workModes.find((mode) => mode.id === first.defaults.workModeId)?.selectable).toBe(true);

    const allowedModelKeys = [
      "defaultReasoningId",
      "familyId",
      "familyLabel",
      "label",
      "modelId",
      "provider",
      "providerLabel",
      "reasoningOptions",
      "surfaces",
    ];
    for (const model of first.models) {
      expect(Object.keys(model).every((key) => allowedModelKeys.includes(key))).toBe(true);
      expect(model.provider.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxProviderIdLength);
      expect(model.modelId.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxModelIdLength);
      expect(model.label.length).toBeLessThanOrEqual(MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength);
      expect(model.reasoningOptions.length).toBeLessThanOrEqual(
        MANAGER_SELECTION_CATALOG_LIMITS.maxReasoningOptionsPerModel,
      );
    }
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "providerCredentials",
      "apiKey",
      "contextWindow",
      "maxOutputTokens",
      "piCost",
      "piUpstreamId",
      "intentionalDivergenceNotes",
      "/tmp/session.jsonl",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps unconfigured managed-auth rows visible but disabled and changes revision by public state only", () => {
    const available = buildManagerSelectionCatalog(ALL_AVAILABLE);
    const withoutAnthropic = new Map(ALL_AVAILABLE);
    withoutAnthropic.set("anthropic", false);
    const unavailable = buildManagerSelectionCatalog(withoutAnthropic);
    const fable = unavailable.models.find((model) => model.modelId === "claude-fable-5-1");

    expect(fable?.surfaces).toEqual({
      create: { selectable: false, unavailableReason: "provider_not_configured" },
      change: { selectable: false, unavailableReason: "provider_not_configured" },
    });
    expect(unavailable.revision).not.toBe(available.revision);
    expect(unavailable.revision).toBe(buildManagerSelectionCatalog(withoutAnthropic).revision);

    const withoutDefaultProvider = new Map(ALL_AVAILABLE);
    withoutDefaultProvider.set("openai-codex", false);
    expect(buildManagerSelectionCatalog(withoutDefaultProvider).defaults).not.toHaveProperty("createManagerModel");
  });

  it("uses structured evaluator results for disabled, hidden, retired, and worker-only rows", async () => {
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: { "claude-fable-5-1": { managerEnabled: false } },
    });
    await modelCatalogService.loadOverrides(dataDir);

    const baseGrok = FORGE_MODEL_CATALOG.models["grok-4.6"];
    modelCatalogService.setXaiOAuthDiscoveredModels([{
      ...baseGrok,
      modelId: "grok-build",
      displayName: "Grok Build",
      isFamilyDefault: false,
      discovered: true,
      authScope: "oauth",
    }]);

    const catalog = buildManagerSelectionCatalog(ALL_AVAILABLE);
    const fable = catalog.models.find((model) => model.modelId === "claude-fable-5-1");
    expect(fable?.surfaces.create).toEqual({ selectable: false, unavailableReason: "disabled" });
    expect(catalog.models.some((model) => model.modelId === "grok-build")).toBe(false);
    expect(catalog.models.some((model) => model.familyId === "pi-codex")).toBe(false);
    expect(catalog.models.some((model) => model.modelId === "gpt-5.4")).toBe(false);

    expect(evaluateExactManagerModelSelection(
      { provider: "xai", modelId: "grok-build" },
      { surface: "create", providerAvailability: ALL_AVAILABLE },
    )).toMatchObject({
      eligible: false,
      code: "unknown",
      checks: { surfaceSupported: false },
    });
    expect(() => resolveExactManagerModelSelection(
      { provider: "anthropic", modelId: "claude-fable-5-1" },
      { surface: "create", providerAvailability: ALL_AVAILABLE },
    )).toThrow("disabled for manager agents");
    expect(() => resolveExactManagerModelSelection(
      { provider: "openai-codex", modelId: "gpt-5.4" },
      { surface: "create", providerAvailability: ALL_AVAILABLE },
    )).toThrow("retired model");
  });

  it("preserves OpenRouter exact IDs and requires verified tools, manager opt-in, and auth", async () => {
    const eligible = openRouterEntry("z-ai/glm-5.1");
    const notOptedIn = openRouterEntry("qwen/qwen3-coder");
    const unverified = openRouterEntry("vendor/unverified", { supportsTools: undefined });
    const retired = openRouterEntry("anthropic/claude-haiku-4.5");
    await writeOpenRouterModels(dataDir, {
      version: 1,
      models: {
        [eligible.modelId]: eligible,
        [notOptedIn.modelId]: notOptedIn,
        [unverified.modelId]: unverified,
        [retired.modelId]: retired,
      },
    });
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        [getOpenRouterModelOverrideKey(eligible.modelId)]: { managerEnabled: true },
        [getOpenRouterModelOverrideKey(unverified.modelId)]: { managerEnabled: true },
        [getOpenRouterModelOverrideKey(retired.modelId)]: { managerEnabled: true },
      },
    });
    await modelCatalogService.loadOverrides(dataDir);

    const catalog = buildManagerSelectionCatalog(ALL_AVAILABLE);
    const option = catalog.models.find((model) => model.provider === "openrouter");
    expect(option).toMatchObject({
      provider: "openrouter",
      providerLabel: "OpenRouter",
      modelId: "z-ai/glm-5.1",
      surfaces: { create: { selectable: true }, change: { selectable: true } },
    });
    expect(catalog.models.some((model) => model.modelId === notOptedIn.modelId)).toBe(false);
    expect(catalog.models.some((model) => model.modelId === unverified.modelId)).toBe(false);
    expect(catalog.models.some((model) => model.modelId === retired.modelId)).toBe(false);

    const withoutAuth = new Map(ALL_AVAILABLE);
    withoutAuth.set("openrouter", false);
    expect(buildManagerSelectionCatalog(withoutAuth).models.find((model) =>
      model.provider === "openrouter" && model.modelId === eligible.modelId
    )?.surfaces.create).toEqual({ selectable: false, unavailableReason: "provider_not_configured" });
  });

  it("keeps every projected selectable surface in resolver parity and enforces response bounds", async () => {
    const models: Record<string, OpenRouterModelEntry> = {};
    const overrides: Record<string, { managerEnabled: true }> = {};
    for (let index = 0; index < 160; index += 1) {
      const model = openRouterEntry(`vendor/model-${String(index).padStart(3, "0")}`);
      models[model.modelId] = model;
      overrides[getOpenRouterModelOverrideKey(model.modelId)] = { managerEnabled: true };
    }
    const overlong = openRouterEntry(`vendor/${"x".repeat(300)}`);
    models[overlong.modelId] = overlong;
    overrides[getOpenRouterModelOverrideKey(overlong.modelId)] = { managerEnabled: true };
    await writeOpenRouterModels(dataDir, { version: 1, models });
    await writeModelOverrides(dataDir, { version: 1, overrides });
    await modelCatalogService.loadOverrides(dataDir);

    const catalog = buildManagerSelectionCatalog(ALL_AVAILABLE);
    expect(catalog.models).toHaveLength(MANAGER_SELECTION_CATALOG_LIMITS.maxModels);
    expect(catalog.models.some((model) => model.modelId === overlong.modelId)).toBe(false);

    for (const option of catalog.models) {
      for (const surface of Object.keys(option.surfaces) as ManagerModelSurface[]) {
        if (!option.surfaces[surface]?.selectable) continue;
        for (const reasoning of option.reasoningOptions) {
          expect(() => resolveExactManagerModelSelection(
            { provider: option.provider, modelId: option.modelId },
            { surface, providerAvailability: ALL_AVAILABLE, reasoningLevel: reasoning.id },
          )).not.toThrow();
        }
      }
    }
  });

  it("accepts extensible catalog IDs but keeps command ingress and persistence closed", () => {
    expect(parseJsonCommand({
      type: "update_project_delegation_defaults",
      profileId: "profile-1",
      managerPosture: "review_led",
    })).toMatchObject({ ok: false });
    expect(parseJsonCommand({
      type: "update_session_delegation",
      sessionAgentId: "session-1",
      managerPosture: { mode: "override", value: "review_led" },
    })).toMatchObject({ ok: false });
    expect(validateAgentDescriptor(baseDescriptor({ managerPosture: "review_led" }))).toMatch(
      /managerPosture must be/,
    );
  });
});
