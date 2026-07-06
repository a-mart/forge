import { readFile } from "node:fs/promises";

export type CaptureCadenceReason = "turns" | "idle" | "compaction" | "close" | "archive" | "feedback";

export interface CaptureCadenceInput {
  enabled: boolean;
  userTurnsSinceWatermark: number;
  lastCaptureCheckAt?: string | null;
  idleGapMs?: number;
  trigger?: "turn" | "idle" | "compaction" | "close" | "archive" | "feedback";
  dailyForksUsed?: number;
  saveLearningAdvancedWatermark?: boolean;
  userTurnInterval?: number;
  idleGapThresholdMs?: number;
  dailyForkCap?: number;
}

export interface CaptureCadenceDecision {
  shouldJudge: boolean;
  shouldForkDirectly: boolean;
  reason?: CaptureCadenceReason;
  skippedReason?: string;
}

export interface CaptureDeltaMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface CaptureJudgeResult {
  shouldFork: boolean;
  pointer?: string;
  raw: string;
}

export interface CaptureJudgeModel {
  complete(prompt: string): Promise<string>;
}

export interface CaptureForkRunnerAdapter {
  forkSession(sourceAgentId: string, options: { label: string; fromMessageId?: string }): Promise<{ sessionAgentId: string }>;
  sendRestrictedTurn(
    forkedAgentId: string,
    message: string,
    options: { allowedTools: ["knowledge", "save_learning"]; reason: "capture_check" },
  ): Promise<void>;
  discardFork(forkedAgentId: string): Promise<void>;
}

export function evaluateCaptureCadence(input: CaptureCadenceInput): CaptureCadenceDecision {
  if (!input.enabled) {
    return { shouldJudge: false, shouldForkDirectly: false, skippedReason: "knowledge_v2_disabled" };
  }
  if (input.saveLearningAdvancedWatermark) {
    return { shouldJudge: false, shouldForkDirectly: false, skippedReason: "save_learning_advanced_watermark" };
  }
  const dailyCap = input.dailyForkCap ?? 3;
  if ((input.dailyForksUsed ?? 0) >= dailyCap) {
    return { shouldJudge: false, shouldForkDirectly: false, skippedReason: "daily_fork_cap" };
  }
  if (input.trigger === "feedback") {
    return { shouldJudge: false, shouldForkDirectly: true, reason: "feedback" };
  }
  if (input.trigger === "compaction" || input.trigger === "close" || input.trigger === "archive") {
    return { shouldJudge: true, shouldForkDirectly: false, reason: input.trigger };
  }
  const pendingTurns = Math.max(0, input.userTurnsSinceWatermark);
  if (pendingTurns === 0) {
    return { shouldJudge: false, shouldForkDirectly: false, skippedReason: "no_pending_user_turns" };
  }
  if (pendingTurns >= (input.userTurnInterval ?? 8)) {
    return { shouldJudge: true, shouldForkDirectly: false, reason: "turns" };
  }
  if (input.trigger === "idle" && (input.idleGapMs ?? 0) >= (input.idleGapThresholdMs ?? 5 * 60_000)) {
    return { shouldJudge: true, shouldForkDirectly: false, reason: "idle" };
  }
  return { shouldJudge: false, shouldForkDirectly: false, skippedReason: "below_threshold" };
}

export async function readCaptureDeltaFromSessionFile(
  sessionFile: string,
  options: { lastCaptureCheckAt?: string | null },
): Promise<CaptureDeltaMessage[]> {
  const raw = await readFile(sessionFile, "utf8");
  const watermarkMs = options.lastCaptureCheckAt ? Date.parse(options.lastCaptureCheckAt) : Number.NEGATIVE_INFINITY;
  const messages: CaptureDeltaMessage[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const parsed = safeParseJson(line);
    const message = extractCaptureMessage(parsed);
    if (!message) continue;
    if (message.timestamp && Date.parse(message.timestamp) <= watermarkMs) continue;
    messages.push(message);
  }
  return messages;
}

export function countUserTurnsSinceWatermark(messages: readonly CaptureDeltaMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

export function buildCaptureJudgePrompt(messages: readonly CaptureDeltaMessage[]): string {
  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`)
    .filter((line) => line.length > 0)
    .join("\n\n");
  return [
    "You are the Forge Cortex capture judge.",
    "Read only this stripped user/assistant delta. Ignore task-local details, secrets, and facts directly derivable from files.",
    "Question: is there any durable correction, preference, convention, gotcha, or pointer that should be captured?",
    "Answer exactly `YES: <one-line pointer>` or `NO`.",
    "",
    transcript,
  ].join("\n");
}

export async function invokeCaptureJudge(
  model: CaptureJudgeModel,
  messages: readonly CaptureDeltaMessage[],
): Promise<CaptureJudgeResult> {
  const raw = (await model.complete(buildCaptureJudgePrompt(messages))).trim();
  if (/^yes\b\s*:?/iu.test(raw)) {
    return {
      shouldFork: true,
      pointer: raw.replace(/^yes\b\s*:?\s*/iu, "").trim() || undefined,
      raw,
    };
  }
  return { shouldFork: false, raw };
}

export async function runCaptureCheckFork(options: {
  enabled: boolean;
  sourceAgentId: string;
  fromMessageId?: string;
  judgePointer?: string;
  adapter: CaptureForkRunnerAdapter;
}): Promise<{ status: "skipped" | "completed"; forkedAgentId?: string }> {
  if (!options.enabled) {
    return { status: "skipped" };
  }
  const fork = await options.adapter.forkSession(options.sourceAgentId, {
    label: "Capture check",
    fromMessageId: options.fromMessageId,
  });
  try {
    const advisory = options.judgePointer ? `\n\nJudge hint: ${options.judgePointer}` : "";
    await options.adapter.sendRestrictedTurn(
      fork.sessionAgentId,
      `Review this fork for durable knowledge that should already have been saved. Use only knowledge/search-read and save_learning. If nothing durable is missing, do nothing.${advisory}`,
      { allowedTools: ["knowledge", "save_learning"], reason: "capture_check" },
    );
    return { status: "completed", forkedAgentId: fork.sessionAgentId };
  } finally {
    await options.adapter.discardFork(fork.sessionAgentId);
  }
}

function extractCaptureMessage(value: unknown): CaptureDeltaMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : {};
  const source = String(record.source ?? nested.source ?? record.role ?? nested.role ?? "");
  const role = source.includes("user") ? "user" : source.includes("assistant") || source.includes("agent") ? "assistant" : undefined;
  if (!role) return undefined;
  const text = extractText(record.text ?? nested.text ?? nested.message ?? record.message);
  if (!text) return undefined;
  return {
    id: typeof record.id === "string" ? record.id : typeof nested.id === "string" ? nested.id : undefined,
    role,
    text,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : typeof nested.timestamp === "string" ? nested.timestamp : undefined,
  };
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) return String((item as { text?: unknown }).text ?? "");
        return "";
      })
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function safeParseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
