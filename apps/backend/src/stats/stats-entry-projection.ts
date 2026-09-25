import { NATIVE_USAGE_ENTRY_TYPE, parseNativeUsageEntry, normalizeCodexUsage, normalizeClaudeUsage } from "../utils/native-usage-records.js";
import { parseGenerationMeasurementCustomEntry, GENERATION_MEASUREMENT_ENTRY_TYPE } from "../utils/generation-measurement-records.js";
import { parseCursorSdkUsageCustomEntry, CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only fields consumed by statistics survive. Never persist message/tool bodies. */
export function projectStatsEntry(value: unknown, fromCache = false): ObjectValue | null {
  if (!object(value)) return null;
  // Native history recovery reads only count/identity fields from explicitly linked files.
  if (fromCache && ["native_claude_usage", "native_codex_usage", "native_codex_context", "native_codex_identity"].includes(String(value.type))) {
    return { ...pick(value, ["type", "timestamp", "sessionId", "messageId", "modelId", "reasoningLevel"]),
      ...(object(value.usage) ? { usage: pickNumbers(value.usage) } : {}) };
  }
  if (value.type === "assistant" && object(value.message) && !value.isSidechain) {
    const usage = normalizeClaudeUsage(value.message.usage);
    if (!usage || typeof value.message.id !== "string" || typeof value.message.model !== "string") return null;
    return { type: "native_claude_usage", ...pick(value, ["timestamp", "sessionId"]), messageId: value.message.id, modelId: value.message.model, usage };
  }
  if (value.type === "session_meta" && object(value.payload) && typeof value.payload.id === "string") return { type: "native_codex_identity", sessionId: value.payload.id };
  if (value.type === "turn_context" && object(value.payload) && typeof value.payload.model === "string") return { type: "native_codex_context", ...pick(value, ["timestamp"]),
    modelId: value.payload.model, reasoningLevel: typeof value.payload.effort === "string" ? value.payload.effort : undefined };
  if (value.type === "event_msg" && object(value.payload) && value.payload.type === "token_count" && object(value.payload.info)) {
    const usage = normalizeCodexUsage(value.payload.info.total_token_usage);
    return usage ? { type: "native_codex_usage", ...pick(value, ["timestamp"]), usage } : null;
  }
  if (value.type === "thinking_level_change" || value.type === "reasoning_level_change") {
    return pick(value, ["type", "thinkingLevel", "reasoningLevel"]);
  }
  if (value.type === "message" && object(value.message) && object(value.message.usage)) {
    const message = pick(value.message, ["timestamp", "model", "modelId", "provider", "reasoningLevel", "thinkingLevel", "reasoning_effort", "reasoningEffort", "reasoning"]);
    const usage = pickNumbers(value.message.usage);
    if (object(value.message.usage.cost)) usage.cost = pickNumbers(value.message.usage.cost);
    return { type: "message", ...pick(value, ["timestamp"]), message: { ...message, usage } };
  }
  if (value.type !== "custom") return null;
  if (["swarm_native_codex_state", "swarm_native_claude_state"].includes(String(value.customType)) && object(value.data)) {
    return { type: "custom", customType: value.customType, data: pick(value.data, ["version", "threadId", "sessionId", "ownerAgentId", "cwd"]) };
  }
  if (value.customType === NATIVE_USAGE_ENTRY_TYPE) {
    const record = parseNativeUsageEntry(value);
    return record ? { type: "custom", customType: NATIVE_USAGE_ENTRY_TYPE, data: record } : null;
  }
  if (value.customType === GENERATION_MEASUREMENT_ENTRY_TYPE) {
    const record = parseGenerationMeasurementCustomEntry(value);
    // Keep a countable marker for malformed measurement diagnostics.
    return { type: "custom", customType: GENERATION_MEASUREMENT_ENTRY_TYPE, data: record };
  }
  if (value.customType === CURSOR_SDK_USAGE_ENTRY_TYPE) {
    const record = parseCursorSdkUsageCustomEntry(value);
    if (!record) return null;
    return { type: "custom", customType: CURSOR_SDK_USAGE_ENTRY_TYPE, timestamp: record.timestamp,
      data: { version: 1, provider: "cursor-sdk", modelId: record.modelId, reasoningLevel: record.reasoningLevel,
        capturedAt: record.capturedAt, usage: record.usage } };
  }
  if (value.customType === "swarm_conversation_entry" && object(value.data)
    && value.data.type === "conversation_message" && value.data.role === "user" && value.data.source === "user_input") {
    const text = typeof value.data.text === "string" ? value.data.text : "";
    return { type: "custom", customType: value.customType, data: {
      type: "conversation_message", role: "user", source: "user_input", ...pick(value.data, ["timestamp"]),
      statsWordCount: fromCache && typeof value.data.statsWordCount === "number"
        ? value.data.statsWordCount : text.match(/fuck/gi)?.length ?? 0,
    } };
  }
  return null;
}

function pick(value: ObjectValue, keys: string[]): ObjectValue {
  return Object.fromEntries(keys.flatMap((key) => {
    const item = value[key];
    return typeof item === "string" || (typeof item === "number" && Number.isFinite(item)) ? [[key, item]] : [];
  }));
}

function pickNumbers(value: ObjectValue): ObjectValue {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "total", "input_tokens", "output_tokens", "cache_read_input_tokens", "cached_tokens", "cache_creation_input_tokens"];
  return Object.fromEntries(keys.filter((key) => typeof value[key] === "number" && Number.isFinite(value[key])).map((key) => [key, value[key]]));
}
