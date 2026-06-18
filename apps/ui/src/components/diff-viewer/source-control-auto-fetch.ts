import type { GitRepoTarget } from '@forge/protocol'

/** Avoid repeated origin fetches while Source Control stays open in one session. */
export const SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS = 5 * 60 * 1000

const lastFetchAtByKey = new Map<string, number>()

export function buildSourceControlAutoFetchKey(options: {
  agentId: string
  repoTarget: GitRepoTarget
  worktreeId?: string | null
  remote?: string
}): string {
  return [
    options.agentId,
    options.repoTarget,
    options.worktreeId ?? 'session',
    options.remote ?? 'origin',
  ].join(':')
}

export function isSourceControlAutoFetchEligible(options: {
  repoTarget: GitRepoTarget
  agentId: string | null
  currentHead: string | null | undefined
  statusHash: string | null | undefined
  remotes: string[] | undefined
  remote?: string
}): boolean {
  const remote = options.remote ?? 'origin'
  return (
    options.repoTarget === 'workspace' &&
    !!options.agentId &&
    !!options.currentHead &&
    !!options.statusHash &&
    (options.remotes?.includes(remote) ?? false)
  )
}

export function shouldAutoFetchOrigin(key: string, now = Date.now()): boolean {
  const lastFetchAt = lastFetchAtByKey.get(key)
  if (lastFetchAt == null) {
    return true
  }
  return now - lastFetchAt >= SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS
}

export function markOriginFetchCompleted(key: string, fetchedAt = Date.now()): void {
  lastFetchAtByKey.set(key, fetchedAt)
}

export function resetSourceControlAutoFetchFreshnessForTests(): void {
  lastFetchAtByKey.clear()
}
