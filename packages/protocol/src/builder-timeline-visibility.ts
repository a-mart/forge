import type { ConversationEntry } from './conversation-events.js'
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isVisibleInManagerAllView,
  type ManagerContextAgentRef,
} from './manager-context-visibility.js'

export type BuilderTimelineChannelView = 'web' | 'all'

export interface BuilderTimelineAgentRef extends ManagerContextAgentRef {
  projectAgent?: unknown
}

export interface BuilderTimelineProjectionContext {
  activeAgentId: string | null
  activeAgentRole: 'manager' | 'worker' | null
  channelView: BuilderTimelineChannelView
  agents: readonly BuilderTimelineAgentRef[]
  /** Full loaded working set, used only to infer legacy manager aliases. */
  history: readonly ConversationEntry[]
}

/**
 * The single semantic inclusion policy for Builder timelines. Callers may
 * merge/page/order entries, but should not recreate Web/All or manager/worker
 * noise rules outside this function.
 */
export function isVisibleInBuilderTimeline(
  entry: ConversationEntry,
  context: BuilderTimelineProjectionContext,
): boolean {
  return createBuilderTimelineVisibilityPredicate(context)(entry)
}

/** Filters a page with one prepared policy context instead of rebuilding manager lookups per row. */
export function filterVisibleBuilderTimeline(
  entries: readonly ConversationEntry[],
  context: BuilderTimelineProjectionContext,
): ConversationEntry[] {
  const isVisible = createBuilderTimelineVisibilityPredicate(context)
  return entries.filter(isVisible)
}

export function createBuilderTimelineVisibilityPredicate(
  context: BuilderTimelineProjectionContext,
): (entry: ConversationEntry) => boolean {
  if (context.channelView === 'all') {
    if (context.activeAgentRole !== 'manager' || !context.activeAgentId) return () => true

    const activeManagerId = context.activeAgentId
    const knownWorkerIds = collectKnownWorkerIds(context.agents, activeManagerId)
    const managerAliasIds = inferManagerAliasIds(context.history, activeManagerId, knownWorkerIds)
    return (entry) => isVisibleInManagerAllView(entry, {
      activeManagerId,
      managerAliasIds,
      knownWorkerIds,
    })
  }

  const agentsById = new Map(context.agents.map((agent) => [agent.agentId, agent]))
  return (entry) => isVisibleInBuilderWebTimeline(entry, context, agentsById)
}

function isVisibleInBuilderWebTimeline(
  entry: ConversationEntry,
  context: BuilderTimelineProjectionContext,
  agentsById: ReadonlyMap<string, BuilderTimelineAgentRef>,
): boolean {
  if (entry.type === 'conversation_log' || entry.type === 'agent_tool_call' || entry.type === 'activity_summary') {
    return false
  }

  if (entry.type === 'agent_message') {
    return (
      context.activeAgentRole === 'manager' &&
      context.activeAgentId !== null &&
      entry.agentId === context.activeAgentId &&
      isProjectAgentExchange(entry, agentsById)
    )
  }

  if (entry.type !== 'conversation_message') return true
  if (entry.source === 'worker_report') return false
  const channel = entry.sourceContext?.channel ?? 'web'
  return channel === 'web' || channel === 'cli'
}

export function isProjectAgentExchange(
  entry: Extract<ConversationEntry, { type: 'agent_message' }>,
  agentsById: ReadonlyMap<string, BuilderTimelineAgentRef>,
): boolean {
  if (entry.source !== 'agent_to_agent') return false
  if (entry.projectAgentExchange === true) return true

  const from = entry.fromAgentId ? agentsById.get(entry.fromAgentId) : undefined
  const to = agentsById.get(entry.toAgentId)
  return Boolean(
    from?.role === 'manager' &&
    to?.role === 'manager' &&
    (from.projectAgent !== undefined || to.projectAgent !== undefined)
  )
}
