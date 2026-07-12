import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ObservabilityFacade,
  ObservabilityRuntimeType,
  ObservabilityToolDefinition,
} from "../../observability/observability-types.js";
import type { AgentDescriptor } from "../types.js";

export interface RecordRuntimePromptAndCreationOptions {
  observability?: ObservabilityFacade;
  descriptor: AgentDescriptor;
  runtimeToken: number;
  runtimeType: ObservabilityRuntimeType;
  forgeResolvedPrompt: string;
  finalSystemPrompt: string;
  startupSystemPromptOverride?: string;
  activeTools: ObservabilityToolDefinition[];
  mcpServers?: string[];
  metadata?: Record<string, unknown>;
}

export function recordRuntimePromptAndCreation(options: RecordRuntimePromptAndCreationOptions): void {
  const common = {
    agentId: options.descriptor.agentId,
    managerId: options.descriptor.role === "manager" ? options.descriptor.agentId : options.descriptor.managerId,
    profileId: options.descriptor.profileId,
    role: options.descriptor.role,
    runtimeType: options.runtimeType,
    runtimeToken: options.runtimeToken,
    cwd: options.descriptor.cwd,
    modelProvider: options.descriptor.model.provider,
    modelId: options.descriptor.model.modelId,
    agentName: options.descriptor.displayName ?? options.descriptor.sessionLabel ?? options.descriptor.agentId,
  };

  options.observability?.recordPromptResolved({
    ...common,
    source: "forge_resolved",
    prompt: options.forgeResolvedPrompt,
  });
  options.observability?.recordPromptResolved({
    ...common,
    source: "runtime_final",
    prompt: options.finalSystemPrompt,
  });
  if (options.startupSystemPromptOverride) {
    options.observability?.recordPromptResolved({
      ...common,
      source: "startup_recovery",
      prompt: options.startupSystemPromptOverride,
    });
  }

  options.observability?.recordRuntimeCreated({
    ...common,
    status: "ready",
    reasoningLevel: options.descriptor.model.thinkingLevel,
    archetypeId: options.descriptor.archetypeId,
    finalSystemPrompt: options.finalSystemPrompt,
    startupSystemPromptOverride: options.startupSystemPromptOverride,
    activeTools: options.activeTools,
    mcpServers: options.mcpServers,
    metadata: options.metadata,
  });
}

export function summarizeRuntimeTools(
  tools: readonly ToolDefinition[],
  options: { activeToolNames?: readonly string[]; source?: string } = {},
): ObservabilityToolDefinition[] {
  const active = new Set(options.activeToolNames ?? []);
  return tools
    .filter((tool) => active.size === 0 || active.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      jsonSchema: (tool as { parameters?: unknown; inputSchema?: unknown; schema?: unknown }).parameters
        ?? (tool as { inputSchema?: unknown }).inputSchema
        ?? (tool as { schema?: unknown }).schema,
      source: options.source ?? "forge",
    }));
}
