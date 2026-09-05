import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  getWsRequestContract,
  type ClientCommand,
  type ServerEvent,
  type SubscribeInventoryCommand,
  type InventorySnapshotEvent,
  type InventoryPongEvent,
} from '../index.js'

describe('opt-in Builder inventory wire contract', () => {
  it('uses a distinct, required-correlated command and a target-free baseline', () => {
    const command = { type: 'subscribe_inventory', requestId: 'inventory-1' } satisfies SubscribeInventoryCommand
    const baseline = { type: 'inventory_snapshot', requestId: command.requestId, agents: [], profiles: [], counts: {}, revision: 0, attentions: [] } satisfies InventorySnapshotEvent
    const pong = { type: 'inventory_pong', serverTime: '2026-09-01T00:00:00.000Z' } satisfies InventoryPongEvent
    expectTypeOf<SubscribeInventoryCommand>().toMatchTypeOf<ClientCommand>()
    expectTypeOf<InventorySnapshotEvent>().toMatchTypeOf<ServerEvent>()
    expectTypeOf<InventoryPongEvent>().toMatchTypeOf<ServerEvent>()
    expect(command.type).not.toBe('subscribe')
    expect('agentId' in command).toBe(false)
    expect('subscribedAgentId' in baseline).toBe(false)
    expect('requestId' in pong).toBe(false)
    expect(getWsRequestContract('subscribe_inventory')).toEqual({
      commandType: 'subscribe_inventory', resultFamily: 'inventory_snapshot',
      requestId: { ui: 'required', wire: 'required' },
      successEvents: ['inventory_snapshot'], errorCodeFragments: ['inventory'],
    })
  })
})
