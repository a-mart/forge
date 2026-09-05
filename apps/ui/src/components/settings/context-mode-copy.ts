import { DEFAULT_CONTEXT_MODE, type ContextMode, type SessionContextModeSnapshot } from '@forge/protocol'

export type SessionContextModeChoice = 'inherit' | ContextMode

export const CONTEXT_MODE_OPTION_LABELS: Record<ContextMode, string> = {
  summary: 'Summary (default)',
  fresh: 'Fresh windows (experimental)',
}

export const CONTEXT_MODE_SHORT_LABELS: Record<ContextMode, string> = {
  summary: 'Summary',
  fresh: 'Fresh windows',
}

export const CONTEXT_MANAGEMENT_TITLE = 'Context management'

export const CONTEXT_MANAGEMENT_DESCRIPTION =
  'Choose how this project continues when context fills. Summary generates a summary; Fresh windows starts from a checkpoint and retrieves older history. History search uses lexical matching.'

export const CONTEXT_MODE_APPLIES_LATER =
  'Saving this setting does not clear the current conversation. It applies at the next context transition.'

export const SESSION_CONTEXT_MODE_INHERIT_LABEL = 'Use project default'

export function contextModeShortLabel(mode: ContextMode): string {
  return CONTEXT_MODE_SHORT_LABELS[mode]
}

export function sessionContextModeChoice(
  snapshot: Pick<SessionContextModeSnapshot, 'sessionOverride'> | null | undefined,
): SessionContextModeChoice {
  return snapshot?.sessionOverride ?? 'inherit'
}

export function inheritChoiceLabel(projectDefault: ContextMode = DEFAULT_CONTEXT_MODE): string {
  return `${SESSION_CONTEXT_MODE_INHERIT_LABEL} (${contextModeShortLabel(projectDefault)})`
}

export function sessionContextOriginLabel(
  snapshot: Pick<SessionContextModeSnapshot, 'sessionOverride'> | null | undefined,
): string {
  return snapshot?.sessionOverride ? 'session override' : 'project default'
}

export function sessionContextStatusLabel(snapshot: SessionContextModeSnapshot): string {
  return `Effective: ${contextModeShortLabel(snapshot.effectiveMode)} · ${sessionContextOriginLabel(snapshot)}`
}
