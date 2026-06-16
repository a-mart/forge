import { describe, expect, it } from 'vitest'
import {
  classifyMissingUpstreamModel,
  isPendingPiUpstreamDivergence,
  PENDING_PI_UPSTREAM_NOTE_PREFIX,
} from '../model-catalog-audit-helpers.mjs'

describe('model-catalog-audit helpers', () => {
  it('recognizes pending Pi upstream divergence notes by prefix', () => {
    expect(isPendingPiUpstreamDivergence(`${PENDING_PI_UPSTREAM_NOTE_PREFIX}; projected via Forge catalog allowlist.`)).toBe(true)
    expect(isPendingPiUpstreamDivergence(' pending pi upstream; waiting for upstream')).toBe(true)
    expect(isPendingPiUpstreamDivergence('Synthetic native Claude Agent SDK runtime variant.')).toBe(false)
    expect(isPendingPiUpstreamDivergence(null)).toBe(false)
  })

  it('classifies missing upstream models as pending only when explicitly marked', () => {
    expect(
      classifyMissingUpstreamModel({
        piUpstreamId: 'claude-opus-4-8',
        intentionalDivergenceNotes:
          'Pending Pi upstream; projected via Forge catalog allowlist until Pi ships claude-opus-4-8.',
      }),
    ).toBe('pending')

    expect(
      classifyMissingUpstreamModel({
        piUpstreamId: 'claude-opus-4-8',
        intentionalDivergenceNotes: null,
      }),
    ).toBe('fail')

    expect(
      classifyMissingUpstreamModel({
        piUpstreamId: null,
        intentionalDivergenceNotes: 'Pending Pi upstream; should not apply without piUpstreamId.',
      }),
    ).toBe('fail')
  })
})
