/* ------------------------------------------------------------------ */
/*  Types for the Skills Viewer feature                               */
/* ------------------------------------------------------------------ */

/** Full skill inventory entry returned by GET /api/settings/skills */
export interface SkillInventoryEntry {
  skillId: string
  name: string
  directoryName: string
  description?: string
  envCount: number
  hasRichConfig: boolean
  sourceKind: 'builtin' | 'repo' | 'machine-local' | 'profile'
  profileId?: string
  rootPath: string
  skillFilePath: string
  isInherited: boolean
  isEffective: boolean
}

/** File/directory entry returned by the files API */
export interface SkillFileEntry {
  name: string
  path: string
  absolutePath: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
}

/** File listing response from GET /api/settings/skills/:skillId/files */
export interface SkillFilesResponse {
  skillId: string
  rootPath: string
  path: string
  entries: SkillFileEntry[]
}

/** File content response from GET /api/settings/skills/:skillId/content */
export interface SkillFileContentResponse {
  path: string
  absolutePath: string
  content: string | null
  binary: boolean
  size: number
  lines?: number
}
