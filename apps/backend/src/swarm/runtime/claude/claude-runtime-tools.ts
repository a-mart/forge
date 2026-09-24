import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CanUseTool, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type { ChoiceQuestion } from "@forge/protocol";

export class ClaudeRuntimeTools {
  readonly server: McpSdkServerConfigWithInstance;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: {
    tools: ToolDefinition<any, any, any>[];
    agentId: string;
    host: Pick<SwarmToolHost, "requestUserChoice">;
    signal: AbortSignal;
    guard<T>(value: T): T;
  }) {
    const tools = new Map(options.tools.map(tool => [tool.name, tool]));
    const listed = options.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: claudeInputSchema(tool) }));
    const instance = new McpServer({ name: "forge", version: "1.0.0" }, { capabilities: { tools: {} } });
    instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
    instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const work = (async () => {
        const signal = AbortSignal.any([extra.signal, options.signal]);
        try {
          signal.throwIfAborted();
          const tool = tools.get(request.params.name);
          if (!tool || !Value.Check(tool.parameters, request.params.arguments ?? {})) throw new Error("Unknown Forge tool or invalid arguments");
          const id = extra._meta?.["claudecode/toolUseId"];
          if (typeof id !== "string") throw new Error("Claude did not supply a tool call identity. Update the Claude runtime.");
          const result = await tool.execute(id, request.params.arguments ?? {}, signal, undefined, {} as never);
          signal.throwIfAborted();
          return options.guard({ content: result.content, isError: (result as { isError?: boolean }).isError === true });
        } catch (error) {
          return options.guard({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      })();
      this.pending.add(work);
      try { return await work; } finally { this.pending.delete(work); }
    });
    this.server = { type: "sdk", name: "forge", instance };
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }

  readonly canUseTool: CanUseTool = async (name, input, context) => {
    const signal = AbortSignal.any([this.options.signal, context.signal]);
    try {
      if (name === "AskUserQuestion") {
        const raw = input.questions as Array<{ question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
        if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw new Error("Invalid question request");
        const questions: ChoiceQuestion[] = raw.map((q, i) => ({ id: String(i), header: q.header ?? "Question", question: q.question,
          options: q.options?.map((o, j) => ({ id: String(j), ...o })), ...(q.multiSelect ? { multiSelect: true } : {}) }));
        const answers = await this.waitForChoice(questions, signal);
        return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(answers.map(answer => [
          raw[Number(answer.questionId)]!.question,
          answer.text || answer.selectedOptionIds.map(id => questions[Number(answer.questionId)]?.options?.find(o => o.id === id)?.label ?? id).join(", "),
        ])) } };
      }
      const description = `${context.title ?? `Allow Claude to use ${name}?`}\n\n${JSON.stringify(this.options.guard(input), null, 2)}`;
      if (description.length > 12_000) throw new Error("Permission request is too large to review; split the operation");
      const answers = await this.waitForChoice([{ id: "permission", header: "Claude permission", question: description,
        options: [{ id: "deny", label: "Deny" }, { id: "allow", label: "Allow once" }] }], signal);
      return answers[0]?.selectedOptionIds.includes("allow") ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user declined this operation." };
    } catch { return { behavior: "deny", message: "Question cancelled or unavailable." }; }
  };

  private async waitForChoice(questions: ChoiceQuestion[], signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    try {
      return await Promise.race([this.options.host.requestUserChoice(this.options.agentId, this.options.guard(questions)),
        new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Claude turn stopped")); signal.addEventListener("abort", abort, { once: true }); })]);
    } finally { signal.removeEventListener("abort", abort); }
  }
}

type JsonSchema = Record<string, any>;

/**
 * Claude silently omits MCP tools whose input schema is not a plain root object, so a root
 * union of object branches is advertised as one object. Calls still validate against the
 * original union.
 */
function claudeInputSchema(tool: ToolDefinition<any, any, any>): { type: "object" } & JsonSchema {
  const schema = tool.parameters as JsonSchema;
  if (!Array.isArray(schema.anyOf)) {
    if (schema.type !== "object") throw new Error(`Forge tool ${tool.name} must use an object input schema.`);
    return schema as { type: "object" };
  }
  const branches = schema.anyOf as JsonSchema[];
  if (!branches.every(branch => branch.type === "object")) throw new Error(`Forge tool ${tool.name} must use object schema branches.`);
  const variants = new Map<string, JsonSchema[]>();
  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      const seen = variants.get(key) ?? [];
      if (!seen.some(entry => JSON.stringify(entry) === JSON.stringify(value))) seen.push(value as JsonSchema);
      variants.set(key, seen);
    }
  }
  const required = branches.map(branch => new Set<string>(branch.required ?? []))
    .reduce((common, next) => new Set([...common].filter(key => next.has(key))));
  return {
    ...(schema.description ? { description: schema.description } : {}),
    type: "object",
    properties: Object.fromEntries([...variants].map(([key, values]) => [key, values.length === 1 ? values[0] : { anyOf: values }])),
    ...(required.size ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}
