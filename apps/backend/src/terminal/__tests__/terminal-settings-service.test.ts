import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTerminalSettingsPath } from "../../swarm/data-paths.js";
import { readTerminalRuntimeConfig } from "../terminal-config.js";
import { TerminalSettingsService } from "../terminal-settings-service.js";

const tempRoots: string[] = [];

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "terminal-settings-"));
  tempRoots.push(root);
  return join(root, "data");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TerminalSettingsService", () => {
  it("defaults to platform settings when no file or env override exists", async () => {
    const dataDir = await createTempDataDir();
    const service = new TerminalSettingsService({ dataDir, env: {} });

    await service.load();

    expect(service.getPersistedSettings()).toEqual({ defaultShell: undefined });
    expect(service.getSettings()).toEqual({
      defaultShell: null,
      persistedDefaultShell: null,
      source: "default",
    });
  });

  it("persists the selected shell in shared/config/terminal-settings.json", async () => {
    const dataDir = await createTempDataDir();
    const service = new TerminalSettingsService({ dataDir, env: {} });

    await service.load();
    const settings = await service.update({ defaultShell: "/bin/zsh" });
    const raw = await readFile(getTerminalSettingsPath(dataDir), "utf8");

    expect(settings).toEqual({
      defaultShell: "/bin/zsh",
      persistedDefaultShell: "/bin/zsh",
      source: "settings",
    });
    expect(JSON.parse(raw)).toEqual({ defaultShell: "/bin/zsh" });
  });

  it("falls back to the env override when the persisted setting is cleared", async () => {
    const dataDir = await createTempDataDir();
    const service = new TerminalSettingsService({
      dataDir,
      env: { FORGE_TERMINAL_DEFAULT_SHELL: "/bin/bash" },
    });

    await service.load();
    await service.update({ defaultShell: "/bin/zsh" });
    const settings = await service.update({ defaultShell: null });

    expect(settings).toEqual({
      defaultShell: "/bin/bash",
      persistedDefaultShell: null,
      source: "env",
    });
  });

  it("gives persisted settings higher priority than the env override in terminal runtime config", async () => {
    const config = await readTerminalRuntimeConfig({
      env: { FORGE_TERMINAL_DEFAULT_SHELL: "/bin/bash" },
      persistedSettings: { defaultShell: "/bin/zsh" },
    });

    expect(config.defaultShell).toBe("/bin/zsh");
  });
});
