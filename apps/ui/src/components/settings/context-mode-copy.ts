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
  'Choose how this project continues when context fills. Summary carries forward a summary. Fresh windows uses task notes and retrieves earlier messages and tool results as needed.'

export const CONTEXT_MODE_DESCRIPTIONS: Record<ContextMode, string> = {
  summary: 'Continues from a summary of earlier work.',
  fresh: 'Continues from task notes and retrieves earlier messages and tool results as needed.',
}

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

export function sessionContextAppliedMode(snapshot: SessionContextModeSnapshot): ContextMode {
  return snapshot.appliedMode ?? (snapshot.freshSupported ? snapshot.effectiveMode : 'summary')
}

export function sessionContextPreferenceLabel(snapshot: SessionContextModeSnapshot): string {
  const origin = sessionContextOriginLabel(snapshot)
  return sessionContextAppliedMode(snapshot) === snapshot.effectiveMode
    ? origin
    : `${contextModeShortLabel(snapshot.effectiveMode)} saved as ${origin}`
}

export function sessionContextStatusLabel(snapshot: SessionContextModeSnapshot): string {
  return `Using: ${contextModeShortLabel(sessionContextAppliedMode(snapshot))} · ${sessionContextPreferenceLabel(snapshot)}`
}
