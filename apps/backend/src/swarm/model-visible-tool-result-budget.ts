import type {
  AgentSession,
  ExtensionFactory,
  LoadExtensionsResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "./pi/pi-ai-compat.js";

export const DEFAULT_TOOL_OUTPUT_TOKENS = 10_000;
export const MAX_TOOL_OUTPUT_TOKENS = 50_000;
export const MIN_TOOL_OUTPUT_TOKENS = 256;

const CHARS_PER_ESTIMATED_TOKEN = 4;
const IMAGE_ESTIMATED_TOKENS = 1_200;
export const TOOL_OUTPUT_TOKEN_PARAMETER = "max_output_tokens";
const OUTPUT_TOKEN_PARAMETER = TOOL_OUTPUT_TOKEN_PARAMETER;

type ToolResultContent = Array<TextContent | ImageContent>;
type SchemaRecord = Record<string, unknown>;
type BudgetParameterMode = "injected" | "native";

// Tool definitions and their TypeBox schemas can be shared between concurrent
// runtimes. Keep injection provenance outside any one runtime controller so a
// later controller does not mistake Forge's own field for a tool-native field.
const injectedBudgetParameterSchemas = new WeakSet<object>();
const instrumentedToolDefinitions = new WeakSet<object>();

export interface RequestedBudget {
  effectiveTokens: number;
  requestedTokens?: number;
}

export interface BoundedToolResultContent {
  content: ToolResultContent;
  truncated: boolean;
  originalEstimatedTokens: number;
  returnedEstimatedTokens: number;
  effectiveMaxOutputTokens: number;
}

export interface ModelVisibleToolResultBudget {
  extensionFactory: ExtensionFactory;
  augmentToolDefinitions(tools: readonly ToolDefinition[]): void;
  augmentExtensions(result: LoadExtensionsResult): LoadExtensionsResult;
  augmentSessionTools(
    session: Pick<AgentSession, "getAllTools" | "getToolDefinition">
      & Partial<Pick<AgentSession, "reload">>,
  ): void;
}

/**
 * Creates one runtime-scoped output governor. The matching extension factory must be
 * loaded last so its message/context handlers see every earlier result transformation.
 */
export function createModelVisibleToolResultBudget(): ModelVisibleToolResultBudget {
  const schemaModes = new WeakMap<object, BudgetParameterMode>();
  const reloadInstrumentedSessions = new WeakSet<object>();
  const toolModes = new Map<string, BudgetParameterMode>();
  const pendingBudgets = new Map<string, RequestedBudget | undefined>();

  const augmentToolDefinition = (tool: ToolDefinition): void => {
    const schema = asRecord(tool.parameters);
    if (!schema) {
      return;
    }

    let mode = schemaModes.get(schema);
    if (!mode) {
      const objectSchemas = findObjectSchemas(schema);
      const targets = objectSchemas.length > 0 ? objectSchemas : makeRootObjectSchema(schema);
      const hasNativeParameter = targets.some((target) => schemaHasNativeOutputBudgetParameter(target));
      mode = hasNativeParameter ? "native" : "injected";

      // A pre-existing field belongs to the tool, including its branch-level
      // semantics. Do not inject Forge metadata into sibling branches where
      // the tool author chose not to accept it.
      if (mode === "injected") {
        for (const target of targets) {
          addOutputBudgetParameter(target);
        }
      }
      schemaModes.set(schema, mode);
    }

    toolModes.set(tool.name, mode);
    if (mode !== "injected" || instrumentedToolDefinitions.has(tool)) {
      return;
    }
    instrumentedToolDefinitions.add(tool);

    const originalPrepareArguments = tool.prepareArguments;
    if (!originalPrepareArguments) {
      return;
    }

    tool.prepareArguments = ((rawArguments: unknown) => {
      const rawRecord = asRecord(rawArguments);
      const requestedTokens = rawRecord?.[OUTPUT_TOKEN_PARAMETER];
      const prepared = originalPrepareArguments(
        rawRecord && Object.hasOwn(rawRecord, OUTPUT_TOKEN_PARAMETER)
          ? omitOutputBudgetParameter(rawRecord)
          : rawArguments,
      );
      const preparedRecord = asRecord(prepared);
      if (requestedTokens === undefined || !preparedRecord) {
        return prepared;
      }
      return {
        ...preparedRecord,
        [OUTPUT_TOKEN_PARAMETER]: requestedTokens,
      };
    }) as ToolDefinition["prepareArguments"];
  };

  const augmentToolDefinitions = (tools: readonly ToolDefinition[]): void => {
    for (const tool of tools) {
      augmentToolDefinition(tool);
    }
  };

  const augmentExtensions = (result: LoadExtensionsResult): LoadExtensionsResult => {
    for (const extension of result.extensions) {
      for (const registeredTool of extension.tools.values()) {
        augmentToolDefinition(registeredTool.definition);
      }
    }
    return result;
  };

  const extensionFactory: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      const input = event.input as Record<string, unknown>;
      const rawRequestedTokens = input[OUTPUT_TOKEN_PARAMETER];
      if (rawRequestedTokens !== undefined) {
        pendingBudgets.set(event.toolCallId, normalizeRequestedBudget(rawRequestedTokens));
      }

      if (toolModes.get(event.toolName) === "injected") {
        delete input[OUTPUT_TOKEN_PARAMETER];
      }
    });

    // Bound ordinary executed results before Pi emits tool_execution_end. The
    // later message_end/context gates remain necessary for immediate failures
    // and for transformations that occur after this hook.
    pi.on("tool_result", (event) => {
      const content = normalizeToolResultContent(event.content);
      const bounded = boundToolResultContent(
        content,
        pendingBudgets.get(event.toolCallId),
      );
      if (!bounded.truncated && content === event.content) {
        return undefined;
      }
      return { content: bounded.content };
    });

    // message_end is the one universal, final boundary for tool-result messages:
    // it also covers unknown tools, validation failures, blocked calls, and
    // aborts, none of which pass through Pi's tool_result hook. Because this
    // factory is last, it also runs after every user/Forge result transform.
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") {
        collectAssistantToolCallBudgets(event.message.content, pendingBudgets);
        return undefined;
      }
      if (event.message.role !== "toolResult") {
        return undefined;
      }

      const requestedBudget = pendingBudgets.get(event.message.toolCallId);
      pendingBudgets.delete(event.message.toolCallId);
      const content = normalizeToolResultContent(event.message.content);
      const bounded = boundToolResultContent(content, requestedBudget);
      if (!bounded.truncated && content === event.message.content) {
        return undefined;
      }
      return {
        message: {
          ...event.message,
          content: bounded.content,
        },
      };
    });

    // Context handlers can replace persisted messages before a provider call.
    // Reapply the governor last so neither a context transform nor old,
    // previously-unbounded history can bypass the model-visible limit.
    pi.on("context", (event) => {
      const contextBudgets = new Map<string, RequestedBudget | undefined>();
      for (const message of event.messages) {
        if (message.role === "assistant") {
          collectAssistantToolCallBudgets(message.content, contextBudgets);
        }
      }

      let modified = false;
      const messages = event.messages.map((message) => {
        if (message.role !== "toolResult") {
          return message;
        }
        const content = normalizeToolResultContent(message.content);
        const bounded = boundToolResultContent(
          content,
          contextBudgets.get(message.toolCallId),
        );
        if (!bounded.truncated && content === message.content) {
          return message;
        }
        modified = true;
        return { ...message, content: bounded.content };
      });
      return modified ? { messages } : undefined;
    });

    const clearPendingBudgets = () => {
      pendingBudgets.clear();
    };
    pi.on("turn_end", clearPendingBudgets);
    pi.on("session_shutdown", () => {
      pendingBudgets.clear();
    });
  };

  return {
    extensionFactory,
    augmentToolDefinitions,
    augmentExtensions,
    augmentSessionTools(session) {
      for (const tool of session.getAllTools()) {
        const definition = session.getToolDefinition(tool.name);
        if (definition) {
          augmentToolDefinition(definition);
        }
      }

      if (reloadInstrumentedSessions.has(session) || typeof session.reload !== "function") {
        return;
      }
      reloadInstrumentedSessions.add(session);
      const originalReload = session.reload.bind(session);
      session.reload = async (...args: Parameters<AgentSession["reload"]>) => {
        await originalReload(...args);
        // Pi rebuilds fresh built-in definitions during reload. Re-augment the
        // active registry before another provider request can be started.
        for (const tool of session.getAllTools()) {
          const definition = session.getToolDefinition(tool.name);
          if (definition) {
            augmentToolDefinition(definition);
          }
        }
      };
    },
  };
}

