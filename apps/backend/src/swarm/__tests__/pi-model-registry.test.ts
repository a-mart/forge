import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelRegistryMockState = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  ModelRegistry: class {
    static create(authStorage: unknown, modelsJsonPath?: string): unknown {
      return modelRegistryMockState.create(authStorage, modelsJsonPath);
    }
  },
}));

import { createPiModelRegistry } from "../pi-model-registry.js";

describe("createPiModelRegistry", () => {
  beforeEach(() => {
    modelRegistryMockState.create.mockReset();
  });

  it("throws before creating a registry when the generated projection file is missing", () => {
    const projectionPath = join(tmpdir(), `forge-missing-${Date.now()}`, "pi-models.json");

    expect(() => createPiModelRegistry({} as never, projectionPath)).toThrow(
      `Pi model projection file is missing: ${projectionPath}. Regenerate it before creating a ModelRegistry.`,
    );
    expect(modelRegistryMockState.create).not.toHaveBeenCalled();
  });

  it("creates a registry from the generated projection file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-pi-model-registry-"));
    const projectionPath = join(rootDir, "pi-models.json");
    await writeFile(projectionPath, '{"providers":{}}\n', "utf8");

    const registry = {
      getError: () => undefined,
    };
    const authStorage = { tag: "auth" };
    modelRegistryMockState.create.mockReturnValue(registry);

    expect(createPiModelRegistry(authStorage as never, projectionPath)).toBe(registry);
    expect(modelRegistryMockState.create).toHaveBeenCalledWith(authStorage, projectionPath);
  });

  it("surfaces ModelRegistry errors after creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-pi-model-registry-"));
    const projectionPath = join(rootDir, "pi-models.json");
    await writeFile(projectionPath, '{"providers":{}}\n', "utf8");

    modelRegistryMockState.create.mockReturnValue({
      getError: () => "projection invalid",
    });

    expect(() => createPiModelRegistry({} as never, projectionPath)).toThrow("projection invalid");
  });
});
