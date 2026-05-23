import type { AgentModelDescriptor, ProjectAgentCapability, ProjectAgentSourceProblem, ProjectAgentSourceStatus } from './agents.js'

export type ProjectResourceTrustState = 'trusted' | 'blocked' | 'untrusted' | 'not_applicable'

export interface ProjectResourcePathInventoryItem {
  path: string
  kind: 'file' | 'directory'
}

export interface ProjectResourceInventorySection {
  path?: string
  exists: boolean
  count: number
  items: ProjectResourcePathInventoryItem[]
  truncated?: boolean
}

export interface RepoProjectAgentDefinitionConfig {
  version: 1
  handle: string
  displayName?: string
  whenToUse: string
  capabilities?: ProjectAgentCapability[]
  model?: AgentModelDescriptor
}

export interface RepoProjectAgentInventoryItem {
  definitionId: string
  handle: string
  path: string
  status: ProjectAgentSourceStatus
  problems: ProjectAgentSourceProblem[]
  displayName?: string
  whenToUse?: string
  requestedCapabilities?: ProjectAgentCapability[]
  recommendedModel?: AgentModelDescriptor
  activatedAgentId?: string
  signature?: string
}

export interface RepoProjectAgentInventorySection {
  path?: string
  exists: boolean
  count: number
  items: RepoProjectAgentInventoryItem[]
  truncated?: boolean
  problems?: ProjectAgentSourceProblem[]
}

export interface ActivateRepoProjectAgentRequest {
  profileId: string
  sessionAgentId: string
  handle: string
  mode: 'create' | 'link'
  targetAgentId?: string
  applyRecommendedModel?: boolean
  approvedCapabilities?: ProjectAgentCapability[]
  explicitBindToSourceWorkspace?: boolean
}

export interface ProjectResourceExecutableSurface {
  kind:
    | 'repo-forge-extensions'
    | 'repo-pi-extensions'
    | 'repo-pi-settings'
    | 'exact-cwd-forge-extension'
    | 'exact-cwd-pi-extension'
    | 'exact-cwd-pi-settings'
  path: string
  exists: boolean
  activeToday?: boolean
  compatibilityPolicy?: 'preserve-with-warning' | 'do-not-create'
  coveredByTrustKey?: string
}

export interface ProjectResourceScaffoldState {
  targetDir?: string
  canSeed: boolean
  missing: string[]
}

export interface ProjectResourcesSnapshotResponse {
  generatedAt: string
  profileId: string
  sessionAgentId: string
  cwdRealpath: string
  detectedGitRoot?: string
  warning?: string
  defaultForgeDir?: string
  effectiveForgeDir?: string
  effectiveForgeDirRealpath?: string
  source: 'git-root' | 'override' | 'none'
  override?: { path: string; valid: boolean; error?: string }
  trust: { state: ProjectResourceTrustState; key?: string }
  signature: string
  dismissedPrompt?: { signature: string; dismissedAt: string }
  scaffold: ProjectResourceScaffoldState
  resources: {
    skills: ProjectResourceInventorySection
    specialists: ProjectResourceInventorySection
    reference: ProjectResourceInventorySection
    forgeExtensions: ProjectResourceInventorySection
    piExtensions: ProjectResourceInventorySection
    piSettings: ProjectResourceInventorySection
    projectAgents?: RepoProjectAgentInventorySection
  }
  executableSurfaces: ProjectResourceExecutableSurface[]
}

export interface ProjectResourceOverrideRequest {
  profileId: string
  sessionAgentId: string
  forgeDir: string | null
}

export interface ProjectResourceTrustRequest {
  profileId: string
  sessionAgentId: string
  action: 'trust' | 'block' | 'reset'
}

export interface ProjectResourceSeedRequest {
  profileId: string
  sessionAgentId: string
}

export interface ProjectResourceMutationResponse {
  success: true
  snapshot: ProjectResourcesSnapshotResponse
}
