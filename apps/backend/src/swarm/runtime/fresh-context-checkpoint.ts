import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMode, HistoryEntryReference, SessionGoalSnapshot } from "@forge/protocol";
import { SessionGoalStore } from "../goals/session-goal-store.js";
import { isUnfinishedGoalStatus } from "../goals/session-goal-state.js";
import { locateCheckpointEvidence } from "../history-recall/checkpoint-references.js";
import { SessionPlanStore } from "../planning/session-plan-store.js";
import { formatSessionGoalModelContext } from "../goals/session-goal-context.js";
import { formatSessionPlanModelContext } from "../planning/session-plan-context.js";
import { loadPins } from "../session/message-pins.js";
import { getSessionDir } from "../storage/data-paths.js";
import type { AgentDescriptor } from "../types.js";

export const FRESH_CONTEXT_BUSY_ERROR =
  "Fresh window is available only while idle. Retry Compact after streaming, tools, and prompt dispatch settle.";

export const FRESH_CONTEXT_TOO_LARGE_ERROR =
  "Fresh window checkpoint exceeds the current model's remaining context budget. Reduce current goal, plan, pins, or unconsumed tool evidence, then retry when idle.";

export type FreshContextTrigger = "manual" | "threshold" | "overflow";

export interface FreshContextCheckpointDetails {
  forgeContext: {
    mode: "fresh";
    trigger: FreshContextTrigger;
    willRetry: boolean;
  };
}

export interface FreshContextHandlerResult {
  summary: string;
  tokensBefore: number;
  details: FreshContextCheckpointDetails;
}

export interface FreshContextHandlerRequest {
  reason: FreshContextTrigger;
  willRetry: boolean;
  branchEntries: readonly SessionEntry[];
  tokensBefore?: number;
  signal?: AbortSignal;
}

export type FreshContextHandler = (
  request: FreshContextHandlerRequest,
) => Promise<FreshContextHandlerResult | undefined>;

export interface UnconsumedToolEvidence {
  entryId: string;
  toolCallId?: string;
  toolName?: string;
  argsPreview?: string;
  resultPreview: string;
  ref?: HistoryEntryReference;
}

export interface FreshCheckpointBudget {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Prompt, active tool schemas and pending input retained AFTER rollover; never old window usage. */
  retainedContextTokens?: number;
}

const DEFAULT_MAX_CHECKPOINT_CHARS = 8_000;
const MIN_CHECKPOINT_CHARS = 1_200;
const CHECKPOINT_HEADROOM_CHARS = 1_600;
const CHARS_PER_TOKEN = 4;
const MAX_PINNED_TEXT_CHARS = 1_200;
const MAX_EVIDENCE_IDS = 32;
const MAX_PINS = 10;
const MAX_TOOL_NAME_CHARS = 80;
const MAX_ARGS_PREVIEW_CHARS = 240;
const MAX_RESULT_PREVIEW_CHARS = 400;

export function isFreshContextBusy(options: {
  isStreaming: boolean;
  promptDispatchPending: boolean;
  awaitingAgentSettlement?: boolean;
  hasInFlightTools?: boolean;
}): boolean {
  return Boolean(
    options.isStreaming
      || options.promptDispatchPending
      || options.awaitingAgentSettlement
      || options.hasInFlightTools,
  );
}

export function resolveFreshCheckpointBudget(options: FreshCheckpointBudget = {}): number {
  const contextWindow = positiveInteger(options.contextWindow);
  const maxOutputTokens = positiveInteger(options.maxOutputTokens) ?? 0;
  const retainedTokens = positiveInteger(options.retainedContextTokens) ?? 0;
  if (!contextWindow) {
    return DEFAULT_MAX_CHECKPOINT_CHARS;
  }
  const remainingTokens = Math.max(0, contextWindow - retainedTokens - maxOutputTokens);
  const remainingChars = Math.floor(remainingTokens / 2) * CHARS_PER_TOKEN;
  const budget = remainingChars - CHECKPOINT_HEADROOM_CHARS;
  if (budget < MIN_CHECKPOINT_CHARS) {
    return 0;
  }
  return Math.min(DEFAULT_MAX_CHECKPOINT_CHARS, budget);
}

