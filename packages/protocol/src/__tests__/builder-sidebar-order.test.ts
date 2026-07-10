import { describe, expect, it } from 'vitest'
import {
  BUILDER_SIDEBAR_ORDER_VERSION,
  type BuilderSidebarOrderState,
  type BuilderSidebarOrderUpdatedEvent,
  type ServerEvent,
  type UpdateBuilderSidebarOrderRequest,
} from '../index.js'

describe('Builder sidebar order protocol', () => {
  it('exports the revisioned local preference contract from the root barrel', () => {
    const request = {
      baseRevision: 3,
      order: [
        { originId: 'local', profileId: 'same-id' },
        { originId: 'remote-1', profileId: 'same-id' },
      ],
    } satisfies UpdateBuilderSidebarOrderRequest

    const state = {
      version: BUILDER_SIDEBAR_ORDER_VERSION,
      revision: 4,
      order: request.order,
      updatedAt: '2026-07-09T12:00:00.000Z',
    } satisfies BuilderSidebarOrderState

    expect(state.order[0]).not.toEqual(state.order[1])
  })

  it('includes a bounded revision-only invalidation in the ServerEvent union', () => {
    const event = {
      type: 'builder_sidebar_order_updated',
      revision: 1,
    } satisfies BuilderSidebarOrderUpdatedEvent satisfies ServerEvent

    expect(event).toEqual({ type: 'builder_sidebar_order_updated', revision: 1 })
    expect(JSON.stringify(event)).not.toContain('"state"')
    expect(JSON.stringify(event)).not.toContain('"order"')
  })
})
