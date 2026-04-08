export type PromptCategory = 'archetype' | 'operational'

export type PromptSourceLayer = 'profile' | 'repo' | 'builtin'

export interface PromptVariableDeclaration {
  name: string
  description: string
}

export interface PromptListEntry {
  category: PromptCategory
  promptId: string
  displayName: string
  description: string
  activeLayer: PromptSourceLayer
  hasProfileOverride: boolean
  variables: PromptVariableDeclaration[]
}

export interface PromptContentResponse {
  category: PromptCategory
  promptId: string
  content: string
  sourceLayer: PromptSourceLayer
  sourcePath: string
  variables: PromptVariableDeclaration[]
}

export type CortexPromptSurfaceKind = 'registry' | 'file'
export type CortexPromptSurfaceGroup = 'system' | 'seed' | 'live' | 'scratch'
export type CortexPromptSurfaceRuntimeEffect =
  | 'futureSeedOnly'
  | 'liveImmediate'
  | 'liveInjected'
  | 'scratchOnly'
export type CortexPromptResetMode = 'profileOverride' | 'reseedFromTemplate' | 'none'

export interface CortexPromptSurfaceSeedPrompt {
  category: PromptCategory
  promptId: string
}

export interface CortexPromptSurfaceListEntry {
  surfaceId: string
  title: string
  description: string
  group: CortexPromptSurfaceGroup
  kind: CortexPromptSurfaceKind
  editable: boolean
  resetMode: CortexPromptResetMode
  runtimeEffect: CortexPromptSurfaceRuntimeEffect
  warning?: string
  category?: PromptCategory
  promptId?: string
  activeLayer?: PromptSourceLayer
  filePath?: string
  sourcePath?: string
  lastModifiedAt?: string
  seedPrompt?: CortexPromptSurfaceSeedPrompt | null
}

export interface CortexPromptSurfaceContentResponse extends CortexPromptSurfaceListEntry {
  content: string
}

export interface CortexPromptSurfaceListResponse {
  enabled: boolean
  surfaces: CortexPromptSurfaceListEntry[]
}
