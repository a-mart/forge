import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { SkillFileService } from "../swarm/skill-file-service.js";
import { SkillMetadataService } from "../swarm/skill-metadata-service.js";
import { SkillBundleError } from "../swarm/skills/skill-bundle-service.js";
import { SkillSharingError } from "../swarm/skills/skill-sharing-service.js";
import type { SwarmConfig } from "../swarm/types.js";
import { createSkillRoutes } from "../ws/http/routes/skill-routes.js";
import { createTempConfig } from "../test-support/temp-config.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill routes", () => {
  it("serves the global skills inventory from the dedicated skill route bundle", async () => {
    const swarmManager = {
      listSkillMetadata: vi.fn(async () => [
        {
          skillId: "skill-1",
          name: "memory",
          directoryName: "memory",
          envCount: 0,
          hasRichConfig: false,
          sourceKind: "builtin",
          rootPath: "/repo/apps/backend/src/swarm/skills/builtins/memory",
          skillFilePath: "/repo/apps/backend/src/swarm/skills/builtins/memory/SKILL.md",
          isInherited: false,
          isEffective: true,
        },
      ]),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(swarmManager.listSkillMetadata).toHaveBeenCalledWith(undefined, undefined);
    await expect(response.json()).resolves.toEqual({
      skills: [
        {
          skillId: "skill-1",
          name: "memory",
          directoryName: "memory",
          envCount: 0,
          hasRichConfig: false,
          sourceKind: "builtin",
          rootPath: "/repo/apps/backend/src/swarm/skills/builtins/memory",
          skillFilePath: "/repo/apps/backend/src/swarm/skills/builtins/memory/SKILL.md",
          isInherited: false,
          isEffective: true,
        },
      ],
    });
  });

  it("passes profileId through and returns only profile-scoped inventory rows", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => [{ profileId: "profile-a", displayName: "Profile A" }]),
      listSkillMetadata: vi.fn(async (profileId?: string) => {
        expect(profileId).toBe("profile-a");
        return [
          {
            skillId: "profile-skill-1",
            name: "custom-profile-skill",
            directoryName: "custom-profile-skill",
            description: "Profile skill",
            envCount: 1,
            hasRichConfig: false,
            sourceKind: "profile",
            profileId: "profile-a",
            rootPath: "/data/profiles/profile-a/pi/skills/custom-profile-skill",
            skillFilePath: "/data/profiles/profile-a/pi/skills/custom-profile-skill/SKILL.md",
            isInherited: false,
            isEffective: true,
          },
        ];
      }),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills?profileId=profile-a`);

    expect(response.status).toBe(200);
    expect(swarmManager.listUserProfiles).toHaveBeenCalledTimes(1);
    expect(swarmManager.listSkillMetadata).toHaveBeenCalledWith("profile-a", undefined);
    await expect(response.json()).resolves.toEqual({
      skills: [
        {
          skillId: "profile-skill-1",
          name: "custom-profile-skill",
          directoryName: "custom-profile-skill",
          description: "Profile skill",
          envCount: 1,
          hasRichConfig: false,
          sourceKind: "profile",
          profileId: "profile-a",
          rootPath: "/data/profiles/profile-a/pi/skills/custom-profile-skill",
          skillFilePath: "/data/profiles/profile-a/pi/skills/custom-profile-skill/SKILL.md",
          isInherited: false,
          isEffective: true,
        },
      ],
    });
  });

  it("passes session context through for workspace-aware skill inventory", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => [{ profileId: "profile-a", displayName: "Profile A" }]),
      listSkillMetadata: vi.fn(async () => [
        {
          skillId: "repo-skill-1",
          name: "repo-skill",
          directoryName: "repo-skill",
          envCount: 0,
          hasRichConfig: false,
          sourceKind: "workspace",
          rootPath: "/repo/.forge/skills/repo-skill",
          skillFilePath: "/repo/.forge/skills/repo-skill/SKILL.md",
          isInherited: true,
          isEffective: true,
        },
      ]),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills?profileId=profile-a&sessionAgentId=session-a`);

    expect(response.status).toBe(200);
    expect(swarmManager.listSkillMetadata).toHaveBeenCalledWith("profile-a", "session-a");
    await expect(response.json()).resolves.toMatchObject({
      skills: [{ sourceKind: "workspace", directoryName: "repo-skill" }],
    });
  });

  it("returns 404 for unknown profile-scoped inventory requests", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => [{ profileId: "profile-a", displayName: "Profile A" }]),
      listSkillMetadata: vi.fn(async () => []),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills?profileId=missing-profile`);

    expect(response.status).toBe(404);
    expect(swarmManager.listSkillMetadata).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Unknown profile: missing-profile" });
  });

  it("shares a skill through an explicit action route", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      shareSkill: vi.fn(async (skillId: string) => ({
        shareUrl: "https://share.test/s/token",
        importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken",
        expiresAt: "2026-05-20T12:00:00.000Z",
        contentSha256: "a".repeat(64),
        warnings: [],
        skillId
      })),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/${encodeURIComponent("skill/share/id")}/share`, {
      method: "POST",
      body: JSON.stringify({})
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(swarmManager.shareSkill).toHaveBeenCalledWith("skill/share/id");
    await expect(response.json()).resolves.toMatchObject({
      shareUrl: "https://share.test/s/token",
      importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken",
      warnings: []
    });
  });

  it("maps disappeared skill roots during share to a safe 404", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      shareSkill: vi.fn(async () => {
        throw new SkillBundleError("missing_skill_root", "Skill no longer exists. Refresh the skill list and try again.", {
          path: "/private/data/skills/vanished"
        });
      }),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/${encodeURIComponent("vanished")}/share`, {
      method: "POST",
      body: JSON.stringify({})
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Skill no longer exists. Refresh the skill list and try again.",
      code: "missing_skill_root"
    });
  });

  it("previews import URLs with profile validation and no writes", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => [{ profileId: "profile-a", displayName: "Profile A" }]),
      previewSkillImportFromUrl: vi.fn(async (url: string, target: unknown) => ({
        bundle: { skill: { handle: "shared-skill", name: "Shared Skill" }, files: [], totals: { fileCount: 0, byteCount: 0 } },
        target,
        conflict: { exists: false },
        warnings: [],
        url
      })),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/import/preview-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://share.test/s/token", target: { scope: "profile", profileId: "profile-a" } })
    });

    expect(response.status).toBe(200);
    expect(swarmManager.previewSkillImportFromUrl).toHaveBeenCalledWith("https://share.test/s/token", {
      scope: "profile",
      profileId: "profile-a"
    });
    await expect(response.json()).resolves.toMatchObject({ conflict: { exists: false }, warnings: [] });
  });

  it("returns 404 for import requests targeting an unknown profile", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => [{ profileId: "profile-a", displayName: "Profile A" }]),
      previewSkillImportFromUrl: vi.fn(async () => ({})),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/import/preview-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://share.test/s/token", target: { scope: "profile", profileId: "missing" } })
    });

    expect(response.status).toBe(404);
    expect(swarmManager.previewSkillImportFromUrl).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "unknown_profile" });
  });

  it("maps skill share service errors to route status codes", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      previewSkillImportFromUrl: vi.fn(async () => {
        throw new SkillSharingError("share_expired", "Skill share expired.", 410);
      }),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/import/preview-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://share.test/s/token" })
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "Skill share expired.", code: "share_expired" });
  });

  it("preserves retry-after and budget status from skill share errors", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      previewSkillImportFromUrl: vi.fn(async () => {
        throw new SkillSharingError("share_rate_limited", "Slow down.", 429, undefined, "120");
      }),
      shareSkill: vi.fn(async () => {
        throw new SkillSharingError("share_budget_exceeded", "Budget exhausted.", 507);
      }),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const rateLimited = await fetch(`${server.baseUrl}/api/settings/skills/import/preview-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://share.test/s/token" })
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("120");
    await expect(rateLimited.json()).resolves.toEqual({
      error: "Slow down.",
      code: "share_rate_limited",
      retryAfter: "120"
    });

    const budgetExceeded = await fetch(`${server.baseUrl}/api/settings/skills/skill-id/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(budgetExceeded.status).toBe(507);
    await expect(budgetExceeded.json()).resolves.toEqual({
      error: "Budget exhausted.",
      code: "share_budget_exceeded"
    });
  });

  it("imports skills through the explicit import route", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      importSkill: vi.fn(async (options: unknown) => ({
        bundle: { skill: { handle: "imported", name: "Imported" }, files: [], totals: { fileCount: 0, byteCount: 0 } },
        target: { scope: "global" },
        rootPath: "/data/skills/imported",
        replaced: false,
        installedOverride: false,
        warnings: [],
        options
      })),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: { url: "https://share.test/s/token" }, conflictStrategy: "replace", confirmReplace: true })
    });

    expect(response.status).toBe(200);
    expect(swarmManager.importSkill).toHaveBeenCalledWith({
      source: { url: "https://share.test/s/token" },
      target: undefined,
      conflictStrategy: "replace",
      confirmReplace: true
    });
    await expect(response.json()).resolves.toMatchObject({ rootPath: "/data/skills/imported", replaced: false });
  });

  it("rejects invalid import source and conflict strategy values", async () => {
    const swarmManager = {
      listUserProfiles: vi.fn(() => []),
      importSkill: vi.fn(async () => ({})),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const invalidStrategy = await fetch(`${server.baseUrl}/api/settings/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: { url: "https://share.test/s/token" }, conflictStrategy: "overwrite" })
    });
    expect(invalidStrategy.status).toBe(400);
    await expect(invalidStrategy.json()).resolves.toMatchObject({ code: "invalid_conflict_strategy" });

    const ambiguousSource = await fetch(`${server.baseUrl}/api/settings/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: { url: "https://share.test/s/token", bundle: { format: "forge.skill.bundle.v1" } } })
    });
    expect(ambiguousSource.status).toBe(400);
    await expect(ambiguousSource.json()).resolves.toMatchObject({ code: "invalid_import_source" });
    expect(swarmManager.importSkill).not.toHaveBeenCalled();
  });

  it("returns 404 instead of crashing on malformed encoded skill ids", async () => {
    const swarmManager = {
      listSkillMetadata: vi.fn(async () => []),
      listUserProfiles: vi.fn(() => []),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills/%E0%A4%A/files`);

    expect(response.status).toBe(404);
    expect(swarmManager.listSkillMetadata).not.toHaveBeenCalled();
  });

  it("lists skill files while filtering hidden and noisy entries", async () => {
    const config = await makeTempConfig();
    const skillDir = join(config.paths.dataDir, "skills", "custom-skill");
    await mkdir(join(skillDir, "docs"), { recursive: true });
    await mkdir(join(skillDir, "node_modules", "dep"), { recursive: true });
    await mkdir(join(skillDir, ".git"), { recursive: true });
    await Promise.all([
      writeFile(join(skillDir, "SKILL.md"), ["---", "name: Custom Skill", "---", "", "# Custom Skill"].join("\n"), "utf8"),
      writeFile(join(skillDir, "README.md"), "# Read me\n", "utf8"),
      writeFile(join(skillDir, ".DS_Store"), "noise", "utf8"),
      writeFile(join(skillDir, "docs", "guide.md"), "# Guide\n", "utf8"),
      writeFile(join(skillDir, "node_modules", "dep", "index.js"), "export default 1;\n", "utf8"),
      writeFile(join(skillDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8"),
    ]);

    const swarmManager = await createServiceBackedSkillManager(config);
    const allSkills = await swarmManager.listSkillMetadata();
    const skill = allSkills.find((s) => s.directoryName === "custom-skill");
    expect(skill).toBeDefined();
    const server = await createSkillRouteTestServer(swarmManager as never);

    const response = await fetch(`${server.baseUrl}/api/settings/skills/${encodeURIComponent(skill!.skillId)}/files`);

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      path: string;
      entries: Array<{ name: string; path: string; type: string; absolutePath: string }>;
    };
    expect(payload.path).toBe("");
    expect(payload.entries).toEqual([
      expect.objectContaining({
        name: "docs",
        path: "docs",
        type: "directory",
        absolutePath: join(skillDir, "docs"),
      }),
      expect.objectContaining({
        name: "README.md",
        path: "README.md",
        type: "file",
        absolutePath: join(skillDir, "README.md"),
      }),
      expect.objectContaining({
        name: "SKILL.md",
        path: "SKILL.md",
        type: "file",
        absolutePath: join(skillDir, "SKILL.md"),
      }),
    ]);
    expect(payload.entries.some((entry) => entry.name === ".DS_Store")).toBe(false);
    expect(payload.entries.some((entry) => entry.name === "node_modules")).toBe(false);
    expect(payload.entries.some((entry) => entry.name === ".git")).toBe(false);
  });

  it("rejects file listing traversal outside the selected skill root", async () => {
    const config = await makeTempConfig();
    const skillDir = join(config.paths.dataDir, "skills", "custom-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), ["---", "name: Custom Skill", "---", "", "# Custom Skill"].join("\n"), "utf8");

    const swarmManager = await createServiceBackedSkillManager(config);
    const allSkills = await swarmManager.listSkillMetadata();
    const skill = allSkills.find((s) => s.directoryName === "custom-skill");
    expect(skill).toBeDefined();
    const server = await createSkillRouteTestServer(swarmManager as never);

    const response = await fetch(
      `${server.baseUrl}/api/settings/skills/${encodeURIComponent(skill!.skillId)}/files?path=..%2Foutside`
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Path traversal is not allowed." });
  });

  it("rejects crafted workspace skill IDs for file listing", async () => {
    const config = await makeTempConfig();
    const arbitrarySkillRoot = join(config.paths.dataDir, "arbitrary", "skills", "dangerous");
    await mkdir(arbitrarySkillRoot, { recursive: true });
    await writeFile(join(arbitrarySkillRoot, "SKILL.md"), ["---", "name: Dangerous", "---", "# Dangerous"].join("\n"), "utf8");
    const craftedSkillId = Buffer.from(JSON.stringify({
      sourceKind: "workspace",
      skillRootPath: arbitrarySkillRoot,
    }), "utf8").toString("base64url");

    const swarmManager = await createServiceBackedSkillManager(config);
    const server = await createSkillRouteTestServer(swarmManager as never);

    const response = await fetch(
      `${server.baseUrl}/api/settings/skills/${encodeURIComponent(craftedSkillId)}/files`
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown skill." });
  });

  it("rejects crafted workspace skill IDs for file content", async () => {
    const config = await makeTempConfig();
    const arbitrarySkillRoot = join(config.paths.dataDir, "arbitrary", "skills", "dangerous");
    await mkdir(arbitrarySkillRoot, { recursive: true });
    await writeFile(join(arbitrarySkillRoot, "SKILL.md"), ["---", "name: Dangerous", "---", "# Dangerous"].join("\n"), "utf8");
    const craftedSkillId = Buffer.from(JSON.stringify({
      sourceKind: "workspace",
      skillRootPath: arbitrarySkillRoot,
    }), "utf8").toString("base64url");

    const swarmManager = await createServiceBackedSkillManager(config);
    const server = await createSkillRouteTestServer(swarmManager as never);

    const response = await fetch(
      `${server.baseUrl}/api/settings/skills/${encodeURIComponent(craftedSkillId)}/content?path=SKILL.md`
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown skill." });
  });

  it("reads skill file content with rooted absolute path metadata", async () => {
    const config = await makeTempConfig();
    const skillDir = join(config.paths.dataDir, "skills", "custom-skill");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(join(skillDir, "SKILL.md"), ["---", "name: Custom Skill", "---", "", "# Custom Skill"].join("\n"), "utf8"),
      writeFile(join(skillDir, "scripts", "helper.mjs"), "export function helper() {\n  return 42\n}\n", "utf8"),
    ]);

    const swarmManager = await createServiceBackedSkillManager(config);
    const allSkills = await swarmManager.listSkillMetadata();
    const skill = allSkills.find((s) => s.directoryName === "custom-skill");
    expect(skill).toBeDefined();
    const server = await createSkillRouteTestServer(swarmManager as never);

    const response = await fetch(
      `${server.baseUrl}/api/settings/skills/${encodeURIComponent(skill!.skillId)}/content?path=scripts%2Fhelper.mjs`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "scripts/helper.mjs",
      absolutePath: join(skillDir, "scripts", "helper.mjs"),
      content: "export function helper() {\n  return 42\n}\n",
      binary: false,
      size: 41,
      lines: 4,
    });
  });
});

