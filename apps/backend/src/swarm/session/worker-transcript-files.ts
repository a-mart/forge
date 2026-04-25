import {
  CONVERSATION_HISTORY_CACHE_SUFFIX,
  isConversationHistoryCacheFilePath
} from "./conversation-history-cache.js";

const WORKER_TRANSCRIPT_SUFFIX = ".jsonl";
export const WORKER_TRANSCRIPT_SIDECAR_AGENT_ID_SUFFIX =
  CONVERSATION_HISTORY_CACHE_SUFFIX.slice(0, -WORKER_TRANSCRIPT_SUFFIX.length);

export function isWorkerTranscriptSidecarAgentId(agentId: string): boolean {
  return agentId.endsWith(WORKER_TRANSCRIPT_SIDECAR_AGENT_ID_SUFFIX);
}

export function isWorkerTranscriptSidecarSessionFile(sessionFile: string): boolean {
  return isConversationHistoryCacheFilePath(sessionFile);
}

export function isCanonicalWorkerTranscriptFileName(filename: string): boolean {
  return filename.endsWith(WORKER_TRANSCRIPT_SUFFIX) && !isWorkerTranscriptSidecarSessionFile(filename);
}

export function getWorkerIdFromCanonicalTranscriptFileName(filename: string): string | null {
  if (!isCanonicalWorkerTranscriptFileName(filename)) {
    return null;
  }

  return filename.slice(0, -WORKER_TRANSCRIPT_SUFFIX.length);
}
