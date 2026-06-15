import type { CliCapabilities } from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../runtime-target.js";

export const CLI_SERVER_VERSION = "1.0.0";

export function buildCliCapabilities(runtimeTarget: RuntimeTarget): CliCapabilities {
  const available = isBuilderRuntimeTarget(runtimeTarget);
  return {
    protocolVersion: 1,
    minCliVersion: "0.1.0",
    available,
    runtimeTarget,
    features: {
      bearerAuth: available,
      headlessWs: available,
      cliSourceContext: available,
      cliSessionMetadata: available,
      choiceOwnerLookup: available,
      activeToolSnapshot: available,
      projectAgentRunTarget: available,
      sessionTranscript: available,
      builderRuntimeOnly: true,
    },
  };
}