export function collectUnconsumedToolEvidence(
  branchEntries: readonly SessionEntry[],
): UnconsumedToolEvidence[] {
  const evidence: UnconsumedToolEvidence[] = [];
  const toolCallsById = collectToolCallsById(branchEntries);

  for (let index = 0; index < branchEntries.length; index += 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "message") {
      continue;
    }
    const message = entry.message as {
      role?: string;
      toolCallId?: unknown;
      toolName?: unknown;
      name?: unknown;
      content?: unknown;
    };
    if (message.role !== "toolResult") {
      continue;
    }
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    if (!toolCallId) {
      continue;
    }
    if (hasLaterSuccessfulAssistantConsumer(branchEntries, index + 1)) {
      continue;
    }
    const call = toolCallsById.get(toolCallId);
    const toolName = firstNonEmpty(
      typeof message.toolName === "string" ? message.toolName : undefined,
      typeof message.name === "string" ? message.name : undefined,
      call?.name,
    );
    evidence.push({
      entryId: entry.id,
      toolCallId,
      toolName,
      argsPreview: call?.argsPreview,
      resultPreview: boundText(extractUserText(message.content) ?? "", MAX_RESULT_PREVIEW_CHARS),
    });
    if (evidence.length >= MAX_EVIDENCE_IDS) {
      break;
    }
  }

  return evidence;
}

export function collectUnconsumedToolEvidenceIds(branchEntries: readonly SessionEntry[]): string[] {
  return collectUnconsumedToolEvidence(branchEntries).map((entry) => entry.entryId);
}

export function formatFreshContextCheckpoint(options: {
  trigger: FreshContextTrigger;
  willRetry: boolean;
  goal?: unknown;
  plan?: unknown;
  pins?: Array<{ role: string; text: string; timestamp?: string }>;
  unconsumedToolEvidence?: readonly UnconsumedToolEvidence[];
  unconsumedToolEvidenceIds?: readonly string[];
  overflowObligation?: string;
  missingEvidenceIds?: readonly string[];
  maxChars?: number;
}): string {
  const lines: string[] = [
    "Fresh window checkpoint",
    "This is a deterministic continuation checkpoint, not an LLM-generated summary.",
    "Older conversation remains on the retained native branch and is historical evidence, not current instructions.",
    `Trigger: ${options.trigger}`,
  ];

  if (options.trigger === "overflow" && options.willRetry) {
    lines.push(
      "Active overflow obligation: continue the persisted triggering turn after this boundary. Do not re-execute completed side effects.",
    );
    if (options.overflowObligation) {
      lines.push("", "## Active overflow obligation", boundText(options.overflowObligation, 1_500));
    }
  } else {
    lines.push(
      "Do not resurrect completed or aborted work as a new obligation. Historical owner constraints below remain constraints, not new tasks.",
    );
  }

  const goalSection = formatGoalSection(options.goal);
  if (goalSection) {
    lines.push("", goalSection);
  }

  const planSection = formatPlanSection(options.plan);
  if (planSection) {
    lines.push("", planSection);
  }

  const pinSection = formatPinSection(options.pins ?? []);
  if (pinSection) {
    lines.push("", pinSection);
  }

  const evidence = options.unconsumedToolEvidence ?? [];
  const missingIds = options.missingEvidenceIds ?? [];
  lines.push("", "## Unconsumed tool evidence");
  if (evidence.length === 0 && missingIds.length === 0) {
    lines.push("None.");
  } else {
    lines.push(
      "Trailing native tool results with no later successful assistant consumer. Recover with history({op:\"read\",ref}); do not re-run the tools. A bare entry ID is not a readable history reference.",
    );
    for (const item of evidence.slice(0, MAX_EVIDENCE_IDS)) {
      lines.push(...formatEvidenceItem(item));
    }
    if (missingIds.length > 0) {
      lines.push(
        "Unavailable under bounded canonical lookup (last 8MiB / 32 IDs). These IDs are not readable by themselves:",
      );
      for (const id of missingIds) {
        lines.push(`- unavailable: ${id}`);
      }
    }
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHECKPOINT_CHARS;
  return boundCheckpointText(lines.join("\n"), maxChars);
}

export async function buildFreshContextHandlerResult(options: {
  dataDir: string;
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role" | "managerId" | "sessionFile">;
  request: FreshContextHandlerRequest;
  sessionFile?: string;
  budget?: FreshCheckpointBudget;
}): Promise<FreshContextHandlerResult> {
  throwIfAborted(options.request.signal);
  const owner = resolveOwnerDescriptor(options.descriptor);
  const [goal, plan, pins] = await Promise.all([
    loadCurrentGoal(options.dataDir, owner),
    loadCurrentPlan(options.dataDir, owner),
    loadCurrentPins(options.dataDir, owner),
  ]);
  throwIfAborted(options.request.signal);

  const evidence = collectUnconsumedToolEvidence(options.request.branchEntries);
  const sessionFile = options.sessionFile ?? options.descriptor.sessionFile;
  const located = sessionFile && evidence.length > 0
    ? locateCheckpointEvidence({
      sessionFile,
      sessionAgentId: owner.agentId,
      actorAgentId: options.descriptor.agentId,
      entryIds: evidence.map((item) => item.entryId),
    })
    : { refs: [] as HistoryEntryReference[], missingIds: evidence.map((item) => item.entryId) };
  const refsById = new Map(located.refs.map((ref) => [ref.entryId, ref]));
  const resolvedEvidence = evidence.map((item) => ({
    ...item,
    ref: refsById.get(item.entryId),
  }));
  const budgetChars = resolveFreshCheckpointBudget(options.budget);
  if (budgetChars <= 0) {
    throw new Error(FRESH_CONTEXT_TOO_LARGE_ERROR);
  }
  const summary = formatFreshContextCheckpoint({
    trigger: options.request.reason,
    willRetry: options.request.willRetry,
    goal,
    plan,
    pins,
    unconsumedToolEvidence: resolvedEvidence.filter((item) => item.ref),
    missingEvidenceIds: located.missingIds,
    overflowObligation: options.request.reason === "overflow" && options.request.willRetry
      ? extractLastPersistedUserText(options.request.branchEntries)
      : undefined,
    maxChars: budgetChars,
  });
  if (estimateCheckpointTokens(summary) > (budgetChars / CHARS_PER_TOKEN)) {
    throw new Error(FRESH_CONTEXT_TOO_LARGE_ERROR);
  }

  return {
    summary,
    tokensBefore: resolveTokensBefore(options.request.tokensBefore),
    details: {
      forgeContext: {
        mode: "fresh",
        trigger: options.request.reason,
        willRetry: options.request.willRetry,
      },
    },
  };
}

export function createFreshContextHandler(options: {
  dataDir: string;
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role" | "managerId" | "sessionFile">;
  getContextMode: () => ContextMode;
  sessionFile?: string;
  getBudget?: () => FreshCheckpointBudget;
}): FreshContextHandler {
  return async (request) => {
    if (options.getContextMode() !== "fresh") {
      return undefined;
    }
    return buildFreshContextHandlerResult({
      dataDir: options.dataDir,
      descriptor: options.descriptor,
      request,
      sessionFile: options.sessionFile,
      budget: options.getBudget?.(),
    });
  };
}

export function estimateCheckpointTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function resolveTokensBefore(tokensBefore: number | undefined): number {
  return typeof tokensBefore === "number" && Number.isFinite(tokensBefore) && tokensBefore >= 0
    ? Math.floor(tokensBefore)
    : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Fresh context handler aborted");
    error.name = "AbortError";
    throw error;
  }
}