export function boundToolResultContent(
  content: ToolResultContent,
  requestedBudget?: RequestedBudget,
): BoundedToolResultContent {
  const effectiveMaxOutputTokens = requestedBudget?.effectiveTokens ?? DEFAULT_TOOL_OUTPUT_TOKENS;
  const originalCost = estimateContentCharacterCost(content);
  const originalEstimatedTokens = estimatedTokensFromCharacterCost(originalCost);
  if (originalEstimatedTokens <= effectiveMaxOutputTokens) {
    return {
      content,
      truncated: false,
      originalEstimatedTokens,
      returnedEstimatedTokens: originalEstimatedTokens,
      effectiveMaxOutputTokens,
    };
  }

  const maximumCharacters = effectiveMaxOutputTokens * CHARS_PER_ESTIMATED_TOKEN;
  let receipt = buildTruncationReceipt({
    originalEstimatedTokens,
    omittedEstimatedTokens: Math.max(1, originalEstimatedTokens - effectiveMaxOutputTokens),
    requestedBudget,
  });

  if (receipt.length >= maximumCharacters) {
    const receiptOnly = safeHeadSlice(receipt, maximumCharacters);
    return {
      content: [{ type: "text", text: receiptOnly }],
      truncated: true,
      originalEstimatedTokens,
      returnedEstimatedTokens: estimatedTokensFromCharacterCost(receiptOnly.length),
      effectiveMaxOutputTokens,
    };
  }

  let head: ToolResultContent = [];
  let tail: ToolResultContent = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const payloadBudget = Math.max(0, maximumCharacters - receipt.length);
    const headBudget = Math.ceil(payloadBudget / 2);
    const tailBudget = payloadBudget - headBudget;
    head = takeContentFromHead(content, headBudget);
    tail = takeContentFromTail(content, tailBudget);

    const retainedCost = estimateContentCharacterCost(head) + estimateContentCharacterCost(tail);
    const omittedEstimatedTokens = Math.max(
      1,
      estimatedTokensFromCharacterCost(Math.max(0, originalCost - retainedCost)),
    );
    const nextReceipt = buildTruncationReceipt({
      originalEstimatedTokens,
      omittedEstimatedTokens,
      requestedBudget,
    });
    if (nextReceipt.length === receipt.length) {
      receipt = nextReceipt;
      break;
    }
    receipt = nextReceipt;
  }

  const boundedContent = mergeAdjacentTextBlocks([
    ...head,
    { type: "text", text: receipt },
    ...tail,
  ]);
  const returnedEstimatedTokens = estimateToolResultContentTokens(boundedContent);

  return {
    content: boundedContent,
    truncated: true,
    originalEstimatedTokens,
    returnedEstimatedTokens,
    effectiveMaxOutputTokens,
  };
}

