import type { AgentDescriptor, ExternalThreadInfo } from './agents.js'
import type { ConversationMessageEvent } from './conversation-events.js'

export type HasExternalThread = Pick<AgentDescriptor, 'externalThread'> & {
  externalThread: ExternalThreadInfo
}

export function isExternalThreadDescriptor(
  descriptor: Pick<AgentDescriptor, 'externalThread'>,
): descriptor is HasExternalThread {
  return descriptor.externalThread?.type === 'codex_app_server'
}

export function isCodexAppServerExternalThreadDescriptor(
  descriptor: Pick<AgentDescriptor, 'externalThread'>,
): descriptor is HasExternalThread {
  return isExternalThreadDescriptor(descriptor)
}

export function shouldExcludeConversationMessageFromModelContext(
  message: Pick<ConversationMessageEvent, 'externalThreadContext'>,
): boolean {
  const context = message.externalThreadContext
  if (!context) {
    return false
  }
  return context.excludeFromModelContext === true
}
