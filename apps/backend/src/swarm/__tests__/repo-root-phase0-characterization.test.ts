import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { discoverForgeExtensions } from "../forge-extension-discovery.js";
import { loadForgeExtensionModules } from "../forge-extension-loader.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repo-root .forge Phase 0 executable characterization", () => {
  it("Forge extension discovery and import use exact cwd .forge/extensions only", async () => {
    const root = await makeTempDir("forge-phase0-");
    const nested = join(root, "nested");
    await mkdir(join(root, ".forge", "extensions"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const rootExtension = join(root, ".forge", "extensions", "root-marker.js");
    await writeFile(
      rootExtension,
      "export const extension = { name: 'root-marker' }; export default function setup() {}\n",
      "utf-8"
    );

    const fromRoot = await discoverForgeExtensions({ dataDir: root, scopes: ["project-local"], cwd: root });
    const fromNested = await discoverForgeExtensions({ dataDir: root, scopes: ["project-local"], cwd: nested });
    const loadResult = await loadForgeExtensionModules(fromRoot);

    expect(fromRoot.map((entry) => entry.path)).toEqual([rootExtension]);
    expect(loadResult.loaded.map((entry) => entry.metadata.name)).toEqual(["root-marker"]);
    expect(loadResult.errors).toEqual([]);
    expect(fromNested).toEqual([]);
  });

  it("Pi DefaultResourceLoader auto-loads exact cwd .pi/extensions only", async () => {
    const root = await makeTempDir("forge-phase0-pi-");
    const nested = join(root, "nested");
    const agentDir = await makeTempDir("forge-agent-");
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const markerPath = join(root, "pi-extension-loaded.txt");
    await writeFile(
      join(root, ".pi", "extensions", "marker.js"),
      `import { writeFileSync } from 'node:fs'; export default function setup() { writeFileSync(${JSON.stringify(
        markerPath
      )}, 'loaded', 'utf-8'); }\n`,
      "utf-8"
    );

    const rootLoader = new DefaultResourceLoader({ cwd: root, agentDir });
    await rootLoader.reload();
    const nestedLoader = new DefaultResourceLoader({ cwd: nested, agentDir });
    await nestedLoader.reload();

    expect(rootLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(
      join(root, ".pi", "extensions", "marker.js")
    );
    expect(rootLoader.getExtensions().errors).toEqual([]);
    expect(nestedLoader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(
      join(root, ".pi", "extensions", "marker.js")
    );
  });

  it("Pi DefaultResourceLoader loads exact cwd .pi/settings.json package extensions", async () => {
    const root = await makeTempDir("forge-phase0-pi-settings-");
    const nested = join(root, "nested");
    const agentDir = await makeTempDir("forge-agent-");
    await mkdir(join(root, ".pi", "local-package"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const extensionPath = join(root, ".pi", "local-package", "package-extension.js");
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ packages: ["./local-package"] }), "utf-8");
    await writeFile(
      join(root, ".pi", "local-package", "package.json"),
      JSON.stringify({ pi: { extensions: ["package-extension.js"] } }),
      "utf-8"
    );
    await writeFile(extensionPath, "export default function setup() {}\n", "utf-8");

    const rootLoader = new DefaultResourceLoader({ cwd: root, agentDir });
    await rootLoader.reload();
    const nestedLoader = new DefaultResourceLoader({ cwd: nested, agentDir });
    await nestedLoader.reload();

    expect(rootLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(extensionPath);
    expect(rootLoader.getExtensions().errors).toEqual([]);
    expect(nestedLoader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(extensionPath);
  });
});
