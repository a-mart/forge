import type { ImageContent, TextContent } from "../pi/pi-ai-compat.js";
import {
  convertToLlm,
  serializeConversation,
  type compact as runPiCompaction,
} from "@earendil-works/pi-coding-agent";

type CompactionPreparation = Parameters<typeof runPiCompaction>[0];
type AgentMessage = CompactionPreparation["messagesToSummarize"][number];

type ConvertToLlmFn = (messages: AgentMessage[]) => unknown[];
type SerializeConversationFn = (messages: unknown[]) => string;

interface PiCompactionMeasurementModule {
  convertToLlm: ConvertToLlmFn;
  serializeConversation: SerializeConversationFn;
}

let piCompactionMeasurementModule: PiCompactionMeasurementModule | null | undefined;

function loadPiCompactionMeasurementModule(): PiCompactionMeasurementModule | null {
  if (piCompactionMeasurementModule !== undefined) {
    return piCompactionMeasurementModule;
  }

  try {
    if (typeof convertToLlm !== "function" || typeof serializeConversation !== "function") {
      throw new Error("Pi compaction measurement modules are missing required exports");
    }

    piCompactionMeasurementModule = {
      convertToLlm: convertToLlm as ConvertToLlmFn,
      serializeConversation: serializeConversation as SerializeConversationFn,
    };
  } catch (error) {
    console.warn(
      "[swarm] Pi compaction measurement unavailable; using JSON fallback for prompt sizing:",
      error instanceof Error ? error.message : String(error),
    );
    piCompactionMeasurementModule = null;
  }

  return piCompactionMeasurementModule;
}

export function __resetPiCompactionMeasurementModuleForTests(): void {
  piCompactionMeasurementModule = undefined;
}

export function __forcePiCompactionMeasurementFallbackForTests(): void {
  piCompactionMeasurementModule = null;
}

function fallbackSerializeMessagesForCompactionMeasurement(messages: AgentMessage[]): string {
  return safeStableStringify(messages);
}

type BoundsCategory =
  | "user_message"
  | "assistant_text"
  | "assistant_thinking"
  | "tool_call_args"
  | "tool_result"
  | "custom_message"
  | "bash_output"
  | "image_payload"
  | "base64_payload";

interface CategoryStats {
  items: number;
  truncatedItems: number;
  originalChars: number;
  boundedChars: number;
  omittedChars: number;
}

export interface CompactionBoundingStats {
  maxPromptChars: number;
  conversationChars: {
    historyOriginal: number;
    historyBounded: number;
    turnPrefixOriginal: number;
    turnPrefixBounded: number;
  };
  promptChars: {
    historyOriginal: number;
    historyBounded: number;
    turnPrefixOriginal: number;
    turnPrefixBounded: number;
    maxOriginal: number;
    maxBounded: number;
  };
  estimatedTokens: {
    original: number;
    bounded: number;
  };
  previousSummaryPresent: boolean;
  previousSummaryChars: number;
  customInstructionsPresent: boolean;
  customInstructionsChars: number;
  splitTurn: {
    enabled: boolean;
    messagesToSummarize: number;
    turnPrefixMessages: number;
  };
  truncationCounts: {
    total: number;
    messagesToSummarize: number;
    turnPrefixMessages: number;
    imagePayloads: number;
    base64Payloads: number;
    tiersApplied: number;
    finalTier: number;
    overBudgetAfterBounding: boolean;
  };
  categories: Record<BoundsCategory, CategoryStats>;
}

export interface BoundedCompactionPreparationResult {
  preparation: CompactionPreparation;
  stats: CompactionBoundingStats;
}

interface CompactionBoundingTier {
  userMessageChars: number;
  assistantTextChars: number;
  assistantThinkingChars: number;
  toolCallArgsChars: number;
  toolResultChars: number;
  customMessageChars: number;
  bashOutputChars: number;
  imageMarkerChars: number;
}

export interface CompactionBoundingOptions {
  customInstructions?: string;
  maxPromptChars?: number;
  tiers?: readonly CompactionBoundingTier[];
}

export const DEFAULT_COMPACTION_BOUNDING_MAX_PROMPT_CHARS = 180_000;

