type ExtensionAPI = {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: Record<string, unknown>;
    execute(): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }): void;
};

const VALIDATION_TOKEN = "FRSR-2026-05-20";
const TOOL_RESULT = `forge-resource-smoke-pi-extension tool called; token ${VALIDATION_TOKEN}`;

export default function forgeResourceSmokePiExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "forge_resource_smoke_pi_tool",
    label: "Forge Resource Smoke Pi Tool",
    description:
      "Test-only tool that returns a deterministic string proving the repo-root .forge Pi extension loaded.",
    promptSnippet: "Return the deterministic Forge repo-root Pi extension smoke token.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return {
        content: [{ type: "text", text: TOOL_RESULT }],
        details: { token: VALIDATION_TOKEN },
      };
    },
  });
}
