import { describe, expect, it } from 'vitest'
import { parseExternalChromeCoordinatorRequest } from '../external-chrome-coordinator.js'

describe('External Chrome coordinator contract', () => {
  it('rejects unknown, extra, and malformed control inputs', () => {
    expect(parseExternalChromeCoordinatorRequest({ operation: 'status' })).toEqual({ operation: 'status' })
    expect(parseExternalChromeCoordinatorRequest({ operation: 'takeover' })).toEqual({ operation: 'takeover' })
    expect(parseExternalChromeCoordinatorRequest({ operation: 'reveal-extension-folder' })).toEqual({ operation: 'reveal-extension-folder' })
    expect(() => parseExternalChromeCoordinatorRequest({ operation: 'rotate-key' })).toThrow(/operation/u)
    expect(() => parseExternalChromeCoordinatorRequest({ operation: 'status', endpoint: '/tmp/leak' })).toThrow(/fields/u)
    expect(() => parseExternalChromeCoordinatorRequest('status')).toThrow(/object/u)
  })
})
