import type { ManagerWsTerminalEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleTerminalEvent(
  event: ServerEvent,
  context: ManagerWsTerminalEventContext,
): boolean {
  switch (event.type) {
    case 'terminals_snapshot':
      context.updateState({
        terminals: event.terminals,
        terminalSessionScopeId: event.sessionAgentId,
      })
      return true

    case 'terminal_created':
    case 'terminal_updated': {
      if (event.sessionAgentId !== context.state.terminalSessionScopeId) {
        return true
      }

      const existingIndex = context.state.terminals.findIndex(
        (terminal) => terminal.terminalId === event.terminal.terminalId,
      )
      const terminals =
        existingIndex >= 0
          ? context.state.terminals.map((terminal, index) =>
              index === existingIndex ? event.terminal : terminal,
            )
          : [...context.state.terminals, event.terminal]
      context.updateState({ terminals })
      return true
    }

    case 'terminal_closed': {
      if (event.sessionAgentId !== context.state.terminalSessionScopeId) {
        return true
      }

      context.updateState({
        terminals: context.state.terminals.filter(
          (terminal) => terminal.terminalId !== event.terminalId,
        ),
      })
      return true
    }

    default:
      return false
  }
}
