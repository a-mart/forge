import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompactionSettingsService,
  CompactionSettingsValidationError,
  clampTimeoutMs,
  createDefaultCompactionSettings,
  MAX_COMPACTION_TIMEOUT_MS,
  MIN_COMPACTION_TIMEOUT_MS,
  normalizeTimeoutMs,
} from "../compaction-settings-service.js";
import { getCompactionSettingsPath } from "../data-paths.js";

function createAvailabilityMap(overrides: Record<string, boolean> = {}): Map<string, boolean> {
  return new Map<string, boolean>([
    ["openai-codex", true],
    ["anthropic", true],
    ["claude-sdk", true],
    ...Object.entries(overrides),
  ]);
}

describe("CompactionSettingsService", () => {
  it("loads defaults when the settings file is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-defaults-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();

    expect(service.getSettings()).toEqual(createDefaultCompactionSettings());
    await expect(access(getCompactionSettingsPath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clamps out-of-range timeout values when loading persisted settings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-load-clamp-"));
    const settingsPath = getCompactionSettingsPath(dataDir);
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          version: 1,
          model: { provider: "openai-codex", modelId: "gpt-5.5" },
          reasoningLevel: "low",
          timeoutMs: 30_000,
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });
    await service.load();

    expect(service.getSettings().timeoutMs).toBe(MIN_COMPACTION_TIMEOUT_MS);

    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          version: 1,
          model: { provider: "openai-codex", modelId: "gpt-5.5" },
          reasoningLevel: "low",
          timeoutMs: 1_000_000,
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await service.load();
    expect(service.getSettings().timeoutMs).toBe(MAX_COMPACTION_TIMEOUT_MS);
  });

  it("loads valid persisted settings unchanged", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-load-"));
    const settingsPath = getCompactionSettingsPath(dataDir);
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          version: 1,
          model: { provider: "openai-codex", modelId: "gpt-5.5" },
          reasoningLevel: "medium",
          timeoutMs: 420_000,
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });
    await service.load();

    expect(service.getSettings()).toEqual({
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "medium",
      timeoutMs: 420_000,
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
  });

  it("falls back to defaults for invalid model and reasoning fields on load", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-load-invalid-"));
    const settingsPath = getCompactionSettingsPath(dataDir);
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          version: 1,
          model: { provider: "", modelId: "not-a-model" },
          reasoningLevel: "not-a-level",
          timeoutMs: "invalid" as unknown as number,
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });
    await service.load();

    expect(service.getSettings()).toEqual({
      ...createDefaultCompactionSettings(),
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
  });

  it("includes timeout constraints in the settings view", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-constraints-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();
    const view = await service.getSettingsView();

    expect(view.constraints).toEqual({
      timeoutMs: { min: MIN_COMPACTION_TIMEOUT_MS, max: MAX_COMPACTION_TIMEOUT_MS, default: 300_000 },
    });
  });

  it("returns availability status without rewriting settings when provider credentials are unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-availability-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap({ "openai-codex": false }),
    });

    await service.load();
    const view = await service.getSettingsView();

    expect(view.settings).toEqual(createDefaultCompactionSettings());
    expect(view.defaults).toEqual(createDefaultCompactionSettings());
    expect(view.availability).toEqual({
      providerConfigured: false,
      modelValid: true,
      reasoningSupported: true,
    });
  });

  it("persists validated updates and merges partial patches", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-update-"));
    const now = new Date("2026-06-24T12:00:00.000Z");
    const service = new CompactionSettingsService({
      dataDir,
      now: () => now,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();
    const result = await service.update({ reasoningLevel: "medium", timeoutMs: 360_000 });

    expect(result.settings).toEqual({
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "medium",
      timeoutMs: 360_000,
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
    expect(result.availability).toEqual({
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    });

    const stored = JSON.parse(await readFile(getCompactionSettingsPath(dataDir), "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({
      version: 1,
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "medium",
      timeoutMs: 360_000,
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
  });

  it("clamps out-of-range timeout values on update", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-update-clamp-"));
    const now = new Date("2026-06-24T12:00:00.000Z");
    const service = new CompactionSettingsService({
      dataDir,
      now: () => now,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();

    const lowResult = await service.update({ timeoutMs: 30_000 });
    expect(lowResult.settings.timeoutMs).toBe(MIN_COMPACTION_TIMEOUT_MS);

    const highResult = await service.update({ timeoutMs: 1_000_000 });
    expect(highResult.settings.timeoutMs).toBe(MAX_COMPACTION_TIMEOUT_MS);
  });

  it("rejects unknown models, unsupported reasoning, and non-finite timeouts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-invalid-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();

    await expect(
      service.update({ model: { provider: "openai-codex", modelId: "not-a-model" } }),
    ).rejects.toBeInstanceOf(CompactionSettingsValidationError);
    await expect(service.update({ reasoningLevel: "not-a-level" as never })).rejects.toBeInstanceOf(
      CompactionSettingsValidationError,
    );
    await expect(service.update({ timeoutMs: Number.NaN })).rejects.toBeInstanceOf(CompactionSettingsValidationError);
    await expect(service.update({ timeoutMs: "300000" as never })).rejects.toBeInstanceOf(
      CompactionSettingsValidationError,
    );
  });

  it("allows timeout-only updates when saved provider credentials are unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-timeout-only-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap({ "openai-codex": false }),
    });

    await service.load();
    const result = await service.update({ timeoutMs: 420_000 });

    expect(result.settings.timeoutMs).toBe(420_000);
    expect(result.settings.model).toEqual({ provider: "openai-codex", modelId: "gpt-5.5" });
    expect(result.availability.providerConfigured).toBe(false);
  });

  it("rejects updates when the selected provider is not configured", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-provider-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => createAvailabilityMap({ "openai-codex": false }),
    });

    await service.load();

    await expect(
      service.update({ model: { provider: "openai-codex", modelId: "gpt-5.5" } }),
    ).rejects.toThrow("Provider openai-codex is not configured for manager model selection");
  });
});

describe("normalizeTimeoutMs", () => {
  it("accepts values within the configured bounds", () => {
    expect(normalizeTimeoutMs(300_000)).toBe(300_000);
    expect(normalizeTimeoutMs(60_000)).toBe(60_000);
    expect(normalizeTimeoutMs(900_000)).toBe(900_000);
  });

  it("clamps finite out-of-range timeout values", () => {
    expect(normalizeTimeoutMs(59_999)).toBe(MIN_COMPACTION_TIMEOUT_MS);
    expect(normalizeTimeoutMs(900_001)).toBe(MAX_COMPACTION_TIMEOUT_MS);
    expect(clampTimeoutMs(15_000)).toBe(MIN_COMPACTION_TIMEOUT_MS);
    expect(clampTimeoutMs(2_000_000)).toBe(MAX_COMPACTION_TIMEOUT_MS);
  });

  it("rejects non-finite timeout values", () => {
    expect(() => normalizeTimeoutMs(Number.NaN)).toThrow(CompactionSettingsValidationError);
    expect(() => normalizeTimeoutMs(Number.POSITIVE_INFINITY)).toThrow(CompactionSettingsValidationError);
    expect(() => normalizeTimeoutMs("300000" as never)).toThrow(CompactionSettingsValidationError);
  });
});
