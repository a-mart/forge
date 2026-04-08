export interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
}

export interface FileListResult {
  cwd: string
  path: string
  entries: FileEntry[]
  isGitRepo?: boolean
  repoName?: string
  branch?: string | null
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

export interface FileContentResult {
  content: string | null
  binary: boolean
  size: number
  lines?: number
}
