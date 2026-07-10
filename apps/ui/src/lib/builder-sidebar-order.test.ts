import { describe, expect, it } from 'vitest'
import {
  builderSidebarOrderKey,
  moveBuilderSidebarOrder,
  parseBuilderSidebarOrderKey,
  reconcileBuilderSidebarOrder,
  resolveBuilderSidebarDragMove,
} from './builder-sidebar-order'

const ref = (originId: string, profileId: string) => ({ originId, profileId })

describe('reconcileBuilderSidebarOrder', () => {
  it('retains offline, disabled, archived, and unknown refs as hidden anchors', () => {
    const stored = [
      ref('remote-offline', 'hidden'),
      ref('local', 'alpha'),
      ref('remote-disabled', 'hidden'),
      ref('local', 'archived'),
      ref('unknown-origin', 'unknown-profile'),
    ]

    expect(reconcileBuilderSidebarOrder(stored, [ref('local', 'alpha')])).toEqual(stored)
  })

  it('inserts newly discovered projects by same-origin natural neighbors without dropping anchors', () => {
    expect(reconcileBuilderSidebarOrder(
      [
        ref('local', 'alpha'),
        ref('remote', 'one'),
        ref('local', 'charlie'),
        ref('remote-offline', 'anchor'),
      ],
      [
        ref('local', 'new-top'),
        ref('local', 'alpha'),
        ref('local', 'bravo'),
        ref('local', 'charlie'),
        ref('remote', 'one'),
        ref('remote', 'two'),
      ],
    )).toEqual([
      ref('local', 'new-top'),
      ref('local', 'alpha'),
      ref('local', 'bravo'),
      ref('remote', 'one'),
      ref('remote', 'two'),
      ref('local', 'charlie'),
      ref('remote-offline', 'anchor'),
    ])
  })

  it('uses natural legacy order as the missing-file seed and appends entirely new origins', () => {
    const natural = [
      ref('local', 'beta'),
      ref('local', 'alpha'),
      ref('remote-a', 'gamma'),
      ref('remote-a', 'delta'),
    ]
    expect(reconcileBuilderSidebarOrder([], natural)).toEqual(natural)

    expect(reconcileBuilderSidebarOrder(
      [ref('local', 'beta'), ref('local', 'alpha')],
      natural,
    )).toEqual(natural)
  })

  it('never interprets a client-local discovery omission as a durable tombstone', () => {
    const sharedOrder = [
      ref('local', 'alpha'),
      ref('electron-only-remote', 'project'),
      ref('browser-visible-remote', 'project'),
    ]

    expect(reconcileBuilderSidebarOrder(sharedOrder, [ref('local', 'alpha')])).toEqual(sharedOrder)
  })

  it('dedupes defensively by the full pair, not raw profile id', () => {
    expect(reconcileBuilderSidebarOrder(
      [ref('local', 'same'), ref('remote', 'same'), ref('local', 'same')],
      [],
    )).toEqual([ref('local', 'same'), ref('remote', 'same')])
    expect(builderSidebarOrderKey(ref('local', 'same'))).not.toBe(
      builderSidebarOrderKey(ref('remote', 'same')),
    )
  })
})

describe('collision-safe sortable identity', () => {
  it('round-trips delimiter-adversarial tuples and resolves the intended drag endpoints', () => {
    const left = ref('origin::nested', 'profile')
    const right = ref('origin', 'nested::profile')
    const leftKey = builderSidebarOrderKey(left)
    const rightKey = builderSidebarOrderKey(right)

    expect(leftKey).not.toBe(rightKey)
    expect(parseBuilderSidebarOrderKey(leftKey)).toEqual(left)
    expect(parseBuilderSidebarOrderKey(rightKey)).toEqual(right)
    expect(resolveBuilderSidebarDragMove(leftKey, rightKey, [left, right])).toEqual({
      active: left,
      over: right,
    })
    expect(resolveBuilderSidebarDragMove('origin::nested::profile', rightKey, [left, right])).toBeNull()
  })
})

describe('moveBuilderSidebarOrder', () => {
  it('moves composite refs while preserving unseen anchors', () => {
    const order = [
      ref('local', 'same'),
      ref('offline', 'anchor'),
      ref('remote', 'same'),
    ]
    expect(moveBuilderSidebarOrder(order, ref('remote', 'same'), ref('local', 'same'))).toEqual([
      ref('remote', 'same'),
      ref('local', 'same'),
      ref('offline', 'anchor'),
    ])
  })

  it('cancels safely when either endpoint is absent', () => {
    expect(moveBuilderSidebarOrder(
      [ref('local', 'alpha')],
      ref('local', 'missing'),
      ref('local', 'alpha'),
    )).toBeNull()
  })
})
