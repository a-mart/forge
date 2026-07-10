import { describe, expect, it, vi } from 'vitest'

describe('repository project creation server stop ordering', () => {
  it('awaits async shutdown settlement before transport reset/close', async () => {
    const order: string[] = []
    let releaseShutdown!: () => void
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })

    const repositoryProjectCreationService = {
      shutdown: async () => {
        order.push('shutdown-start')
        await shutdownGate
        order.push('shutdown-done')
      },
    }
    const wsHandler = {
      reset: () => {
        order.push('reset')
      },
    }
    const closeTransport = async () => {
      order.push('close')
    }

    const stopPromise = (async () => {
      await repositoryProjectCreationService.shutdown()
      wsHandler.reset()
      await closeTransport()
    })()

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['shutdown-start'])
    releaseShutdown()
    await stopPromise
    expect(order).toEqual(['shutdown-start', 'shutdown-done', 'reset', 'close'])
  })
})

void vi