export function estimateToolResultContentTokens(content: ToolResultContent): number {
  return estimatedTokensFromCharacterCost(estimateContentCharacterCost(content));
}

function normalizeRequestedBudget(value: unknown): RequestedBudget {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { effectiveTokens: DEFAULT_TOOL_OUTPUT_TOKENS };
  }
  const requestedTokens = Math.floor(value);
  return {
    requestedTokens,
    effectiveTokens: Math.min(
      MAX_TOOL_OUTPUT_TOKENS,
      Math.max(MIN_TOOL_OUTPUT_TOKENS, requestedTokens),
    ),
  };
}

function findObjectSchemas(schema: SchemaRecord): SchemaRecord[] {
  const found: SchemaRecord[] = [];
  const visited = new Set<object>();

  const visit = (candidate: unknown): void => {
    const record = asRecord(candidate);
    if (!record || visited.has(record)) {
      return;
    }
    visited.add(record);

    if (record.type === "object" || asRecord(record.properties)) {
      found.push(record);
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = record[keyword];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          visit(branch);
        }
      }
    }
  };

  visit(schema);
  return found;
}

function makeRootObjectSchema(schema: SchemaRecord): SchemaRecord[] {
  if (schema.type !== undefined && schema.type !== "object") {
    return [];
  }
  schema.type = "object";
  schema.properties ??= {};
  return [schema];
}

function schemaHasOutputBudgetParameter(schema: SchemaRecord): boolean {
  const properties = asRecord(schema.properties);
  return properties ? Object.hasOwn(properties, OUTPUT_TOKEN_PARAMETER) : false;
}

function schemaHasNativeOutputBudgetParameter(schema: SchemaRecord): boolean {
  const properties = asRecord(schema.properties);
  if (!properties || !Object.hasOwn(properties, OUTPUT_TOKEN_PARAMETER)) {
    return false;
  }
  const parameterSchema = asRecord(properties[OUTPUT_TOKEN_PARAMETER]);
  return !parameterSchema || !injectedBudgetParameterSchemas.has(parameterSchema);
}

function addOutputBudgetParameter(schema: SchemaRecord): void {
  const properties = asRecord(schema.properties) ?? {};
  if (!schemaHasOutputBudgetParameter(schema)) {
    const parameterSchema = {
      type: "integer",
      minimum: MIN_TOOL_OUTPUT_TOKENS,
      description:
        `Output token budget. Defaults to ${DEFAULT_TOOL_OUTPUT_TOKENS} estimated tokens; ` +
        "larger requests may be capped by runtime policy.",
    };
    injectedBudgetParameterSchemas.add(parameterSchema);
    properties[OUTPUT_TOKEN_PARAMETER] = parameterSchema;
  }
  schema.properties = properties;
}

function omitOutputBudgetParameter(input: SchemaRecord): SchemaRecord {
  const copy = { ...input };
  delete copy[OUTPUT_TOKEN_PARAMETER];
  return copy;
}

