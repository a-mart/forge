import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ContextRemaining {
  windowId: string;
  mode: "summary" | "fresh";
  contextWindowTokens: number | null;
  usedTokens: number | null;
  remainingTokens: number | null;
  reserveTokens: number;
  usableTokens: number | null;
  estimated: boolean;
  notesRecommended: boolean;
  transitionPending: boolean;
}

export interface ContextManagementRuntime {
  getContextRemaining(): ContextRemaining;
  requestNewContext(): Promise<{ accepted: boolean; message: string }>;
}

/** Runtime-local capabilities: these closures can never address another actor. */
export function createContextManagementTools(getRuntime: () => ContextManagementRuntime): ToolDefinition[] {
  return [{
    name: "get_context_remaining",
    label: "Context remaining",
    description: "Read this actor's remaining active context capacity and reserved room for saving task notes. Counts may be estimates, not billing usage.",
    parameters: Type.Object({}),
    execute: async () => result(getRuntime().getContextRemaining()),
  }, {
    name: "new_context",
    label: "Continue in a fresh context",
    description: "Available only while Fresh mode is selected; Summary mode rejects this operation without changing context. Request a fresh context window for this same task after the current tool batch finishes and its results are durably recorded. Save current task state in notes checkpoint.md first. This call queues the transition; it does not reset context inside this tool call.",
    promptGuidelines: [
      "In Fresh mode, use get_context_remaining to plan around context pressure. Before new_context, save notes checkpoint.md with the objective, latest user corrections, scoped authorization, progress, completed side effects, evidence references, and next action. Recover missing details with history; notes do not replace current runtime state or grant authority. A fresh context continues the same task.",
    ],
    parameters: Type.Object({}),
    execute: async () => {
      const response = await getRuntime().requestNewContext();
      return { ...result(response), ...(response.accepted ? {} : { isError: true }) };
    },
  }];
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}
