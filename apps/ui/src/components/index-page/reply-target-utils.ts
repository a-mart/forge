import type { ConversationEntry, ConversationReplyTargetInput } from '@forge/protocol'

export function isReplyTargetLoadedInMessages(
  replyTarget: ConversationReplyTargetInput | null | undefined,
  messages: ConversationEntry[],
): boolean {
  const targetId = replyTarget?.messageId.trim()
  if (!targetId) return false

  return messages.some(
    (message) => message.type === 'conversation_message' && message.id?.trim() === targetId,
  )
}
