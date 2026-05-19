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
  resources: {
    skills: ProjectResourceInventorySection
    specialists: ProjectResourceInventorySection
    reference: ProjectResourceInventorySection
    forgeExtensions: ProjectResourceInventorySection
    piExtensions: ProjectResourceInventorySection
    piSettings: ProjectResourceInventorySection
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
