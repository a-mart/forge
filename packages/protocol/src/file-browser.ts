import type { GitSourceContextKind } from './git.js'

export interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
}

export interface FileBrowserSourceContext {
  kind: Extract<GitSourceContextKind, 'workspace' | 'worktree'>
  worktreeId?: string
  worktreePath?: string
  isSessionCwd: boolean
}

export interface FileListResult {
  cwd: string
  path: string
  entries: FileEntry[]
  isGitRepo?: boolean
  repoName?: string
  branch?: string | null
  context?: FileBrowserSourceContext
}

export interface FileCountResult {
  count: number
  method: 'git' | 'none'
}

export interface FileSearchMatch {
  path: string
  type: 'file'
}

export interface FileSearchResult {
  results: FileSearchMatch[]
  totalMatches: number
  unavailable?: true
}

export interface FileVersionToken {
  kind: 'sha256-stat-v1'
  sha256: string
  size: number
  mtimeMs: number
}

export type FileEditabilityReason =
  | 'binary'
  | 'too_large'
  | 'unsupported_encoding'
  | 'not_file'
  | 'read_error'

export interface FileEditability {
  editable: boolean
  reason?: FileEditabilityReason
  maxEditableBytes: number
}

export interface FileContentResult {
  content: string | null
  binary: boolean
  size: number
  lines?: number
  encoding?: 'utf8'
  version?: FileVersionToken
  editability?: FileEditability
}

export interface FileSaveNormalRequest {
  agentId: string
  path: string
  content: string
  baseVersion: FileVersionToken
  worktreeId?: string | null
  overwrite?: false
}

export interface FileSaveOverwriteRequest {
  agentId: string
  path: string
  content: string
  baseVersion: FileVersionToken
  worktreeId?: string | null
  overwrite: true
}

export type FileSaveRequest = FileSaveNormalRequest | FileSaveOverwriteRequest

export type FileSaveConflictReason =
  | 'modified'
  | 'deleted'
  | 'not_file'
  | 'binary'
  | 'too_large'
  | 'unsupported_encoding'

export interface FileSaveConflictResponse {
  success: false
  conflict: true
  reason: FileSaveConflictReason
  currentVersion?: FileVersionToken
  currentSize?: number
}

export interface FileSaveSuccessResponse {
  success: true
  version: FileVersionToken
  size: number
  lines: number
  bytesWritten: number
}

export type FileSaveResponse = FileSaveSuccessResponse | FileSaveConflictResponse

export interface FileDeleteRequest {
  agentId: string
  path: string
  worktreeId?: string | null
}

export interface FileDeleteResponse {
  success: true
  path: string
  entryType: 'file' | 'directory'
}
