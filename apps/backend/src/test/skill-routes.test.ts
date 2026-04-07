import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSkillRoutes } from "../ws/routes/skill-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
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
});

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
