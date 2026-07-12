import {
  isUserVisibleAssistantConversationMessage,
  type ConversationEntry,
} from './conversation-events.js'

export interface ManagerContextAgentRef {
  agentId: string
  role?: string
  managerId?: string
}

export function collectKnownWorkerIds(
  agents: readonly ManagerContextAgentRef[],
  activeManagerId: string,
): Set<string> {
  const workerIds = new Set<string>()

  for (const agent of agents) {
    if (agent.role === 'worker' && agent.managerId === activeManagerId) {
      workerIds.add(agent.agentId)
    }
  }

  return workerIds
}

function isUserVisibleManagerTranscriptEntry(entry: ConversationEntry): boolean {
  if (entry.type !== 'conversation_message') {
    return false
  }

  return (
    entry.source === 'project_agent_input' ||
    entry.source === 'user_input' ||
    isUserVisibleAssistantConversationMessage(entry)
  )
}

export function isManagerSessionTranscriptEntry(entry: ConversationEntry): boolean {
  return (
    entry.type === 'conversation_message' ||
    entry.type === 'choice_request'
  )
}

export function inferManagerAliasIds(
  history: readonly ConversationEntry[],
  activeManagerId: string,
  knownWorkerIds: ReadonlySet<string>,
): Set<string> {
  const aliases = new Set<string>([activeManagerId])

  for (const entry of history) {
    if (!isUserVisibleManagerTranscriptEntry(entry)) {
      continue
    }

    const agentId = entry.agentId.trim()
    if (agentId.length > 0 && !knownWorkerIds.has(agentId)) {
      aliases.add(agentId)
    }
  }

  for (const entry of history) {
    if (entry.type !== 'agent_message') {
      continue
    }

    const agentId = entry.agentId.trim()
    if (agentId.length === 0 || knownWorkerIds.has(agentId)) {
      continue
    }

    const fromAgentId = entry.fromAgentId?.trim()
    const toAgentId = entry.toAgentId.trim()
    if (agentId !== fromAgentId && agentId !== toAgentId) {
      continue
    }

    const touchesKnownAlias =
      (fromAgentId !== undefined && aliases.has(fromAgentId)) ||
      aliases.has(toAgentId) ||
      fromAgentId === activeManagerId ||
      toAgentId === activeManagerId ||
      aliases.has(agentId)

    if (touchesKnownAlias) {
      aliases.add(agentId)
    }
  }

  return aliases
}

export function isProtectedManagerContextEntry(
  entry: ConversationEntry,
  managerAliasIds: ReadonlySet<string>,
  knownWorkerIds: ReadonlySet<string>,
): boolean {
  if (entry.type === 'agent_tool_call') {
    if (entry.kind === 'tool_execution_update') {
      return false
    }

    const agentId = entry.agentId.trim()
    const actorAgentId = entry.actorAgentId.trim()
    if (agentId.length === 0 || actorAgentId.length === 0 || agentId !== actorAgentId) {
      return false
    }

    if (!managerAliasIds.has(agentId) || knownWorkerIds.has(actorAgentId)) {
      return false
    }

    return true
  }

  if (entry.type === 'agent_message') {
    const agentId = entry.agentId.trim()
    if (agentId.length === 0 || !managerAliasIds.has(agentId)) {
      return false
    }

    const fromAgentId = entry.fromAgentId?.trim()
    const toAgentId = entry.toAgentId.trim()
    return (
      agentId === toAgentId &&
      fromAgentId !== undefined &&
      fromAgentId.length > 0 &&
      fromAgentId !== agentId
    )
  }

  return false
}

export function isVisibleInManagerAllView(
  entry: ConversationEntry,
  options: {
    activeManagerId: string
    managerAliasIds: ReadonlySet<string>
    knownWorkerIds: ReadonlySet<string>
  },
): boolean {
  const { activeManagerId, managerAliasIds, knownWorkerIds } = options

  if (entry.type === 'conversation_log') {
    return false
  }

  if (entry.type === 'conversation_message') {
    if (isUserVisibleManagerTranscriptEntry(entry)) {
      return true
    }

    return managerAliasIds.has(entry.agentId.trim())
  }

  if (entry.type === 'choice_request') {
    const agentId = entry.agentId.trim()
    if (managerAliasIds.has(agentId)) {
      return true
    }

    const sessionAgentId = entry.sessionAgentId?.trim()
    return sessionAgentId !== undefined && sessionAgentId.length > 0 && managerAliasIds.has(sessionAgentId)
  }

  if (entry.type === 'model_cache_observation') {
    return managerAliasIds.has(entry.agentId.trim())
  }

  if (entry.type === 'agent_tool_call') {
    return isProtectedManagerContextEntry(entry, managerAliasIds, knownWorkerIds)
  }

  if (entry.type === 'agent_message') {
    if (entry.source === 'user_to_agent' && entry.toAgentId.trim() === activeManagerId) {
      return true
    }

    if (isProtectedManagerContextEntry(entry, managerAliasIds, knownWorkerIds)) {
      return true
    }

    const agentId = entry.agentId.trim()
    if (managerAliasIds.has(agentId)) {
      const fromAgentId = entry.fromAgentId?.trim()
      const toAgentId = entry.toAgentId.trim()
      if (
        agentId === fromAgentId ||
        agentId === toAgentId ||
        fromAgentId === activeManagerId ||
        toAgentId === activeManagerId ||
        (fromAgentId !== undefined && knownWorkerIds.has(fromAgentId)) ||
        knownWorkerIds.has(toAgentId)
      ) {
        return true
      }
    }

    return false
  }

  return false
}
