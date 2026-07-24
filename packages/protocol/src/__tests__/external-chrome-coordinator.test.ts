import { describe, expect, it } from 'vitest'
import * as root from '../index.js'
import {
  EXTERNAL_CHROME_COORDINATOR_OPERATIONS,
  parseExternalChromeCoordinatorRequest,
  type ExternalChromeExtensionPathState,
} from '../external-chrome-coordinator.js'

describe('External Chrome coordinator contract', () => {
  it('exports the narrow exact operation set from the root barrel', () => {
    expect(EXTERNAL_CHROME_COORDINATOR_OPERATIONS).toEqual([
      'status', 'enable', 'disable', 'repair', 'rollback', 'remove', 'takeover', 'reveal-extension-folder',
    ])
    expect(root.parseExternalChromeCoordinatorRequest).toBe(parseExternalChromeCoordinatorRequest)
    const corruptDeployment: ExternalChromeExtensionPathState = 'mismatch'
    expect(corruptDeployment).toBe('mismatch')
  })

  it('rejects unknown, extra, and malformed control inputs', () => {
    expect(parseExternalChromeCoordinatorRequest({ operation: 'status' })).toEqual({ operation: 'status' })
    expect(parseExternalChromeCoordinatorRequest({ operation: 'takeover' })).toEqual({ operation: 'takeover' })
    expect(parseExternalChromeCoordinatorRequest({ operation: 'reveal-extension-folder' })).toEqual({ operation: 'reveal-extension-folder' })
    expect(() => parseExternalChromeCoordinatorRequest({ operation: 'rotate-key' })).toThrow(/operation/u)
    expect(() => parseExternalChromeCoordinatorRequest({ operation: 'status', endpoint: '/tmp/leak' })).toThrow(/fields/u)
    expect(() => parseExternalChromeCoordinatorRequest('status')).toThrow(/object/u)
  })
})
