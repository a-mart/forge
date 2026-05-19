import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectExecutableTrustPlan, buildProjectSafePiProjectSettingsStorage, filterUntrustedProjectPiExtensions } from "../project-executable-trust.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project executable trust helpers", () => {
  it("filters untrusted project-local Pi extensions without filtering global extensions", () => {
    const root = "/repo";
    const config = createConfig(root);
    const result = filterUntrustedProjectPiExtensions({
      result: {
        runtime: {} as never,
        extensions: [
          createLoadedExtension(join(root, ".pi", "extensions", "blocked.js")),
          createLoadedExtension(join(config.paths.agentDir, "npm", "global-package", "extension.js"))
        ],
        errors: []
      },
      descriptor: createDescriptor(root),
      config,
      trustPlan: {
        trusted: false,
        resolution: {
          repoRootResources: {
            piExtensionsDir: join(root, ".forge", "pi", "extensions"),
            forgeExtensionsDir: join(root, ".forge", "extensions")
          }
        } as never
      }
    });

    expect(result.extensions.map((extension) => extension.path)).toEqual([
      join(config.paths.agentDir, "npm", "global-package", "extension.js")
    ]);
  });

  it("does not trust nested exact-cwd legacy executables from repo-root trust", () => {
    const root = "/repo";
    const cwd = join(root, "nested");
    const plan = buildProjectExecutableTrustPlan({
      cwd,
      resolution: {
        trust: { state: "trusted", key: join(root, ".forge") },
        effectiveForgeDirRealpath: join(root, ".forge"),
        repoRootResources: {
          forgeExtensionsDir: join(root, ".forge", "extensions"),
          piExtensionsDir: join(root, ".forge", "pi", "extensions"),
          piSettingsPath: join(root, ".forge", "pi", "settings.json")
        }
      } as never
    });

    expect(plan.trustedForgeExtensionDirs).not.toContain(join(cwd, ".forge", "extensions"));
    expect(plan.trustedPiExtensionDirs).not.toContain(join(cwd, ".pi", "extensions"));
    expect(plan.trustedPiSettingsPaths).not.toContain(join(cwd, ".pi", "settings.json"));
  });

  it("uses an empty project Pi settings surface when repo executables are untrusted", () => {
    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir: "/tmp/agent",
      projectExecutablesTrusted: false
    });

    let projectSettings: string | undefined;
    storage.withLock("project", (current) => {
      projectSettings = current;
      return current;
    });

    expect(JSON.parse(projectSettings ?? "{}")).toMatchObject({ packages: [], extensions: ["!*"] });
  });

  it("reads trusted repo .forge/pi/settings.json project settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-settings-"));
    tempDirs.push(root);
    const settingsPath = join(root, ".forge", "pi", "settings.json");
    await mkdir(join(root, ".forge", "pi"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ packages: ["./local-package"] }), "utf8");
    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir: join(root, "agent"),
      projectSettingsPaths: [settingsPath],
      projectExecutablesTrusted: true
    });

    let projectSettings: string | undefined;
    storage.withLock("project", (current) => {
      projectSettings = current;
      return current;
    });

    expect(JSON.parse(projectSettings ?? "{}")).toMatchObject({ packages: [join(root, ".forge", "pi", "local-package")] });
  });
});

function createLoadedExtension(path: string) {
  return {
    path,
    resolvedPath: path,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    flags: new Map()
  };
}

function createDescriptor(cwd: string): AgentDescriptor {
  return {
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "now",
    updatedAt: "now",
    cwd,
    model: { provider: "openai", modelId: "gpt-5.4", thinkingLevel: "high" },
    sessionFile: join(cwd, "session.jsonl")
  };
}

function createConfig(root: string): SwarmConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    managerId: "manager-1",
    defaultCwd: root,
    defaultModel: { provider: "openai", modelId: "gpt-5.4", thinkingLevel: "high" },
    paths: {
      rootDir: root,
      dataDir: join(root, "data"),
      agentDir: join(root, "data", "agent"),
      managerAgentDir: join(root, "data", "agent", "manager"),
      swarmDir: join(root, "data", "swarm"),
      agentsStoreFile: join(root, "data", "swarm", "agents.json"),
      uploadsDir: join(root, "data", "uploads"),
      sharedAuthFile: join(root, "data", "shared", "config", "auth", "auth.json"),
      sharedSecretsFile: join(root, "data", "shared", "config", "secrets.json")
    }
  };
}
