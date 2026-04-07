import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelRegistryMockState = vi.hoisted(() => ({
  construct: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    ModelRegistry: {
      create: (...args: unknown[]) => modelRegistryMockState.construct(...args),
    },
  };
});

import { createPiModelRegistry } from "../pi-model-registry.js";

describe("createPiModelRegistry", () => {
  beforeEach(() => {
    modelRegistryMockState.construct.mockReset();
  });

  it("throws before creating a registry when the generated projection file is missing", () => {
    const projectionPath = join(tmpdir(), `forge-missing-${Date.now()}`, "pi-models.json");

    expect(() => createPiModelRegistry({} as never, projectionPath)).toThrow(
      `Pi model projection file is missing: ${projectionPath}. Regenerate it before creating a ModelRegistry.`,
    );
    expect(modelRegistryMockState.construct).not.toHaveBeenCalled();
  });

  it("creates a registry from the generated projection file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-pi-model-registry-"));
    const projectionPath = join(rootDir, "pi-models.json");
    await writeFile(projectionPath, '{"providers":{}}\n', "utf8");

    const registry = {
      getError: () => undefined,
    };
    const authStorage = { tag: "auth" };
    modelRegistryMockState.construct.mockReturnValue(registry);

    expect(createPiModelRegistry(authStorage as never, projectionPath)).toBe(registry);
    expect(modelRegistryMockState.construct).toHaveBeenCalledWith(authStorage, projectionPath);
  });

  it("surfaces ModelRegistry errors after creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-pi-model-registry-"));
    const projectionPath = join(rootDir, "pi-models.json");
    await writeFile(projectionPath, '{"providers":{}}\n', "utf8");

    modelRegistryMockState.construct.mockReturnValue({
      getError: () => "projection invalid",
    });

    expect(() => createPiModelRegistry({} as never, projectionPath)).toThrow("projection invalid");
  });
});
