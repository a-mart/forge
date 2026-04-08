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
