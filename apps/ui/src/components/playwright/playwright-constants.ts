/**
 * Sentinel value used as the worktree filter key for sessions that live on the
 * repo root (i.e. `session.worktreeName === null`).  Chosen to never collide
 * with a real git-worktree directory name.
 */
export const REPO_ROOT_WORKTREE_KEY = '__repo_root__'

/** User-facing label for repo-root sessions in the worktree dropdown. */
export const REPO_ROOT_WORKTREE_LABEL = 'Main repo'
