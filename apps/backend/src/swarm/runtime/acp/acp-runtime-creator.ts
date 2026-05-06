import { AcpAgentRuntime } from "../../acp-agent-runtime.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import type {
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
import { planRuntimeEnv } from "../runtime-resource-plan.js";
import { planRuntimeTools } from "../runtime-tool-plan.js";
import { createAcpMcpToolBridge } from "./acp-mcp-tool-bridge.js";

interface AcpRuntimeCreatorDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  onSessionFileRotated?: (descriptor: AgentDescriptor, sessionFile: string) => Promise<void>;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  buildAcpRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
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

export class AcpRuntimeCreator {
  constructor(private readonly deps: AcpRuntimeCreatorDependencies) {}

  async createRuntimeForDescriptor(options: {
    descriptor: AgentDescriptor;
    systemPrompt: string;
    runtimeToken: number;
    sessionDescriptor: AgentDescriptor | undefined;
  }): Promise<SwarmAgentRuntime> {
    const { descriptor, systemPrompt, runtimeToken, sessionDescriptor } = options;
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor,
      runtimeType: "acp",
      runtimeToken
    });
    const { swarmTools } = planRuntimeTools({
      host: this.deps.host,
      descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings
    });
    const [acpSystemPrompt, memoryResources] = await Promise.all([
      this.deps.buildAcpRuntimeSystemPrompt(descriptor, systemPrompt),
      this.deps.getMemoryRuntimeResources(descriptor)
    ]);
    const mcpBridge = await createAcpMcpToolBridge(swarmTools);

    this.deps.logDebug("runtime:create:start", {
      runtime: "cursor-acp",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      mcpServer: mcpBridge.mcpDescriptor.name,
      mcpUrl: mcpBridge.mcpDescriptor.url
    });

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await AcpAgentRuntime.create({
        descriptor: cloneRuntimeDescriptor(descriptor),
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
        now: this.deps.now,
        systemPrompt: acpSystemPrompt,
        mcpServers: [mcpBridge.mcpDescriptor],
        runtimeEnv: planRuntimeEnv({
          dataDir: this.deps.config.paths.dataDir,
          memoryContextFile: memoryResources.memoryContextFile
        }),
        onSessionFileRotated: async (sessionFile) => {
          await this.deps.onSessionFileRotated?.(descriptor, sessionFile);
        },
        onUnexpectedExit: async () => {
          await mcpBridge.shutdown();
        }
      });
    } catch (error) {
      await mcpBridge.shutdown().catch(() => undefined);
      throw error;
    }

    bindAcpBridgeCleanup(runtime, () => mcpBridge.shutdown());

    this.deps.logDebug("runtime:create:ready", {
      runtime: "cursor-acp",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      mcpServer: mcpBridge.mcpDescriptor.name,
      systemPromptPreview: previewForLog(acpSystemPrompt, 240)
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

function bindAcpBridgeCleanup(runtime: SwarmAgentRuntime, cleanup: () => Promise<void>): void {
  let cleanupPromise: Promise<void> | undefined;
  const runCleanup = async () => {
    cleanupPromise ??= cleanup();
    await cleanupPromise;
  };

  const wrap = (methodName: "terminate" | "shutdownForReplacement" | "recycle") => {
    const original = runtime[methodName].bind(runtime) as (...args: any[]) => Promise<void>;
    runtime[methodName] = (async (...args: any[]) => {
      try {
        await original(...args);
      } finally {
        await runCleanup();
      }
    }) as typeof runtime[typeof methodName];
  };

  wrap("terminate");
  wrap("shutdownForReplacement");
  wrap("recycle");
}
