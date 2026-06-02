export const CODEX_MENTION_HANDLE = 'Codex' as const

export interface ProjectAgentSuggestion {
  agentId: string
  handle: string
  displayName: string
  whenToUse: string
}

export interface CodexMentionSuggestion {
  kind: 'codex'
  handle: typeof CODEX_MENTION_HANDLE
  displayName: string
  whenToUse: string
}

export interface CodexToolMentionSuggestion {
  kind: 'codex_tool'
  selector: string
  displayName: string
  whenToUse: string
  serverName: string
  toolName: string
}

export interface ProjectAgentMentionSuggestion extends ProjectAgentSuggestion {
  kind: 'project_agent'
}

export type MentionSuggestion =
  | CodexMentionSuggestion
  | CodexToolMentionSuggestion
  | ProjectAgentMentionSuggestion

export const CODEX_MENTION_SUGGESTION: CodexMentionSuggestion = {
  kind: 'codex',
  handle: CODEX_MENTION_HANDLE,
  displayName: 'Codex app-server',
  whenToUse: 'Route this message to Codex when placed at the start of your message.',
}

export function toProjectAgentMentionSuggestion(
  agent: ProjectAgentSuggestion,
): ProjectAgentMentionSuggestion {
  return { kind: 'project_agent', ...agent }
}

export function isCodexMentionSuggestion(
  suggestion: MentionSuggestion,
): suggestion is CodexMentionSuggestion {
  return suggestion.kind === 'codex'
}

export function isCodexToolMentionSuggestion(
  suggestion: MentionSuggestion,
): suggestion is CodexToolMentionSuggestion {
  return suggestion.kind === 'codex_tool'
}
