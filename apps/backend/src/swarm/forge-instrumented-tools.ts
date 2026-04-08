import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import type { ToolAfterResultEnvelope } from "./forge-extension-types.js";

interface WrapForgeToolsWithExtensionHooksOptions {
  tools: ToolDefinition[];
  forgeExtensionHost: ForgeExtensionHost;
  bindingToken: string;
}

export function wrapForgeToolsWithExtensionHooks(
  options: WrapForgeToolsWithExtensionHooksOptions
): ToolDefinition[] {
  return options.tools.map((tool) => wrapForgeToolWithExtensionHooks(tool, options));
}

function wrapForgeToolWithExtensionHooks(
  tool: ToolDefinition,
  options: Omit<WrapForgeToolsWithExtensionHooksOptions, "tools">
): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, ...rest) {
      const originalInput = normalizeToolInput(params);
      const beforeResult = await options.forgeExtensionHost.dispatchToolBefore(options.bindingToken, {
        toolName: tool.name,
        toolCallId,
        input: cloneStructured(originalInput)
      });

      if (beforeResult?.block === true) {
        throw new Error(beforeResult.reason?.trim() || `Tool ${tool.name} was blocked by a Forge extension.`);
      }

      const executedInput = beforeResult?.input ? normalizeToolInput(beforeResult.input) : originalInput;

      try {
        const result = await tool.execute(toolCallId, executedInput, ...rest);
        await options.forgeExtensionHost.dispatchToolAfter(options.bindingToken, {
          toolName: tool.name,
          toolCallId,
          input: cloneStructured(executedInput),
          result: buildSuccessEnvelope(result)
        });
        return result;
      } catch (error) {
        await options.forgeExtensionHost.dispatchToolAfter(options.bindingToken, {
          toolName: tool.name,
          toolCallId,
          input: cloneStructured(executedInput),
          result: buildFailureEnvelope(error)
        });
        throw error;
      }
    }
  };
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return cloneStructured(value as Record<string, unknown>);
}

function buildSuccessEnvelope(result: unknown): ToolAfterResultEnvelope {
  const clonedResult = cloneStructured(result);
  return {
    ok: true,
    value: clonedResult,
    raw: clonedResult
  };
}

function buildFailureEnvelope(error: unknown): ToolAfterResultEnvelope {
  return {
    ok: false,
    error: normalizeErrorMessage(error),
    raw: cloneStructured(error)
  };
}

function cloneStructured<T>(value: T): T {
  return structuredClone(value);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  return "Unknown Forge tool execution error";
}
