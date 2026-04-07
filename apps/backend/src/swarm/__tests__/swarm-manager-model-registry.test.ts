import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { SwarmManager } from "../swarm-manager.js";
import { generatePiProjection } from "../model-catalog-projection.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(),
}));

vi.mock("../memory-merge.js", async () => {
  const actual = await vi.importActual<typeof import("../memory-merge.js")>("../memory-merge.js");
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  };
});

async function makeTempConfig(port = 8791): Promise<SwarmConfig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "forge-swarm-manager-model-registry-"));
  const repoRoot = resolve(process.cwd(), "../..");
  const dataDir = join(dataRoot, "data");
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
  const memoryDir = join(dataDir, "memory");
  const repoMemorySkillFile = join(repoRoot, "apps", "backend", "src", "swarm", "skills", "builtins", "memory", "SKILL.md");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(sharedAuthDir, { recursive: true });
  await mkdir(sharedIntegrationsDir, { recursive: true });
  await mkdir(sharedCacheDir, { recursive: true });
  await mkdir(sharedStateDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(managerAgentDir, { recursive: true });

  return {
    host: "127.0.0.1",
    port,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
    },
    defaultCwd: repoRoot,
    cwdAllowlistRoots: [repoRoot],
    paths: {
      rootDir: repoRoot,
      resourcesDir: repoRoot,
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
      repoArchetypesDir: join(repoRoot, "apps", "backend", "src", "swarm", "archetypes"),
      memoryFile: join(memoryDir, "manager.md"),
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager"),
    },
  };
}

function buildDescriptor(config: SwarmConfig): AgentDescriptor {
  return {
    agentId: "session-1",
    displayName: "Session 1",
    role: "manager",
    managerId: "manager",
    profileId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
    },
    sessionFile: join(config.paths.sessionsDir, "session-1.jsonl"),
  };
}

describe("SwarmManager Pi model registry usage", () => {
  beforeEach(() => {
    memoryMergeMockState.executeLLMMerge.mockReset();
  });

  it("resolves the project agent analysis model through the generated Pi projection", async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const config = await makeTempConfig();
      const piModelsJsonPath = await generatePiProjection(config.paths.dataDir);
      const authStorage = AuthStorage.create(config.paths.sharedAuthFile);
      authStorage.set("openai-codex", { type: "api_key", key: "sk-project-agent-analysis" } as never);

      const manager = new SwarmManager(config);
      (manager as any).piModelsJsonPath = piModelsJsonPath;
      const result = await (manager as any).resolveProjectAgentAnalysisModel();

      expect([
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          label: "anthropic/claude-opus-4-6",
        },
        {
          provider: "openai-codex",
          id: "gpt-5.4",
          label: "openai-codex/gpt-5.4",
        },
      ]).toContainEqual({
        provider: result.model.provider,
        id: result.model.id,
        label: result.modelLabel,
      });
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }
    }
  });

  it("uses the generated Pi projection when resolving the session memory merge model", async () => {
    const config = await makeTempConfig(8792);
    const piModelsJsonPath = await generatePiProjection(config.paths.dataDir);
    const authStorage = AuthStorage.create(config.paths.sharedAuthFile);
    authStorage.set("openai-codex", { type: "api_key", key: "sk-memory-merge" } as never);
    memoryMergeMockState.executeLLMMerge.mockResolvedValue("# Swarm Memory\n\n## Decisions\n- merged\n");

    const manager = new SwarmManager(config);
    (manager as any).piModelsJsonPath = piModelsJsonPath;
    const descriptor = buildDescriptor(config);
    const result = await (manager as any).executeSessionMemoryLLMMerge(descriptor, "# Profile", "# Session");

    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-codex", id: "gpt-5.4" }),
      "# Profile",
      "# Session",
      expect.objectContaining({
        apiKey: "sk-memory-merge",
        systemPrompt: expect.any(String),
      }),
    );
    expect(result).toEqual({
      mergedContent: "# Swarm Memory\n\n## Decisions\n- merged\n",
      model: "openai-codex/gpt-5.4",
    });
  });
});
