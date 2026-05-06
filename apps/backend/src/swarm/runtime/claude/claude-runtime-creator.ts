import { ClaudeAgentRuntime } from "../../claude-agent-runtime.js";
import { ClaudeAuthResolver } from "../../claude-auth-resolver.js";
import { createClaudeMcpToolBridge } from "../../claude-mcp-tool-bridge.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import { modelCatalogService } from "../../model-catalog-service.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime
} from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  SwarmConfig
} from "../../types.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import { planClaudeRuntimePrompt } from "../runtime-prompt-plan.js";
import { planRuntimeEnv } from "../runtime-resource-plan.js";
import { planRuntimeTools } from "../runtime-tool-plan.js";

interface ClaudeRuntimeCreatorDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  logDebug: (message: string, details?: unknown) => void;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  buildClaudeRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
  callbacks: {
    onStatusChange: (
      runtimeToken: number,
      agentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ) => Promise<void>;
    onSessionEvent: (runtimeToken: number, agentId: string, event: RuntimeSessionEvent) => Promise<void>;
    onAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>;
    onRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>;
  };
}

export class ClaudeRuntimeCreator {
  constructor(private readonly deps: ClaudeRuntimeCreatorDependencies) {}

  async createRuntimeForDescriptor(options: {
    descriptor: AgentDescriptor;
    systemPrompt: string;
    runtimeToken: number;
    sessionDescriptor: AgentDescriptor | undefined;
    creationOptions?: RuntimeCreationOptions;
  }): Promise<SwarmAgentRuntime> {
    const { descriptor, systemPrompt, runtimeToken, sessionDescriptor, creationOptions } = options;
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor,
      runtimeType: "claude",
      runtimeToken
    });
    const { swarmTools } = planRuntimeTools({
      host: this.deps.host,
      descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings
    });
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sessionId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    const workerId = descriptor.role === "worker" ? descriptor.agentId : undefined;
    const authResolver = new ClaudeAuthResolver(this.deps.config.paths.dataDir);
    const [mcpBridge, claudeSystemPrompt, memoryResources] = await Promise.all([
      createClaudeMcpToolBridge(swarmTools, { serverName: `forge-swarm-${descriptor.agentId}` }),
      this.deps.buildClaudeRuntimeSystemPrompt(descriptor, systemPrompt),
      this.deps.getMemoryRuntimeResources(descriptor)
    ]);

    this.deps.logDebug("runtime:create:start", {
      runtime: "claude-sdk",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      profileId,
      sessionId,
      workerId,
      mcpServer: mcpBridge.serverName,
      allowedToolCount: mcpBridge.allowedTools.length
    });

    const promptPlan = planClaudeRuntimePrompt({
      systemPrompt: claudeSystemPrompt,
      startupRecoveryContext: creationOptions?.startupRecoveryContext
    });
    const runtime = new ClaudeAgentRuntime({
      descriptor: cloneRuntimeDescriptor(descriptor),
      systemPrompt: claudeSystemPrompt,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(runtimeToken, agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(runtimeToken, agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(runtimeToken, agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(runtimeToken, agentId, error);
        }
      },
      dataDir: this.deps.config.paths.dataDir,
      profileId,
      sessionId,
      ...(workerId ? { workerId } : {}),
      authResolver,
      mcpServers: {
        [mcpBridge.serverName]: mcpBridge.server
      },
      allowedTools: mcpBridge.allowedTools,
      runtimeEnv: planRuntimeEnv({
        dataDir: this.deps.config.paths.dataDir,
        memoryContextFile: memoryResources.memoryContextFile
      }),
      modelContextWindow: modelCatalogService.getEffectiveContextWindow(
        descriptor.model.modelId,
        descriptor.model.provider
      ),
      ...(promptPlan.startupSystemPromptOverride !== undefined
        ? { startupSystemPromptOverride: promptPlan.startupSystemPromptOverride }
        : {}),
      ...(promptPlan.skipInitialSessionResume !== undefined
        ? { skipInitialSessionResume: promptPlan.skipInitialSessionResume }
        : {})
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "claude-sdk",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      allowedTools: mcpBridge.allowedTools,
      systemPromptPreview: previewForLog(claudeSystemPrompt, 240)
    });

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    return runtime;
  }
}

function cloneRuntimeDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return structuredClone(descriptor);
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
