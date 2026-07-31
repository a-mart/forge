import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type LoadExtensionsResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import {
  guardSecureRuntimeError,
  guardSecureRuntimeValue,
  type SecureRuntimeBinding,
} from "./secure-runtime-binding.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function createSecurePiCodingTools(options: {
  cwd: string;
  binding: SecureRuntimeBinding;
}): AnyToolDefinition[] {
  const bash = createBashToolDefinition(options.cwd, {
    operations: {
      exec: async (command, cwd, execution) => {
        const result = await options.binding.executeBash({
          command,
          cwd,
          ...(execution.signal ? { signal: execution.signal } : {}),
          ...(typeof execution.timeout === "number"
            ? { timeoutMs: execution.timeout * 1_000 }
            : {}),
          onData: (data) => {
            execution.onData(Buffer.from(data));
          },
        });
        return { exitCode: result.exitCode };
      },
    },
  });

  return guardSecureRuntimeTools(
    [
      bash,
      createReadToolDefinition(options.cwd),
      createEditToolDefinition(options.cwd),
      createWriteToolDefinition(options.cwd),
      createGrepToolDefinition(options.cwd),
      createFindToolDefinition(options.cwd),
      createLsToolDefinition(options.cwd),
    ],
    options.binding,
  );
}

export function guardSecureRuntimeTools(
  tools: readonly AnyToolDefinition[],
  binding: SecureRuntimeBinding,
): AnyToolDefinition[] {
  return tools.map((tool) => guardSecureRuntimeTool(tool, binding));
}

export function applySecurePiResourcePolicy<
  T extends {
    additionalExtensionPaths: string[];
    extensionsOverride?: (result: LoadExtensionsResult) => LoadExtensionsResult;
  },
>(plan: T): T & { noExtensions: true } {
  return {
    ...plan,
    noExtensions: true,
    additionalExtensionPaths: [],
    extensionsOverride: retainInlinePiExtensions,
  };
}

function guardSecureRuntimeTool(
  tool: AnyToolDefinition,
  binding: SecureRuntimeBinding,
): AnyToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const guardedOnUpdate = onUpdate
        ? (update: Parameters<NonNullable<typeof onUpdate>>[0]) => {
            onUpdate(guardSecureRuntimeValue(binding, update));
          }
        : undefined;

      try {
        const result = await tool.execute(
          toolCallId,
          params,
          signal,
          guardedOnUpdate,
          ctx,
        );
        return guardSecureRuntimeValue(binding, result);
      } catch (error) {
        throw guardSecureRuntimeError(binding, error);
      }
    },
  };
}

function retainInlinePiExtensions(result: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.filter(
      (extension) =>
        isInlineExtensionPath(extension.path) ||
        isInlineExtensionPath(extension.resolvedPath),
    ),
    errors: result.errors.filter((entry) => isInlineExtensionPath(entry.path)),
  };
}

function isInlineExtensionPath(pathValue: string | undefined): boolean {
  return (pathValue?.trim() ?? "").startsWith("<inline");
}
