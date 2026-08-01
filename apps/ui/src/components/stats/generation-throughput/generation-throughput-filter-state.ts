import type { GenerationThroughputFilterState } from './GenerationThroughputFilters'

export function providerFilterPatch(value: string): Partial<GenerationThroughputFilterState> {
  return {
    provider: value === 'all' ? undefined : value,
    // A model is provider-scoped. Clear it for every provider selection,
    // including "All providers", so no hidden stale model constrains the query.
    modelId: undefined,
  }
}
