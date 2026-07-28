import { describe, expect, it } from 'vitest'
import {
  BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS,
  BUILDER_SIDEBAR_ORDER_MAX_REFS,
  BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES,
  BUILDER_SIDEBAR_ORDER_VERSION,
  type BuilderSidebarOrderState,
  type BuilderSidebarOrderUpdatedEvent,
  type ServerEvent,
  type UpdateBuilderSidebarOrderRequest,
} from '../index.js'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('Builder sidebar order protocol', () => {
  it('exports the revisioned local preference contract from the root barrel', () => {
    const request: UpdateBuilderSidebarOrderRequest = {
      baseRevision: 3,
      order: [
        { originId: 'local', profileId: 'same-id' },
        { originId: 'remote-1', profileId: 'same-id' },
      ],
    }

    const state: BuilderSidebarOrderState = {
      version: BUILDER_SIDEBAR_ORDER_VERSION,
      revision: 4,
      order: request.order,
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const wireState = roundTrip(state)

    expect(wireState).toEqual(state)
    expect(wireState.order[0]).not.toEqual(wireState.order[1])
    expect(wireState.order).toHaveLength(2)
    expect(wireState.order.length).toBeLessThanOrEqual(BUILDER_SIDEBAR_ORDER_MAX_REFS)
    expect(wireState.order.every((ref) =>
      [...ref.originId, ...ref.profileId].length <= BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS,
    )).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(wireState)).byteLength)
      .toBeLessThanOrEqual(BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES)
  })

  it('includes a bounded revision-only invalidation in the ServerEvent union', () => {
    const event: BuilderSidebarOrderUpdatedEvent = {
      type: 'builder_sidebar_order_updated',
      revision: 1,
    }
    const wireEvent = roundTrip<ServerEvent>(event)

    expect(wireEvent).toEqual({ type: 'builder_sidebar_order_updated', revision: 1 })
    expect(JSON.stringify(wireEvent)).not.toContain('"state"')
    expect(JSON.stringify(wireEvent)).not.toContain('"order"')
  })
})
