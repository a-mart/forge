import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectResourceMutationResponse, ProjectResourcesSnapshotResponse } from "@forge/protocol";
import { createProjectResourceRoutes } from "../project-resource-routes.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../../../../swarm/types.js";

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project resource routes", () => {
  it("returns resolver snapshot and passive inventory for a session workspace", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "skills", "repo-skill"), { recursive: true });
    await mkdir(join(harness.workspaceDir, ".forge", "specialists"), { recursive: true });
    await mkdir(join(harness.workspaceDir, ".forge", "reference", "nested"), { recursive: true });
    await mkdir(join(harness.workspaceDir, ".forge", "project-agents", "docs", "reference"), { recursive: true });
    await mkdir(join(harness.workspaceDir, ".forge", "extensions"), { recursive: true });
    await writeFile(join(harness.workspaceDir, ".forge", "skills", "repo-skill", "SKILL.md"), "# Skill\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "specialists", "backend.md"), "# Specialist\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "reference", "nested", "notes.md"), "# Notes\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "project-agents", "docs", "config.json"), JSON.stringify({ version: 1, handle: "docs", whenToUse: "Maintain docs" }), "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "project-agents", "docs", "prompt.md"), "You maintain docs.\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "project-agents", "docs", "reference", "guide.md"), "# Guide\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "extensions", "marker.js"), "export default function() {}\n", "utf-8");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;

    expect(payload.profileId).toBe("profile-a");
    expect(payload.sessionAgentId).toBe("session-a");
    expect(payload.effectiveForgeDirRealpath).toBe(await realpath(join(harness.workspaceDir, ".forge")));
    expect(payload.resources.skills.count).toBe(1);
    expect(payload.resources.specialists.count).toBe(1);
    expect(payload.resources.reference.items.map((item) => item.path)).toEqual([join("nested", "notes.md")]);
    expect(payload.resources.projectAgents?.items).toEqual([
      expect.objectContaining({ definitionId: "docs", handle: "docs", status: "valid", whenToUse: "Maintain docs" })
    ]);
    expect(payload.resources.projectAgents?.items[0]?.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.resources.forgeExtensions.count).toBe(1);
    expect(payload.trust.state).toBe("untrusted");
    expect(payload.executableSurfaces.some((surface) => surface.kind === "repo-forge-extensions" && surface.exists)).toBe(
      true
    );
  });

  it("activates a repo project-agent definition and marks it active in refreshed inventory", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "project-agents", "docs"), { recursive: true });
    await writeFile(join(harness.workspaceDir, ".forge", "project-agents", "docs", "config.json"), JSON.stringify({ version: 1, handle: "docs", whenToUse: "Maintain docs" }), "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "project-agents", "docs", "prompt.md"), "You maintain docs.\n", "utf-8");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/project-agents/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: "profile-a",
        sessionAgentId: "session-a",
        definitionId: "docs",
        mode: "create"
      })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourceMutationResponse & { agentId: string; projectAgent: unknown };
    expect(payload.success).toBe(true);
    expect(payload.agentId).toBe("activated-docs");
    expect(payload.projectAgent).toMatchObject({ handle: "docs", whenToUse: "Maintain docs" });
    expect(payload.snapshot.resources.projectAgents?.items[0]).toMatchObject({
      definitionId: "docs",
      activatedAgentId: "activated-docs"
    });
  });

  it("seeds a missing repo-root .forge scaffold without arbitrary client paths", async () => {
    const harness = await createHarness({ missingForge: true });

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", forgeDir: "/ignored" })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourceMutationResponse;
    const forgeDir = join(harness.workspaceDir, ".forge");
    expect(payload.snapshot.effectiveForgeDirRealpath).toBe(await realpath(forgeDir));
    expect(payload.snapshot.resources.skills.exists).toBe(true);
    expect(payload.snapshot.resources.specialists.exists).toBe(true);
    expect(payload.snapshot.resources.reference.exists).toBe(true);
    expect(payload.snapshot.resources.projectAgents?.exists).toBe(true);
    expect(payload.snapshot.resources.forgeExtensions.exists).toBe(true);
    expect(payload.snapshot.resources.piExtensions.exists).toBe(true);
    expect(JSON.parse(await readFile(join(forgeDir, "pi", "settings.json"), "utf-8"))).toEqual({ packages: [] });
    const readme = await readFile(join(forgeDir, "README.md"), "utf-8");
    expect(readme).toContain("agent-facing resources");
    expect(readme).toContain("quote or escape injected output");
    expect(readme).toContain("List repo Pi extensions/custom tools explicitly in `pi/settings.json`");
    expect(readme).toContain("deterministic and harmless");
  });

  it("adds missing scaffold entries without overwriting existing README or settings", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "pi"), { recursive: true });
    await writeFile(join(harness.workspaceDir, ".forge", "README.md"), "custom readme\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "pi", "settings.json"), JSON.stringify({ packages: ["npm:test"] }), "utf-8");

    const beforeResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(beforeResponse.status).toBe(200);
    const beforePayload = (await beforeResponse.json()) as ProjectResourcesSnapshotResponse;
    expect(beforePayload.scaffold.canSeed).toBe(true);
    expect(beforePayload.scaffold.targetDir).toBe(await realpath(join(harness.workspaceDir, ".forge")));
    expect(beforePayload.scaffold.missing).toEqual(expect.arrayContaining([
      ".forge/skills/",
      ".forge/specialists/",
      ".forge/reference/",
      ".forge/project-agents/",
      ".forge/extensions/",
      ".forge/pi/extensions/"
    ]));
    expect(beforePayload.scaffold.missing).not.toContain(".forge/README.md");
    expect(beforePayload.scaffold.missing).not.toContain(".forge/pi/settings.json");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" })
    });

    expect(response.status).toBe(200);
    expect(await readFile(join(harness.workspaceDir, ".forge", "README.md"), "utf-8")).toBe("custom readme\n");
    expect(JSON.parse(await readFile(join(harness.workspaceDir, ".forge", "pi", "settings.json"), "utf-8"))).toEqual({ packages: ["npm:test"] });
    const payload = (await response.json()) as ProjectResourceMutationResponse;
    expect(payload.snapshot.resources.piExtensions.exists).toBe(true);
    expect(payload.snapshot.scaffold.missing).toEqual([]);
  });

  it("seeds a valid override .forge directory", async () => {
    const harness = await createHarness({ missingForge: true });
    const override = join(await makeTempDir("forge-route-override-"), ".forge");
    await mkdir(override, { recursive: true });

    const overrideResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources/override`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", forgeDir: override })
    });
    expect(overrideResponse.status).toBe(200);

    const beforeResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(beforeResponse.status).toBe(200);
    const beforePayload = (await beforeResponse.json()) as ProjectResourcesSnapshotResponse;
    expect(beforePayload.source).toBe("override");
    expect(beforePayload.scaffold.canSeed).toBe(true);
    expect(beforePayload.scaffold.targetDir).toBe(await realpath(override));
    expect(beforePayload.scaffold.missing).toEqual(expect.arrayContaining([
      ".forge/README.md",
      ".forge/skills/",
      ".forge/specialists/",
      ".forge/reference/",
      ".forge/project-agents/",
      ".forge/extensions/",
      ".forge/pi/extensions/",
      ".forge/pi/settings.json"
    ]));

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourceMutationResponse;
    expect(payload.snapshot.source).toBe("override");
    expect(payload.snapshot.scaffold.targetDir).toBe(await realpath(override));
    expect(payload.snapshot.scaffold.missing).toEqual([]);
    expect(JSON.parse(await readFile(join(override, "pi", "settings.json"), "utf-8"))).toEqual({ packages: [] });
  });

  it("seeds through a symlinked repo-root .forge directory", async () => {
    const harness = await createHarness({ missingForge: true });
    const target = join(await makeTempDir("forge-route-symlink-target-"), ".forge");
    await mkdir(target, { recursive: true });
    await symlink(target, join(harness.workspaceDir, ".forge"), "dir");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourceMutationResponse;
    expect(payload.snapshot.effectiveForgeDirRealpath).toBe(await realpath(target));
    expect(payload.snapshot.scaffold.missing).toEqual([]);
    expect(await readFile(join(target, "README.md"), "utf-8")).toContain("agent-facing resources");
  });

  it("rejects scaffold creation when no Git root is detected", async () => {
    const harness = await createHarness({ nonGitWorkspace: true, missingForge: true });

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" })
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("no Git repository root");
  });

  it("derives trust mutation path server-side from the session context", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge"), { recursive: true });

    const trustResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources/trust`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", action: "trust", path: "/ignored" })
    });
    expect(trustResponse.status).toBe(200);
    const trustPayload = (await trustResponse.json()) as ProjectResourceMutationResponse;
    expect(trustPayload.snapshot.trust).toEqual({
      state: "trusted",
      key: await realpath(join(harness.workspaceDir, ".forge"))
    });
  });

  it("degrades malformed project resource settings to defaults", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge"), { recursive: true });
    await mkdir(join(harness.dataDir, "shared", "config"), { recursive: true });
    await writeFile(join(harness.dataDir, "shared", "config", "project-resources.json"), "{not-json", "utf-8");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.trust.state).toBe("untrusted");
  });

  it("degrades missing session cwd to an empty no-workspace snapshot", async () => {
    const harness = await createHarness({ missingCwd: true });

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.source).toBe("none");
    expect(payload.trust.state).toBe("not_applicable");
    expect(payload.warning).toContain("Session working directory is unavailable");
    expect(payload.executableSurfaces).toEqual([]);
    expect(payload.resources.skills.count).toBe(0);
  });

  it("rejects clear override mutation when session cwd is missing", async () => {
    const harness = await createHarness({ missingCwd: true });

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/override`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", forgeDir: null })
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; success?: boolean };
    expect(payload.error).toContain("Session working directory is unavailable");
    expect(payload.success).toBeUndefined();
  });

  it("applies CORS headers on early trust errors", async () => {
    const harness = await createHarness({ missingForge: true });

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/trust`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://example.test" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", action: "trust" })
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://example.test");
  });

  it("skips a symlinked repository reference root in Settings inventory", async () => {
    const harness = await createHarness();
    const target = join(await makeTempDir("forge-reference-target-"), "reference");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "leaked.md"), "# Leaked\n", "utf-8");
    await rm(join(harness.workspaceDir, ".forge", "reference"), { recursive: true, force: true });
    await symlink(target, join(harness.workspaceDir, ".forge", "reference"), "dir");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.resources.reference.exists).toBe(false);
    expect(payload.resources.reference.items).toEqual([]);
  });

  it("marks Settings inventory truncated when non-matching entries hit the traversal cap", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "reference"), { recursive: true });
    await Promise.all(
      Array.from({ length: 1005 }, (_, index) =>
        writeFile(join(harness.workspaceDir, ".forge", "reference", `ignored-${String(index).padStart(4, "0")}.txt`), "ignored", "utf-8")
      )
    );

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.resources.reference.items).toEqual([]);
    expect(payload.resources.reference.count).toBe(0);
    expect(payload.resources.reference.truncated).toBe(true);
  });

  it("marks Settings inventory truncated when symlink-heavy entries hit the traversal cap", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "reference"), { recursive: true });
    const target = join(harness.workspaceDir, ".forge", "reference", "target.md");
    await writeFile(target, "# Target\n", "utf-8");
    await Promise.all(
      Array.from({ length: 1005 }, (_, index) =>
        symlink(target, join(harness.workspaceDir, ".forge", "reference", `link-${String(index).padStart(4, "0")}.md`))
      )
    );

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.resources.reference.items.map((item) => item.path)).not.toContain("link-0000.md");
    expect(payload.resources.reference.truncated).toBe(true);
  });

  it("caps Settings inventory traversal", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "reference"), { recursive: true });
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        writeFile(join(harness.workspaceDir, ".forge", "reference", `${String(index).padStart(2, "0")}.md`), "# Note\n", "utf-8")
      )
    );

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectResourcesSnapshotResponse;
    expect(payload.resources.reference.items).toHaveLength(50);
    expect(payload.resources.reference.count).toBe(50);
    expect(payload.resources.reference.truncated).toBe(true);
  });

  it("validates override directory name and stores realpath-normalized override", async () => {
    const harness = await createHarness();
    const override = join(await makeTempDir("forge-override-parent-"), ".forge");
    await mkdir(override, { recursive: true });
    const badOverride = join(await makeTempDir("forge-bad-override-"), "not-forge");
    await mkdir(badOverride, { recursive: true });

    const badResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources/override`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", forgeDir: badOverride })
    });
    expect(badResponse.status).toBe(400);

    const goodResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources/override`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", forgeDir: override })
    });
    expect(goodResponse.status).toBe(200);
    const payload = (await goodResponse.json()) as ProjectResourceMutationResponse;
    expect(payload.snapshot.source).toBe("override");
    expect(payload.snapshot.effectiveForgeDirRealpath).toBe(await realpath(override));
  });
});

