import type { ConversationEntry } from '@forge/protocol'
import type {
  ConversationLogEntry,
  ToolExecutionDisplayEntry,
  ToolExecutionEvent,
  ToolExecutionLogEntry,
} from './types'

export type { ToolExecutionEvent }

export function isToolExecutionLog(
  entry: ConversationLogEntry,
): entry is ToolExecutionLogEntry {
  return (
    entry.kind === 'tool_execution_start' ||
    entry.kind === 'tool_execution_update' ||
    entry.kind === 'tool_execution_end'
  )
}

export function isToolExecutionEvent(
  entry: ConversationEntry,
): entry is ToolExecutionEvent {
  if (entry.type === 'agent_tool_call') {
    return true
  }

  return entry.type === 'conversation_log' && isToolExecutionLog(entry)
}

export function resolveToolExecutionEventActorAgentId(
  event: ToolExecutionEvent,
): string {
  return event.type === 'agent_tool_call' ? event.actorAgentId : event.agentId
}

export function hydrateToolDisplayEntry(
  displayEntry: ToolExecutionDisplayEntry,
  event: ToolExecutionEvent,
): void {
  displayEntry.actorAgentId = resolveToolExecutionEventActorAgentId(event)
  displayEntry.toolName = event.toolName ?? displayEntry.toolName
  displayEntry.toolCallId = event.toolCallId ?? displayEntry.toolCallId
  displayEntry.timestamp = event.timestamp
  displayEntry.latestKind = event.kind
  // A raw live event is richer than the replay-safe collapsed summary. Clear
  // a summary that may have arrived first so it cannot mask live input/output.
  displayEntry.displaySummary = undefined

  if (event.kind === 'tool_execution_start') {
    if (!displayEntry.startTimestamp) {
      displayEntry.startTimestamp = event.timestamp
    }
    displayEntry.inputPayload = event.text
    displayEntry.latestPayload = event.text
    displayEntry.outputPayload = undefined
    displayEntry.isError = false
    return
  }

  if (event.kind === 'tool_execution_update') {
    displayEntry.latestPayload = event.text
    return
  }

  displayEntry.outputPayload = event.text
  displayEntry.latestPayload = event.text
  displayEntry.isError = event.isError
}
