import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import { createTempConfig, type TempConfigHandle } from "../../test-support/temp-config.js";
import { getProfilePiSkillsDir } from "../data-paths.js";
import { SkillBundleService } from "../skills/skill-bundle-service.js";
import { SkillSharingError, SkillSharingService } from "../skills/skill-sharing-service.js";
import { SkillMetadataService } from "../skills/skill-metadata-service.js";
import type { SwarmConfig } from "../types.js";

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

describe("SkillSharingService", () => {
  it("packages and uploads a shareable skill to the configured share worker", async () => {
    const harness = await createHarness({
      fetchFn: async (input, init) => {
        expect(String(input)).toBe("https://share.test/api/v1/skill-shares");
        expect(init?.method).toBe("POST");
        const parsed = JSON.parse(String(init?.body)) as { bundle: SkillBundleManifestV1 };
        expect(parsed.bundle.skill.handle).toBe("uploadable-skill");
        return jsonResponse({
          shareUrl: "https://share.test/s/token",
          importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken",
          expiresAt: "2026-05-20T12:00:00.000Z",
          contentSha256: parsed.bundle.contentSha256,
          warnings: [{ severity: "warning", code: "worker_warning", message: "worker warning" }]
        });
      }
    });
    await createGlobalSkill(harness.config, "uploadable-skill", {
      "SKILL.md": "---\nname: Uploadable\nunsupportedKey: true\n---\n\n# Uploadable\n"
    });
    const skillId = await getGlobalSkillId(harness.metadataService, "uploadable-skill");

    const result = await harness.sharingService.shareSkill(skillId);

    expect(result).toMatchObject({
      shareUrl: "https://share.test/s/token",
      importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken",
      expiresAt: "2026-05-20T12:00:00.000Z"
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "frontmatter_warning" }),
      expect.objectContaining({ code: "worker_warning" })
    ]));
  });

  it("previews only allowlisted share URLs and maps expired links", async () => {
    const harness = await createHarness({
      fetchFn: async (input) => {
        expect(String(input)).toBe("https://share.test/s/expired");
        return jsonResponse({ error: "Share expired." }, { status: 410 });
      }
    });

    await expect(harness.sharingService.previewImportFromUrl({ url: "https://evil.test/s/token" })).rejects.toMatchObject({
      code: "untrusted_share_url",
      statusCode: 403
    });
    await expect(harness.sharingService.previewImportFromUrl({ url: "https://share.test/s/expired" })).rejects.toMatchObject({
      code: "share_expired",
      statusCode: 410
    });
  });

  it("previews and imports a bundle without trusting renderer preview data", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "source-skill", {
      "SKILL.md": "---\nname: Source Skill\ndescription: Import me\n---\n\n# Source\n",
      "scripts/helper.sh": "#!/usr/bin/env bash\necho imported\n"
    });
    const bundle = await packageGlobalSkill(harness, "source-skill");

    const preview = await harness.sharingService.previewImportBundle({ bundle, target: { scope: "profile", profileId: "profile-a" } });
    expect(preview).toMatchObject({
      bundle: {
        skill: { handle: "source-skill", name: "Source Skill" },
        totals: { fileCount: 2 }
      },
      target: { scope: "profile", profileId: "profile-a" },
      conflict: { exists: false }
    });
    expect(preview.bundle.files[0]).not.toHaveProperty("content");
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "script_file" })]));

    const result = await harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" }
    });

    expect(result).toMatchObject({ replaced: false, target: { scope: "profile", profileId: "profile-a" } });
    const importedRoot = join(getProfilePiSkillsDir(harness.config.paths.dataDir, "profile-a"), "source-skill");
    await expect(readFile(join(importedRoot, "SKILL.md"), "utf8")).resolves.toContain("# Source");
    const profileSkills = await harness.metadataService.getProfileSkillMetadata("profile-a");
    expect(profileSkills.some((skill) => skill.directoryName === "source-skill")).toBe(true);
  });

  it("rejects conflicts by default and replaces only with explicit confirmation", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "conflict-skill", {
      "SKILL.md": "---\nname: Conflict Skill\n---\n\n# Original\n"
    });
    const bundle = await packageGlobalSkill(harness, "conflict-skill");

    await createProfileSkill(harness.config, "profile-a", "conflict-skill", {
      "SKILL.md": "---\nname: Conflict Skill\n---\n\n# Existing\n"
    });

    await expect(harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" }
    })).rejects.toMatchObject({ code: "skill_import_conflict", statusCode: 409 });

    await expect(harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace"
    })).rejects.toMatchObject({ code: "skill_import_replace_not_confirmed", statusCode: 409 });

    await harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace",
      confirmReplace: true
    });

    await expect(readFile(join(getProfilePiSkillsDir(harness.config.paths.dataDir, "profile-a"), "conflict-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("# Original");
  });

  it("fetches URL sources again at import time", async () => {
    let fetchCount = 0;
    const harness = await createHarness({
      fetchFn: async () => {
        fetchCount += 1;
        const bundle = fetchCount === 1
          ? await createBundleForSkill(harness.config, harness.metadataService, "url-skill-first")
          : await createBundleForSkill(harness.config, harness.metadataService, "url-skill-second");
        return jsonResponse(bundle);
      }
    });
    await createGlobalSkill(harness.config, "url-skill-first", {
      "SKILL.md": "---\nname: URL First\n---\n\n# First\n"
    });
    await createGlobalSkill(harness.config, "url-skill-second", {
      "SKILL.md": "---\nname: URL Second\n---\n\n# Second\n"
    });

    const target = { scope: "profile" as const, profileId: "profile-a" };
    const preview = await harness.sharingService.previewImportFromUrl({ url: "https://share.test/s/token", target });
    const result = await harness.sharingService.importSkill({ source: { url: "https://share.test/s/token" }, target });

    expect(preview.bundle.skill.handle).toBe("url-skill-first");
    expect(result.bundle.skill.handle).toBe("url-skill-second");
    expect(fetchCount).toBe(2);
  });
});

