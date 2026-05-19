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
    expect(result.repoRootResources.forgeExtensionsDir).toBe(join(rootRealpath, ".forge", "extensions"));
    expect(result.repoRootResources.piExtensionsDir).toBe(join(rootRealpath, ".forge", "pi", "extensions"));
    expect(result.repoRootResources.piSettingsPath).toBe(join(rootRealpath, ".forge", "pi", "settings.json"));
    expect(result.legacyExecutableSurfaces.map((surface) => surface.kind)).toEqual([
      "exact-cwd-forge-extension",
      "exact-cwd-pi-extension",
      "exact-cwd-pi-settings"
    ]);
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

  it("changes signature for in-place edits to exact-cwd .forge/extensions files", async () => {
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

    expect(after.signature).not.toBe(before.signature);
  });

  it("changes signature for in-place edits to exact-cwd .pi/extensions files", async () => {
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

    expect(after.signature).not.toBe(before.signature);
  });

  it("changes signature for in-place edits to package extension files referenced by .pi/settings.json", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(root, ".pi", "local-package"), { recursive: true });
    const extensionPath = join(root, ".pi", "local-package", "package-extension.js");
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ packages: ["./local-package"] }), "utf-8");
    await writeFile(
      join(root, ".pi", "local-package", "package.json"),
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
