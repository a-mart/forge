import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputBatcher } from '../output-batcher.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('OutputBatcher', () => {
  it('flushes pushed data after the configured interval', async () => {
    vi.useFakeTimers()
    const onFlush = vi.fn<(_: Buffer) => Promise<void>>().mockResolvedValue(undefined)
    const batcher = new OutputBatcher({ intervalMs: 16, onFlush })

    batcher.push(Buffer.from('hello'))

    await vi.advanceTimersByTimeAsync(15)
    expect(onFlush).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0]?.[0].toString('utf8')).toBe('hello')
  })

  it('coalesces multiple pushes within the interval into a single flush', async () => {
    vi.useFakeTimers()
    const onFlush = vi.fn<(_: Buffer) => Promise<void>>().mockResolvedValue(undefined)
    const batcher = new OutputBatcher({ intervalMs: 16, onFlush })

    batcher.push('hello')
    batcher.push(Buffer.from(' '))
    batcher.push('world')

    await vi.advanceTimersByTimeAsync(16)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0]?.[0].toString('utf8')).toBe('hello world')
  })

  it('flushes remaining data when stopped', async () => {
    vi.useFakeTimers()
    const onFlush = vi.fn<(_: Buffer) => Promise<void>>().mockResolvedValue(undefined)
    const batcher = new OutputBatcher({ intervalMs: 16, onFlush })

    batcher.push('pending')

    await expect(batcher.stop()).resolves.toBeUndefined()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0]?.[0].toString('utf8')).toBe('pending')
  })

  it('treats stop on an empty batcher as a no-op', async () => {
    const onFlush = vi.fn<(_: Buffer) => Promise<void>>().mockResolvedValue(undefined)
    const batcher = new OutputBatcher({ intervalMs: 16, onFlush })

    await expect(batcher.stop()).resolves.toBeUndefined()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('logs timer-driven flush errors instead of throwing', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const batcher = new OutputBatcher({
      intervalMs: 5,
      onFlush: async () => {
        throw new Error('flush failed')
      },
    })

    batcher.push('boom')
    await vi.advanceTimersByTimeAsync(5)

    expect(warn).toHaveBeenCalledWith('[output-batcher] Flush error: flush failed')
  })
})