interface Harness {
  config: SwarmConfig;
  metadataService: SkillMetadataService;
  sharingService: SkillSharingService;
}

async function createHarness(options: { fetchFn?: typeof fetch } = {}): Promise<Harness> {
  const handle = await createTempConfig({ prefix: "skill-sharing-service-test-", port: 0 });
  tempHandles.push(handle);
  const metadataService = new SkillMetadataService({ config: handle.config });
  const sharingService = new SkillSharingService({
    config: handle.config,
    skillMetadataService: metadataService,
    shareBaseUrl: "https://share.test",
    fetchFn: options.fetchFn ?? vi.fn(async () => jsonResponse({ error: "not configured" }, { status: 503 })),
    now: () => new Date("2026-05-13T12:00:00.000Z")
  });
  return { config: handle.config, metadataService, sharingService };
}

async function createGlobalSkill(config: SwarmConfig, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(config.paths.dataDir, "skills", handle), files);
}

async function createProfileSkill(config: SwarmConfig, profileId: string, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(getProfilePiSkillsDir(config.paths.dataDir, profileId), handle), files);
}

async function writeSkillFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

async function getGlobalSkillId(metadataService: SkillMetadataService, handle: string): Promise<string> {
  await metadataService.reloadSkillMetadata();
  const skill = metadataService.getSkillMetadata().find((entry) => entry.directoryName === handle);
  if (!skill) throw new SkillSharingError("missing_test_skill", `Missing test skill ${handle}`, 500);
  return skill.skillId;
}

async function packageGlobalSkill(harness: Harness, handle: string): Promise<SkillBundleManifestV1> {
  return createBundleForSkill(harness.config, harness.metadataService, handle);
}

async function createBundleForSkill(
  config: SwarmConfig,
  metadataService: SkillMetadataService,
  handle: string
): Promise<SkillBundleManifestV1> {
  const bundleService = new SkillBundleService({
    skillMetadataService: metadataService,
    now: () => new Date("2026-05-13T12:00:00.000Z")
  });
  const skillId = await getGlobalSkillId(metadataService, handle);
  return (await bundleService.packageSkill(skillId)).bundle;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}