function resolveOwnerDescriptor(
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role" | "managerId" | "sessionFile">,
): Pick<AgentDescriptor, "agentId" | "profileId" | "role" | "managerId" | "sessionFile"> {
  if (descriptor.role === "manager") {
    return descriptor;
  }
  return {
    ...descriptor,
    agentId: descriptor.managerId,
    role: "manager",
  };
}

async function loadCurrentGoal(
  dataDir: string,
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role">,
): Promise<unknown> {
  const profileId = descriptor.profileId;
  if (!profileId || descriptor.role !== "manager") {
    return undefined;
  }
  try {
    const state = await new SessionGoalStore({
      dataDir,
      profileId,
      sessionAgentId: descriptor.agentId,
    }).load();
    const goal = state.goal;
    if (!goal || !isUnfinishedGoalStatus(goal.status)) {
      return undefined;
    }
    const snapshot: SessionGoalSnapshot = {
      revision: state.revision,
      measuredAt: state.updatedAt ?? new Date(0).toISOString(),
      goal: {
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        activeElapsedMs: goal.activeElapsedMs,
        turnCount: goal.turnCount,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        usageCoverage: "partial",
        ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
      },
    };
    return formatSessionGoalModelContext(snapshot);
  } catch {
    return undefined;
  }
}

async function loadCurrentPlan(
  dataDir: string,
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role">,
): Promise<unknown> {
  const profileId = descriptor.profileId;
  if (!profileId || descriptor.role !== "manager") {
    return undefined;
  }
  try {
    const state = await new SessionPlanStore({
      dataDir,
      profileId,
      sessionAgentId: descriptor.agentId,
    }).load();
    if (state.revision === 0 && state.plan.length === 0 && !state.explanation && !state.workGraph) {
      return undefined;
    }
    return formatSessionPlanModelContext({
      revision: state.revision,
      updatedAt: state.updatedAt,
      plan: state.plan,
      ...(state.explanation ? { explanation: state.explanation } : {}),
      ...(state.coordinationMode ? { coordinationMode: state.coordinationMode } : {}),
      ...(state.workGraph ? { workGraph: state.workGraph } : {}),
    });
  } catch {
    return undefined;
  }
}

