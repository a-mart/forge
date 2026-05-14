import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects untrusted share worker response URLs", async () => {
    const mismatchHarness = await createHarness({
      fetchFn: async (input, init) => {
        const parsed = JSON.parse(String(init?.body)) as { bundle: SkillBundleManifestV1 };
        expect(String(input)).toBe("https://share.test/api/v1/skill-shares");
        return jsonResponse({
          shareUrl: "https://share.test/s/token",
          importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Fother-token",
          expiresAt: "2026-05-20T12:00:00.000Z",
          contentSha256: parsed.bundle.contentSha256,
          warnings: []
        });
      }
    });
    await createGlobalSkill(mismatchHarness.config, "mismatch-share", {
      "SKILL.md": "---\nname: Mismatch Share\n---\n\n# Mismatch\n"
    });
    await expect(mismatchHarness.sharingService.shareSkill(await getGlobalSkillId(mismatchHarness.metadataService, "mismatch-share")))
      .rejects.toMatchObject({ code: "invalid_share_response", statusCode: 502 });

    const untrustedHarness = await createHarness({
      fetchFn: async (input, init) => {
        const parsed = JSON.parse(String(init?.body)) as { bundle: SkillBundleManifestV1 };
        expect(String(input)).toBe("https://share.test/api/v1/skill-shares");
        return jsonResponse({
          shareUrl: "https://evil.test/s/token",
          importUrl: "forge://skill-import?url=https%3A%2F%2Fevil.test%2Fs%2Ftoken",
          expiresAt: "2026-05-20T12:00:00.000Z",
          contentSha256: parsed.bundle.contentSha256,
          warnings: []
        });
      }
    });
    await createGlobalSkill(untrustedHarness.config, "untrusted-share", {
      "SKILL.md": "---\nname: Untrusted Share\n---\n\n# Untrusted\n"
    });
    await expect(untrustedHarness.sharingService.shareSkill(await getGlobalSkillId(untrustedHarness.metadataService, "untrusted-share")))
      .rejects.toMatchObject({ code: "invalid_share_response", statusCode: 502 });
  });

  it("allows IPv6 localhost share URLs from env for share, preview, and import", async () => {
    const originalBaseUrl = process.env.FORGE_SKILL_SHARE_BASE_URL;
    process.env.FORGE_SKILL_SHARE_BASE_URL = "http://[::1]:8787";
    try {
      let sharedBundle: SkillBundleManifestV1 | undefined;
      const target = { scope: "profile" as const, profileId: "profile-a" };
      const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(String(input)).toBe("http://[::1]:8787/api/v1/skill-shares");
          const parsed = JSON.parse(String(init.body)) as { bundle: SkillBundleManifestV1 };
          sharedBundle = parsed.bundle;
          return jsonResponse({
            shareUrl: "http://[::1]:8787/s/token",
            importUrl: "forge://skill-import?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8787%2Fs%2Ftoken",
            expiresAt: "2026-05-20T12:00:00.000Z",
            contentSha256: parsed.bundle.contentSha256,
            warnings: []
          });
        }
        expect(String(input)).toBe("http://[::1]:8787/s/token");
        return jsonResponse(sharedBundle);
      });
      const sourceHarness = await createHarness({ shareBaseUrl: null, fetchFn });
      await createGlobalSkill(sourceHarness.config, "ipv6-localhost", {
        "SKILL.md": "---\nname: IPv6 Localhost\n---\n\n# IPv6\n"
      });

      const share = await sourceHarness.sharingService.shareSkill(await getGlobalSkillId(sourceHarness.metadataService, "ipv6-localhost"));
      expect(share).toMatchObject({
        shareUrl: "http://[::1]:8787/s/token",
        importUrl: "forge://skill-import?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8787%2Fs%2Ftoken"
      });

      const targetHarness = await createHarness({ shareBaseUrl: null, fetchFn });
      const preview = await targetHarness.sharingService.previewImportFromUrl({ url: share.shareUrl, target });
      expect(preview.bundle.skill.handle).toBe("ipv6-localhost");

      const result = await targetHarness.sharingService.importSkill({ source: { url: share.shareUrl }, target });
      expect(result).toMatchObject({ target, replaced: false, installedOverride: false });
      await expect(readFile(join(getProfilePiSkillsDir(targetHarness.config.paths.dataDir, "profile-a"), "ipv6-localhost", "SKILL.md"), "utf8"))
        .resolves.toContain("# IPv6");
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.FORGE_SKILL_SHARE_BASE_URL;
      } else {
        process.env.FORGE_SKILL_SHARE_BASE_URL = originalBaseUrl;
      }
    }
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

  it("preserves share worker budget and retry-after errors", async () => {
    const uploadHarness = await createHarness({
      fetchFn: async () => jsonResponse({ error: "Budget exhausted." }, { status: 507 })
    });
    await createGlobalSkill(uploadHarness.config, "budget-upload", {
      "SKILL.md": "---\nname: Budget Upload\n---\n\n# Budget\n"
    });
    await expect(uploadHarness.sharingService.shareSkill(await getGlobalSkillId(uploadHarness.metadataService, "budget-upload")))
      .rejects.toMatchObject({ code: "share_budget_exceeded", statusCode: 507 });

    const retryHarness = await createHarness({
      fetchFn: async () => jsonResponse({ error: "Try later." }, { status: 429, headers: { "Retry-After": "120" } })
    });
    await expect(retryHarness.sharingService.previewImportFromUrl({ url: "https://share.test/s/rate-limited" }))
      .rejects.toMatchObject({ code: "share_rate_limited", statusCode: 429, retryAfter: "120" });

    const downloadBudgetHarness = await createHarness({
      fetchFn: async () => jsonResponse({ error: "Budget exhausted." }, { status: 507 })
    });
    await expect(downloadBudgetHarness.sharingService.previewImportFromUrl({ url: "https://share.test/s/budget" }))
      .rejects.toMatchObject({ code: "share_budget_exceeded", statusCode: 507 });
  });

  it("previews and imports a bundle without trusting renderer preview data", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "source-skill", {
      "SKILL.md": "---\nname: Source Skill\ndescription: Import me\n---\n\n# Source\n",
      "scripts/helper.sh": "#!/usr/bin/env bash\necho imported\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "source-skill");

    const targetHarness = await createHarness();
    const preview = await targetHarness.sharingService.previewImportBundle({ bundle, target: { scope: "profile", profileId: "profile-a" } });
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

    const result = await targetHarness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" }
    });

    expect(result).toMatchObject({ replaced: false, installedOverride: false, target: { scope: "profile", profileId: "profile-a" } });
    const importedRoot = join(getProfilePiSkillsDir(targetHarness.config.paths.dataDir, "profile-a"), "source-skill");
    await expect(readFile(join(importedRoot, "SKILL.md"), "utf8")).resolves.toContain("# Source");
    const profileSkills = await targetHarness.metadataService.getProfileSkillMetadata("profile-a");
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

    const result = await harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace",
      confirmReplace: true
    });
    expect(result).toMatchObject({ replaced: true, installedOverride: false });

    await expect(readFile(join(getProfilePiSkillsDir(harness.config.paths.dataDir, "profile-a"), "conflict-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("# Original");
  });

  it("surfaces effective repo collisions before filesystem-path shadowing", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "repo-collision", {
      "SKILL.md": "---\nname: Repo Collision\n---\n\n# Imported\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "repo-collision");

    const targetHarness = await createHarness();
    await createRepoSkill(targetHarness.config, "repo-collision", {
      "SKILL.md": "---\nname: Repo Collision\n---\n\n# Repo\n"
    });

    const preview = await targetHarness.sharingService.previewImportBundle({ bundle });
    expect(preview.conflict).toMatchObject({
      exists: true,
      existingSourceKind: "repo",
      existingDirectoryName: "repo-collision",
      conflictType: "effective_skill"
    });

    await expect(targetHarness.sharingService.importSkill({ source: { bundle } }))
      .rejects.toMatchObject({ code: "skill_import_conflict", statusCode: 409 });

    const result = await targetHarness.sharingService.importSkill({
      source: { bundle },
      conflictStrategy: "replace",
      confirmReplace: true
    });
    expect(result).toMatchObject({ replaced: false, installedOverride: true });
    await expect(readFile(join(targetHarness.config.paths.dataDir, "skills", "repo-collision", "SKILL.md"), "utf8"))
      .resolves.toContain("# Imported");
  });

  it("surfaces stale target roots before replacing when an effective repo skill also exists", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "compound-collision", {
      "SKILL.md": "---\nname: Compound Collision\n---\n\n# Imported\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "compound-collision");

    const targetHarness = await createHarness();
    await createRepoSkill(targetHarness.config, "compound-collision", {
      "SKILL.md": "---\nname: Compound Collision\n---\n\n# Repo\n"
    });
    const staleRoot = join(targetHarness.config.paths.dataDir, "skills", "compound-collision");
    await mkdir(staleRoot, { recursive: true });
    await writeFile(join(staleRoot, "STALE.txt"), "stale local data\n", "utf8");

    const preview = await targetHarness.sharingService.previewImportBundle({ bundle });
    expect(preview.conflict).toMatchObject({
      exists: true,
      existingSourceKind: "machine-local",
      existingRootPath: staleRoot,
      existingDirectoryName: "compound-collision",
      conflictType: "target_path",
      relatedConflicts: [
        expect.objectContaining({
          sourceKind: "repo",
          directoryName: "compound-collision",
          conflictType: "effective_skill"
        })
      ]
    });

    const result = await targetHarness.sharingService.importSkill({
      source: { bundle },
      conflictStrategy: "replace",
      confirmReplace: true
    });
    expect(result).toMatchObject({ replaced: true, installedOverride: true });
    await expect(readFile(join(staleRoot, "SKILL.md"), "utf8")).resolves.toContain("# Imported");
    await expect(lstat(join(staleRoot, "STALE.txt"))).rejects.toThrow();
  });

  it("blocks imports that would shadow required built-in skills", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "brave-search", {
      "SKILL.md": "---\nname: Brave Search\n---\n\n# Replacement search\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "brave-search");

    const targetHarness = await createHarness();
    const preview = await targetHarness.sharingService.previewImportBundle({
      bundle,
      target: { scope: "profile", profileId: "profile-a" }
    });
    expect(preview.conflict).toMatchObject({
      exists: true,
      existingSourceKind: "builtin",
      existingDirectoryName: "brave-search",
      conflictType: "effective_skill",
      isRequiredBuiltin: true,
      isBlocking: true
    });

    await expect(targetHarness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace",
      confirmReplace: true
    })).rejects.toMatchObject({ code: "skill_import_required_builtin_conflict", statusCode: 409 });
  });

  it("rejects invalid import conflict strategies", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "strategy-skill", {
      "SKILL.md": "---\nname: Strategy Skill\n---\n\n# Strategy\n"
    });
    const bundle = await packageGlobalSkill(harness, "strategy-skill");

    await expect(harness.sharingService.importSkill({
      source: { bundle },
      conflictStrategy: "overwrite" as never
    })).rejects.toMatchObject({ code: "invalid_conflict_strategy", statusCode: 400 });
  });

  it("rejects unknown profile targets at the service boundary", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "unknown-profile-target", {
      "SKILL.md": "---\nname: Unknown Profile Target\n---\n\n# Target\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "unknown-profile-target");
    const targetHarness = await createHarness({ validProfileIds: ["profile-a"] });

    await expect(targetHarness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "missing-profile" }
    })).rejects.toMatchObject({ code: "unknown_profile", statusCode: 404 });
    await expect(lstat(getProfilePiSkillsDir(targetHarness.config.paths.dataDir, "missing-profile"))).rejects.toThrow();
  });

  it("fetches URL sources again at import time", async () => {
    const firstSourceHarness = await createHarness();
    await createGlobalSkill(firstSourceHarness.config, "url-skill-first", {
      "SKILL.md": "---\nname: URL First\n---\n\n# First\n"
    });
    const firstBundle = await packageGlobalSkill(firstSourceHarness, "url-skill-first");

    const secondSourceHarness = await createHarness();
    await createGlobalSkill(secondSourceHarness.config, "url-skill-second", {
      "SKILL.md": "---\nname: URL Second\n---\n\n# Second\n"
    });
    const secondBundle = await packageGlobalSkill(secondSourceHarness, "url-skill-second");

    let fetchCount = 0;
    const targetHarness = await createHarness({
      fetchFn: async () => {
        fetchCount += 1;
        return jsonResponse(fetchCount === 1 ? firstBundle : secondBundle);
      }
    });

    const target = { scope: "profile" as const, profileId: "profile-a" };
    const preview = await targetHarness.sharingService.previewImportFromUrl({ url: "https://share.test/s/token", target });
    const result = await targetHarness.sharingService.importSkill({ source: { url: "https://share.test/s/token" }, target });

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

async function createHarness(options: { fetchFn?: typeof fetch; validProfileIds?: string[]; shareBaseUrl?: string | null } = {}): Promise<Harness> {
  const handle = await createTempConfig({ prefix: "skill-sharing-service-test-", port: 0 });
  tempHandles.push(handle);
  const metadataService = new SkillMetadataService({ config: handle.config });
  const sharingService = new SkillSharingService({
    config: handle.config,
    skillMetadataService: metadataService,
    ...(options.shareBaseUrl === null ? {} : { shareBaseUrl: options.shareBaseUrl ?? "https://share.test" }),
    fetchFn: options.fetchFn ?? vi.fn(async () => jsonResponse({ error: "not configured" }, { status: 503 })),
    now: () => new Date("2026-05-13T12:00:00.000Z"),
    validateProfileTarget: options.validProfileIds
      ? (profileId) => options.validProfileIds?.includes(profileId) ?? false
      : undefined
  });
  return { config: handle.config, metadataService, sharingService };
}

async function createGlobalSkill(config: SwarmConfig, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(config.paths.dataDir, "skills", handle), files);
}

async function createProfileSkill(config: SwarmConfig, profileId: string, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(getProfilePiSkillsDir(config.paths.dataDir, profileId), handle), files);
}

async function createRepoSkill(config: SwarmConfig, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(config.paths.rootDir, ".swarm", "skills", handle), files);
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