async function createServiceBackedSkillManager(config: SwarmConfig): Promise<{
  listSkillMetadata: (profileId?: string) => Promise<Array<{
    skillId: string;
    name: string;
    directoryName: string;
    description?: string;
    envCount: number;
    hasRichConfig: boolean;
    sourceKind: "builtin" | "repo" | "machine-local" | "profile" | "workspace";
    profileId?: string;
    rootPath: string;
    skillFilePath: string;
    isInherited: boolean;
    isEffective: boolean;
  }>>;
  listSkillFiles: (skillId: string, relativePath?: string) => Promise<unknown>;
  getSkillFileContent: (skillId: string, relativePath: string) => Promise<unknown>;
  listUserProfiles: () => Array<{ profileId: string; displayName: string }>;
}> {
  const skillMetadataService = new SkillMetadataService({ config });
  const skillFileService = new SkillFileService();
  await skillMetadataService.ensureSkillMetadataLoaded();

  return {
    listUserProfiles() {
      return [];
    },
    async listSkillMetadata(profileId?: string) {
      const metadata = typeof profileId === "string"
        ? await skillMetadataService.getProfileSkillMetadata(profileId)
        : skillMetadataService.getSkillMetadata();

      return metadata
        .map((entry) => ({
          skillId: entry.skillId,
          name: entry.skillName,
          directoryName: entry.directoryName,
          description: entry.description,
          envCount: entry.env.length,
          hasRichConfig: false,
          sourceKind: entry.sourceKind,
          ...(entry.profileId ? { profileId: entry.profileId } : {}),
          rootPath: entry.rootPath,
          skillFilePath: entry.path,
          isInherited: entry.isInherited,
          isEffective: entry.isEffective,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    async listSkillFiles(skillId: string, relativePath = "") {
      const skill = await skillMetadataService.resolveSkillById(skillId);
      if (!skill) {
        throw new Error("Unknown skill.");
      }

      return skillFileService.listDirectory(skill, relativePath);
    },
    async getSkillFileContent(skillId: string, relativePath: string) {
      const skill = await skillMetadataService.resolveSkillById(skillId);
      if (!skill) {
        throw new Error("Unknown skill.");
      }

      return skillFileService.getFileContent(skill, relativePath);
    },
  };
}

async function makeTempConfig(): Promise<SwarmConfig> {
  const handle = await createTempConfig({ prefix: "skill-routes-test-", port: 0 });
  tempRoots.push(handle.tempRootDir);
  return handle.config;
}

async function createSkillRouteTestServer(swarmManager: Parameters<typeof createSkillRoutes>[0]["swarmManager"]): Promise<TestServer> {
  const routes = createSkillRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };

  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createSkillRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  await route.handle(request, response, requestUrl);
}
