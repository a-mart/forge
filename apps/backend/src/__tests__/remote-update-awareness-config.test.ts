import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfig } from "../config.js";

describe("remote update awareness config", () => {
  it("wires a feature-owned database path and SQLite loader in Builder", async () => {
    const oldData = process.env.FORGE_DATA_DIR;
    const oldTarget = process.env.FORGE_RUNTIME_TARGET;
    process.env.FORGE_DATA_DIR = join("/tmp", "forge-awareness-config");
    process.env.FORGE_RUNTIME_TARGET = "builder";
    try {
      const config = createConfig();
      expect(config.paths.remoteUpdateAwarenessDbPath).toBe(
        join(process.env.FORGE_DATA_DIR, "shared", "state", "remote-update-awareness.db")
      );
      expect(config.remoteUpdateAwarenessModules).toBeDefined();
      expect(await config.remoteUpdateAwarenessModules?.loadDatabaseModule()).toBeTypeOf("function");
      expect(config.collaborationModules).toBeUndefined();
    } finally {
      if (oldData === undefined) delete process.env.FORGE_DATA_DIR;
      else process.env.FORGE_DATA_DIR = oldData;
      if (oldTarget === undefined) delete process.env.FORGE_RUNTIME_TARGET;
      else process.env.FORGE_RUNTIME_TARGET = oldTarget;
    }
  });
});
