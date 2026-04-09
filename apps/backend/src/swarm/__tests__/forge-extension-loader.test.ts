import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadForgeExtensionModule, loadForgeExtensionModules } from "../forge-extension-loader.js";
import type { DiscoveredForgeExtension } from "../forge-extension-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadForgeExtensionModule", () => {
  it("loads TypeScript ESM extensions and extracts metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "protect-env.ts");
    await writeFile(
      extensionPath,
      [
        'export const extension = {',
        '  name: "protect-env",',
        '  description: "Protect env files"',
        '};',
        'export default (forge) => { forge.loaded = "ts-esm"; };',
        ''
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadForgeExtensionModule(discovered(extensionPath));
    const forge = { loaded: "" } as { loaded: string };
    await loaded.setup(forge as never);

    expect(loaded.metadata).toEqual({
      name: "protect-env",
      description: "Protect env files"
    });
    expect(forge.loaded).toBe("ts-esm");
  });

  it("loads CommonJS .js extensions returned as module namespace objects by jiti", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "protect-env.js");
    await writeFile(
      extensionPath,
      [
        "module.exports = function setup(forge) { forge.loaded = 'js-cjs'; };",
        "module.exports.extension = {",
        "  name: 'protect-env',",
        "  description: 'Protect env files'",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadForgeExtensionModule(discovered(extensionPath));
    const forge = { loaded: "" } as { loaded: string };
    await loaded.setup(forge as never);

    expect(loaded.metadata).toEqual({
      name: "protect-env",
      description: "Protect env files"
    });
    expect(forge.loaded).toBe("js-cjs");
  });

  it("loads ESM .js extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "versioning-webhook.js");
    await writeFile(
      extensionPath,
      [
        'export const extension = { name: "versioning-webhook" };',
        'export default (forge) => { forge.loaded = "js-esm"; };',
        ''
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadForgeExtensionModule(discovered(extensionPath));
    const forge = { loaded: "" } as { loaded: string };
    await loaded.setup(forge as never);

    expect(loaded.metadata).toEqual({ name: "versioning-webhook" });
    expect(forge.loaded).toBe("js-esm");
  });

  it("rejects extensions without a default export function", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const missingDefaultPath = join(dir, "missing-default.ts");
    const invalidDefaultPath = join(dir, "invalid-default.ts");
    await writeFile(missingDefaultPath, 'export const extension = { name: "missing-default" };\n', "utf8");
    await writeFile(invalidDefaultPath, 'export default { nope: true };\n', "utf8");

    await expect(loadForgeExtensionModule(discovered(missingDefaultPath))).rejects.toThrow(
      "Forge extension default export must be a function"
    );
    await expect(loadForgeExtensionModule(discovered(invalidDefaultPath))).rejects.toThrow(
      "Forge extension default export must be a function"
    );
  });

  it("isolates load errors so one broken file does not prevent other modules from loading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const workingPath = join(dir, "working.ts");
    const brokenPath = join(dir, "broken.ts");
    await writeFile(workingPath, 'export default () => {};\n', "utf8");
    await writeFile(brokenPath, 'throw new Error("broken module");\n', "utf8");

    const result = await loadForgeExtensionModules([discovered(workingPath), discovered(brokenPath)]);

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.discovered.path).toBe(workingPath);
    expect(result.errors).toEqual([
      expect.objectContaining({
        discovered: expect.objectContaining({ path: brokenPath }),
        error: expect.stringContaining("broken module")
      })
    ]);
  });

  it("shares module-level state across repeated loads until the file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "shared-state.ts");
    await writeFile(
      extensionPath,
      [
        "let loadCount = 0;",
        "export default (forge) => {",
        "  loadCount += 1;",
        "  forge.loaded = `first:${loadCount}`;",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const firstLoaded = await loadForgeExtensionModule(discovered(extensionPath));
    const firstForge = { loaded: "" } as { loaded: string };
    await firstLoaded.setup(firstForge as never);
    expect(firstForge.loaded).toBe("first:1");

    const secondLoaded = await loadForgeExtensionModule(discovered(extensionPath));
    const secondForge = { loaded: "" } as { loaded: string };
    await secondLoaded.setup(secondForge as never);
    expect(secondForge.loaded).toBe("first:2");

    await writeFile(
      extensionPath,
      [
        "let loadCount = 100;",
        "export default (forge) => {",
        "  loadCount += 1;",
        "  forge.loaded = `second:${loadCount}`;",
        "};",
        "// ensure file size changes so the signature changes even on coarse mtime filesystems",
        ""
      ].join("\n"),
      "utf8"
    );

    const thirdLoaded = await loadForgeExtensionModule(discovered(extensionPath));
    const thirdForge = { loaded: "" } as { loaded: string };
    await thirdLoaded.setup(thirdForge as never);
    expect(thirdForge.loaded).toBe("second:101");
  });

  it("reloads edited extension code on the next load boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "reload.ts");
    await writeFile(extensionPath, 'export default (forge) => { forge.loaded = "first"; };\n', "utf8");

    const firstLoaded = await loadForgeExtensionModule(discovered(extensionPath));
    const firstForge = { loaded: "" } as { loaded: string };
    await firstLoaded.setup(firstForge as never);
    expect(firstForge.loaded).toBe("first");

    await writeFile(extensionPath, 'export default (forge) => { forge.loaded = "second"; };\n// changed\n', "utf8");

    const secondLoaded = await loadForgeExtensionModule(discovered(extensionPath));
    const secondForge = { loaded: "" } as { loaded: string };
    await secondLoaded.setup(secondForge as never);
    expect(secondForge.loaded).toBe("second");
  });
});

function discovered(path: string): DiscoveredForgeExtension {
  return {
    displayName: basename(path) || path,
    path,
    scope: "global"
  };
}
