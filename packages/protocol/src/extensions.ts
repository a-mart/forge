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

export type ForgeScope = 'global' | 'profile' | 'project-local'
export type ForgeRuntimeType = 'pi' | 'claude' | 'codex'

export interface ForgeDiscoveredExtensionMetadata {
  displayName: string
  path: string
  scope: ForgeScope
  profileId?: string
  cwd?: string
  name?: string
  description?: string
  loadError?: string
}

export interface ForgeRuntimeExtensionMetadata {
  displayName: string
  path: string
  scope: ForgeScope
  name?: string
  description?: string
  hooks: string[]
}

export interface ForgeRuntimeExtensionSnapshot {
  agentId: string
  role: 'manager' | 'worker'
  managerId: string
  profileId?: string
  runtimeType: ForgeRuntimeType
  loadedAt: string
  extensions: ForgeRuntimeExtensionMetadata[]
}

export interface ForgeExtensionDiagnosticError {
  timestamp: string
  phase: string
  message: string
  path?: string
  hook?: string
  agentId?: string
  runtimeType?: ForgeRuntimeType
}

export interface ForgeSettingsExtensionsPayload {
  discovered: ForgeDiscoveredExtensionMetadata[]
  snapshots: ForgeRuntimeExtensionSnapshot[]
  recentErrors: ForgeExtensionDiagnosticError[]
  directories: {
    global: string
    profileTemplate: string
    projectLocalRelative: string
  }
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
  forge?: ForgeSettingsExtensionsPayload
}
