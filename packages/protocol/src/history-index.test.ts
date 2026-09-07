import { describe, expectTypeOf, it } from 'vitest'
import type { HistoryIndexStatus, UpdateHistoryIndexSettingsRequest } from './index.js'
describe('History index public contract', () => {
  it('exports bounded operational metadata and an exact boolean preference', () => {
    expectTypeOf<UpdateHistoryIndexSettingsRequest>().toEqualTypeOf<{ paused: boolean }>()
    expectTypeOf<HistoryIndexStatus['activity']>().toEqualTypeOf<'starting' | 'indexing' | 'idle' | 'paused' | 'unavailable'>()
    expectTypeOf<HistoryIndexStatus['storage']>().toEqualTypeOf<{ databaseBytes: number | null; walBytes: number | null }>()
    expectTypeOf<HistoryIndexStatus['statistics']>().toBeNullable()
  })
})
