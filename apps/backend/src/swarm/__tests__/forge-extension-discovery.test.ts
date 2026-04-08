import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverForgeExtensions } from "../forge-extension-discovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("discoverForgeExtensions", () => {
  it("returns global, profile, and project-local extensions in scope order with normalized path sort", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-discovery-"));
    tempDirs.push(rootDir);

    const dataDir = join(rootDir, "data");
    const cwd = join(rootDir, "repo");
    const globalDir = join(dataDir, "extensions");
    const profileDir = join(dataDir, "profiles", "alpha", "extensions");
    const projectDir = join(cwd, ".forge", "extensions");

    await mkdir(join(globalDir, "a-dir"), { recursive: true });
    await mkdir(join(profileDir, "a-dir"), { recursive: true });
    await mkdir(join(projectDir, "a-dir"), { recursive: true });

    await writeFile(join(globalDir, "b-ext.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(globalDir, "a-dir", "index.js"), "module.exports = () => {}\n", "utf8");
    await writeFile(join(globalDir, "shared.ts"), "export default () => {}\n", "utf8");

    await writeFile(join(profileDir, "b-ext.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(profileDir, "a-dir", "index.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(profileDir, "shared.ts"), "export default () => {}\n", "utf8");

    await writeFile(join(projectDir, "b-ext.js"), "module.exports = () => {}\n", "utf8");
    await writeFile(join(projectDir, "a-dir", "index.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(projectDir, "shared.ts"), "export default () => {}\n", "utf8");

    const discovered = await discoverForgeExtensions({
      dataDir,
      scopes: ["global", "profile", "project-local"],
      profileId: "alpha",
      cwd
    });

    expect(discovered.map((entry) => ({
      scope: entry.scope,
      path: relative(rootDir, entry.path),
      displayName: entry.displayName
    }))).toEqual([
      {
        scope: "global",
        path: relative(rootDir, join(globalDir, "a-dir", "index.js")),
        displayName: "a-dir"
      },
      {
        scope: "global",
        path: relative(rootDir, join(globalDir, "b-ext.ts")),
        displayName: "b-ext.ts"
      },
      {
        scope: "global",
        path: relative(rootDir, join(globalDir, "shared.ts")),
        displayName: "shared.ts"
      },
      {
        scope: "profile",
        path: relative(rootDir, join(profileDir, "a-dir", "index.ts")),
        displayName: "a-dir"
      },
      {
        scope: "profile",
        path: relative(rootDir, join(profileDir, "b-ext.ts")),
        displayName: "b-ext.ts"
      },
      {
        scope: "profile",
        path: relative(rootDir, join(profileDir, "shared.ts")),
        displayName: "shared.ts"
      },
      {
        scope: "project-local",
        path: relative(rootDir, join(projectDir, "a-dir", "index.ts")),
        displayName: "a-dir"
      },
      {
        scope: "project-local",
        path: relative(rootDir, join(projectDir, "b-ext.js")),
        displayName: "b-ext.js"
      },
      {
        scope: "project-local",
        path: relative(rootDir, join(projectDir, "shared.ts")),
        displayName: "shared.ts"
      }
    ]);
  });

  it("supports .ts, .js, index.ts, and index.js entrypoints", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-discovery-"));
    tempDirs.push(rootDir);

    const dataDir = join(rootDir, "data");
    const cwd = join(rootDir, "repo");
    const projectDir = join(cwd, ".forge", "extensions");

    await mkdir(join(projectDir, "dir-ts"), { recursive: true });
    await mkdir(join(projectDir, "dir-js"), { recursive: true });
    await writeFile(join(projectDir, "single.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(projectDir, "single.js"), "module.exports = () => {}\n", "utf8");
    await writeFile(join(projectDir, "dir-ts", "index.ts"), "export default () => {}\n", "utf8");
    await writeFile(join(projectDir, "dir-js", "index.js"), "module.exports = () => {}\n", "utf8");

    const discovered = await discoverForgeExtensions({
      dataDir,
      scopes: ["project-local"],
      cwd
    });

    expect(discovered.map((entry) => entry.displayName)).toEqual(["dir-js", "dir-ts", "single.js", "single.ts"]);
  });

  it("does not shadow extensions by display name across scopes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-discovery-"));
    tempDirs.push(rootDir);

    const dataDir = join(rootDir, "data");
    const cwd = join(rootDir, "repo");
    const paths = [
      join(dataDir, "extensions", "same-name.ts"),
      join(dataDir, "profiles", "alpha", "extensions", "same-name.ts"),
      join(cwd, ".forge", "extensions", "same-name.ts")
    ];

    await Promise.all(paths.map(async (pathValue) => {
      await mkdir(dirname(pathValue), { recursive: true });
      await writeFile(pathValue, "export default () => {}\n", "utf8");
    }));

    const discovered = await discoverForgeExtensions({
      dataDir,
      scopes: ["global", "profile", "project-local"],
      profileId: "alpha",
      cwd
    });

    expect(discovered.filter((entry) => entry.displayName === "same-name.ts")).toHaveLength(3);
    expect(discovered.map((entry) => entry.scope)).toEqual(["global", "profile", "project-local"]);
  });

  it("uses the exact cwd for project-local discovery and does not walk ancestors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-discovery-"));
    tempDirs.push(rootDir);

    const dataDir = join(rootDir, "data");
    const repoRoot = join(rootDir, "repo");
    const nestedCwd = join(repoRoot, "packages", "app");
    const ancestorProjectDir = join(repoRoot, ".forge", "extensions");
    const exactProjectDir = join(nestedCwd, ".forge", "extensions");

    await mkdir(ancestorProjectDir, { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(ancestorProjectDir, "ancestor.ts"), "export default () => {}\n", "utf8");

    await expect(
      discoverForgeExtensions({
        dataDir,
        scopes: ["project-local"],
        cwd: nestedCwd
      })
    ).resolves.toEqual([]);

    await mkdir(exactProjectDir, { recursive: true });
    await writeFile(join(exactProjectDir, "exact.ts"), "export default () => {}\n", "utf8");

    const discovered = await discoverForgeExtensions({
      dataDir,
      scopes: ["project-local"],
      cwd: nestedCwd
    });

    expect(discovered.map((entry) => relative(rootDir, entry.path))).toEqual([
      relative(rootDir, join(exactProjectDir, "exact.ts"))
    ]);
  });
});
