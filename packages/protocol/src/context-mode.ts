/** Summary remains the default unless a project or session explicitly opts in. */
export const CONTEXT_MODES = ['summary', 'fresh'] as const
export type ContextMode = (typeof CONTEXT_MODES)[number]
export const DEFAULT_CONTEXT_MODE: ContextMode = 'summary'

export function isContextMode(value: unknown): value is ContextMode {
  return value === 'summary' || value === 'fresh'
}

export function resolveContextMode(
  projectDefault: ContextMode | undefined,
  sessionOverride: ContextMode | undefined,
): ContextMode {
  return sessionOverride ?? projectDefault ?? DEFAULT_CONTEXT_MODE
}

export interface SessionContextModeSnapshot {
  sessionAgentId: string
  profileId: string
  projectDefault: ContextMode
  sessionOverride?: ContextMode
  effectiveMode: ContextMode
  /** Fresh-window operation is a runtime capability, not implied by the saved preference. */
  freshSupported: boolean
  unsupportedReason?: string
}

export interface ProjectContextModeSnapshot {
  profileId: string
  mode: ContextMode
}

export interface UpdateSessionContextModeRequest {
  /** null restores project inheritance. */
  mode: ContextMode | null
}

export interface UpdateProjectContextModeRequest {
  mode: ContextMode
}
