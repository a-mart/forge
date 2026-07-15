import type { ConversationHistoryPageMetadata } from "@forge/protocol";

/**
 * Keeps backend paging diagnostics behind the websocket boundary. The Builder
 * only needs the opaque cursor and state required to decide whether to request
 * another page.
 */
export function projectConversationPageMetadataForWire(
  page: ConversationHistoryPageMetadata,
): ConversationHistoryPageMetadata {
  return {
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasOlder: page.hasOlder,
    completeness: page.completeness,
    source: page.source,
  };
}
