import { describe, expect, it } from 'vitest'
import { getWsRequestContract } from '../index.js'

describe('opt-in Builder inventory wire contract', () => {
  it('correlates subscribe_inventory to inventory_snapshot and does not alias subscribe', () => {
    expect(getWsRequestContract('subscribe_inventory')).toEqual({
      commandType: 'subscribe_inventory',
      resultFamily: 'inventory_snapshot',
      requestId: { ui: 'required', wire: 'required' },
      successEvents: ['inventory_snapshot'],
      errorCodeFragments: ['inventory'],
    })
    expect(getWsRequestContract('subscribe_inventory')?.commandType).not.toBe('subscribe')
  })
})
