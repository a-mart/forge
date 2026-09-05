import type { AgentDescriptor, ManagerProfile } from './agents.js'
import type { SessionAttention } from './session-attention.js'

/** Opt-in, local Builder inventory. Never selects a conversation or marks it read.
 * Older servers reject this distinct command; clients must not fall back to subscribe.
 */
export interface SubscribeInventoryCommand {
  type: 'subscribe_inventory'
  requestId: string
}

/** Transport liveness only; not a capability acknowledgement or a viewed target. */
export interface InventoryPongEvent {
  type: 'inventory_pong'
  serverTime: string
}

/** Complete origin baseline and positive capability acknowledgement. Not transcript data. */
export interface InventorySnapshotEvent {
  type: 'inventory_snapshot'
  requestId: string
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  counts: Record<string, number>
  revision: number
  attentions: SessionAttention[]
}
