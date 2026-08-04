import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type LoadExtensionsResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import {
  guardSecureRuntimeError,
  guardSecureRuntimeValue,
  SECURE_RUNTIME_GUARD_FAILURE_MESSAGE,
  type SecureRuntimeBinding,
} from "./secure-runtime-binding.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function createSecurePiCodingTools(options: {
  cwd: string;
  binding: SecureRuntimeBinding;
  hostBashOperations?: BashOperations;
  hostCommandPrefix?: string;
  hostShellPath?: string;
  platform?: NodeJS.Platform;
}): AnyToolDefinition[] {
  const platform = options.platform ?? process.platform;
  const hostBash = createBashToolDefinition(options.cwd, {
    operations: createGuardedHostBashOperations(
      options.binding,
      options.hostBashOperations ?? createLocalBashOperations({
        shellPath: options.hostShellPath,
      }),
    ),
    commandPrefix: options.hostCommandPrefix,
  });
  hostBash.label = `Host Bash · ${hostPlatformLabel(platform)}`;
  hostBash.description = hostBashDescription(platform);
  hostBash.promptSnippet =
    "Use host Bash for ordinary repository work, builds, tests, Git, GitHub CLI, and host-integrated tools";

  const secureBash = createBashToolDefinition(options.cwd, {
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
  secureBash.name = "secure_bash";
  secureBash.label = "Secure Bash · Linux container";
  secureBash.description =
    "Execute Bash inside Forge's Linux secure container. Use only when the command needs an approved Secure Sessions value or Secure Sessions SSH trust. The workspace and working directory are mapped automatically; prefer relative paths. Host programs, credential managers, and authenticated host CLIs are intentionally unavailable—use normal bash for those.";
  secureBash.promptSnippet =
    "Use secure_bash only for commands that need approved secrets or Secure Sessions SSH trust";

  return guardSecureRuntimeTools(
    [
      hostBash,
      secureBash,
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

function createGuardedHostBashOperations(
  binding: SecureRuntimeBinding,
  operations: BashOperations,
): BashOperations {
  return {
    exec: async (command, cwd, execution) => {
      const outputGuard = binding.createOutputGuard();
      const guardAbortController = new AbortController();
      let outputFailure: Error | undefined;
      let operationError: unknown;
      let operationFailed = false;
      let operationResult: { exitCode: number | null } | undefined;

      try {
        try {
          operationResult = await operations.exec(command, cwd, {
            ...execution,
            onData: (data) => {
              if (outputFailure) return;
              try {
                const guarded = outputGuard.write(data);
                if (guarded.byteLength > 0) {
                  execution.onData(Buffer.from(guarded));
                }
              } catch {
                outputFailure = new Error(
                  SECURE_RUNTIME_GUARD_FAILURE_MESSAGE,
                );
                guardAbortController.abort();
              }
            },
            signal: execution.signal
              ? AbortSignal.any([
                  execution.signal,
                  guardAbortController.signal,
                ])
              : guardAbortController.signal,
          });
        } catch (error) {
          operationFailed = true;
          operationError = error;
        }

        try {
          const tail = await outputGuard.close();
          if (!outputFailure && tail.byteLength > 0) {
            execution.onData(Buffer.from(tail));
          }
        } catch {
          outputFailure ??= new Error(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
        }

        if (outputFailure) throw outputFailure;
        if (operationFailed) throw operationError;
        if (!operationResult) {
          throw new Error(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
        }
        return operationResult;
      } finally {
        outputGuard.dispose();
      }
    },
  };
}

function hostPlatformLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return "Linux";
}

function hostBashDescription(platform: NodeJS.Platform): string {
  const environment = platform === "win32"
    ? "Windows host Bash (normally Git Bash)"
    : `${hostPlatformLabel(platform)} host Bash`;
  return `Execute a command in ${environment} with the normal host PATH, authentication, and developer tools. Approved Secure Sessions values are never injected here. Use this for ordinary repository work, builds, tests, Git, GitHub CLI, and host-integrated tools; use secure_bash only when a command needs an approved secret.`;
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
