import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ForgeExtensionHost } from "./forge-extension-host.js";

interface BuildForgePiToolBridgeExtensionFactoryOptions {
  forgeExtensionHost: ForgeExtensionHost;
  bindingToken: string;
  skippedToolNames: Iterable<string>;
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

      const beforeResult = await options.forgeExtensionHost.dispatchToolBefore(options.bindingToken, {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: normalizeToolInput(event.input)
      });

      if (beforeResult?.input) {
        replaceToolInput(event, beforeResult.input);
      }

      if (beforeResult?.block === true) {
        return {
          block: true,
          reason: beforeResult.reason?.trim() || `Tool ${event.toolName} was blocked by a Forge extension.`
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

      await options.forgeExtensionHost.dispatchToolAfter(options.bindingToken, {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: normalizeToolInput(event.input),
        result: event.isError
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
            }
      });

      return undefined;
    });
  };
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
