export const CONVERSATION_HISTORY_CACHE_SUFFIX = ".conversation.jsonl";

export function isConversationHistoryCacheFilePath(path: string): boolean {
  return path.endsWith(CONVERSATION_HISTORY_CACHE_SUFFIX);
}

export function getConversationHistoryCacheFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}${CONVERSATION_HISTORY_CACHE_SUFFIX}`
    : `${sessionFile}${CONVERSATION_HISTORY_CACHE_SUFFIX}`;
}
