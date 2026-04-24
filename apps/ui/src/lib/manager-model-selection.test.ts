import { describe, expect, it } from 'vitest'
import {
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from './manager-model-selection'

describe('encodeManagerModelValue / decodeManagerModelValue', () => {
  it('round-trips provider and modelId', () => {
    const encoded = encodeManagerModelValue('anthropic', 'claude-opus-4-6')
    expect(encoded).toBe('anthropic::claude-opus-4-6')
    expect(decodeManagerModelValue(encoded)).toEqual({ provider: 'anthropic', modelId: 'claude-opus-4-6' })
  })

  it('returns undefined for invalid values', () => {
    expect(decodeManagerModelValue('')).toBeUndefined()
    expect(decodeManagerModelValue('no-separator')).toBeUndefined()
  })
})

describe('buildManagerModelRows provider availability gating', () => {
  it('marks managed-auth provider rows unavailable when providerAvailability is empty', () => {
    const rows = buildManagerModelRows('create', {}, {})

    // With empty providerAvailability, managed-auth providers should be unavailable
    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    expect(anthropicRows.length).toBeGreaterThan(0)
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeTruthy()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    expect(codexRows.length).toBeGreaterThan(0)
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeTruthy()
    }
  })

  it('marks managed-auth provider rows unavailable when providerAvailability is false', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': false,
      'openai-codex': false,
    })

    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeTruthy()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeTruthy()
    }
  })

  it('marks managed-auth provider rows available when providerAvailability is true', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': true,
      'openai-codex': true,
      'claude-sdk': true,
    })

    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    expect(anthropicRows.length).toBeGreaterThan(0)
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeUndefined()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    expect(codexRows.length).toBeGreaterThan(0)
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeUndefined()
    }
  })

  it('does not gate external-availability providers on providerAvailability', () => {
    // External providers (e.g. OpenRouter) should always be available regardless of providerAvailability
    const rows = buildManagerModelRows('change', {}, {})

    const externalRows = rows.filter((r) => r.provider === 'openrouter' || r.provider === 'cursor-acp')
    // External providers may or may not have models on the change surface,
    // but if they do, they should not be marked unavailable
    for (const row of externalRows) {
      expect(row.unavailableReason).toBeUndefined()
    }
  })
})

describe('groupManagerModelRows', () => {
  it('groups rows by provider preserving order', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': true,
      'openai-codex': true,
    })

    const available = rows.filter((r) => !r.unavailableReason)
    const groups = groupManagerModelRows(available)

    // Should have at least Anthropic and OpenAI Codex groups
    const providerIds = groups.map((g) => g.provider)
    expect(providerIds).toContain('anthropic')
    expect(providerIds).toContain('openai-codex')

    // Each group should have non-empty rows
    for (const group of groups) {
      expect(group.rows.length).toBeGreaterThan(0)
      // All rows in a group share the same provider
      for (const row of group.rows) {
        expect(row.provider).toBe(group.provider)
      }
    }
  })
})
