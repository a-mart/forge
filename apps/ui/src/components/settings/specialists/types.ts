import type {
  ManagerReasoningLevel,
  ModelPresetInfo,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'
import type { SelectableModel } from '@/lib/model-preset'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const SCOPE_GLOBAL = 'global' as const

export const SPECIALIST_COLORS = [
  '#2563eb', // blue
  '#7c3aed', // violet
  '#059669', // emerald
  '#d97706', // amber
  '#dc2626', // red
  '#0891b2', // cyan
  '#c026d3', // fuchsia
  '#65a30d', // lime
  '#f97316', // orange
  '#6b7280', // gray
  '#ec4899', // pink
  '#10b981', // green
  '#f59e0b', // yellow
]

export const DEFAULT_WHEN_TO_USE = 'General-purpose worker for implementation tasks.'
export const DEFAULT_MODEL_ID = 'gpt-5.3-codex'
export const DEFAULT_REASONING_LEVEL: ManagerReasoningLevel = 'xhigh'

export const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

/** Human-friendly provider labels for Select group headers. */
export const PROVIDER_LABELS: Record<string, string> = {
  'openai-codex': 'OpenAI Codex',
  'anthropic': 'Anthropic',
  'claude-sdk': 'Claude SDK',
  xai: 'xAI',
}

export const HIDE_DISABLED_KEY = 'forge-specialists-hide-disabled'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SettingsSpecialistsProps {
  wsUrl: string
  apiClient?: import('../settings-api-client').SettingsApiClient
  profiles: import('@forge/protocol').ManagerProfile[]
  specialistChangeKey: number
  modelConfigChangeKey: number
}

export interface CardEditState {
  handle: string
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  provider: string
  reasoningLevel: string
  fallbackModelId: string
  fallbackProvider: string
  fallbackReasoningLevel: string
  pinned: boolean
  webSearch: boolean
  promptBody: string
}

export type SpecialistCardMode = 'global' | 'profileOverride' | 'inherited'

export interface SpecialistCardProps {
  mode: SpecialistCardMode
  specialist: ResolvedSpecialistDefinition
  isEditing: boolean
  editState: CardEditState | undefined
  isSaving: boolean
  isCloning?: boolean
  cardError?: string
  isPromptExpanded: boolean
  isFallbackExpanded: boolean
  onExpand: () => void
  onCancelEditing: () => void
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  onSave: () => void
  onDelete?: () => void
  onRevert?: () => void
  onClone?: () => void
  onToggleEnabled: () => void
  onTogglePrompt: () => void
  onToggleFallback: () => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  allSpecialists: ResolvedSpecialistDefinition[]
}
