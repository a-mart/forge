import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeCreator } from "../runtime/codex/codex-runtime-creator.js";
import { ClaudeRuntimeCreator } from "../runtime/claude/claude-runtime-creator.js";
import { CodexAgentRuntime } from "../runtime/codex/codex-agent-runtime.js";
import { ClaudeAgentRuntime } from "../runtime/claude/claude-agent-runtime.js";
import type { AgentDescriptor } from "../types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../runtime/claude/claude-runtime-environment.js", () => ({ assertClaudeSetup: vi.fn(), claudeRuntimeEnvironment: vi.fn(async () => ({})), resolveClaudeExecutable: vi.fn(async () => "claude") }));
vi.mock("../runtime/codex/codex-runtime-auth.js", () => ({ CodexRuntimeAuth: class { initialize = vi.fn(); release = vi.fn(); } }));

describe.each(["codex-native", "claude-native"])("%s roster worker creation", provider => {
  it("inherits manager trust and extension scope while preserving worker authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-worker-"));
    const manager = { role: "manager", agentId: "manager", managerId: "manager", profileId: "p", cwd: root } as AgentDescriptor;
    const descriptor = { ...manager, role: "worker", agentId: "reviewer", model: { provider, modelId: provider === "codex-native" ? "gpt-6-sol" : "claude-fable-5-1", thinkingLevel: "high" } } as AgentDescriptor;
    const create = vi.spyOn(provider === "codex-native" ? CodexAgentRuntime : ClaudeAgentRuntime, "create").mockResolvedValue({} as never);
    const trust = vi.fn(async () => ({ trusted: true }));
    const prepare = vi.fn(async () => null);
    try {
      const Creator = provider === "codex-native" ? CodexRuntimeCreator : ClaudeRuntimeCreator;
      await new Creator({ config: { paths: { dataDir: root } }, host: { listAgents: () => [manager, descriptor], getAgent: () => manager, isSecureSessionsEnabledForAgent: () => false },
        forgeExtensionHost: { prepareRuntimeBindings: prepare }, resolveProjectExecutableTrustPlan: trust,
        getMemoryRuntimeResources: async () => ({ memoryContextFile: { path: "memory", content: "Manager memory" }, skillMetadata: [] }),
        getSwarmContextFiles: async () => [],
      } as never).create({ descriptor, sessionDescriptor: manager, systemPrompt: "You are an independent reviewer. Return findings to the manager.", runtimeToken: 2, callbacks: {} as never });
      expect(trust).toHaveBeenCalledWith({ descriptor, sessionDescriptor: manager });
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ descriptor, sessionDescriptor: manager }));
      const options = create.mock.calls[0]![0];
      expect(options.systemPrompt).toContain("independent reviewer");
      expect(options.systemPrompt).toContain("Return your result to the owning Forge manager");
      expect(options.systemPrompt).not.toContain("Use Forge workers for the configured roster");
      expect(options.tools.map(t => t.name)).not.toContain("spawn_agent");
    } finally { create.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a worker whose owning session is Collaboration", async () => {
    const Creator = provider === "codex-native" ? CodexRuntimeCreator : ClaudeRuntimeCreator;
    await expect(new Creator({} as never).create({ descriptor: { role: "worker", model: { provider } } as AgentDescriptor,
      sessionDescriptor: { role: "manager", sessionSurface: "collab" } as AgentDescriptor,
      systemPrompt: "worker", runtimeToken: 1, callbacks: {} as never })).rejects.toThrow("local Builder");
  });
});
