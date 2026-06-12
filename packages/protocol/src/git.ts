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

// --- Source Control workspace (additive; existing repoTarget=workspace defaults unchanged) ---

export type GitSourceContextKind = 'workspace' | 'versioning' | 'worktree'

export interface GitSourceContextRef {
  repoTarget: GitRepoTarget
  worktreeId?: string
}

export interface GitWorktreeAgentSummary {
  agentId: string
  displayName: string
  role: 'manager' | 'worker'
  status: string
}

export interface GitWorktreeSummary {
  id: string
  path: string
  repoRoot: string
  branch: string | null
  headSha: string | null
  isMainWorktree: boolean
  isCurrentContext: boolean
  locked?: boolean
  prunable?: boolean
  dirty: boolean
  dirtySummary: { filesChanged: number; insertions: number; deletions: number }
  activeAgents: GitWorktreeAgentSummary[]
}

export interface GitWorktreeListResult extends GitRepoMetadata {
  worktrees: GitWorktreeSummary[]
  context: GitSourceContextRef
  notInitialized?: boolean
}

export type GitBranchKind = 'local' | 'remote' | 'current'

export interface GitBranchSummary {
  name: string
  kind: GitBranchKind
  headSha: string | null
  upstream?: string | null
  ahead?: number
  behind?: number
  isCheckedOutInAnotherWorktree?: boolean
}

export interface GitBranchListResult extends GitRepoMetadata {
  branches: GitBranchSummary[]
  remotes: string[]
  currentBranch: string | null
  currentHead: string | null
  statusHash: string | null
  context: GitSourceContextRef
  notInitialized?: boolean
}

export interface GitMutationRequestBase {
  agentId: string
  repoTarget?: GitRepoTarget
  worktreeId?: string
  expectedHead: string
  expectedStatusHash: string
}

export interface GitFetchRequest extends GitMutationRequestBase {
  remote?: string
}

export interface GitSwitchBranchRequest extends GitMutationRequestBase {
  branch: string
}

export interface GitCreateBranchRequest extends GitMutationRequestBase {
  branch: string
  startPoint?: string
}

export interface GitPullFfOnlyRequest extends GitMutationRequestBase {
  remote?: string
}

export type GitPreflightIssueSeverity = 'block' | 'warn'

export interface GitPreflightIssue {
  code: string
  message: string
  severity: GitPreflightIssueSeverity
}

export interface GitMutationPreflight {
  allowed: boolean
  issues: GitPreflightIssue[]
  currentBranch: string | null
  currentHead: string | null
  statusHash: string | null
}

export interface GitMutationResult extends GitRepoMetadata {
  success: boolean
  context: GitSourceContextRef
  currentBranch: string | null
  currentHead: string | null
  warnings: string[]
  errors: string[]
  statusSummary: { filesChanged: number; insertions: number; deletions: number }
  invalidateCaches: boolean
}

export interface GitFetchResult extends GitMutationResult {
  remote: string
}

export interface GitPullResult extends GitMutationResult {
  remote: string
  upstream: string
  fastForward: boolean
}

export type GitHostedProviderKind = 'github' | 'none'

export interface GitHostedProviderStatus {
  provider: GitHostedProviderKind
  available: boolean
  authenticated: boolean
  remoteUrl: string | null
  message?: string
}

export type GitPullRequestState = 'open' | 'closed' | 'merged'

export interface GitPullRequestSummary {
  number: number
  title: string
  state: GitPullRequestState
  author: string
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  mergedAt?: string | null
  headRef: string
  baseRef: string
  isDraft: boolean
  isCurrentBranch: boolean
  checkStatus?: 'pending' | 'success' | 'failure' | 'neutral' | null
  reviewDecision?: string | null
  providerUrl?: string
}

export interface GitPullRequestListResult extends GitRepoMetadata {
  open: GitPullRequestSummary[]
  recentlyClosed: GitPullRequestSummary[]
  currentBranchPullRequest: GitPullRequestSummary | null
  providerStatus: GitHostedProviderStatus
  context: GitSourceContextRef
  notInitialized?: boolean
}

export interface GitPullRequestCheckSummary {
  name: string
  status: 'pending' | 'success' | 'failure' | 'neutral'
  url?: string
}

export interface GitPullRequestDetail extends GitPullRequestSummary {
  body: string
  mergeable: boolean | null
  mergeBlockedReason?: string
  checks: GitPullRequestCheckSummary[]
  reviewDecision?: string | null
  changedFiles: number
  additions: number
  deletions: number
  headSha: string
}
