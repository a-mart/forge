import type {
  PromptCategory,
  PromptSourceLayer,
} from './shared-types.js'

export interface PromptChangedEvent {
  type: 'prompt_changed'
  category: PromptCategory
  promptId: string
  layer: PromptSourceLayer
  action: 'saved' | 'deleted'
}

export interface CortexPromptSurfaceChangedEvent {
  type: 'cortex_prompt_surface_changed'
  profileId: string
  surfaceId: string
  filePath: string
  updatedAt: string
}

export interface SpecialistRosterChangedEvent {
  type: 'specialist_roster_changed'
  profileId: string
  specialistIds: string[]
  updatedAt: string
}

export interface ModelConfigChangedEvent {
  type: 'model_config_changed'
  updatedAt: string
}