async function createHarness(options: { missingCwd?: boolean; missingForge?: boolean; nonGitWorkspace?: boolean } = {}): Promise<{ baseUrl: string; workspaceDir: string; dataDir: string }> {
  const dataDir = await makeTempDir("forge-route-data-");
  const workspaceDir = options.missingCwd ? join(await makeTempDir("forge-route-missing-parent-"), "deleted") : await makeTempDir("forge-route-workspace-");
  if (!options.missingCwd) {
    if (!options.nonGitWorkspace) {
      execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
    }
    if (!options.missingForge) {
      await mkdir(join(workspaceDir, ".forge"), { recursive: true });
    }
  }
  const descriptor = createDescriptor(workspaceDir);
  const activatedAgents: AgentDescriptor[] = [];
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    getAgent: (agentId: string) => (agentId === descriptor.agentId ? descriptor : activatedAgents.find((agent) => agent.agentId === agentId)),
    listAgents: () => [descriptor, ...activatedAgents],
    activateRepoProjectAgent: async (request: { definitionId: string }) => {
      const workspaceRealpath = await realpath(workspaceDir);
      const forgeDirRealpath = await realpath(join(workspaceDir, ".forge"));
      const agent: AgentDescriptor = {
        ...createDescriptor(workspaceDir),
        agentId: `activated-${request.definitionId}`,
        managerId: `activated-${request.definitionId}`,
        projectAgent: {
          handle: request.definitionId,
          whenToUse: "Maintain docs",
          source: {
            type: "repo",
            workspaceKey: `profile-a::${workspaceRealpath}`,
            forgeDirRealpath,
            definitionId: request.definitionId,
            activatedAt: "2026-04-03T00:00:00.000Z"
          }
        }
      };
      activatedAgents.push(agent);
      return { profileId: "profile-a", agentId: agent.agentId, projectAgent: agent.projectAgent! };
    },
    applyProjectResourceTrustChange: async () => undefined,
    applyProjectResourceWorkspaceChange: async () => undefined
  } as unknown as SwarmManager;
  const routes = createProjectResourceRoutes({ swarmManager });
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
    if (!route) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    await route.handle(request, response, requestUrl);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind test server");
  }
  servers.push({ close: () => new Promise((resolveClose) => server.close(() => resolveClose())) });
  return { baseUrl: `http://127.0.0.1:${address.port}`, workspaceDir, dataDir };
}

function createDescriptor(cwd: string): AgentDescriptor {
  return {
    agentId: "session-a",
    managerId: "session-a",
    profileId: "profile-a",
    role: "manager",
    status: "idle",
    cwd,
    sessionFile: join(cwd, "session.jsonl"),
    memoryFile: join(cwd, "memory.md"),
    model: { provider: "openai", modelId: "gpt-5.1-codex-max" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as AgentDescriptor;
}