export const DEFAULT_COMPACTION_BOUNDING_TIERS: readonly CompactionBoundingTier[] = [
  {
    userMessageChars: 24_000,
    assistantTextChars: 12_000,
    assistantThinkingChars: 2_000,
    toolCallArgsChars: 6_000,
    toolResultChars: 12_000,
    customMessageChars: 12_000,
    bashOutputChars: 10_000,
    imageMarkerChars: 180,
  },
  {
    userMessageChars: 18_000,
    assistantTextChars: 8_000,
    assistantThinkingChars: 1_200,
    toolCallArgsChars: 4_000,
    toolResultChars: 8_000,
    customMessageChars: 8_000,
    bashOutputChars: 6_000,
    imageMarkerChars: 160,
  },
  {
    userMessageChars: 12_000,
    assistantTextChars: 5_000,
    assistantThinkingChars: 700,
    toolCallArgsChars: 2_400,
    toolResultChars: 5_000,
    customMessageChars: 5_000,
    bashOutputChars: 3_600,
    imageMarkerChars: 140,
  },
  {
    userMessageChars: 8_000,
    assistantTextChars: 3_200,
    assistantThinkingChars: 400,
    toolCallArgsChars: 1_600,
    toolResultChars: 3_200,
    customMessageChars: 3_200,
    bashOutputChars: 2_200,
    imageMarkerChars: 120,
  },
  {
    userMessageChars: 4_000,
    assistantTextChars: 1_800,
    assistantThinkingChars: 240,
    toolCallArgsChars: 900,
    toolResultChars: 1_800,
    customMessageChars: 1_800,
    bashOutputChars: 1_200,
    imageMarkerChars: 100,
  },
  {
    userMessageChars: 2_400,
    assistantTextChars: 1_100,
    assistantThinkingChars: 140,
    toolCallArgsChars: 520,
    toolResultChars: 1_100,
    customMessageChars: 1_100,
    bashOutputChars: 720,
    imageMarkerChars: 96,
  },
  {
    userMessageChars: 1_600,
    assistantTextChars: 700,
    assistantThinkingChars: 96,
    toolCallArgsChars: 320,
    toolResultChars: 700,
    customMessageChars: 700,
    bashOutputChars: 420,
    imageMarkerChars: 92,
  },
] as const;

export function boundCompactionPreparation(
  preparation: CompactionPreparation,
  options: CompactionBoundingOptions = {},
): BoundedCompactionPreparationResult {
  const maxPromptChars = options.maxPromptChars ?? DEFAULT_COMPACTION_BOUNDING_MAX_PROMPT_CHARS;
  const tiers = options.tiers ?? DEFAULT_COMPACTION_BOUNDING_TIERS;
  const originalMetrics = measurePreparationPrompts(preparation, options.customInstructions);

  let chosenPreparation = clonePreparation(preparation);
  let chosenStats = createStats({
    originalPreparation: preparation,
    boundedPreparation: chosenPreparation,
    customInstructions: options.customInstructions,
    maxPromptChars,
    originalMetrics,
    boundedMetrics: originalMetrics,
    finalTier: 0,
    tiersApplied: 0,
  });

  for (let index = 0; index < tiers.length; index += 1) {
    const boundedPreparation = applyBoundingTier(preparation, tiers[index]!);
    const boundedMetrics = measurePreparationPrompts(boundedPreparation, options.customInstructions);
    const stats = createStats({
      originalPreparation: preparation,
      boundedPreparation,
      customInstructions: options.customInstructions,
      maxPromptChars,
      originalMetrics,
      boundedMetrics,
      finalTier: index + 1,
      tiersApplied: index + 1,
    });

    chosenPreparation = boundedPreparation;
    chosenStats = stats;

    if (boundedMetrics.maxPromptChars <= maxPromptChars) {
      break;
    }
  }

  if (chosenStats.promptChars.maxBounded > maxPromptChars) {
    const emergencyBaseTier = tiers[tiers.length - 1]!;
    let workingPreparation = chosenPreparation;
    let workingMetrics = measurePreparationPrompts(workingPreparation, options.customInstructions);

    for (let extraStep = 0; extraStep < 8 && workingMetrics.maxPromptChars > maxPromptChars; extraStep += 1) {
      const ratio = Math.max(0.08, maxPromptChars / Math.max(workingMetrics.maxPromptChars, 1));
      const emergencyTier = scaleBoundingTier(emergencyBaseTier, ratio);
      workingPreparation = applyBoundingTier(workingPreparation, emergencyTier);
      workingMetrics = measurePreparationPrompts(workingPreparation, options.customInstructions);
      chosenPreparation = workingPreparation;
      chosenStats = createStats({
        originalPreparation: preparation,
        boundedPreparation: chosenPreparation,
        customInstructions: options.customInstructions,
        maxPromptChars,
        originalMetrics,
        boundedMetrics: workingMetrics,
        finalTier: tiers.length + extraStep + 1,
        tiersApplied: tiers.length + extraStep + 1,
      });
    }
  }

  const aggregatePreparation = applyAggregatePromptBudget(chosenPreparation, options.customInstructions, maxPromptChars);
  const aggregateMetrics = measurePreparationPrompts(aggregatePreparation, options.customInstructions);
  chosenPreparation = aggregatePreparation;
  chosenStats = createStats({
    originalPreparation: preparation,
    boundedPreparation: chosenPreparation,
    customInstructions: options.customInstructions,
    maxPromptChars,
    originalMetrics,
    boundedMetrics: aggregateMetrics,
    finalTier: chosenStats.truncationCounts.finalTier,
    tiersApplied: chosenStats.truncationCounts.tiersApplied,
  });

  chosenStats.truncationCounts.overBudgetAfterBounding = chosenStats.promptChars.maxBounded > maxPromptChars;
  return { preparation: chosenPreparation, stats: chosenStats };
}

