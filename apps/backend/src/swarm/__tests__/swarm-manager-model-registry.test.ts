import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import {
  bootWithDefaultManager,
  createAgentDescriptor,
  createTempConfig,
  FakeRuntime,
  makeTempConfig as buildSwarmManagerHarnessTempConfig,
  TestSwarmManager as TestSwarmManagerBase,
  type TempConfigHandle,
} from "../../test-support/index.js";
import { SwarmManager } from "../swarm-manager.js";
import { generatePiProjection } from "../model-catalog-projection.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime } from "../runtime-contracts.js";
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

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    (runtime as FakeRuntime).terminateMutatesDescriptorStatus = false;
    return runtime;
  }
}

async function makeSwarmManagerHarnessConfig(port = 8890): Promise<SwarmConfig> {
  return buildSwarmManagerHarnessTempConfig({
    prefix: "swarm-manager-test-",
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
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

describe("SwarmManager spawn_agent preset routing", () => {
  it('maps spawn_agent model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Worker',
      model: 'pi-codex',
    })

    const pi54Worker = await manager.spawnAgent('manager', {
      agentId: 'GPT 5.4 Worker',
      model: 'pi-5.4',
    })

    const opusWorker = await manager.spawnAgent('manager', {
      agentId: 'Opus Worker',
      model: 'pi-opus',
    })

    const codexAppWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex App Worker',
      model: 'codex-app',
    })

    expect(codexWorker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(pi54Worker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(opusWorker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    expect(codexAppWorker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
  })

  it('applies spawn_agent modelId and reasoningLevel overrides over preset defaults', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Override Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'medium',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'medium',
    })
  })

  it('maps anthropic reasoning none/xhigh to low/high for spawn_agent', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const lowMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus None Worker',
      model: 'pi-opus',
      reasoningLevel: 'none',
    })

    const highMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus Xhigh Worker',
      model: 'pi-opus',
      reasoningLevel: 'xhigh',
    })

    expect(lowMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
    expect(highMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
  })

  it('applies spawn_agent overrides when inheriting manager model fallback', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Fallback Override Worker',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'low',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'low',
    })
  })
  it('reroutes spawn_agent model from spark to codex when spark is temporarily quota-blocked', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~4307 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to codex when worker message_end stopReason is error', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeSessionEvent(sparkWorker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'You have hit your ChatGPT usage limit ... in 20 min.',
      },
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to gpt-5.4 when spark and codex are blocked', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })
    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_start',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 120 min.',
    })
    await (manager as any).handleRuntimeError(codexWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Rate limit exceeded for requests per minute. Try again in 30 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Escalation Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.4')
  })

  it('does not reroute spawn_agent model for non-quota runtime errors', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Network socket disconnected before secure TLS connection was established.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('does not apply quota rerouting outside prompt_dispatch/prompt_start phases', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'steer_delivery',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 30 min.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Worker',
        model: 'invalid-model' as any,
      }),
     ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-5.4|pi-5.5|pi-opus|sdk-opus|sdk-sonnet|pi-grok|codex-app|cursor-acp')
  })

  it('rejects invalid spawn_agent reasoning levels with a clear error', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Reasoning Worker',
        reasoningLevel: 'ultra' as any,
      }),
    ).rejects.toThrow('spawn_agent.reasoningLevel must be one of none|low|medium|high|xhigh')
  })
});
