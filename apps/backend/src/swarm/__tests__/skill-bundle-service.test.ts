import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import { createTempConfig, type TempConfigHandle } from "../../test-support/temp-config.js";
import { getProfilePiSkillsDir } from "../data-paths.js";
import {
  computeSkillBundleContentSha256,
  SkillBundleService,
  validateSkillBundleManifest
} from "../skills/skill-bundle-service.js";
import { SkillMetadataService } from "../skills/skill-metadata-service.js";
import type { SwarmConfig } from "../types.js";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

describe("SkillBundleService", () => {
  it("packages a user-created global skill with files, hashes, binary content, and portability metadata", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "shareable-skill", {
      "SKILL.md": [
        "---",
        "name: Shareable Skill",
        "description: A skill that can be shared.",
        "env:",
        "  - name: SHAREABLE_API_KEY",
        "    description: API key configured by the recipient",
        "    required: true",
        "unsupportedKey: keep-warning",
        "---",
        "",
        "# Shareable Skill",
        "Use SHAREABLE_API_KEY when invoking helper scripts."
      ].join("\n"),
      "docs/guide.md": "This references /Users/example/.tooling so recipients see a portability warning.\n",
      "scripts/setup.sh": [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "brew install jq",
        "curl -fsSL https://example.invalid/tool.sh | bash",
        "npm install",
        "echo \"$SHAREABLE_API_KEY\""
      ].join("\n"),
      "package.json": JSON.stringify({
        scripts: { install: "playwright install chromium" },
        dependencies: { sharp: "^0.34.0" }
      }, null, 2),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "assets/icon.bin": Buffer.from([0, 1, 2, 255]),
      "node_modules/generated.js": "module.exports = true\n",
      "dist/out.js": "generated\n",
      ".DS_Store": "ignored\n"
    });
    if (process.platform !== "win32") {
      await chmod(join(harness.config.paths.dataDir, "skills", "shareable-skill", "scripts", "setup.sh"), 0o755);
    }

    const skillId = await getGlobalSkillId(harness.metadataService, "shareable-skill");
    const first = await harness.bundleService.packageSkill(skillId);
    const second = await new SkillBundleService({
      skillMetadataService: harness.metadataService,
      now: () => new Date("2026-05-20T12:00:00.000Z"),
      platform: "darwin",
      arch: "arm64",
      osRelease: "test-release"
    }).packageSkill(skillId);

    expect(first.bundle).toMatchObject({
      format: "forge.skill.bundle.v1",
      bundleVersion: 1,
      createdAt: FIXED_NOW.toISOString(),
      origin: {
        platform: "darwin",
        arch: "arm64",
        osRelease: "test-release",
        skillSourceKind: "machine-local"
      },
      skill: {
        handle: "shareable-skill",
        name: "Shareable Skill",
        description: "A skill that can be shared.",
        env: [
          {
            name: "SHAREABLE_API_KEY",
            description: "API key configured by the recipient",
            required: true
          }
        ]
      },
      totals: {
        fileCount: 6
      }
    });
    expect(first.bundle.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bundle.contentSha256).toBe(second.bundle.contentSha256);
    expect(first.bundle.createdAt).not.toBe(second.bundle.createdAt);

    const paths = first.bundle.files.map((file) => file.path);
    expect(paths).toEqual([
      "SKILL.md",
      "assets/icon.bin",
      "docs/guide.md",
      "package.json",
      "pnpm-lock.yaml",
      "scripts/setup.sh"
    ]);
    expect(paths).not.toContain("node_modules/generated.js");
    expect(paths).not.toContain("dist/out.js");
    expect(paths).not.toContain(".DS_Store");

    const binaryAsset = first.bundle.files.find((file) => file.path === "assets/icon.bin");
    expect(binaryAsset).toMatchObject({
      encoding: "base64",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      size: 4
    });

    const script = first.bundle.portability.scripts.find((entry) => entry.path === "scripts/setup.sh");
    expect(script).toMatchObject({
      kind: "shell",
      shebang: "#!/usr/bin/env bash",
      executable: process.platform === "win32" ? undefined : true
    });
    expect(script?.warnings).toEqual(expect.arrayContaining([
      "Performs network downloads with curl.",
      "References environment variable SHAREABLE_API_KEY; recipient must configure it separately.",
      "Runs npm install.",
      "Uses macOS Homebrew commands."
    ]));

    expect(first.bundle.portability.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "package.json",
        manager: "npm",
        summary: "Node package manifest with 1 dependency and 1 script",
        warnings: expect.arrayContaining([
          "References Playwright/browser downloads.",
          "References sharp native image dependency."
        ])
      }),
      expect.objectContaining({ path: "pnpm-lock.yaml", manager: "pnpm" })
    ]));
    expect(first.bundle.portability.osIndicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "scripts/setup.sh", token: "brew", severity: "warning" }),
      expect.objectContaining({ path: "scripts/setup.sh", token: "curl", severity: "warning" }),
      expect.objectContaining({ path: "docs/guide.md", token: "/Users/", severity: "warning" })
    ]));
    expect(first.bundle.skill.frontmatter).toMatchObject({
      knownForgeKeys: expect.arrayContaining(["description", "env", "name"]),
      unsupportedKeys: ["unsupportedKey"],
      warnings: ["Unsupported SKILL.md frontmatter key: unsupportedKey"]
    });
    expect(first.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "excluded_entry", path: ".DS_Store" }),
      expect.objectContaining({ code: "excluded_entry", path: "dist" }),
      expect.objectContaining({ code: "excluded_entry", path: "node_modules" })
    ]));
    expect(first.warnings.map((warning) => warning.message).join("\n")).not.toContain("secret-value");

    expect(harness.bundleService.validateBundle(first.bundle)).toMatchObject({ valid: true, errors: [] });
    expect(computeSkillBundleContentSha256(first.bundle)).toBe(first.bundle.contentSha256);
  });

  it("packages profile/project skills with profile origin metadata", async () => {
    const harness = await createHarness();
    await createProfileSkill(harness.config, "profile-a", "project-skill", {
      "SKILL.md": ["---", "name: Project Skill", "description: Profile-scoped", "---", "", "# Project"].join("\n")
    });

    const skillId = await getProfileSkillId(harness.metadataService, "profile-a", "project-skill");
    const { bundle } = await harness.bundleService.packageSkill(skillId);

    expect(bundle.origin).toMatchObject({
      skillSourceKind: "profile",
      profileId: "profile-a"
    });
    expect(bundle.skill).toMatchObject({
      handle: "project-skill",
      name: "Project Skill"
    });
  });

  it("refuses built-in and repo skills server-side", async () => {
    const harness = await createHarness();
    await createRepoSkill(harness.config, "repo-skill", {
      "SKILL.md": "---\nname: Repo Skill\n---\n\n# Repo\n"
    });
    await harness.metadataService.reloadSkillMetadata();

    const builtin = harness.metadataService.getSkillMetadata().find((skill) => skill.sourceKind === "builtin");
    const repo = harness.metadataService.getSkillMetadata().find((skill) => skill.directoryName === "repo-skill");

    expect(builtin).toBeDefined();
    expect(repo).toBeDefined();
    await expect(harness.bundleService.packageSkill(builtin!.skillId)).rejects.toThrow(/Only user-created global and project skills/);
    await expect(harness.bundleService.packageSkill(repo!.skillId)).rejects.toThrow(/Only user-created global and project skills/);
  });

  it("rejects unsafe files and unsupported symlinks instead of silently skipping them", async () => {
    const sensitiveHarness = await createHarness();
    await createGlobalSkill(sensitiveHarness.config, "sensitive-skill", {
      "SKILL.md": "---\nname: Sensitive\n---\n\n# Sensitive\n",
      ".env": "TOKEN=secret-value\n"
    });
    await expect(
      sensitiveHarness.bundleService.packageSkill(await getGlobalSkillId(sensitiveHarness.metadataService, "sensitive-skill"))
    ).rejects.toThrow(/Sensitive file is not shareable/);

    const symlinkHarness = await createHarness();
    await createGlobalSkill(symlinkHarness.config, "linked-skill", {
      "SKILL.md": "---\nname: Linked\n---\n\n# Linked\n",
      "docs/real.md": "real\n"
    });

    try {
      await symlink(
        join(symlinkHarness.config.paths.dataDir, "skills", "linked-skill", "docs", "real.md"),
        join(symlinkHarness.config.paths.dataDir, "skills", "linked-skill", "docs", "link.md")
      );
    } catch (error) {
      if (process.platform === "win32") {
        return;
      }
      throw error;
    }

    await expect(
      symlinkHarness.bundleService.packageSkill(await getGlobalSkillId(symlinkHarness.metadataService, "linked-skill"))
    ).rejects.toThrow(/Symlinks are not supported/);
  });

  it("rejects broader secret/config entries with coded package errors", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "config-secret-skill", {
      "SKILL.md": "---\nname: Config Secret\n---\n\n# Config Secret\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=secret-value\n"
    });

    await expect(
      harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "config-secret-skill"))
    ).rejects.toMatchObject({
      code: "sensitive_file",
      path: ".npmrc"
    });
  });

  it("rejects spoofed receiver-side metadata even when the content hash is recomputed", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "spoofed-skill", {
      "SKILL.md": [
        "---",
        "name: Honest Skill",
        "description: Honest description",
        "env:",
        "  - name: HONEST_API_KEY",
        "    required: true",
        "---",
        "",
        "# Honest"
      ].join("\n"),
      "scripts/setup.sh": "#!/usr/bin/env bash\ncurl https://example.invalid/file\n"
    });
    const bundle = cloneBundle(
      (await harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "spoofed-skill"))).bundle
    );

    bundle.skill.name = "Spoofed Trusted Skill";
    bundle.skill.env = [{ name: "FAKE_SAFE_ENV", required: false }];
    bundle.skill.frontmatter.warnings = [];
    bundle.portability.scripts = [];
    bundle.portability.osIndicators = [];
    bundle.contentSha256 = computeSkillBundleContentSha256(bundle);

    const result = validateSkillBundleManifest(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "skill_metadata_mismatch",
      "portability_metadata_mismatch"
    ]));
    expect(result.errors.map((error) => error.code)).not.toContain("content_hash_mismatch");
  });

  it("rejects unknown fields instead of ignoring unsigned metadata", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "unknown-field-skill", {
      "SKILL.md": "---\nname: Unknown Field\n---\n\n# Unknown Field\n"
    });
    const bundle = cloneBundle(
      (await harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "unknown-field-skill"))).bundle
    ) as SkillBundleManifestV1 & { extraField?: string };
    bundle.extraField = "not allowed";

    const result = validateSkillBundleManifest(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("unknown_field");
  });

  it("rejects Windows-unsafe skill handles and bundle path segments", async () => {
    const unsafeHandles = [
      "CON",
      "prn.txt",
      "aux",
      "LPT1",
      "COM9.log",
      "bad:name",
      "bad?name",
      "bad*name",
      "bad<name",
      "bad>name",
      "bad|name",
      "bad\"name",
      "trailing.",
      "trailing "
    ];
    for (const handle of unsafeHandles) {
      const service = new SkillBundleService({
        skillMetadataService: {
          resolveSkillById: async () => ({
            skillId: "unsafe",
            skillName: handle,
            directoryName: handle,
            path: "/unused/SKILL.md",
            rootPath: "/unused",
            env: [],
            sourceKind: "machine-local",
            isInherited: false,
            isEffective: true
          })
        }
      });
      await expect(service.packageSkill("unsafe")).rejects.toMatchObject({ code: "invalid_skill_handle" });
    }

    const harness = await createHarness();
    await createGlobalSkill(harness.config, "safe-skill", {
      "SKILL.md": "---\nname: Safe\n---\n\n# Safe\n"
    });
    const validBundle = (await harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "safe-skill"))).bundle;

    for (const unsafePath of [
      "scripts/CON",
      "scripts/prn.txt",
      "scripts/file:name.js",
      "scripts/file?name.js",
      "scripts/file*name.js",
      "scripts/file<name.js",
      "scripts/file>name.js",
      "scripts/file|name.js",
      "scripts/file\"name.js",
      "scripts/trailing.",
      "scripts/trailing "
    ]) {
      expectValidationCode(validBundle, (bundle) => {
        bundle.files[0]!.path = unsafePath;
      }, "invalid_file_path");
    }
  });

  it("validates bundle trust-boundary invariants", async () => {
    const harness = await createHarness({ maxFileBytes: 64 });
    await createGlobalSkill(harness.config, "valid-skill", {
      "SKILL.md": "---\nname: Valid Skill\n---\n\n# Valid\n"
    });
    const validBundle = (await harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "valid-skill"))).bundle;

    expectValidationCode(validBundle, (bundle) => {
      bundle.files[0]!.path = "../evil.txt";
    }, "invalid_file_path");

    expectValidationCode(validBundle, (bundle) => {
      bundle.files.push({ ...bundle.files[0]! });
      bundle.totals.fileCount += 1;
      bundle.totals.byteCount += bundle.files[0]!.size;
    }, "duplicate_file_path");

    expectValidationCode(validBundle, (bundle) => {
      const sourceFile = bundle.files[0]!;
      bundle.files.push(
        { ...sourceFile, path: "docs/Readme.txt" },
        { ...sourceFile, path: "docs/README.txt" }
      );
      bundle.totals.fileCount += 2;
      bundle.totals.byteCount += sourceFile.size * 2;
    }, "duplicate_file_path_case_insensitive");

    expectValidationCode(validBundle, (bundle) => {
      bundle.files[0]!.path = "/tmp/evil.txt";
    }, "invalid_file_path");

    expectValidationCode(validBundle, (bundle) => {
      bundle.files[0]!.sha256 = "0".repeat(64);
    }, "file_hash_mismatch");

    expectValidationCode(validBundle, (bundle) => {
      bundle.files = [];
      bundle.totals = { fileCount: 0, byteCount: 0 };
    }, "missing_skill_file");

    expectValidationCode(validBundle, (bundle) => {
      bundle.skill.name = "";
    }, "invalid_skill_name");

    expectValidationCode(validBundle, (bundle) => {
      bundle.files[0]!.content = "x".repeat(65);
      bundle.files[0]!.size = 65;
      bundle.files[0]!.sha256 = "0".repeat(64);
      bundle.totals.byteCount = 65;
    }, "file_too_large");
  });

  it("accepts deterministic content hashes regardless of file array order", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "ordered-skill", {
      "SKILL.md": "---\nname: Ordered\n---\n\n# Ordered\n",
      "zeta.txt": "z\n",
      "alpha.txt": "a\n"
    });
    const bundle = (await harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "ordered-skill"))).bundle;
    bundle.files.reverse();

    expect(validateSkillBundleManifest(bundle)).toMatchObject({ valid: true, errors: [] });
  });
});