interface PromptMetrics {
  historyConversationChars: number;
  historyPromptChars: number;
  turnPrefixConversationChars: number;
  turnPrefixPromptChars: number;
  maxPromptChars: number;
}

interface AggregateProtectionPlan {
  tailCount: number;
  recentUserCount: number;
  preserveFirstUser: boolean;
  preserveLatestSummary: boolean;
}

const HISTORY_AGGREGATE_PROTECTION_PLANS: readonly AggregateProtectionPlan[] = [
  { tailCount: 12, recentUserCount: 3, preserveFirstUser: true, preserveLatestSummary: true },
  { tailCount: 8, recentUserCount: 2, preserveFirstUser: true, preserveLatestSummary: true },
  { tailCount: 4, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: true },
  { tailCount: 2, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: false },
  { tailCount: 1, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: false },
] as const;

const TURN_PREFIX_AGGREGATE_PROTECTION_PLANS: readonly AggregateProtectionPlan[] = [
  { tailCount: 8, recentUserCount: 2, preserveFirstUser: true, preserveLatestSummary: true },
  { tailCount: 4, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: false },
  { tailCount: 2, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: false },
  { tailCount: 1, recentUserCount: 1, preserveFirstUser: true, preserveLatestSummary: false },
] as const;

function applyAggregatePromptBudget(
  preparation: CompactionPreparation,
  customInstructions: string | undefined,
  maxPromptChars: number,
): CompactionPreparation {
  const historyConversationBudget = Math.max(
    0,
    maxPromptChars
      - buildHistoryPromptText({
          conversationText: "",
          previousSummary: preparation.previousSummary,
          customInstructions,
        }).length,
  );
  const turnPrefixConversationBudget = Math.max(0, maxPromptChars - buildTurnPrefixPromptText("").length);

  return {
    ...preparation,
    fileOps: cloneFileOps(preparation.fileOps),
    settings: { ...preparation.settings },
    messagesToSummarize: reduceMessageCollectionToConversationBudget({
      messages: preparation.messagesToSummarize,
      conversationBudgetChars: historyConversationBudget,
      collectionLabel: "messagesToSummarize",
      protectionPlans: HISTORY_AGGREGATE_PROTECTION_PLANS,
    }),
    turnPrefixMessages: preparation.isSplitTurn
      ? reduceMessageCollectionToConversationBudget({
          messages: preparation.turnPrefixMessages,
          conversationBudgetChars: turnPrefixConversationBudget,
          collectionLabel: "turnPrefixMessages",
          protectionPlans: TURN_PREFIX_AGGREGATE_PROTECTION_PLANS,
        })
      : preparation.turnPrefixMessages.slice(),
  };
}

function reduceMessageCollectionToConversationBudget(options: {
  messages: AgentMessage[];
  conversationBudgetChars: number;
  collectionLabel: "messagesToSummarize" | "turnPrefixMessages";
  protectionPlans: readonly AggregateProtectionPlan[];
}): AgentMessage[] {
  if (options.messages.length === 0) {
    return [];
  }

  if (options.conversationBudgetChars <= 0) {
    return [];
  }

  if (serializeMessages(options.messages).length <= options.conversationBudgetChars) {
    return options.messages.slice();
  }

  let best = options.messages.slice();
  for (const plan of options.protectionPlans) {
    const protectedIndexes = buildAggregateProtectedIndexes(options.messages, plan);
    const removalCandidates = buildAggregateRemovalCandidates(options.messages, protectedIndexes);
    const removedIndexes = new Set<number>();

    for (const removalIndex of removalCandidates) {
      removedIndexes.add(removalIndex);
      const reduced = materializeAggregateReducedMessages(options.messages, removedIndexes, options.collectionLabel);
      best = reduced;
      if (serializeMessages(reduced).length <= options.conversationBudgetChars) {
        return reduced;
      }
    }

    const fullyReduced = materializeAggregateReducedMessages(options.messages, removedIndexes, options.collectionLabel);
    best = fullyReduced;
    if (serializeMessages(fullyReduced).length <= options.conversationBudgetChars) {
      return fullyReduced;
    }
  }

  return best;
}

function buildAggregateProtectedIndexes(
  messages: AgentMessage[],
  plan: AggregateProtectionPlan,
): Set<number> {
  const protectedIndexes = new Set<number>();
  const tailStart = Math.max(0, messages.length - plan.tailCount);
  for (let index = tailStart; index < messages.length; index += 1) {
    protectedIndexes.add(index);
  }

  if (plan.preserveFirstUser) {
    const firstUserIndex = messages.findIndex((message) => message.role === "user");
    if (firstUserIndex >= 0) {
      protectedIndexes.add(firstUserIndex);
    }
  }

  if (plan.recentUserCount > 0) {
    let preserved = 0;
    for (let index = messages.length - 1; index >= 0 && preserved < plan.recentUserCount; index -= 1) {
      if (messages[index]?.role === "user") {
        protectedIndexes.add(index);
        preserved += 1;
      }
    }
  }

  if (plan.preserveLatestSummary) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "branchSummary" || messages[index]?.role === "compactionSummary") {
        protectedIndexes.add(index);
        break;
      }
    }
  }

  return protectedIndexes;
}

