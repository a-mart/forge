export type RuntimeExtensionSource =
  | 'global-worker'
  | 'global-manager'
  | 'profile'
  | 'project-local'
  | 'package'
  | 'unknown'

export type DiscoveredExtensionSource =
  | 'global-worker'
  | 'global-manager'
  | 'profile'
  | 'project-local'

export interface DiscoveredExtensionMetadata {
  displayName: string
  path: string
  source: DiscoveredExtensionSource
  profileId?: string
  cwd?: string
}

export interface RuntimeExtensionMetadata {
  displayName: string
  path: string
  resolvedPath: string
  source: RuntimeExtensionSource
  events: string[]
  tools: string[]
}

export interface RuntimeExtensionLoadError {
  path: string
  error: string
}

export interface AgentRuntimeExtensionSnapshot {
  agentId: string
  role: 'manager' | 'worker'
  managerId: string
  profileId?: string
  loadedAt: string
  extensions: RuntimeExtensionMetadata[]
  loadErrors: RuntimeExtensionLoadError[]
}

export interface SettingsExtensionsResponse {
  generatedAt: string
  discovered: DiscoveredExtensionMetadata[]
  snapshots: AgentRuntimeExtensionSnapshot[]
  directories: {
    globalWorker: string
    globalManager: string
    profileTemplate: string
    projectLocalRelative: string
  }
}