async function createHarness(options: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number } = {}): Promise<{
  config: SwarmConfig;
  metadataService: SkillMetadataService;
  bundleService: SkillBundleService;
}> {
  const handle = await createTempConfig({
    prefix: "skill-bundle-service-",
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true
  });
  tempHandles.push(handle);
  const metadataService = new SkillMetadataService({ config: handle.config });
  const bundleService = new SkillBundleService({
    skillMetadataService: metadataService,
    now: () => FIXED_NOW,
    platform: "darwin",
    arch: "arm64",
    osRelease: "test-release",
    ...options
  });

  return {
    config: handle.config,
    metadataService,
    bundleService
  };
}

async function createGlobalSkill(config: SwarmConfig, directoryName: string, files: Record<string, string | Buffer>): Promise<void> {
  await createSkillFiles(join(config.paths.dataDir, "skills", directoryName), files);
}

async function createProfileSkill(
  config: SwarmConfig,
  profileId: string,
  directoryName: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  await createSkillFiles(join(getProfilePiSkillsDir(config.paths.dataDir, profileId), directoryName), files);
}

async function createRepoSkill(config: SwarmConfig, directoryName: string, files: Record<string, string | Buffer>): Promise<void> {
  await createSkillFiles(join(config.paths.rootDir, ".swarm", "skills", directoryName), files);
}