function buildAggregateRemovalCandidates(messages: AgentMessage[], protectedIndexes: Set<number>): number[] {
  const candidates: Array<{ index: number; priority: number }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (protectedIndexes.has(index)) {
      continue;
    }
    candidates.push({ index, priority: aggregateRemovalPriority(messages[index]!) });
  }

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.index - right.index;
  });
  return candidates.map((candidate) => candidate.index);
}

function aggregateRemovalPriority(message: AgentMessage): number {
  switch (message.role) {
    case "toolResult":
    case "custom":
    case "bashExecution":
      return 0;
    case "assistant":
      return 1;
    case "branchSummary":
    case "compactionSummary":
      return 2;
    case "user":
      return 3;
    default:
      return 4;
  }
}

function materializeAggregateReducedMessages(
  messages: AgentMessage[],
  removedIndexes: Set<number>,
  collectionLabel: "messagesToSummarize" | "turnPrefixMessages",
): AgentMessage[] {
  if (removedIndexes.size === 0) {
    return messages.slice();
  }

  const reduced: AgentMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    if (!removedIndexes.has(index)) {
      reduced.push(messages[index]!);
      index += 1;
      continue;
    }

    const omitted: AgentMessage[] = [];
    while (index < messages.length && removedIndexes.has(index)) {
      omitted.push(messages[index]!);
      index += 1;
    }

    if (omitted.length > 0) {
      reduced.push(buildAggregateOmissionMessage(omitted, collectionLabel));
    }
  }

  return reduced;
}

function buildAggregateOmissionMessage(
  omittedMessages: AgentMessage[],
  collectionLabel: "messagesToSummarize" | "turnPrefixMessages",
): AgentMessage {
  const roleCounts = new Map<string, number>();
  for (const message of omittedMessages) {
    roleCounts.set(message.role, (roleCounts.get(message.role) ?? 0) + 1);
  }

  const roleSummary = Array.from(roleCounts.entries())
    .map(([role, count]) => `${role}:${count}`)
    .join(", ");
  const firstTimestamp = readMessageTimestamp(omittedMessages[0]);
  const lastTimestamp = readMessageTimestamp(omittedMessages[omittedMessages.length - 1]);
  const text = [
    `[forge compaction omitted ${omittedMessages.length} ${collectionLabel} message${omittedMessages.length === 1 ? "" : "s"} to stay within the prompt budget]`,
    roleSummary ? `roles=${roleSummary}` : undefined,
    firstTimestamp !== undefined || lastTimestamp !== undefined
      ? `timestamps=${firstTimestamp ?? "unknown"}..${lastTimestamp ?? "unknown"}`
      : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");

  return {
    role: "custom",
    customType: "forge_compaction_aggregate_omission",
    content: [{ type: "text", text: text.length <= 240 ? text : `${text.slice(0, 237)}...` }],
    display: false,
    timestamp: lastTimestamp ?? firstTimestamp ?? 0,
  } as AgentMessage;
}

function readMessageTimestamp(message: AgentMessage | undefined): number | undefined {
  if (!message) {
    return undefined;
  }
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
}

function applyBoundingTier(
  preparation: CompactionPreparation,
  tier: CompactionBoundingTier,
): CompactionPreparation {
  return {
    ...preparation,
    fileOps: cloneFileOps(preparation.fileOps),
    settings: { ...preparation.settings },
    messagesToSummarize: preparation.messagesToSummarize.map((message) =>
      boundMessage(message, "messagesToSummarize", tier),
    ),
    turnPrefixMessages: preparation.turnPrefixMessages.map((message) =>
      boundMessage(message, "turnPrefixMessages", tier),
    ),
  };
}

function boundMessage(
  message: AgentMessage,
  collection: "messagesToSummarize" | "turnPrefixMessages",
  tier: CompactionBoundingTier,
): AgentMessage {
  switch (message.role) {
    case "user":
      return {
        ...message,
        content: boundContent(message.content, collection, tier, "user_message", tier.userMessageChars),
      };

    case "assistant":
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type === "text") {
            return {
              ...block,
              text: boundTextField(block.text, "assistant_text", tier.assistantTextChars),
            };
          }
          if (block.type === "thinking") {
            return {
              ...block,
              thinking: boundTextField(block.thinking, "assistant_thinking", tier.assistantThinkingChars),
            };
          }
          if (block.type === "toolCall") {
            return {
              ...block,
              arguments: boundJsonValue(block.arguments, tier.toolCallArgsChars) as Record<string, unknown>,
            };
          }
          return block;
        }),
      };

    case "toolResult":
      return {
        ...message,
        content: boundContent(message.content, collection, tier, "tool_result", tier.toolResultChars),
      } as AgentMessage;

    case "custom":
      return {
        ...message,
        content: boundContent(message.content, collection, tier, "custom_message", tier.customMessageChars),
      } as AgentMessage;

    case "bashExecution":
      return {
        ...message,
        command: boundTextField(message.command, "user_message", Math.min(tier.userMessageChars, 2_000)),
        output: boundTextField(message.output, "bash_output", tier.bashOutputChars),
      };

    case "branchSummary":
    case "compactionSummary":
      return {
        ...message,
        summary: boundTextField(message.summary, "custom_message", tier.customMessageChars),
      };

    default:
      return message;
  }
}