function estimateContentCharacterCost(content: ToolResultContent): number {
  let characters = 0;
  for (const block of content) {
    characters += block.type === "text"
      ? block.text.length
      : IMAGE_ESTIMATED_TOKENS * CHARS_PER_ESTIMATED_TOKEN;
  }
  return characters;
}

function estimatedTokensFromCharacterCost(characters: number): number {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

function takeContentFromHead(content: ToolResultContent, characterBudget: number): ToolResultContent {
  const selected: ToolResultContent = [];
  let remaining = characterBudget;
  for (const block of content) {
    const cost = block.type === "text"
      ? block.text.length
      : IMAGE_ESTIMATED_TOKENS * CHARS_PER_ESTIMATED_TOKEN;
    if (cost <= remaining) {
      selected.push(block);
      remaining -= cost;
      continue;
    }
    if (block.type === "text" && remaining > 0) {
      const text = safeHeadSlice(block.text, remaining);
      if (text) {
        selected.push({ ...block, text });
      }
    }
    break;
  }
  return selected;
}

function takeContentFromTail(content: ToolResultContent, characterBudget: number): ToolResultContent {
  const selected: ToolResultContent = [];
  let remaining = characterBudget;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index]!;
    const cost = block.type === "text"
      ? block.text.length
      : IMAGE_ESTIMATED_TOKENS * CHARS_PER_ESTIMATED_TOKEN;
    if (cost <= remaining) {
      selected.unshift(block);
      remaining -= cost;
      continue;
    }
    if (block.type === "text" && remaining > 0) {
      const text = safeTailSlice(block.text, remaining);
      if (text) {
        selected.unshift({ ...block, text });
      }
    }
    break;
  }
  return selected;
}

function safeHeadSlice(text: string, maximumLength: number): string {
  let end = Math.min(text.length, Math.max(0, maximumLength));
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function safeTailSlice(text: string, maximumLength: number): string {
  let start = Math.max(0, text.length - Math.max(0, maximumLength));
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  return text.slice(start);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function buildTruncationReceipt(options: {
  originalEstimatedTokens: number;
  omittedEstimatedTokens: number;
  requestedBudget?: RequestedBudget;
}): string {
  const limit = options.requestedBudget?.effectiveTokens ?? DEFAULT_TOOL_OUTPUT_TOKENS;
  let limitSource = `default ${DEFAULT_TOOL_OUTPUT_TOKENS}-token limit`;
  const requested = options.requestedBudget?.requestedTokens;
  if (requested !== undefined) {
    if (requested > MAX_TOOL_OUTPUT_TOKENS) {
      limitSource = `requested ${requested} tokens, capped at ${MAX_TOOL_OUTPUT_TOKENS}`;
    } else if (requested < MIN_TOOL_OUTPUT_TOKENS) {
      limitSource = `requested ${requested} tokens, raised to the ${MIN_TOOL_OUTPUT_TOKENS}-token runtime minimum`;
    } else {
      limitSource = `requested ${limit} tokens`;
    }
  }

  return (
    `\n\n[Forge tool output truncated: omitted approximately ${options.omittedEstimatedTokens} of ` +
    `${options.originalEstimatedTokens} estimated tokens; preserved the head and tail within the ` +
    `${limit}-token budget (${limitSource}). A future call may request max_output_tokens up to ` +
    `${MAX_TOOL_OUTPUT_TOKENS}.]\n\n`
  );
}

function mergeAdjacentTextBlocks(content: ToolResultContent): ToolResultContent {
  const merged: ToolResultContent = [];
  for (const block of content) {
    const previous = merged.at(-1);
    if (block.type === "text" && previous?.type === "text") {
      previous.text += block.text;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function asRecord(value: unknown): SchemaRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SchemaRecord
    : undefined;
}

function normalizeToolResultContent(value: unknown): ToolResultContent {
  if (!Array.isArray(value)) {
    return [];
  }
  const valid = value.filter((block): block is TextContent | ImageContent => {
    const record = asRecord(block);
    if (record?.type === "text") {
      return typeof record.text === "string" && record.text.length > 0;
    }
    return record?.type === "image"
      && typeof record.data === "string"
      && typeof record.mimeType === "string";
  });
  return valid.length === value.length ? value as ToolResultContent : valid;
}

function collectAssistantToolCallBudgets(
  content: unknown,
  budgets: Map<string, RequestedBudget | undefined>,
): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    const record = asRecord(block);
    if (
      record?.type !== "toolCall"
      || typeof record.id !== "string"
      || !record.id
    ) {
      continue;
    }
    const args = asRecord(record.arguments);
    const requested = args?.[OUTPUT_TOKEN_PARAMETER];
    if (requested !== undefined) {
      budgets.set(record.id, normalizeRequestedBudget(requested));
    }
  }
}
