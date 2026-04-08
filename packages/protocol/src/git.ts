import type { PromptCategory } from './prompts.js'

export type GitRepoTarget = 'workspace' | 'versioning'
export type GitRepoKind = 'workspace' | 'versioning'

export interface GitRepoMetadata {
  repoName: string
  repoRoot: string
  repoKind: GitRepoKind
  repoLabel: string
}

export interface GitFileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
  oldPath?: string
  additions?: number
  deletions?: number
}

export interface GitStatusResult extends GitRepoMetadata {
  files: GitFileStatus[]
  branch: string
  summary: { filesChanged: number; insertions: number; deletions: number }
  truncated?: boolean
  totalFiles?: number
  notInitialized?: boolean
}

export interface GitDiffResult {
  oldContent: string
  newContent: string
  binary?: true
  truncated?: true
  reason?: 'file_too_large'
  notInitialized?: boolean
}

export interface GitCommitMetadata {
  reason?: string
  source?: string
  sources?: string[]
  profileId?: string
  sessionId?: string
  agentId?: string
  reviewRunId?: string
  promptCategory?: PromptCategory
  promptId?: string
  paths: string[]
}

export interface GitLogEntry {
  sha: string
  shortSha: string
  message: string
  author: string
  date: string
  filesChanged: number
  metadata?: GitCommitMetadata | null
}

export interface GitLogResult {
  commits: GitLogEntry[]
  hasMore: boolean
  notInitialized?: boolean
}

export interface GitFileHistoryStats {
  totalEdits: number
  lastModifiedAt: string | null
  editsToday: number
  editsThisWeek: number
}

export interface GitFileLogResult {
  file: string
  commits: GitLogEntry[]
  stats: GitFileHistoryStats
  hasMore: boolean
  notInitialized?: boolean
}

export interface GitFileSectionProvenanceEntry {
  heading: string
  level: number
  lineStart: number
  lineEnd: number
  lastModifiedSha: string | null
  lastModifiedAt: string | null
  lastModifiedSummary: string | null
  reviewRunId: string | null
}

export interface GitFileSectionProvenanceResult {
  file: string
  sections: GitFileSectionProvenanceEntry[]
  notInitialized?: boolean
}

export interface GitCommitDetail {
  sha: string
  message: string
  author: string
  date: string
  files: GitFileStatus[]
  metadata?: GitCommitMetadata | null
  notInitialized?: boolean
}