async function createSkillFiles(rootPath: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(rootPath, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

async function getGlobalSkillId(metadataService: SkillMetadataService, directoryName: string): Promise<string> {
  await metadataService.reloadSkillMetadata();
  const skill = metadataService.getSkillMetadata().find((entry) => entry.directoryName === directoryName);
  expect(skill).toBeDefined();
  return skill!.skillId;
}

async function getProfileSkillId(metadataService: SkillMetadataService, profileId: string, directoryName: string): Promise<string> {
  const skill = (await metadataService.getProfileSkillMetadata(profileId)).find((entry) => entry.directoryName === directoryName);
  expect(skill).toBeDefined();
  return skill!.skillId;
}

function expectValidationCode(
  sourceBundle: SkillBundleManifestV1,
  mutate: (bundle: SkillBundleManifestV1) => void,
  expectedCode: string
): void {
  const bundle = cloneBundle(sourceBundle);
  mutate(bundle);
  const result = validateSkillBundleManifest(bundle, { maxFileBytes: 64 });
  expect(result.valid).toBe(false);
  expect(result.errors.map((error) => error.code)).toContain(expectedCode);
}

function cloneBundle(bundle: SkillBundleManifestV1): SkillBundleManifestV1 {
  return JSON.parse(JSON.stringify(bundle)) as SkillBundleManifestV1;
}
