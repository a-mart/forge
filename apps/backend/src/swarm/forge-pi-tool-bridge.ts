import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type { AgentDescriptor } from "./types.js";

interface BuildForgePiToolBridgeExtensionFactoryOptions {
  forgeExtensionHost: ForgeExtensionHost;
  bindingToken: string;
  skippedToolNames: Iterable<string>;
  host?: SwarmToolHost;
  descriptor?: AgentDescriptor;
}

interface PiToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface PiToolResultEvent extends PiToolCallEvent {
  content?: unknown;
  details?: unknown;
  isError: boolean;
}

export function buildForgePiToolBridgeExtensionFactory(
  options: BuildForgePiToolBridgeExtensionFactoryOptions
): ExtensionFactory {
  const skippedToolNames = new Set(options.skippedToolNames);

  return (pi) => {
    pi.on("tool_call", async (event: PiToolCallEvent) => {
      if (skippedToolNames.has(event.toolName)) {
        return undefined;
      }

      const normalizedInput = normalizeToolInput(event.input);
      const beforeResult = await options.forgeExtensionHost.dispatchToolBefore(options.bindingToken, {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: normalizedInput
      });
      recordExtensionToolHook(options, event.toolName, event.toolCallId, "before", normalizedInput, beforeResult);

      if (beforeResult?.input) {
        replaceToolInput(event, beforeResult.input);
      }

      if (beforeResult?.block === true) {
        const reason = beforeResult.reason?.trim() || `Tool ${event.toolName} was blocked by a Forge extension.`;
        recordExtensionToolHook(options, event.toolName, event.toolCallId, "after", normalizedInput, { ok: false, error: reason }, true);
        return {
          block: true,
          reason
        };
      }

      return undefined;
    });

    pi.on("tool_result", async (event: PiToolResultEvent) => {
      if (skippedToolNames.has(event.toolName)) {
        return undefined;
      }

      const rawResult = cloneStructured({
        content: event.content,
        details: event.details,
        isError: event.isError
      });

      const normalizedInput = normalizeToolInput(event.input);
      const afterResult = event.isError
        ? {
            ok: false,
            error: extractToolErrorMessage(event),
            raw: rawResult
          }
        : {
            ok: true,
            value: cloneStructured({
              content: event.content,
              details: event.details
            }),
            raw: rawResult
          };

      await options.forgeExtensionHost.dispatchToolAfter(options.bindingToken, {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: normalizedInput,
        result: afterResult
      });
      recordExtensionToolHook(options, event.toolName, event.toolCallId, "after", normalizedInput, afterResult, event.isError);

      return undefined;
    });
  };
}

function recordExtensionToolHook(
  options: BuildForgePiToolBridgeExtensionFactoryOptions,
  toolName: string,
  toolCallId: string,
  phase: "before" | "after",
  input: Record<string, unknown>,
  output?: unknown,
  isError = false,
): void {
  if (!options.host || !options.descriptor) {
    return;
  }

  options.host.recordToolSideEffect?.(options.descriptor.agentId, {
    toolName,
    toolCallId,
    phase,
    input,
    output,
    isError,
    metadata: {
      source: "forge_pi_tool_bridge",
      bindingToken: options.bindingToken,
    },
  });
}

function replaceToolInput(event: PiToolCallEvent, nextInput: Record<string, unknown>): void {
  const normalizedInput = normalizeToolInput(nextInput);
  const currentInput = event.input;

  if (!currentInput || typeof currentInput !== "object" || Array.isArray(currentInput)) {
    (event as PiToolCallEvent & { input: Record<string, unknown> }).input = normalizedInput;
    return;
  }

  for (const key of Object.keys(currentInput)) {
    if (!(key in normalizedInput)) {
      delete currentInput[key];
    }
  }

  Object.assign(currentInput, normalizedInput);
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return cloneStructured(value as Record<string, unknown>);
}

function cloneStructured<T>(value: T): T {
  return structuredClone(value);
}

function extractToolErrorMessage(event: PiToolResultEvent): string {
  const message = extractTextContent(event.content);
  if (message.length > 0) {
    return message;
  }

  return `Tool ${event.toolName} failed`;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item): item is { type: string; text: string } => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string";
    })
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}
