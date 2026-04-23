import type {
  CollaborationSessionActivityEntry,
  CollaborationTranscriptMessage,
  ConversationEntry,
  ConversationMessageEvent,
  ChoiceRequestEvent,
} from '@forge/protocol'
import type { CollabChoiceRequest } from '@/lib/collab-ws-state'

/**
 * Converts collab transcript messages, choice requests, and session activity
 * into Builder's {@link ConversationEntry[]} format so the collab surface
 * can reuse the Builder `MessageList` component.
 *
 * Every mapped entry carries `agentId: sessionAgentId` so downstream
 * Builder components (artifact/file wiring, tool display, etc.) resolve
 * correctly.
 */
export function adaptCollabToConversationEntries(options: {
  messages: CollaborationTranscriptMessage[]
  choiceRequests: CollabChoiceRequest[]
  activity: CollaborationSessionActivityEntry[]
  sessionAgentId: string
}): ConversationEntry[] {
  const { messages, choiceRequests, activity, sessionAgentId } = options

  const messageEntries: Array<{ ts: number; index: number; entry: ConversationEntry }> =
    messages
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map((m, index) => ({
        ts: parseTimestamp(m.timestamp),
        index,
        entry: mapTranscriptMessage(m, sessionAgentId),
      }))

  const choiceEntries: Array<{ ts: number; index: number; entry: ConversationEntry }> =
    choiceRequests.map((r, index) => ({
      ts: parseTimestamp(r.timestamp),
      index: messageEntries.length + index,
      entry: mapChoiceRequest(r, sessionAgentId),
    }))

  const activityEntries: Array<{ ts: number; index: number; entry: ConversationEntry }> =
    activity.map((a, index) => ({
      ts: parseTimestamp(a.timestamp),
      index: messageEntries.length + choiceEntries.length + index,
      entry: { ...a, agentId: a.agentId || sessionAgentId },
    }))

  const all = [...messageEntries, ...choiceEntries, ...activityEntries]

  all.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    return a.index - b.index
  })

  return all.map((item) => item.entry)
}

function mapTranscriptMessage(
  m: CollaborationTranscriptMessage,
  agentId: string,
): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId,
    id: m.id,
    role: m.role,
    text: m.text,
    attachments: m.attachments,
    timestamp: m.timestamp,
    source: m.source,
    sourceContext: m.sourceContext,
    projectAgentContext: m.projectAgentContext,
    pinned: m.pinned,
    collaborationAuthor: m.collaborationAuthor,
  }
}

function mapChoiceRequest(
  r: CollabChoiceRequest,
  sessionAgentId: string,
): ChoiceRequestEvent {
  return {
    type: 'choice_request',
    agentId: r.agentId || sessionAgentId,
    choiceId: r.choiceId,
    questions: r.questions,
    status: r.status,
    answers: r.answers,
    timestamp: r.timestamp,
  }
}

function parseTimestamp(ts: string): number {
  const parsed = new Date(ts).getTime()
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
}