function boundContent(
  content: string | (TextContent | ImageContent)[],
  collection: "messagesToSummarize" | "turnPrefixMessages",
  tier: CompactionBoundingTier,
  category: Exclude<BoundsCategory, "assistant_thinking" | "assistant_text" | "tool_call_args" | "bash_output" | "image_payload" | "base64_payload">,
  maxChars: number,
): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") {
    return boundTextField(content, category, maxChars);
  }

  return content.map((block) => {
    if (block.type === "text") {
      return {
        ...block,
        text: boundTextField(block.text, category, maxChars),
      } satisfies TextContent;
    }

    return {
      type: "text",
      text: imageMarker(block, tier.imageMarkerChars, collection),
    } satisfies TextContent;
  });
}

function boundTextField(text: string, category: BoundsCategory, maxChars: number): string {
  const payloadKind = detectPayloadKind(text);
  if (payloadKind) {
    return payloadMarker(payloadKind, text);
  }

  if (text.length <= maxChars) {
    return text;
  }

  return headTail(text, maxChars, category);
}

function boundJsonValue(value: unknown, maxSerializedChars: number): unknown {
  if (value && typeof value === "object" && "__forge_compaction_truncated_args" in value) {
    return value;
  }

  const sanitized = sanitizeStructuredValue(value, Math.min(maxSerializedChars, 2_000));
  const bounded = safeStableStringify(sanitized);

  if (bounded.length <= maxSerializedChars) {
    return sanitized;
  }

  const truncated = headTail(bounded, maxSerializedChars, "tool_call_args");
  const payloadMarkers = extractPayloadMarkers(bounded);
  return {
    __forge_compaction_truncated_args: truncated,
    ...(payloadMarkers.length > 0 ? { __forge_compaction_payloads: payloadMarkers } : {}),
  };
}

function extractPayloadMarkers(serialized: string): string[] {
  const markers: string[] = [];
  for (const marker of ["[forge compaction omitted image payload", "[forge compaction omitted base64 payload"]) {
    if (serialized.includes(marker)) {
      markers.push(marker);
    }
  }
  return markers;
}

function sanitizeStructuredValue(value: unknown, maxStringChars: number, depth = 0): unknown {
  if (typeof value === "string") {
    const payloadKind = detectPayloadKind(value);
    if (payloadKind) {
      return payloadMarker(payloadKind, value);
    }
    if (value.length <= maxStringChars) {
      return value;
    }
    return headTail(value, maxStringChars, "tool_call_args");
  }

  if (Array.isArray(value)) {
    const bounded = value.map((entry) => sanitizeStructuredValue(entry, maxStringChars, depth + 1));
    if (bounded.length <= 12) {
      return bounded;
    }
    const head = bounded.slice(0, 8);
    const tail = bounded.slice(-3);
    return [...head, `[forge compaction omitted ${bounded.length - 11} array items]`, ...tail];
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries.length <= 24
      ? entries
      : [
          ...entries.slice(0, 16),
          ["__forgeCompactionOmittedKeys", entries.length - 20],
          ...entries.slice(-4),
        ];

    const next: Record<string, unknown> = {};
    for (const [key, entryValue] of limitedEntries) {
      next[key] = depth >= 8 ? `[forge compaction truncated nested value depth=${depth}]` : sanitizeStructuredValue(entryValue, maxStringChars, depth + 1);
    }
    return next;
  }

  return value;
}

function detectPayloadKind(value: string): "image_payload" | "base64_payload" | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 512) {
    return undefined;
  }

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
    return "image_payload";
  }

  if (/^data:[^\n]+;base64,/i.test(trimmed)) {
    return "base64_payload";
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 1_024) {
    return undefined;
  }

  const sample = compact.slice(0, Math.min(compact.length, 4_096));
  const looksBase64Alphabet = /^[A-Za-z0-9+/=]+$/.test(sample) && sample.length / compact.length > 0.6;
  const hasBase64SignalChars = /[+/=]/.test(sample)
    || /\d/.test(sample)
    || (/[a-z]/.test(sample) && /[A-Z]/.test(sample));
  const charCounts = new Map<string, number>();
  for (const char of sample) {
    charCounts.set(char, (charCounts.get(char) ?? 0) + 1);
  }
  const maxCharShare = Math.max(...charCounts.values()) / sample.length;
  if (looksBase64Alphabet && hasBase64SignalChars && maxCharShare < 0.4) {
    return "base64_payload";
  }

  return undefined;
}

