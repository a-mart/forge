import type { AgentDescriptor, AgentModelDescriptor, ExternalThreadInfo } from './agents.js'
import type { ConversationMessageEvent } from './conversation-events.js'

export const CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL = {
  provider: 'codex-app-server',
  modelId: 'app-server',
  thinkingLevel: 'none',
} as const satisfies AgentModelDescriptor

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

export function isForgeManagedRuntimeWorkerDescriptor(
  descriptor: Pick<AgentDescriptor, 'role' | 'externalThread'>,
): boolean {
  return descriptor.role === 'worker' && !isExternalThreadDescriptor(descriptor)
}

export function requiresForgeAgentRuntime(
  descriptor: Pick<AgentDescriptor, 'role' | 'externalThread'>,
): boolean {
  if (descriptor.role === 'manager') {
    return true
  }

  return isForgeManagedRuntimeWorkerDescriptor(descriptor)
}

export function validateCodexExternalThreadModelInvariant(
  model: Pick<AgentModelDescriptor, 'provider' | 'modelId' | 'thinkingLevel'>,
): string | undefined {
  if (model.provider !== CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.provider) {
    return `Codex external-thread descriptors must use provider "${CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.provider}"`
  }

  if (model.modelId !== CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.modelId) {
    return `Codex external-thread descriptors must use modelId "${CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.modelId}"`
  }

  if (model.thinkingLevel !== CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.thinkingLevel) {
    return `Codex external-thread descriptors must use thinkingLevel "${CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL.thinkingLevel}"`
  }

  return undefined
}
