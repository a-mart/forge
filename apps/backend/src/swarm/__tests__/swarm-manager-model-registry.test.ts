import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createAgentDescriptor, createTempConfig, type TempConfigHandle } from "../../test-support/index.js";
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

const tempConfigHandles: TempConfigHandle[] = [];

async function makeTempConfig(port = 8791): Promise<SwarmConfig> {
  const repoRoot = resolve(process.cwd(), "../..");
  const handle = await createTempConfig({
    prefix: "forge-swarm-manager-model-registry-",
    port,
    rootDir: repoRoot,
    resourcesDir: repoRoot,
    defaultCwd: repoRoot,
    cwdAllowlistRoots: [repoRoot],
    repoArchetypesDir: join(repoRoot, "apps", "backend", "src", "swarm", "archetypes"),
    repoMemorySkillFile: join(repoRoot, "apps", "backend", "src", "swarm", "skills", "builtins", "memory", "SKILL.md"),
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
    },
  });
  tempConfigHandles.push(handle);
  return handle.config;
}

function buildDescriptor(config: SwarmConfig): AgentDescriptor {
  return createAgentDescriptor({
    agentId: "session-1",
    displayName: "Session 1",
    role: "manager",
    managerId: "manager",
    profileId: "manager",
    rootDir: config.defaultCwd,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
    },
    sessionFile: join(config.paths.sessionsDir, "session-1.jsonl"),
  });
}

describe("SwarmManager Pi model registry usage", () => {
  beforeEach(() => {
    memoryMergeMockState.executeLLMMerge.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempConfigHandles.splice(0).map((handle) => handle.cleanup()));
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