function payloadMarker(kind: "image_payload" | "base64_payload", value: string): string {
  if (kind === "image_payload") {
    const mimeMatch = value.trim().match(/^data:([^;,]+)[;,]/i);
    const mimeType = mimeMatch?.[1] ?? "image/*";
    return `[forge compaction omitted image payload: mimeType=${mimeType}; originalChars=${value.length}]`;
  }

  return `[forge compaction omitted base64 payload: originalChars=${value.length}]`;
}

function imageMarker(
  block: ImageContent,
  maxChars: number,
  _collection: "messagesToSummarize" | "turnPrefixMessages",
): string {
  const marker = `[forge compaction omitted image payload: mimeType=${block.mimeType}; originalChars=${block.data.length}]`;
  return marker.length <= maxChars ? marker : marker.slice(0, maxChars);
}

function headTail(text: string, maxChars: number, category: BoundsCategory): string {
  const markerOnly = `[forge compaction truncated ${category}: originalChars=${text.length}]`;
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= markerOnly.length + 12) {
    return markerOnly.slice(0, maxChars);
  }

  let headWeight = 0.65;
  if (category === "user_message") headWeight = 0.78;
  if (category === "tool_result" || category === "bash_output") headWeight = 0.58;
  if (category === "assistant_thinking") headWeight = 0.72;

  let head = Math.max(16, Math.ceil((maxChars - markerOnly.length) * headWeight));
  let tail = Math.max(8, maxChars - markerOnly.length - head);
  if (head + tail >= text.length) {
    tail = Math.max(0, text.length - head - 1);
  }

  while (head + tail < text.length) {
    const omittedChars = text.length - head - tail;
    const marker = `\n\n[forge compaction truncated ${category}: omittedChars=${omittedChars}]\n\n`;
    const total = head + tail + marker.length;
    if (total <= maxChars) {
      return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`;
    }
    if (head >= tail && head > 16) {
      head -= 1;
      continue;
    }
    if (tail > 8) {
      tail -= 1;
      continue;
    }
    return markerOnly.slice(0, maxChars);
  }

  return markerOnly.slice(0, maxChars);
}

function measurePreparationPrompts(
  preparation: CompactionPreparation,
  customInstructions: string | undefined,
): PromptMetrics {
  const historyConversation = serializeMessages(preparation.messagesToSummarize);
  const turnPrefixConversation = serializeMessages(preparation.turnPrefixMessages);

  const historyPromptChars = historyConversation.length > 0 || Boolean(preparation.previousSummary) || Boolean(customInstructions?.trim())
    ? buildHistoryPromptText({
        conversationText: historyConversation,
        previousSummary: preparation.previousSummary,
        customInstructions,
      }).length
    : 0;

  const turnPrefixPromptChars = turnPrefixConversation.length > 0 && preparation.isSplitTurn
    ? buildTurnPrefixPromptText(turnPrefixConversation).length
    : 0;

  return {
    historyConversationChars: historyConversation.length,
    historyPromptChars,
    turnPrefixConversationChars: turnPrefixConversation.length,
    turnPrefixPromptChars,
    maxPromptChars: Math.max(historyPromptChars, turnPrefixPromptChars),
  };
}

export function serializeMessagesForCompactionMeasurement(messages: AgentMessage[]): string {
  const measurementModule = loadPiCompactionMeasurementModule();
  if (!measurementModule) {
    return fallbackSerializeMessagesForCompactionMeasurement(messages);
  }

  return measurementModule.serializeConversation(measurementModule.convertToLlm(messages));
}

function serializeMessages(messages: AgentMessage[]): string {
  return serializeMessagesForCompactionMeasurement(messages);
}

function buildHistoryPromptText(options: {
  conversationText: string;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  let basePrompt = options.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (options.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${options.customInstructions}`;
  }

  let promptText = `<conversation>\n${options.conversationText}\n</conversation>\n\n`;
  if (options.previousSummary) {
    promptText += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;
  return promptText;
}

function buildTurnPrefixPromptText(conversationText: string): string {
  return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

function createStats(options: {
  originalPreparation: CompactionPreparation;
  boundedPreparation: CompactionPreparation;
  customInstructions: string | undefined;
  maxPromptChars: number;
  originalMetrics: PromptMetrics;
  boundedMetrics: PromptMetrics;
  finalTier: number;
  tiersApplied: number;
}): CompactionBoundingStats {
  const categories = collectCategoryStats(options.boundedPreparation);
  const truncationCounts = summarizeTruncationCounts(options.boundedPreparation, categories);

  return {
    maxPromptChars: options.maxPromptChars,
    conversationChars: {
      historyOriginal: options.originalMetrics.historyConversationChars,
      historyBounded: options.boundedMetrics.historyConversationChars,
      turnPrefixOriginal: options.originalMetrics.turnPrefixConversationChars,
      turnPrefixBounded: options.boundedMetrics.turnPrefixConversationChars,
    },
    promptChars: {
      historyOriginal: options.originalMetrics.historyPromptChars,
      historyBounded: options.boundedMetrics.historyPromptChars,
      turnPrefixOriginal: options.originalMetrics.turnPrefixPromptChars,
      turnPrefixBounded: options.boundedMetrics.turnPrefixPromptChars,
      maxOriginal: options.originalMetrics.maxPromptChars,
      maxBounded: options.boundedMetrics.maxPromptChars,
    },
    estimatedTokens: {
      original: estimateTokens(options.originalMetrics.maxPromptChars),
      bounded: estimateTokens(options.boundedMetrics.maxPromptChars),
    },
    previousSummaryPresent: Boolean(options.originalPreparation.previousSummary),
    previousSummaryChars: options.originalPreparation.previousSummary?.length ?? 0,
    customInstructionsPresent: Boolean(options.customInstructions?.trim()),
    customInstructionsChars: options.customInstructions?.length ?? 0,
    splitTurn: {
      enabled: options.originalPreparation.isSplitTurn,
      messagesToSummarize: options.originalPreparation.messagesToSummarize.length,
      turnPrefixMessages: options.originalPreparation.turnPrefixMessages.length,
    },
    truncationCounts: {
      ...truncationCounts,
      tiersApplied: options.tiersApplied,
      finalTier: options.finalTier,
      overBudgetAfterBounding: false,
    },
    categories,
  };
}

function collectCategoryStats(preparation: CompactionPreparation): Record<BoundsCategory, CategoryStats> {
  const categories = createEmptyCategories();
  for (const message of preparation.messagesToSummarize) {
    collectMessageStats(message, categories);
  }
  for (const message of preparation.turnPrefixMessages) {
    collectMessageStats(message, categories);
  }
  return categories;
}

function collectMessageStats(
  message: AgentMessage,
  categories: Record<BoundsCategory, CategoryStats>,
): void {
  switch (message.role) {
    case "user":
      collectContentStats(message.content, "user_message", categories);
      return;
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") {
          recordTextStats(categories.assistant_text, block.text, "assistant_text", undefined, categories);
          continue;
        }
        if (block.type === "thinking") {
          recordTextStats(categories.assistant_thinking, block.thinking, "assistant_thinking", undefined, categories);
          continue;
        }
        if (block.type === "toolCall") {
          collectStructuredValueStats(block.arguments, categories);
        }
      }
      return;
    case "toolResult":
      collectContentStats(message.content, "tool_result", categories);
      return;
    case "custom":
      collectContentStats(message.content, "custom_message", categories);
      return;
    case "bashExecution":
      recordTextStats(categories.user_message, message.command, "user_message", undefined, categories);
      recordTextStats(categories.bash_output, message.output, "bash_output", undefined, categories);
      return;
    case "branchSummary":
    case "compactionSummary":
      recordTextStats(categories.custom_message, message.summary, "custom_message", undefined, categories);
      break;
    default:
      break;
  }
}

