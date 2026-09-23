import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChoiceQuestion } from "@forge/protocol";
import type { RuntimeSessionEvent } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { normalizeNativeToolContract, stableToolContract } from "./codex-tool-contract.js";

type Tool = ToolDefinition<any, any, any>;
type NativeTool = { name: string; type: string; inputSchema: unknown };

/** Dynamic tools preserve Forge ownership; native coding tools stay inside Codex. */
export class CodexRuntimeTools {
  private readonly tools: Map<string, Tool>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unavailableTools = new Set<string>();
  private legacyBudgetTools = new Set<string>();

  constructor(private readonly options: {
    tools: Tool[];
    agentId: string;
    host: Pick<SwarmToolHost, "requestUserChoice">;
    emit(event: RuntimeSessionEvent): Promise<void>;
  }) {
    this.tools = new Map(options.tools.map(tool => [tool.name, tool]));
  }

  definitions() {
    return [{ type: "namespace", name: "forge", description: "Forge session coordination, task notes, history, and browser integration.",
      tools: [...this.tools.values()].map(tool => ({ type: "function", name: tool.name,
        description: tool.description, inputSchema: tool.parameters, deferLoading: false })) }];
  }

  restoreContract(definitions: unknown): void {
    const persisted = normalizeNativeToolContract(definitions);
    const current = normalizeNativeToolContract(this.definitions());
    // App-server keeps the tool definitions from thread creation. A changed
    // description is safe with the current implementation, but a changed input
    // schema must never dispatch old arguments into a new handler.
    const persistedTools = (persisted.value as Array<{ tools: NativeTool[] }>).flatMap(namespace => namespace.tools);
    const currentTools = (current.value as Array<{ tools: NativeTool[] }>).flatMap(namespace => namespace.tools);
    const oldByName = new Map(persistedTools.map(tool => [tool.name, tool]));
    if (oldByName.size !== persistedTools.length) throw new Error("Invalid native Codex tool contract.");
    for (const tool of currentTools) {
      const old = oldByName.get(tool.name);
      if (!old || stableToolContract(old.inputSchema) !== stableToolContract(tool.inputSchema) || old.type !== tool.type) {
        this.tools.delete(tool.name);
        if (old) this.unavailableTools.add(tool.name);
      }
    }
    for (const old of persistedTools) {
      if (!this.tools.has(old.name)) this.unavailableTools.add(old.name);
    }
    this.legacyBudgetTools = persisted.legacyBudgetTools;
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }

  async request(method: string, params: Record<string, any>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("Codex turn was stopped");
    const work = this.handleRequest(method, params, signal);
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }

  private async handleRequest(method: string, params: Record<string, any>, signal: AbortSignal): Promise<unknown> {
    if (method === "item/tool/call") return this.callTool(params, signal);
    if (method === "item/tool/requestUserInput") {
      if (!Array.isArray(params.questions) || params.questions.some((q: any) => q.isSecret)) {
        throw new Error("Native Codex cannot collect secrets through ordinary questions. Use a supported Secure Session.");
      }
      const questions: ChoiceQuestion[] = params.questions.map((q: any) => ({
        id: q.id, header: q.header, question: q.question,
        options: q.options?.map((o: any, index: number) => ({ id: String(index), label: o.label, description: o.description })),
      }));
      const answers = await waitWithAbort(this.options.host.requestUserChoice(this.options.agentId, questions), signal);
      return { answers: Object.fromEntries(answers.map(answer => [answer.questionId, { answers: answer.text
        ? [answer.text] : answer.selectedOptionIds.map(id => questions.find(q => q.id === answer.questionId)?.options?.find(o => o.id === id)?.label ?? id) }])) };
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval") {
      if (method === "item/commandExecution/requestApproval" && !params.command && !params.networkApprovalContext && !params.additionalPermissions) {
        throw new Error("Command approval details are unavailable.");
      }
      if (method === "item/fileChange/requestApproval" && !params.forgeFileChanges) {
        throw new Error("File approval requires the complete proposed changes. Split large changes into smaller patches and retry.");
      }
      const description = method === "item/commandExecution/requestApproval"
        ? `Allow this command or permission request?\n\n${String(params.command ?? "")}\n\nDirectory: ${String(params.cwd ?? "current workspace")}\n${String(params.reason ?? "")}\n${params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext) : ""}\n${params.additionalPermissions ? JSON.stringify(params.additionalPermissions) : ""}`
        : method === "item/fileChange/requestApproval"
          ? `Allow these file changes once?\n\n${String(params.reason ?? "")}\n${params.forgeFileChanges}`
          : `Allow these additional permissions for this turn?\n\n${JSON.stringify(params.permissions)}`;
      if (description.length > 12_000) throw new Error("Approval details are too large to review. Split the request and retry.");
      try {
        const answers = await waitWithAbort(this.options.host.requestUserChoice(this.options.agentId, [{
          id: "approval", header: "Codex permission", question: description, options: [
            { id: "decline", label: "Deny" }, { id: "accept", label: "Allow once" },
          ],
        }]), signal);
        const accepted = !signal.aborted && answers[0]?.selectedOptionIds.includes("accept");
        if (method === "item/permissions/requestApproval") return { permissions: accepted ? params.permissions : {}, scope: "turn" };
        return { decision: accepted ? "accept" : "decline" };
      } catch {
        return method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
      }
    }
    if (method === "mcpServer/elicitation/request") return { action: "decline" };
    throw new Error(`Unsupported native Codex request: ${method}`);
  }

  private async callTool(params: Record<string, any>, signal: AbortSignal): Promise<unknown> {
    const tool = params.namespace === "forge" ? this.tools.get(params.tool) : undefined;
    if (!tool && params.namespace === "forge" && this.unavailableTools.has(params.tool)) {
      return { success: false, contentItems: [{ type: "inputText",
        text: `Forge tool ${params.tool} changed since this native thread started. Continue with available tools, or fork the session to use the current version.` }] };
    }
    if (!tool) throw new Error("Unknown Forge tool for this runtime");
    let args = params.arguments;
    if (this.legacyBudgetTools.has(tool.name) && args && typeof args === "object" && !Array.isArray(args)) {
      args = { ...args };
      delete args.max_output_tokens;
    }
    if (!Value.Check(tool.parameters, args)) throw new Error("Invalid Forge tool arguments");
    const toolCallId = String(params.callId);
    await this.options.emit({ type: "tool_execution_start", toolName: tool.name, toolCallId, args: params.arguments });
    try {
      const result = await tool.execute(toolCallId, args, signal, undefined, {} as never);
      if (signal.aborted) throw new Error("Codex turn was stopped");
      const isError = (result as { isError?: boolean }).isError === true;
      await this.options.emit({ type: "tool_execution_end", toolName: tool.name, toolCallId, result, isError });
      return { success: !isError, contentItems: result.content.map((block: any) => block.type === "image"
        ? { type: "inputImage", imageUrl: `data:${block.mimeType};base64,${block.data}` }
        : { type: "inputText", text: String(block.text ?? "").slice(0, 32_000) }) };
    } catch (error) {
      const result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      await this.options.emit({ type: "tool_execution_end", toolName: tool.name, toolCallId, result, isError: true });
      return { success: false, contentItems: [{ type: "inputText", text: result.content[0]!.text }] };
    }
  }
}

export async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Codex turn was stopped");
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Codex turn was stopped"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
