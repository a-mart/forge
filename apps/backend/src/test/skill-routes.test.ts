import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import { SkillFileService } from "../swarm/skill-file-service.js";
import { SkillMetadataService } from "../swarm/skill-metadata-service.js";
import type { SwarmConfig } from "../swarm/types.js";
import { createSkillRoutes } from "../ws/routes/skill-routes.js";

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
    expect(swarmManager.listSkillMetadata).toHaveBeenCalledWith(undefined);
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

  it("passes profileId through and returns inherited profile inventory rows", async () => {
    const swarmManager = {
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
          {
            skillId: "builtin-skill-1",
            name: "memory",
            directoryName: "memory",
            envCount: 0,
            hasRichConfig: false,
            sourceKind: "builtin",
            rootPath: "/repo/apps/backend/src/swarm/skills/builtins/memory",
            skillFilePath: "/repo/apps/backend/src/swarm/skills/builtins/memory/SKILL.md",
            isInherited: true,
            isEffective: true,
          },
        ];
      }),
    };

    const server = await createSkillRouteTestServer(swarmManager as never);
    const response = await fetch(`${server.baseUrl}/api/settings/skills?profileId=profile-a`);

    expect(response.status).toBe(200);
    expect(swarmManager.listSkillMetadata).toHaveBeenCalledWith("profile-a");
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
        {
          skillId: "builtin-skill-1",
          name: "memory",
          directoryName: "memory",
          envCount: 0,
          hasRichConfig: false,
          sourceKind: "builtin",
          rootPath: "/repo/apps/backend/src/swarm/skills/builtins/memory",
          skillFilePath: "/repo/apps/backend/src/swarm/skills/builtins/memory/SKILL.md",
          isInherited: true,
          isEffective: true,
        },
      ],
    });
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
    sourceKind: "builtin" | "repo" | "machine-local" | "profile";
    profileId?: string;
    rootPath: string;
    skillFilePath: string;
    isInherited: boolean;
    isEffective: boolean;
  }>>;
  listSkillFiles: (skillId: string, relativePath?: string) => Promise<unknown>;
  getSkillFileContent: (skillId: string, relativePath: string) => Promise<unknown>;
}> {
  const skillMetadataService = new SkillMetadataService({ config });
  const skillFileService = new SkillFileService();
  await skillMetadataService.ensureSkillMetadataLoaded();

  return {
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
          hasRichConfig: entry.directoryName.trim().toLowerCase() === "chrome-cdp",
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
  const root = await mkdtemp(join(tmpdir(), "skill-routes-test-"));
  tempRoots.push(root);

  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "sessions");
  const uploadsDir = join(dataDir, "uploads");
  const profilesDir = join(dataDir, "profiles");
  const sharedDir = join(dataDir, "shared");
  const sharedConfigDir = join(sharedDir, "config");
  const sharedCacheDir = join(sharedDir, "cache");
  const sharedStateDir = join(sharedDir, "state");
  const sharedAuthDir = join(sharedConfigDir, "auth");
  const sharedAuthFile = join(sharedAuthDir, "auth.json");
  const sharedSecretsFile = join(sharedConfigDir, "secrets.json");
  const sharedIntegrationsDir = join(sharedConfigDir, "integrations");
  const authDir = join(dataDir, "auth");
  const agentDir = join(dataDir, "agent");
  const managerAgentDir = join(agentDir, "manager");
  const repoArchetypesDir = join(root, ".swarm", "archetypes");
  const memoryDir = join(dataDir, "memory");
  const memoryFile = join(memoryDir, "manager.md");
  const repoMemorySkillFile = join(root, ".swarm", "skills", "memory", "SKILL.md");

  await Promise.all([
    mkdir(swarmDir, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
    mkdir(uploadsDir, { recursive: true }),
    mkdir(profilesDir, { recursive: true }),
    mkdir(sharedAuthDir, { recursive: true }),
    mkdir(sharedIntegrationsDir, { recursive: true }),
    mkdir(sharedCacheDir, { recursive: true }),
    mkdir(sharedStateDir, { recursive: true }),
    mkdir(authDir, { recursive: true }),
    mkdir(memoryDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(managerAgentDir, { recursive: true }),
    mkdir(repoArchetypesDir, { recursive: true }),
  ]);

  return {
    host: "127.0.0.1",
    port: 0,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium",
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, "worktrees")],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, "agents.json"),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager"),
    },
  };
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
