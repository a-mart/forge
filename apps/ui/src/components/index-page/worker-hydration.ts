import { originRegistry, type OriginId } from '@/lib/origin-store'

/** Fetch a session's workers from the origin that owns its session id. */
export function hydrateSessionWorkers(originId: OriginId, sessionAgentId: string): void {
  void originRegistry.getOrigin(originId)?.getClient().getSessionWorkers(sessionAgentId).catch(() => {})
}