function collectStructuredValueStats(
  value: unknown,
  categories: Record<BoundsCategory, CategoryStats>,
  depth = 0,
): void {
  if (depth > 12) {
    recordTextStats(categories.tool_call_args, "[forge compaction truncated nested value depth]", "tool_call_args", undefined, categories);
  } else if (typeof value === "string") {
    recordTextStats(categories.tool_call_args, value, "tool_call_args", undefined, categories);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectStructuredValueStats(entry, categories, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      recordTextStats(categories.tool_call_args, key, "tool_call_args", undefined, categories);
      collectStructuredValueStats(entryValue, categories, depth + 1);
    }
  } else if (value !== undefined) {
    recordTextStats(categories.tool_call_args, String(value), "tool_call_args", undefined, categories);
  }
}

function collectContentStats(
  content: string | (TextContent | ImageContent)[],
  category: "user_message" | "tool_result" | "custom_message",
  categories: Record<BoundsCategory, CategoryStats>,
): void {
  if (typeof content === "string") {
    recordTextStats(categories[category], content, category, undefined, categories);
    return;
  }

  for (const block of content) {
    if (block.type === "text") {
      recordTextStats(categories[category], block.text, category, undefined, categories);
      continue;
    }
    recordTextStats(categories.image_payload, imageMarker(block, 10_000, "messagesToSummarize"), "image_payload", block.data.length);
  }
}

