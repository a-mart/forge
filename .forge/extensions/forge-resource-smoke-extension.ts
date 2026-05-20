export const extension = {
  name: "forge-resource-smoke-extension",
  description:
    "Test-only Forge extension fixture that makes one explicit bash probe visibly report repo-root .forge extension loading.",
};

type ForgeToolBeforeEvent = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
};

type ForgeRuntimeContext = {
  readonly log?: {
    info?(message: string, data?: Record<string, unknown>): void;
  };
};

type ForgeApi = {
  on(
    eventName: "tool:before",
    handler: (
      event: ForgeToolBeforeEvent,
      context: ForgeRuntimeContext,
    ) => { input: Record<string, unknown> } | void | Promise<{ input: Record<string, unknown> } | void>,
  ): void;
};

const PROBE_COMMAND = "echo forge-resource-smoke-extension-probe";
const OBSERVED_OUTPUT = "forge-resource-smoke-extension observed; token FRSR-2026-05-20";
const OBSERVED_COMMAND = `printf '%s\n' '${OBSERVED_OUTPUT}'`;

export default function forgeResourceSmokeExtension(forge: ForgeApi) {
  forge.on("tool:before", (event, context) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command;
    if (command !== PROBE_COMMAND) return undefined;

    context.log?.info?.("Forge resource smoke extension observed explicit probe command", {
      toolName: event.toolName,
    });

    return {
      input: {
        ...event.input,
        command: OBSERVED_COMMAND,
      },
    };
  });
}
