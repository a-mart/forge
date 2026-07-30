import { describe, expect, it, vi } from 'vitest'
import { installSingletonContentBridge } from '../src/runtime/content-bridge-singleton.js'

describe('document-owned content bridge singleton', () => {
  it('keeps exactly one activation in one live isolated-world document', () => {
    const documentScope: Record<string, unknown> = {}
    let dispose!: () => void
    const first = vi.fn((cleanup: () => void) => { dispose = cleanup })
    const duplicate = vi.fn()

    expect(installSingletonContentBridge(documentScope, first)).toBe(true)
    expect(installSingletonContentBridge(documentScope, duplicate)).toBe(false)
    expect(first).toHaveBeenCalledOnce()
    expect(duplicate).not.toHaveBeenCalled()
    expect(Object.keys(documentScope)).toEqual([])

    dispose()
    expect(installSingletonContentBridge(documentScope, duplicate)).toBe(true)
    expect(duplicate).toHaveBeenCalledOnce()
  })

  it('removes a failed activation marker so a later recovery injection can reconnect', () => {
    const documentScope: Record<string, unknown> = {}
    expect(() => installSingletonContentBridge(documentScope, () => { throw new Error('connect failed') }))
      .toThrow('connect failed')
    expect(installSingletonContentBridge(documentScope, () => undefined)).toBe(true)
  })
})
