import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES,
  parseExternalChromeJsonRpcFrame,
  type BrowserAutomationResultByOperation,
} from '@forge/protocol'
import { compactSnapshotForJsonRpc, jsonRpcResponseBytes } from '../src/runtime/snapshot-compaction.js'

const id = 'desktop-snapshot-fixture'
const execute = (overrides: Partial<BrowserAutomationResultByOperation['snapshot']> = {}) => ({
  protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-snapshot', leaseEpoch: 1,
  tabId: 7, operation: 'snapshot' as const, ok: true as const,
  result: {
    tabId: '7', url: 'https://fixture.test/large', title: 'Large fixture', loading: false,
    viewportSetting: { mode: 'fill' as const }, viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    visibleText: 'Visible '.repeat(2_500),
    interactiveElements: Array.from({ length: 200 }, (_, index) => ({
      tag: 'button', role: 'button', name: `Action ${index}`, selector: `#action-${index}-${'x'.repeat(500)}`,
      x: index, y: index, width: 100, height: 30,
    })),
    accessibility: { frames: [{ targetId: 'target-7', nodes: Array.from({ length: 200 }, (_, index) => ({ role: { value: 'button' }, name: { value: `Action ${index}` }, description: 'a'.repeat(500) })) }] },
    consoleEntries: Array.from({ length: 200 }, () => ({ level: 'log', text: 'console '.repeat(100), timestamp: new Date(0).toISOString() })),
    networkEntries: Array.from({ length: 200 }, (_, index) => ({ url: `https://fixture.test/${index}`, method: 'GET', status: 200, failed: false, timestamp: new Date(0).toISOString() })),
    actionTimeline: Array.from({ length: 100 }, (_, index) => ({ id: `action-${index}`, action: 'snapshot', status: 'succeeded' as const, startedAt: new Date(0).toISOString() })),
    screenshot: { mimeType: 'image/png' as const, data: 'A'.repeat(48_000), width: 900, height: 700 },
    ...overrides,
  },
})

describe('bounded External Chrome snapshot compaction', () => {
  it('keeps small snapshots byte-identical and compacts candidate-scale DOM/AX/PNG data', () => {
    const small = execute({
      visibleText: 'small', interactiveElements: [], accessibility: { frames: [] }, consoleEntries: [], networkEntries: [], actionTimeline: [],
      screenshot: { mimeType: 'image/png', data: 'AA==', width: 1, height: 1 },
    })
    expect(compactSnapshotForJsonRpc(small, id, 256 * 1_024)).toBe(small)

    const large = execute()
    expect(jsonRpcResponseBytes(id, large)).toBeGreaterThan(256 * 1_024 - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES)
    const compacted = compactSnapshotForJsonRpc(large, id, 256 * 1_024) as typeof large
    expect(compacted.ok).toBe(true)
    expect(compacted.result.screenshot.data).toBe(large.result.screenshot.data)
    expect(compacted.result.compaction?.omitted).toEqual(expect.objectContaining({
      consoleEntries: 200, networkEntries: 200, actionTimelineEntries: 100,
    }))
    expect(jsonRpcResponseBytes(id, compacted)).toBeLessThanOrEqual(256 * 1_024 - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES)
  })

  it('measures finalized metadata at the exact bare-envelope boundary', () => {
    const budget = 256 * 1_024 - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES
    const make = (dataLength: number, consoleEntries: BrowserAutomationResultByOperation['snapshot']['consoleEntries']) => execute({
      visibleText: '', interactiveElements: [], accessibility: { frames: [] }, networkEntries: [], actionTimeline: [], consoleEntries,
      screenshot: { mimeType: 'image/png', data: 'A'.repeat(dataLength), width: 900, height: 700 },
    })
    let low = 0
    let high = budget
    let exactLength: number | null = null
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const bytes = jsonRpcResponseBytes(id, make(middle, []))
      if (bytes === budget) { exactLength = middle; break }
      if (bytes < budget) low = middle + 1
      else high = middle - 1
    }
    expect(exactLength).not.toBeNull()
    const entry = { level: 'log', text: 'one', timestamp: new Date(0).toISOString() }
    const compacted = compactSnapshotForJsonRpc(make(exactLength as number, [entry]), id, 256 * 1_024)
    expect(jsonRpcResponseBytes(id, compacted)).toBeLessThanOrEqual(budget)
  })

  it('delivers the compacted response through the shared strict JSON-RPC parser', () => {
    const compacted = compactSnapshotForJsonRpc(execute(), id, 256 * 1_024)
    const parsed = parseExternalChromeJsonRpcFrame(JSON.stringify({ jsonrpc: '2.0', id, result: compacted }), {
      expectedResponseMethod: 'forge.browser.execute', protocolVersion: 1,
    })
    expect(parsed).toMatchObject({ result: { ok: true, operation: 'snapshot', result: { compaction: { omitted: expect.any(Object) } } } })
    const invalid = structuredClone(parsed) as { result: { result: { compaction: { omitted: Record<string, unknown> } } } }
    invalid.result.result.compaction.omitted = {}
    expect(() => parseExternalChromeJsonRpcFrame(JSON.stringify(invalid), {
      expectedResponseMethod: 'forge.browser.execute', protocolVersion: 1,
    })).toThrow(/omitted must contain at least one positive omission count/u)
  })

  it('returns a typed failure when the screenshot alone cannot fit the negotiated envelope', () => {
    const oversizedScreenshot = execute({
      visibleText: '', interactiveElements: [], accessibility: { frames: [] }, consoleEntries: [], networkEntries: [], actionTimeline: [],
      screenshot: { mimeType: 'image/png', data: 'A'.repeat(260_000), width: 900, height: 700 },
    })
    const result = compactSnapshotForJsonRpc(oversizedScreenshot, id, 256 * 1_024) as typeof oversizedScreenshot
    expect(result).toMatchObject({ ok: false, error: { code: 'response-too-large', details: { limitation: 'screenshot-only-envelope-overflow' } } })
    expect(jsonRpcResponseBytes(id, result)).toBeLessThanOrEqual(256 * 1_024 - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES)
  })
})
