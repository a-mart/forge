/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'

function buildFileBrowserQueryKey(
  scope: string,
  agentId: string | null,
  worktreeId: string | null | undefined,
  ...parts: string[]
): string {
  return `${scope}:${agentId ?? ''}:${worktreeId ?? ''}:${parts.join(':')}`
}

describe('file browser query keys', () => {
  it('separates cache entries by worktreeId for the same agent and path', () => {
    const sessionKey = buildFileBrowserQueryKey('files:list', 'agent-1', null, 'src')
    const worktreeKey = buildFileBrowserQueryKey('files:list', 'agent-1', 'abc123', 'src')

    expect(sessionKey).not.toBe(worktreeKey)
    expect(sessionKey).toBe('files:list:agent-1::src')
    expect(worktreeKey).toBe('files:list:agent-1:abc123:src')
  })
})
