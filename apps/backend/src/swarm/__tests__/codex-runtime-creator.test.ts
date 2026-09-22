import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRuntimeCreator } from "../runtime/codex/codex-runtime-creator.js";
import { CodexAgentRuntime } from "../runtime/codex/codex-agent-runtime.js";
import { CodexRuntimeAuth } from "../runtime/codex/codex-runtime-auth.js";
import { CodexRuntimeTools } from "../runtime/codex/codex-runtime-tools.js";
import type { AgentDescriptor } from "../types.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import { createSwarmRuntimeControllerHost, type SwarmRuntimeControllerHostAdapterOptions } from "../swarm-runtime-controller-host-adapter.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("passes project SSH policy through the production host adapter while preserving native threads across toggles", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-creator-"));
  roots.push(root);
  const descriptor = { agentId: "manager", managerId: "manager", profileId: "project", role: "manager",
    sessionSurface: "builder", cwd: root, model: { provider: "codex-native", modelId: "gpt-6-astra" },
  } as AgentDescriptor;
  let enabled = true;
  const getSecureRuntimeBinding = vi.fn();
  const host: SwarmToolHost = { isSecureSessionsEnabledForAgent: () => enabled, getSecureRuntimeBinding,
    getSecureSessionAgentView: vi.fn(), requestSecureSecretAccess: vi.fn(), requestSecureSshHostTrust: vi.fn(),
    requestUserChoice: vi.fn(), listAgents: vi.fn(), getContextMode: vi.fn(), getWorkerActivity: vi.fn(),
    spawnAgent: vi.fn(), killAgent: vi.fn(), sendMessage: vi.fn(), createSessionFromAgent: vi.fn(),
    publishToUser: vi.fn(), invokeBrowserAutomation: vi.fn(), updatePlan: vi.fn(), updateWorkGraph: vi.fn(),
    acceptWorkGraphNode: vi.fn(), createGoal: vi.fn(), getGoal: vi.fn(), updateGoal: vi.fn() };
  // RuntimeController passes this adapter to RuntimeFactory/Creator in production.
  // Supplying the facade directly here would conceal missing capability forwarding.
  const runtimeHost = createSwarmRuntimeControllerHost({ toolHost: host } as SwarmRuntimeControllerHostAdapterOptions);
  vi.spyOn(CodexRuntimeAuth.prototype, "initialize").mockResolvedValue();
  const create = vi.spyOn(CodexAgentRuntime, "create").mockResolvedValue({} as CodexAgentRuntime);
  type Dependencies = ConstructorParameters<typeof CodexRuntimeCreator>[0];
  const creator = new CodexRuntimeCreator({
    config: { paths: { dataDir: root } } as Dependencies["config"],
    host: runtimeHost,
    forgeExtensionHost: { prepareRuntimeBindings: async () => undefined } as unknown as Dependencies["forgeExtensionHost"],
    resolveProjectExecutableTrustPlan: async () => ({ trusted: false }) as Awaited<ReturnType<Dependencies["resolveProjectExecutableTrustPlan"]>>,
    getMemoryRuntimeResources: async () => ({ memoryContextFile: { path: join(root, "memory.md"), content: "" }, additionalSkillPaths: [], skillMetadata: [] }),
    getSwarmContextFiles: async () => [],
  });
  const build = async () => {
    await creator.create({ descriptor, systemPrompt: "Test integration", runtimeToken: 1,
      callbacks: { onStatusChange: vi.fn(), onSessionEvent: vi.fn(), onAgentEnd: vi.fn(), onRuntimeError: vi.fn() } });
    return create.mock.calls.at(-1)![0];
  };
  const legacy = await build();
  expect(legacy.systemPrompt).toContain("inspect forge.secure_session_status and use forge.secure_bash");
  enabled = false;
  const disabled = await build();
  expect(disabled.systemPrompt).toContain("Secure Sessions are disabled for this project");
  expect(disabled.systemPrompt).toContain("normal host SSH configuration and authentication");
  expect(disabled.systemPrompt).not.toContain("inspect forge.secure_session_status and use forge.secure_bash");
  expect(disabled.systemPrompt).not.toContain("For SSH password login use an SSH_ASKPASS binding");
  const bridge = (options: typeof disabled) => new CodexRuntimeTools({ tools: options.tools,
    agentId: descriptor.agentId, host, emit: async () => {} });
  const enabledContract = bridge(legacy).definitions();
  const disabledBridge = bridge(disabled);
  expect(disabledBridge.definitions()).toEqual(enabledContract);
  expect(() => disabledBridge.restoreContract(enabledContract)).not.toThrow();
  expect(disabled.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    "secure_bash", "secure_session_status", "request_secret_access", "request_ssh_host_trust",
  ]));
  // Retaining a definition never grants execution while project authority is absent.
  const result = await disabledBridge.request("item/tool/call", { namespace: "forge", tool: "secure_bash",
    callId: "disabled-call", arguments: { command: "true", secretAliases: [] } }, new AbortController().signal);
  expect(result).toMatchObject({ success: false });
  expect(getSecureRuntimeBinding).toHaveBeenCalledOnce();
  enabled = true;
  const restored = await build();
  expect(restored.systemPrompt).toBe(legacy.systemPrompt);
  expect(() => bridge(restored).restoreContract(disabledBridge.definitions())).not.toThrow();
});
