import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadForgeExtensionModule } from "../forge-extension-loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadForgeExtensionModule", () => {
  it("loads CommonJS .js extensions returned as module namespace objects by jiti", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-extension-loader-"));
    tempDirs.push(dir);

    const extensionPath = join(dir, "protect-env.js");
    await writeFile(
      extensionPath,
      [
        "module.exports = function setup() {};",
        "module.exports.extension = {",
        "  name: 'protect-env',",
        "  description: 'Protect env files'",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadForgeExtensionModule({
      displayName: "protect-env.js",
      path: extensionPath,
      scope: "global"
    });

    expect(loaded.discovered.path).toBe(extensionPath);
    expect(loaded.metadata).toEqual({
      name: "protect-env",
      description: "Protect env files"
    });
    expect(typeof loaded.setup).toBe("function");
  });
});
