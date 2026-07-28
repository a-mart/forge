import { describe, expect, it, vi } from 'vitest'
import { RepositoryProjectCreationService } from '../swarm/repository-project-creation-service.js'
import { makeWsServerTempConfig, WsServerTestSwarmManager } from '../test-support/ws-integration-harness.js'
import { WsHandler } from '../ws/ws-handler.js'
import { SwarmWebSocketServer } from '../ws/server.js'

describe('repository project creation server stop ordering', () => {
  it('awaits the real creation service shutdown before resetting the real WS handler', async () => {
    const config = await makeWsServerTempConfig(0)
    const manager = new WsServerTestSwarmManager(config)
    const order: string[] = []
    let releaseShutdown!: () => void
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })

    const originalShutdown = RepositoryProjectCreationService.prototype.shutdown
    const shutdownSpy = vi.spyOn(RepositoryProjectCreationService.prototype, 'shutdown').mockImplementation(async function (this: RepositoryProjectCreationService) {
      order.push('shutdown-start')
      await shutdownGate
      await originalShutdown.call(this)
      order.push('shutdown-done')
    })
    const resetSpy = vi.spyOn(WsHandler.prototype, 'reset').mockImplementation(() => {
      order.push('reset')
    })

    try {
      const server = new SwarmWebSocketServer({
        swarmManager: manager,
        host: config.host,
        port: config.port,
        allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      })
      await manager.boot()
      await server.start()
      const stopPromise = server.stop()
      await vi.waitFor(() => expect(shutdownSpy).toHaveBeenCalledTimes(1))
      expect(order).toEqual(['shutdown-start'])
      expect(resetSpy).not.toHaveBeenCalled()

      releaseShutdown()
      await stopPromise
      expect(order).toEqual(['shutdown-start', 'shutdown-done', 'reset'])
    } finally {
      releaseShutdown()
      shutdownSpy.mockRestore()
      resetSpy.mockRestore()
    }
  })
})
