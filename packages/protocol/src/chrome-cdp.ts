export interface ChromeCdpEndpoint {
  portFile: string
  port: number
  wsPath: string
  wsUrl: string
}

export interface ChromeCdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  browserContextId?: string
}

export interface ChromeCdpVersionInfo {
  Browser?: string
  product?: string
  revision?: string
  userAgent?: string
  jsVersion?: string
}

export interface ChromeCdpConfig {
  contextId: string | null
  urlAllow: string[]
  urlBlock: string[]
}

export interface ChromeCdpStatus {
  connected: boolean
  port?: number
  browser?: string
  version?: string
  tabCount?: number
  error?: string
}

export interface ChromeCdpProfile {
  contextId: string
  tabCount: number
  sampleUrls: string[]
  isDefault: boolean
}

export interface ChromeCdpPreviewTab {
  targetId: string
  title: string
  url: string
}
