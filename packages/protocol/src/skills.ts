export type SkillSourceKind = 'builtin' | 'repo' | 'machine-local' | 'profile'

export interface SkillInventoryEntry {
  skillId: string
  name: string
  directoryName: string
  description?: string
  envCount: number
  hasRichConfig: boolean
  sourceKind: SkillSourceKind
  profileId?: string
  rootPath: string
  skillFilePath: string
  isInherited: boolean
  isEffective: boolean
}

export interface SkillInventoryResponse {
  skills: SkillInventoryEntry[]
}

export interface SkillFileEntry {
  name: string
  path: string
  absolutePath: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
}

export interface SkillFilesResponse {
  skillId: string
  rootPath: string
  path: string
  entries: SkillFileEntry[]
}

export interface SkillFileContentResponse {
  path: string
  absolutePath: string
  content: string | null
  binary: boolean
  size: number
  lines?: number
}

export type SkillBundleFormat = 'forge.skill.bundle.v1'

export type SkillBundleFileEncoding = 'utf8' | 'base64'

export type SkillBundleWarningSeverity = 'info' | 'warning' | 'error'

export type SkillBundleScriptKind =
  | 'shell'
  | 'powershell'
  | 'batch'
  | 'node'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'other'

export type SkillBundleDependencyManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'pip'
  | 'uv'
  | 'poetry'
  | 'cargo'
  | 'go'
  | 'other'

export interface SkillBundleIssue {
  severity: SkillBundleWarningSeverity
  code: string
  message: string
  path?: string
}

export interface SkillBundleEnvDeclaration {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
}

export interface SkillBundleOsIndicator {
  path: string
  token: string
  severity: 'info' | 'warning'
}

export interface SkillBundleScriptInfo {
  path: string
  kind: SkillBundleScriptKind
  shebang?: string
  executable?: boolean
  warnings: string[]
}

export interface SkillBundleDependencyInfo {
  path: string
  manager: SkillBundleDependencyManager
  summary: string
  warnings: string[]
}

export interface SkillBundleFileEntry {
  path: string
  size: number
  sha256: string
  encoding: SkillBundleFileEncoding
  executable?: boolean
  content: string
}

export interface SkillBundleManifestV1 {
  format: SkillBundleFormat
  bundleVersion: 1
  createdAt: string
  contentSha256: string
  origin: {
    forgeVersion?: string
    platform: string
    arch: string
    osRelease?: string
    skillSourceKind: SkillSourceKind
    profileId?: string
  }
  skill: {
    handle: string
    name: string
    description?: string
    env: SkillBundleEnvDeclaration[]
    frontmatter: {
      knownForgeKeys: string[]
      knownPiKeys: string[]
      unsupportedKeys: string[]
      warnings: string[]
    }
  }
  portability: {
    osIndicators: SkillBundleOsIndicator[]
    scripts: SkillBundleScriptInfo[]
    dependencies: SkillBundleDependencyInfo[]
  }
  files: SkillBundleFileEntry[]
  totals: {
    fileCount: number
    byteCount: number
  }
}

export type SkillBundlePreviewFileEntry = Omit<SkillBundleFileEntry, 'content'>

export type SkillBundlePreviewManifestV1 = Omit<SkillBundleManifestV1, 'files'> & {
  files: SkillBundlePreviewFileEntry[]
}

export type SkillImportScope = 'global' | 'profile'

export interface SkillImportTarget {
  scope: SkillImportScope
  profileId?: string
}

export interface SkillImportConflictState {
  exists: boolean
  existingSourceKind?: SkillSourceKind
  existingSkillId?: string
  existingRootPath?: string
}

export interface SkillImportPreviewResponse {
  bundle: SkillBundlePreviewManifestV1
  target: SkillImportTarget
  conflict: SkillImportConflictState
  warnings: SkillBundleIssue[]
}

export type SkillImportConflictStrategy = 'reject' | 'replace'

export interface SkillImportSource {
  url?: string
  bundle?: SkillBundleManifestV1
}

export interface SkillImportPreviewUrlRequest {
  url: string
  target?: SkillImportTarget
}

export interface SkillImportPreviewBundleRequest {
  bundle: SkillBundleManifestV1
  target?: SkillImportTarget
}

export interface SkillImportRequest {
  source: SkillImportSource
  target?: SkillImportTarget
  conflictStrategy?: SkillImportConflictStrategy
  confirmReplace?: boolean
}

export interface SkillImportResultResponse {
  bundle: SkillBundlePreviewManifestV1
  target: SkillImportTarget
  rootPath: string
  skillId?: string
  replaced: boolean
  warnings: SkillBundleIssue[]
}

export interface SkillShareResponse {
  shareUrl: string
  importUrl: string
  expiresAt: string
  contentSha256: string
  warnings: SkillBundleIssue[]
}
