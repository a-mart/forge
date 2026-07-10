import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'
import { hydrateSessionWorkers } from './worker-hydration'

afterEach(() => originRegistry.destroyAll())

describe('hydrateSessionWorkers', () => {
  it('uses the active remote origin client, never the local client, for colliding session ids', () => {
    const local = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local.test', offline: true })
    const remote = originRegistry.createOrigin({ originId: 'remote:west', wsUrl: 'ws://remote.test', offline: true })
    const localFetch = vi.spyOn(local.getClient(), 'getSessionWorkers').mockResolvedValue({ sessionAgentId: 'same-session', workers: [] })
    const remoteFetch = vi.spyOn(remote.getClient(), 'getSessionWorkers').mockResolvedValue({ sessionAgentId: 'same-session', workers: [] })

    hydrateSessionWorkers('remote:west', 'same-session')

    expect(remoteFetch).toHaveBeenCalledWith('same-session')
    expect(localFetch).not.toHaveBeenCalled()
  })
})
