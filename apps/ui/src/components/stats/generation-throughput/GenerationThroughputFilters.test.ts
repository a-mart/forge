import { describe, expect, it } from 'vitest'
import { providerFilterPatch } from './generation-throughput-filter-state'

describe('GenerationThroughputFilters provider changes', () => {
  it.each([
    ['a concrete provider', 'anthropic', { provider: 'anthropic', modelId: undefined }],
    ['All providers', 'all', { provider: undefined, modelId: undefined }],
  ])('clears a stale model when selecting %s', (_case, selected, expected) => {
    expect(providerFilterPatch(selected)).toEqual(expected)
    expect(providerFilterPatch(selected)).toHaveProperty('modelId', undefined)
  })
})
