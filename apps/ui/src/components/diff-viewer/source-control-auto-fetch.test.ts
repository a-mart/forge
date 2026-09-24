import { describe, expect, it, beforeEach } from 'vitest'
import {
  SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS,
  isSourceControlAutoFetchEligible,
  markOriginFetchCompleted,
  resetSourceControlAutoFetchFreshnessForTests,
  shouldAutoFetchOrigin,
} from './source-control-auto-fetch'

describe('source-control-auto-fetch', () => {
  beforeEach(() => {
    resetSourceControlAutoFetchFreshnessForTests()
  })

  it('allows auto-fetch only for workspace repos with origin configured', () => {
    expect(
      isSourceControlAutoFetchEligible({
        repoTarget: 'workspace',
        agentId: 'agent-1',
        currentHead: 'abc',
        statusHash: 'status',
        remotes: ['origin'],
      }),
    ).toBe(true)

    expect(
      isSourceControlAutoFetchEligible({
        repoTarget: 'versioning',
        agentId: 'agent-1',
        currentHead: 'abc',
        statusHash: 'status',
        remotes: ['origin'],
      }),
    ).toBe(false)

    expect(
      isSourceControlAutoFetchEligible({
        repoTarget: 'workspace',
        agentId: 'agent-1',
        currentHead: 'abc',
        statusHash: 'status',
        remotes: [],
      }),
    ).toBe(false)
  })

  it('treats missing fetch history as stale', () => {
    const key = 'agent-1:workspace:session:origin'
    expect(shouldAutoFetchOrigin(key, 1_000)).toBe(true)
  })

  it('skips auto-fetch inside the freshness window', () => {
    const key = 'agent-1:workspace:session:origin'
    const now = 10_000
    markOriginFetchCompleted(key, now)

    expect(shouldAutoFetchOrigin(key, now + SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS - 1)).toBe(false)
    expect(shouldAutoFetchOrigin(key, now + SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS)).toBe(true)
  })
})
