import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSharedModelOverridesPath } from "../data-paths.js";
import { ModelCatalogService } from "../model-catalog-service.js";
import { readModelOverrides, writeModelOverrides } from "../model-overrides.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-model-overrides-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model-overrides", () => {
  it("returns an empty override file when none exists", async () => {
    const dataDir = await makeTempDataDir();
    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {},
    });
  });

  it("ignores malformed override files", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getSharedModelOverridesPath(dataDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {},
    });
  });

  it("applies override caps and disabled defaults through the catalog service", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-opus-4-6": {
          enabled: false,
          contextWindowCap: 300_000,
        },
        "claude-opus-4-7": {
          enabled: false,
        },
        "claude-sdk/claude-opus-4-6": {
          enabled: true,
          contextWindowCap: 250_000,
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getEffectiveContextWindow("claude-opus-4-6")).toBe(300_000);
    expect(service.isModelEnabled("claude-opus-4-6")).toBe(false);
    expect(service.getEffectiveContextWindow("claude-opus-4-6", "claude-sdk")).toBe(250_000);
    expect(service.isModelEnabled("claude-opus-4-6", "claude-sdk")).toBe(true);

    const opusPreset = service.getModelPresetInfoList().find((preset) => preset.presetId === "pi-opus");
    expect(opusPreset?.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(service.resolveModelDescriptorFromFamily("pi-opus")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
      thinkingLevel: "medium",
    });
  });

  it("preserves empty and non-empty model-specific instruction overrides", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "gpt-5.3-codex": {
          modelSpecificInstructions: "Line one\r\nLine two",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
        "claude-sdk/claude-opus-4-6": {
          modelSpecificInstructions: "   \r\n\t  ",
        },
        empty: {},
      },
    });

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {
        "gpt-5.3-codex": {
          modelSpecificInstructions: "Line one\nLine two",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
        "claude-sdk/claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
      },
    });
  });

  it("resolves built-in, override, and explicit-clear model-specific instructions", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "gpt-5.3-codex": {
          modelSpecificInstructions: "Custom GPT instructions",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getEffectiveModelSpecificInstructions("gpt-5.4")).toContain(
      "Return the requested sections only, in the requested order.",
    );
    expect(service.getEffectiveModelSpecificInstructions("claude-haiku-4-5-20251001")).toContain(
      "Prefer concise, direct answers over essay-style framing.",
    );
    expect(service.getEffectiveModelSpecificInstructions("claude-opus-4-6", "claude-sdk")).toContain(
      "Prefer concise, direct answers over essay-style framing.",
    );
    expect(service.getEffectiveModelSpecificInstructions("grok-4")).toBeUndefined();
    expect(service.getEffectiveModelSpecificInstructions("gpt-5.3-codex")).toBe("Custom GPT instructions");
    expect(service.getEffectiveModelSpecificInstructions("claude-opus-4-6")).toBeUndefined();
  });
});
