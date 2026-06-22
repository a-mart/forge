import { createHash } from "node:crypto";
import type { ObservabilityFacade } from "../../../observability/observability-types.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import { modelCatalogService } from "../../model-catalog-service.js";
import type { ProjectExecutableTrustPlan } from "../../project-executable-trust.js";
import { resolveCursorSdkApiKey } from "../../secrets-env-service.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime
} from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus, SwarmConfig } from "../../types.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import { recordRuntimePromptAndCreation, summarizeRuntimeTools } from "../runtime-observability-capture.js";
import { planCursorSdkRuntimePrompt } from "../runtime-prompt-plan.js";
import { planRuntimeTools } from "../runtime-tool-plan.js";
import { CursorSdkAgentRuntime, getDefaultCursorSdkStateRoot } from "./cursor-sdk-agent-runtime.js";
import { loadCursorSdkModule } from "./cursor-sdk-loader.js";
import { createCursorSdkMcpToolBridge } from "./cursor-sdk-mcp-tool-bridge.js";
import { toCursorSdkModelSelection } from "./cursor-sdk-model-selection.js";


interface CursorSdkRuntimeCreatorDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  observability?: ObservabilityFacade;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  resolveProjectExecutableTrustPlan: (options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }) => Promise<ProjectExecutableTrustPlan>;
  buildCursorSdkRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
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

export class CursorSdkRuntimeCreator {
  constructor(private readonly deps: CursorSdkRuntimeCreatorDependencies) {}

  async createRuntimeForDescriptor(options: {
    descriptor: AgentDescriptor;
    systemPrompt: string;
    runtimeToken: number;
    sessionDescriptor: AgentDescriptor | undefined;
    creationOptions?: RuntimeCreationOptions;
  }): Promise<SwarmAgentRuntime> {
    const { descriptor, systemPrompt, runtimeToken, sessionDescriptor, creationOptions } = options;

    const projectExecutableTrustPlan = await this.deps.resolveProjectExecutableTrustPlan({
      descriptor,
      sessionDescriptor
    });
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor,
      runtimeType: "cursor-sdk",
      runtimeToken,
      projectExecutableTrustPlan
    });
    const { swarmTools } = planRuntimeTools({
      host: this.deps.host,
      descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings
    });

    const sdk = await loadCursorSdkModule();
    const auth = await resolveCursorSdkApiKey(this.deps.config);
    const cursorSystemPrompt = await this.deps.buildCursorSdkRuntimeSystemPrompt(descriptor, systemPrompt);
    const promptPlan = planCursorSdkRuntimePrompt({
      systemPrompt: cursorSystemPrompt,
      startupRecoveryContext: creationOptions?.startupRecoveryContext,
    });
    const stateRoot = getDefaultCursorSdkStateRoot(descriptor);
    const model = toCursorSdkModelSelection(descriptor.model);
    const mcpBridge = await createCursorSdkMcpToolBridge(swarmTools, { serverName: `forge-swarm-${descriptor.agentId}` });

    this.deps.logDebug("runtime:create:start", {
      runtime: "cursor-sdk",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      cwd: descriptor.cwd,
      authSource: auth.source,
      mcpServer: mcpBridge.serverName,
      modelContextWindow: modelCatalogService.getEffectiveContextWindow(descriptor.model.modelId, descriptor.model.provider)
    });

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await CursorSdkAgentRuntime.create({
        descriptor: structuredClone(descriptor),
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
        sdk,
        apiKey: auth.apiKey,
        model,
        systemPrompt: cursorSystemPrompt,
        startupSystemPromptOverride: promptPlan.startupSystemPromptOverride,
        skipInitialSessionResume: promptPlan.skipInitialSessionResume,
        onStartupRecoveryConsumed: creationOptions?.onStartupRecoveryConsumed,
        mcpServers: mcpBridge.mcpServers,
        stateRoot,
        promptHash: hashPrompt(cursorSystemPrompt)
      });
    } catch (error) {
      await mcpBridge.shutdown().catch(() => undefined);
      this.deps.logDebug("runtime:create:cursor_sdk:failed", sanitizeRuntimeErrorForLog(error));
      throw error;
    }

    bindBridgeCleanup(runtime, () => mcpBridge.shutdown());

    this.deps.logDebug("runtime:create:ready", {
      runtime: "cursor-sdk",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      mcpServer: mcpBridge.serverName,
      stateRoot
    });

    recordRuntimePromptAndCreation({
      observability: this.deps.observability,
      descriptor,
      runtimeToken,
      runtimeType: "cursor-sdk",
      forgeResolvedPrompt: systemPrompt,
      finalSystemPrompt: cursorSystemPrompt,
      startupSystemPromptOverride: promptPlan.startupSystemPromptOverride,
      activeTools: summarizeRuntimeTools(swarmTools),
      mcpServers: [mcpBridge.serverName],
      metadata: {
        authSource: auth.source,
        stateRoot,
        promptHash: hashPrompt(cursorSystemPrompt),
        modelContextWindow: modelCatalogService.getEffectiveContextWindow(descriptor.model.modelId, descriptor.model.provider),
        projectExecutablesTrusted: projectExecutableTrustPlan.trusted,
      },
    });

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    return runtime;
  }
}

function bindBridgeCleanup(runtime: SwarmAgentRuntime, cleanup: () => Promise<void>): void {
  let cleanupPromise: Promise<void> | undefined;
  const runCleanup = async () => {
    cleanupPromise ??= cleanup();
    await cleanupPromise;
  };

  for (const methodName of ["terminate", "shutdownForReplacement", "recycle"] as const) {
    const original = runtime[methodName].bind(runtime) as (...args: any[]) => Promise<void>;
    runtime[methodName] = (async (...args: any[]) => {
      try {
        await original(...args);
      } finally {
        await runCleanup();
      }
    }) as typeof runtime[typeof methodName];
  }
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function sanitizeRuntimeErrorForLog(error: unknown): { name?: string; message: string; code?: unknown } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {})
    };
  }
  return { message: String(error) };
}
