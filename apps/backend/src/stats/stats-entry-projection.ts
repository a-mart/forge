import { parseGenerationMeasurementCustomEntry, GENERATION_MEASUREMENT_ENTRY_TYPE } from "../utils/generation-measurement-records.js";
import { parseCursorSdkUsageCustomEntry, CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only fields consumed by statistics survive. Never persist message/tool bodies. */
export function projectStatsEntry(value: unknown, fromCache = false): ObjectValue | null {
  if (!object(value)) return null;
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