function recordTextStats(
  target: CategoryStats,
  value: string,
  category: BoundsCategory,
  originalCharsOverride?: number,
  categories?: Record<BoundsCategory, CategoryStats>,
): void {
  const originalChars = originalCharsOverride ?? readOriginalCharsFromMarker(value) ?? value.length;
  const payloadKind = readPayloadKindFromMarker(value) ?? detectPayloadKind(value);
  const truncated = payloadKind !== undefined || value.includes(`[forge compaction truncated ${category}:`) || value.includes("[forge compaction omitted ");
  target.items += 1;
  target.originalChars += originalChars;
  target.boundedChars += value.length;
  target.omittedChars += Math.max(0, originalChars - value.length);
  if (truncated) {
    target.truncatedItems += 1;
  }

  if (categories) {
    const embeddedPayloadKinds: Array<"image_payload" | "base64_payload"> = [];
    if (payloadKind) {
      embeddedPayloadKinds.push(payloadKind);
    }
    if (!payloadKind && value.includes("[forge compaction omitted image payload:")) {
      embeddedPayloadKinds.push("image_payload");
    }
    if (!payloadKind && value.includes("[forge compaction omitted base64 payload:")) {
      embeddedPayloadKinds.push("base64_payload");
    }

    for (const embeddedPayloadKind of embeddedPayloadKinds) {
      const payloadTarget = categories[embeddedPayloadKind];
      payloadTarget.items += 1;
      payloadTarget.originalChars += originalChars;
      payloadTarget.boundedChars += value.length;
      payloadTarget.omittedChars += Math.max(0, originalChars - value.length);
      payloadTarget.truncatedItems += 1;
    }
  }
}

function readPayloadKindFromMarker(value: string): "image_payload" | "base64_payload" | undefined {
  if (value.startsWith("[forge compaction omitted image payload:")) {
    return "image_payload";
  }
  if (value.startsWith("[forge compaction omitted base64 payload:")) {
    return "base64_payload";
  }
  return undefined;
}

function readOriginalCharsFromMarker(value: string): number | undefined {
  const match = value.match(/originalChars=(\d+)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarizeTruncationCounts(
  preparation: CompactionPreparation,
  categories: Record<BoundsCategory, CategoryStats>,
): Omit<CompactionBoundingStats["truncationCounts"], "tiersApplied" | "finalTier" | "overBudgetAfterBounding"> {
  return {
    total: Object.values(categories).reduce((sum, category) => sum + category.truncatedItems, 0),
    messagesToSummarize: countTruncatedMessages(preparation.messagesToSummarize),
    turnPrefixMessages: countTruncatedMessages(preparation.turnPrefixMessages),
    imagePayloads: categories.image_payload.truncatedItems,
    base64Payloads: categories.base64_payload.truncatedItems,
  };
}

function countTruncatedMessages(messages: AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (safeStableStringify(message).includes("[forge compaction truncated") || safeStableStringify(message).includes("[forge compaction omitted ")) {
      count += 1;
    }
  }
  return count;
}

function createEmptyCategories(): Record<BoundsCategory, CategoryStats> {
  return {
    user_message: emptyCategoryStats(),
    assistant_text: emptyCategoryStats(),
    assistant_thinking: emptyCategoryStats(),
    tool_call_args: emptyCategoryStats(),
    tool_result: emptyCategoryStats(),
    custom_message: emptyCategoryStats(),
    bash_output: emptyCategoryStats(),
    image_payload: emptyCategoryStats(),
    base64_payload: emptyCategoryStats(),
  };
}

function emptyCategoryStats(): CategoryStats {
  return { items: 0, truncatedItems: 0, originalChars: 0, boundedChars: 0, omittedChars: 0 };
}

function scaleBoundingTier(baseTier: CompactionBoundingTier, ratio: number): CompactionBoundingTier {
  return {
    userMessageChars: clampScaled(Math.floor(baseTier.userMessageChars * Math.max(ratio, 0.42)), 480, baseTier.userMessageChars),
    assistantTextChars: clampScaled(Math.floor(baseTier.assistantTextChars * ratio), 180, baseTier.assistantTextChars),
    assistantThinkingChars: clampScaled(Math.floor(baseTier.assistantThinkingChars * ratio), 48, baseTier.assistantThinkingChars),
    toolCallArgsChars: clampScaled(Math.floor(baseTier.toolCallArgsChars * ratio), 180, baseTier.toolCallArgsChars),
    toolResultChars: clampScaled(Math.floor(baseTier.toolResultChars * ratio), 180, baseTier.toolResultChars),
    customMessageChars: clampScaled(Math.floor(baseTier.customMessageChars * ratio), 180, baseTier.customMessageChars),
    bashOutputChars: clampScaled(Math.floor(baseTier.bashOutputChars * ratio), 160, baseTier.bashOutputChars),
    imageMarkerChars: clampScaled(Math.floor(baseTier.imageMarkerChars * Math.max(ratio, 0.92)), 88, baseTier.imageMarkerChars),
  };
}

function clampScaled(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clonePreparation(preparation: CompactionPreparation): CompactionPreparation {
  return {
    ...preparation,
    fileOps: cloneFileOps(preparation.fileOps),
    settings: { ...preparation.settings },
    messagesToSummarize: preparation.messagesToSummarize.slice(),
    turnPrefixMessages: preparation.turnPrefixMessages.slice(),
  };
}

function cloneFileOps(fileOps: CompactionPreparation["fileOps"]): CompactionPreparation["fileOps"] {
  return {
    read: new Set(fileOps.read),
    written: new Set(fileOps.written),
    edited: new Set(fileOps.edited),
  };
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (nestedValue instanceof Set) {
        return Array.from(nestedValue).sort();
      }
      return nestedValue;
    }) ?? "";
  } catch {
    return "[unserializable]";
  }
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
