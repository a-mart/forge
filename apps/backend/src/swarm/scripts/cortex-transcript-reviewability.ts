import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isConversationEntryEvent } from "../session/conversation-validators.js";
import type { ConversationEntryEvent } from "../types.js";

export const CONVERSATION_ENTRY_CUSTOM_TYPE = "swarm_conversation_entry";

// Runtime-state custom entries must be classified deliberately. Anything not in
// this allowlist is treated as review-needed if it appears after the raw Cortex
// review watermark.
export const IGNORABLE_INTERNAL_CUSTOM_TYPES = new Set<string>([
  "swarm_model_change_continuity_request",
  "swarm_model_change_continuity_applied",
  "swarm_claude_session_state",
  "swarm_claude_compaction_summary",
  "swarm_acp_runtime_state",
]);

export interface TranscriptReviewableStats {
  rawTotalBytes: number;
  rawReviewedBytes: number;
  rawDeltaBytes: number;
  reviewableTranscriptTotalBytes: number;
  reviewableTranscriptReviewedBytes: number;
  reviewableTranscriptDeltaBytes: number;
  ignoredInternalTranscriptDeltaBytes: number;
  unknownTranscriptDeltaBytes: number;
  malformedTranscriptDeltaBytes: number;
  sliceStartBytes: number;
  compacted: boolean;
}

export async function analyzeSessionTranscriptReviewability(options: {
  sessionFile: string;
  rawReviewedBytes: number;
  fallbackRawTotalBytes?: number;
}): Promise<TranscriptReviewableStats> {
  const rawReviewedBytes = normalizeByteCount(options.rawReviewedBytes);
  const statSize = await readFileSize(options.sessionFile);
  const rawTotalBytes = statSize ?? normalizeOptionalByteCount(options.fallbackRawTotalBytes) ?? 0;
  const rawDeltaBytes = rawTotalBytes - rawReviewedBytes;
  const compacted = rawReviewedBytes > rawTotalBytes;

  const stats: TranscriptReviewableStats = {
    rawTotalBytes,
    rawReviewedBytes,
    rawDeltaBytes,
    reviewableTranscriptTotalBytes: 0,
    reviewableTranscriptReviewedBytes: 0,
    reviewableTranscriptDeltaBytes: 0,
    ignoredInternalTranscriptDeltaBytes: 0,
    unknownTranscriptDeltaBytes: 0,
    malformedTranscriptDeltaBytes: 0,
    sliceStartBytes: rawReviewedBytes,
    compacted,
  };

  if (statSize === null) {
    // With only legacy meta.stats and no file to classify, preserve prior
    // fail-safe behavior: positive raw drift is actionable unknown transcript.
    if (rawDeltaBytes > 0) {
      stats.unknownTranscriptDeltaBytes = rawDeltaBytes;
    }
    return stats;
  }

  let pending = Buffer.alloc(0);
  let lineStartBytes = 0;

  for await (const chunk of createReadStream(options.sessionFile)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);

    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const lineBuffer = pending.subarray(0, newlineIndex + 1);
      classifyLine(stats, lineBuffer, lineStartBytes, rawReviewedBytes);
      lineStartBytes += lineBuffer.length;
      pending = pending.subarray(newlineIndex + 1);
      newlineIndex = pending.indexOf(0x0a);
    }
  }

  if (pending.length > 0) {
    classifyLine(stats, pending, lineStartBytes, rawReviewedBytes);
  }

  stats.reviewableTranscriptDeltaBytes = Math.max(
    0,
    stats.reviewableTranscriptTotalBytes - stats.reviewableTranscriptReviewedBytes,
  );
  return stats;
}

function classifyLine(
  stats: TranscriptReviewableStats,
  lineBuffer: Buffer,
  lineStartBytes: number,
  rawReviewedBytes: number,
): void {
  const lineEndBytes = lineStartBytes + lineBuffer.length;
  const lineByteLength = lineBuffer.length;
  const trimmed = lineBuffer.toString("utf8").trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (lineEndBytes > rawReviewedBytes) {
      stats.malformedTranscriptDeltaBytes += lineByteLength;
    }
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    if (lineEndBytes > rawReviewedBytes) {
      stats.unknownTranscriptDeltaBytes += lineByteLength;
    }
    return;
  }

  const record = parsed as { type?: unknown; customType?: unknown; data?: unknown };
  if (record.type === "session") {
    return;
  }

  if (record.type !== "custom") {
    if (lineEndBytes > rawReviewedBytes) {
      stats.unknownTranscriptDeltaBytes += lineByteLength;
    }
    return;
  }

  if (record.customType === CONVERSATION_ENTRY_CUSTOM_TYPE) {
    if (isConversationEntryEvent(record.data)) {
      if (isPersistedReviewableConversationEntry(record.data)) {
        stats.reviewableTranscriptTotalBytes += lineByteLength;
        if (lineEndBytes <= rawReviewedBytes) {
          stats.reviewableTranscriptReviewedBytes += lineByteLength;
        }
      }
      return;
    }

    if (lineEndBytes > rawReviewedBytes) {
      stats.unknownTranscriptDeltaBytes += lineByteLength;
    }
    return;
  }

  if (typeof record.customType === "string" && IGNORABLE_INTERNAL_CUSTOM_TYPES.has(record.customType)) {
    if (lineEndBytes > rawReviewedBytes) {
      stats.ignoredInternalTranscriptDeltaBytes += lineByteLength;
    }
    return;
  }

  if (lineEndBytes > rawReviewedBytes) {
    stats.unknownTranscriptDeltaBytes += lineByteLength;
  }
}

function isPersistedReviewableConversationEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_log") {
    return false;
  }

  if (entry.type === "agent_tool_call") {
    return entry.kind !== "tool_execution_update";
  }

  return true;
}

async function readFileSize(filePath: string): Promise<number | null> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? fileStat.size : null;
  } catch {
    return null;
  }
}

function normalizeByteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeOptionalByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
