import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectResourceSettingsStore } from "../project-resource-settings.js";
import { createWorkspaceKey, ProjectWorkspaceResolver } from "../project-workspace-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ProjectWorkspaceResolver", () => {
  it("resolves repository resources from the nearest Git root for nested cwd", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const nested = join(root, "packages", "app");
    await mkdir(join(nested), { recursive: true });
    await mkdir(join(root, ".forge"), { recursive: true });

    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });
    const rootRealpath = await realpath(root);

    expect(result.detectedGitRoot).toBe(rootRealpath);
    expect(result.defaultForgeDir).toBe(join(rootRealpath, ".forge"));
    expect(result.effectiveForgeDirRealpath).toBe(join(rootRealpath, ".forge"));
    expect(result.source).toBe("git-root");
    expect(result.repoRootResources.skillsDir).toBe(join(rootRealpath, ".forge", "skills"));
    expect(result.repoRootResources.projectAgentsDir).toBe(join(rootRealpath, ".forge", "project-agents"));
    expect(result.repoRootResources.forgeExtensionsDir).toBe(join(rootRealpath, ".forge", "extensions"));
    expect(result.repoRootResources.piExtensionsDir).toBe(join(rootRealpath, ".forge", "pi", "extensions"));
    expect(result.repoRootResources.piSettingsPath).toBe(join(rootRealpath, ".forge", "pi", "settings.json"));
    expect(result.legacyExecutableSurfaces.map((surface) => surface.kind)).toEqual([
      "exact-cwd-forge-extension",
      "exact-cwd-pi-extension",
      "exact-cwd-pi-settings"
    ]);
  });

  it("resolves passive repository resources without executable signature work", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, ".forge", "extensions"), { recursive: true });
    await writeFile(join(root, ".forge", "extensions", "extension.ts"), "throw new Error('do not read');");

    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const result = await resolver.resolvePassive({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });
    const rootRealpath = await realpath(root);

    expect(result.effectiveForgeDirRealpath).toBe(join(rootRealpath, ".forge"));
    expect(result.repoRootResources.referenceDir).toBe(join(rootRealpath, ".forge", "reference"));
    expect("signature" in result).toBe(false);
    expect("legacyExecutableSurfaces" in result).toBe(false);
  });

  it("uses the nearest nested Git root", async () => {
    const outer = await makeTempDir("forge-outer-");
    execFileSync("git", ["init"], { cwd: outer, stdio: "ignore" });
    const inner = join(outer, "vendor", "inner");
    await mkdir(inner, { recursive: true });
    execFileSync("git", ["init"], { cwd: inner, stdio: "ignore" });
    const nested = join(inner, "src");
    await mkdir(join(nested), { recursive: true });
    await mkdir(join(inner, ".forge"), { recursive: true });

    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });
    const innerRealpath = await realpath(inner);

    expect(result.detectedGitRoot).toBe(innerRealpath);
    expect(result.effectiveForgeDirRealpath).toBe(join(innerRealpath, ".forge"));
  });

  it("does not ancestor-walk for .forge outside a Git workspace", async () => {
    const root = await makeTempDir("forge-nongit-");
    const nested = join(root, "a", "b");
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(nested, { recursive: true });

    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    expect(result.detectedGitRoot).toBeUndefined();
    expect(result.defaultForgeDir).toBeUndefined();
    expect(result.effectiveForgeDirRealpath).toBeUndefined();
    expect(result.source).toBe("none");
    expect(result.repoRootResources).toEqual({});
  });

  it("applies valid .forge overrides only within the matching workspace key", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const override = join(await makeTempDir("forge-override-parent-"), ".forge");
    await mkdir(override, { recursive: true });
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir, () => "2026-05-19T00:00:00.000Z");
    const rootRealpath = await realpath(root);
    const overrideRealpath = await realpath(override);
    await store.setOverride(createWorkspaceKey("profile-a", rootRealpath), override);

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const matching = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });
    const otherProfile = await resolver.resolve({ profileId: "profile-b", sessionAgentId: "session-b", cwd: root });

    expect(matching.source).toBe("override");
    expect(matching.effectiveForgeDirRealpath).toBe(overrideRealpath);
    expect(otherProfile.source).toBe("git-root");
    expect(otherProfile.effectiveForgeDirRealpath).toBeUndefined();
  });

  it("rejects override paths that are not named .forge", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const badOverride = join(await makeTempDir("forge-bad-override-"), "not-forge");
    await mkdir(badOverride, { recursive: true });
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir);
    const rootRealpath = await realpath(root);
    await store.setOverride(createWorkspaceKey("profile-a", rootRealpath), badOverride);

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(result.override).toEqual({
      path: badOverride,
      valid: false,
      error: "Override directory must be named .forge"
    });
    expect(result.source).toBe("git-root");
  });

  it("derives trust from the effective .forge realpath", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge"), { recursive: true });
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir, () => "2026-05-19T00:00:00.000Z");
    const trustKey = await realpath(join(root, ".forge"));
    await store.setTrust(trustKey, "trust");

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(result.trust).toEqual({ state: "trusted", key: trustKey });
    expect(result.legacyExecutableSurfaces.every((surface) => surface.coveredByTrustKey === undefined)).toBe(true);
  });

  it("does not cover nested exact-cwd .forge/.pi surfaces with repo-root trust", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const nested = join(root, "nested");
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(nested, ".forge", "extensions"), { recursive: true });
    await mkdir(join(nested, ".pi", "extensions"), { recursive: true });
    await writeFile(join(nested, ".pi", "settings.json"), JSON.stringify({ packages: [] }), "utf-8");
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir);
    await store.setTrust(await realpath(join(root, ".forge")), "trust");

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    expect(result.trust.state).toBe("trusted");
    expect(result.legacyExecutableSurfaces.every((surface) => surface.coveredByTrustKey === undefined)).toBe(true);
    expect(result.legacyExecutableSurfaces.every((surface) => surface.activeToday === false)).toBe(true);
  });

  it("does not cover root exact-cwd .pi surfaces with repo-root .forge trust", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ packages: [] }), "utf-8");
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir);
    await store.setTrust(await realpath(join(root, ".forge")), "trust");

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(result.trust.state).toBe("trusted");
    expect(result.legacyExecutableSurfaces.every((surface) => surface.coveredByTrustKey === undefined)).toBe(true);
    expect(result.legacyExecutableSurfaces.find((surface) => surface.kind === "exact-cwd-pi-extension")?.activeToday).toBe(false);
    expect(result.legacyExecutableSurfaces.find((surface) => surface.kind === "exact-cwd-pi-settings")?.activeToday).toBe(false);
  });

  it("accepts a .forge override symlink to a directory", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const target = join(await makeTempDir("forge-real-override-"), "target");
    await mkdir(target, { recursive: true });
    const link = join(await makeTempDir("forge-link-parent-"), ".forge");
    await symlink(target, link, "dir");
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir);
    await store.setOverride(createWorkspaceKey("profile-a", await realpath(root)), link);

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(result.override).toEqual({ path: await realpath(target), valid: true });
    expect(result.effectiveForgeDirRealpath).toBe(await realpath(target));
  });

  it("changes signature when executable resource metadata changes", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "extensions"), { recursive: true });
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(join(root, ".forge", "extensions", "marker.js"), "export default function () {}\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("changes signature for in-place edits to existing extension files", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "extensions"), { recursive: true });
    const extensionPath = join(root, ".forge", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("changes signature for in-place edits to repo-root .forge/pi/extensions files", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi", "extensions"), { recursive: true });
    const extensionPath = join(root, ".forge", "pi", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("does not change signature for inactive exact-cwd .forge/extensions files", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const nested = join(root, "nested");
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(nested, ".forge", "extensions"), { recursive: true });
    const extensionPath = join(nested, ".forge", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    expect(after.signature).toBe(before.signature);
  });

  it("does not change signature for inactive exact-cwd .pi/extensions files", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    const extensionPath = join(root, ".pi", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).toBe(before.signature);
  });

  it("does not invalidate manage-later signatures for inactive exact-cwd executable changes", async () => {
    const root = await makeTempDir("forge-workspace-");
    const nested = join(root, "nested");
    const dataDir = await makeTempDir("forge-data-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(nested, ".pi", "extensions"), { recursive: true });
    const extensionPath = join(nested, ".pi", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: nested });

    expect(after.legacyExecutableSurfaces.find((surface) => surface.kind === "exact-cwd-pi-extension")?.activeToday).toBe(false);
    expect(after.signature).toBe(before.signature);
  });

  it("invalidates a dismissed executable prompt when executable signature changes", async () => {
    const root = await makeTempDir("forge-workspace-");
    const dataDir = await makeTempDir("forge-data-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "extensions"), { recursive: true });
    const extensionPath = join(root, ".forge", "extensions", "marker.js");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const store = new ProjectResourceSettingsStore(dataDir);
    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });
    expect(before.trust.key).toBeTruthy();
    await store.dismissExecutablePrompt(before.trust.key!, before.signature);

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });
    const dismissed = await store.getDismissedExecutablePrompt(before.trust.key!);

    expect(after.signature).not.toBe(before.signature);
    expect(dismissed?.signature).toBe(before.signature);
    expect(dismissed?.signature).not.toBe(after.signature);
  });

  it("fingerprints package manifest directory extension entries including child package manifests", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi", "manifest-dir", "extensions", "nestedpkg", "lib"), { recursive: true });
    const extensionPath = join(root, ".forge", "pi", "manifest-dir", "extensions", "nestedpkg", "lib", "ext.ts");
    await writeFile(join(root, ".forge", "pi", "settings.json"), JSON.stringify({ packages: ["./manifest-dir"] }), "utf-8");
    await writeFile(join(root, ".forge", "pi", "manifest-dir", "package.json"), JSON.stringify({ pi: { extensions: ["extensions"] } }), "utf-8");
    await writeFile(join(root, ".forge", "pi", "manifest-dir", "extensions", "nestedpkg", "package.json"), JSON.stringify({ pi: { extensions: ["lib/ext.ts"] } }), "utf-8");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("fingerprints package manifest glob extension entries that match child package directories", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi", "manifest-glob", "extensions", "globpkg", "lib"), { recursive: true });
    const extensionPath = join(root, ".forge", "pi", "manifest-glob", "extensions", "globpkg", "lib", "glob-ext.ts");
    await writeFile(join(root, ".forge", "pi", "settings.json"), JSON.stringify({ packages: ["./manifest-glob"] }), "utf-8");
    await writeFile(join(root, ".forge", "pi", "manifest-glob", "package.json"), JSON.stringify({ pi: { extensions: ["extensions/*"] } }), "utf-8");
    await writeFile(join(root, ".forge", "pi", "manifest-glob", "extensions", "globpkg", "package.json"), JSON.stringify({ pi: { extensions: ["lib/glob-ext.ts"] } }), "utf-8");
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("only fingerprints package extensions included by object basename filters", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi", "filtered", "extensions"), { recursive: true });
    const includedPath = join(root, ".forge", "pi", "filtered", "extensions", "included.ts");
    const legacyPath = join(root, ".forge", "pi", "filtered", "extensions", "legacy.ts");
    await writeFile(
      join(root, ".forge", "pi", "settings.json"),
      JSON.stringify({ packages: [{ source: "./filtered", extensions: ["*.ts", "!legacy.ts"] }] }),
      "utf-8"
    );
    await writeFile(includedPath, "export default function () { return 1; }\n", "utf-8");
    await writeFile(legacyPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(legacyPath, "export default function () { return 2; }\n", "utf-8");
    const afterExcludedEdit = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });
    await writeFile(includedPath, "export default function () { return 2; }\n", "utf-8");
    const afterIncludedEdit = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(afterExcludedEdit.signature).toBe(before.signature);
    expect(afterIncludedEdit.signature).not.toBe(before.signature);
  });

  it("fingerprints local file package sources even when object filters are empty", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi"), { recursive: true });
    const extensionPath = join(root, ".forge", "pi", "single.ts");
    await writeFile(
      join(root, ".forge", "pi", "settings.json"),
      JSON.stringify({ packages: [{ source: "./single.ts", extensions: [] }] }),
      "utf-8"
    );
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });

  it("changes signature for in-place edits to package extension files referenced by repo-root .forge/pi/settings.json", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge", "pi", "local-package"), { recursive: true });
    const extensionPath = join(root, ".forge", "pi", "local-package", "package-extension.js");
    await writeFile(join(root, ".forge", "pi", "settings.json"), JSON.stringify({ packages: ["./local-package"] }), "utf-8");
    await writeFile(
      join(root, ".forge", "pi", "local-package", "package.json"),
      JSON.stringify({ pi: { extensions: ["package-extension.js"] } }),
      "utf-8"
    );
    await writeFile(extensionPath, "export default function () { return 1; }\n", "utf-8");
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const before = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    await writeFile(extensionPath, "export default function () { return 2; }\n", "utf-8");
    const after = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(after.signature).not.toBe(before.signature);
  });
});
