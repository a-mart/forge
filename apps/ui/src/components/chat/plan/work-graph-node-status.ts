import type { WorkGraphNodeStatus } from '@forge/protocol'

export function workGraphNodeStatusLabel(status: WorkGraphNodeStatus): string {
  switch (status) {
    case 'completed': return 'Accepted'
    case 'running': return 'Running'
    case 'awaiting_review': return 'Awaiting review'
    case 'waiting': return 'Waiting for decision'
    case 'blocked': return 'Blocked'
    case 'cancelled': return 'Cancelled'
    default: return 'Pending'
  }
}