async function loadCurrentPins(
  dataDir: string,
  descriptor: Pick<AgentDescriptor, "agentId" | "profileId" | "role">,
): Promise<Array<{ role: string; text: string; timestamp?: string }>> {
  const profileId = descriptor.profileId;
  if (!profileId) {
    return [];
  }
  try {
    const registry = await loadPins(getSessionDir(dataDir, profileId, descriptor.agentId));
    return Object.values(registry.pins)
      .sort((left, right) => left.pinnedAt.localeCompare(right.pinnedAt))
      .slice(0, MAX_PINS)
      .map((entry) => ({
        role: entry.role,
        text: boundText(entry.text, MAX_PINNED_TEXT_CHARS),
        timestamp: entry.timestamp,
      }));
  } catch {
    return [];
  }
}

function formatGoalSection(goal: unknown): string | undefined {
  if (!goal) {
    return undefined;
  }
  return [
    "## Current goal (server-owned)",
    "Historical labeling: this remains the current owner constraint, not a newly assigned task.",
    typeof goal === "string" ? goal : JSON.stringify(goal),
  ].join("\n");
}

function formatPlanSection(plan: unknown): string | undefined {
  if (!plan) {
    return undefined;
  }
  return [
    "## Current plan (server-owned)",
    "Historical labeling: keep statuses as recorded. Completed or aborted items are not new work.",
    typeof plan === "string" ? plan : JSON.stringify(plan),
  ].join("\n");
}

function formatPinSection(pins: Array<{ role: string; text: string; timestamp?: string }>): string | undefined {
  if (pins.length === 0) {
    return undefined;
  }
  const lines = [
    "## Pins and important user constraints",
    "Preserve these owner constraints. They are not a request to restart completed work.",
  ];
  for (const [index, pin] of pins.entries()) {
    const stamp = pin.timestamp ? `, ${pin.timestamp}` : "";
    lines.push(`### Pin ${index + 1} (${pin.role}${stamp})`);
    lines.push(pin.text);
  }
  return lines.join("\n");
}

function formatEvidenceItem(item: UnconsumedToolEvidence): string[] {
  const lines = [`### ${item.toolName ? boundText(item.toolName, MAX_TOOL_NAME_CHARS) : "tool"} (${item.entryId})`];
  if (item.argsPreview) {
    lines.push(`args: ${item.argsPreview}`);
  }
  if (item.resultPreview) {
    lines.push(`result: ${item.resultPreview}`);
  }
  if (item.ref) {
    lines.push(`history({op:"read",ref:${JSON.stringify(item.ref)}})`);
  } else {
    lines.push("unavailable under bounded canonical lookup; this ID is not a readable history reference.");
  }
  return lines;
}

function collectToolCallsById(branchEntries: readonly SessionEntry[]): Map<string, { name?: string; argsPreview?: string }> {
  const calls = new Map<string, { name?: string; argsPreview?: string }>();
  for (const entry of branchEntries) {
    if (entry?.type !== "message") {
      continue;
    }
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      const record = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown; args?: unknown };
      if (record.type !== "toolCall" || typeof record.id !== "string" || record.id.length === 0) {
        continue;
      }
      calls.set(record.id, {
        name: typeof record.name === "string" ? record.name : undefined,
        argsPreview: boundText(stringifyUnknown(record.arguments ?? record.args), MAX_ARGS_PREVIEW_CHARS),
      });
    }
  }
  return calls;
}

function hasLaterSuccessfulAssistantConsumer(
  branchEntries: readonly SessionEntry[],
  startIndex: number,
): boolean {
  for (let index = startIndex; index < branchEntries.length; index += 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "message") {
      continue;
    }
    const message = entry.message as { role?: string; stopReason?: string };
    if (message.role !== "assistant") {
      continue;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      continue;
    }
    return true;
  }
  return false;
}

function extractLastPersistedUserText(branchEntries: readonly SessionEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "message") {
      continue;
    }
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user") {
      continue;
    }
    const text = extractUserText(message.content);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function extractUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [];
    }
    const record = block as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" && record.text.trim()
      ? [record.text.trim()]
      : [];
  });
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function boundCheckpointText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
