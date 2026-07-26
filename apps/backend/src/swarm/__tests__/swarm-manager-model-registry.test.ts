import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
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
      await generatePiProjection(config.paths.dataDir);
      const authStorage = AuthStorage.create(config.paths.sharedAuthFile);
      authStorage.set("openai-codex", { type: "api_key", key: "sk-project-agent-analysis" } as never);

      const manager = new SwarmManager(config);
      await manager.reloadModelCatalogOverridesAndProjection();
      const result = await (manager as any).projectAgentCoordinator.resolveDefaultAnalysisModel();

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
    await generatePiProjection(config.paths.dataDir);
    const authStorage = AuthStorage.create(config.paths.sharedAuthFile);
    authStorage.set("openai-codex", { type: "api_key", key: "sk-memory-merge" } as never);
    memoryMergeMockState.executeLLMMerge.mockResolvedValue("# Swarm Memory\n\n## Decisions\n- merged\n");

    const manager = new SwarmManager(config);
    await manager.reloadModelCatalogOverridesAndProjection();
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

    expect(codexWorker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'xhigh',
    })
    expect(pi54Worker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(opusWorker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      thinkingLevel: 'high',
    })
  })

  it('applies spawn_agent modelId and reasoningLevel overrides over preset defaults', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Override Worker',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-terra',
      reasoningLevel: 'medium',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.6-terra',
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
      modelId: 'claude-opus-4-8',
      thinkingLevel: 'low',
    })
    expect(highMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      thinkingLevel: 'high',
    })
  })

  it('applies spawn_agent overrides when inheriting manager model fallback', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Fallback Override Worker',
      modelId: 'gpt-5.4-mini',
      reasoningLevel: 'low',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4-mini',
      thinkingLevel: 'low',
    })
  })
  it('reroutes spawn_agent model from GPT-5.6 Sol to Terra when Sol is temporarily quota-blocked', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const solWorker = await manager.spawnAgent('manager', {
      agentId: 'Sol Block Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    await (manager as any).handleRuntimeError(solWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~4307 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Sol Fallback Worker',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.6-terra')
  })

  it('reroutes spawn_agent model from GPT-5.6 Sol to Terra when worker message_end stopReason is error', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const solWorker = await manager.spawnAgent('manager', {
      agentId: 'Sol Message End Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    await (manager as any).handleRuntimeSessionEvent(solWorker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'You have hit your ChatGPT usage limit ... in 20 min.',
      },
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Sol Message End Fallback Worker',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.6-terra')
  })

  it('reroutes spawn_agent model from Sol to Luna when Sol and Terra are blocked', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const solWorker = await manager.spawnAgent('manager', {
      agentId: 'Sol Block Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })
    const terraWorker = await manager.spawnAgent('manager', {
      agentId: 'Terra Block Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-terra',
    })

    await (manager as any).handleRuntimeError(solWorker.agentId, {
      phase: 'prompt_start',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 120 min.',
    })
    await (manager as any).handleRuntimeError(terraWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Rate limit exceeded for requests per minute. Try again in 30 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Sol Escalation Worker',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.6-luna')
  })

  it('does not reroute spawn_agent model for non-quota runtime errors', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const solWorker = await manager.spawnAgent('manager', {
      agentId: 'Sol Non Quota Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    await (manager as any).handleRuntimeError(solWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Network socket disconnected before secure TLS connection was established.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Sol Non Quota Followup',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    expect(followup.model.modelId).toBe('gpt-5.6-sol')
  })

  it('does not apply quota rerouting outside prompt_dispatch/prompt_start phases', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const solWorker = await manager.spawnAgent('manager', {
      agentId: 'Sol Steer Delivery Source',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    await (manager as any).handleRuntimeError(solWorker.agentId, {
      phase: 'steer_delivery',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 30 min.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Sol Steer Delivery Followup',
      model: 'pi-5.6',
      modelId: 'gpt-5.6-sol',
    })

    expect(followup.model.modelId).toBe('gpt-5.6-sol')
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
     ).rejects.toThrow(
      'spawn_agent.model must be one of pi-5.5|pi-5.6|pi-5.4|pi-opus|pi-sonnet|pi-fable|sdk-opus|sdk-sonnet|pi-grok|cursor-composer|cursor-grok-45',
      )
  })

  it('rejects invalid spawn_agent reasoning levels with a clear error', async () => {
    const config = await makeSwarmManagerHarnessConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Reasoning Worker',
        reasoningLevel: 'galaxy' as any,
      }),
    ).rejects.toThrow('spawn_agent.reasoningLevel must be one of none|low|medium|high|xhigh|max|ultra')
  })
});
