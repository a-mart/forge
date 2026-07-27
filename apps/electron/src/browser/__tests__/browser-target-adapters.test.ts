import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
} from '@forge/protocol'
import { BrowserAutomationManager } from '../browser-automation-manager.js'
import { ExternalChromeTargetAdapter } from '../external-chrome-target-adapter.js'
import { FakeExternalChromeTransport } from './fixtures/fake-external-chrome-transport.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BrowserTargetAdapter routing', () => {
  it('routes a target-agnostic status request through the automatic Managed Browser default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-managed-adapter-'))
    roots.push(root)
    const manager = new BrowserAutomationManager({ approvedDataRoot: root, hostWebContentsId: 1, sendToRenderer: () => undefined })

    await expect(manager.execute(request('status', {}, null))).resolves.toMatchObject({ ok: true, operation: 'status' })
    expect(manager.capabilities.protocolVersions).toEqual({ minimum: 2, maximum: 2 })
  })

  it('automatically acquires Chrome without a caller host choice and preserves returned affinity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-external-adapter-'))
    roots.push(root)
    const transport = new FakeExternalChromeTransport()
    const manager = new BrowserAutomationManager({
      approvedDataRoot: root,
      hostWebContentsId: 1,
      sendToRenderer: () => undefined,
      externalChromeAdapter: new ExternalChromeTargetAdapter(transport),
    })

    const response = await manager.execute(request('open', { show: false, reuseExistingTab: true }, null))
    expect(response).toMatchObject({
      ok: true,
      operation: 'open',
      updatedTab: { tabId: 'external-tab-1', targetAffinity: 'external-chrome' },
    })
    expect(transport.acquisitions).toMatchObject([{ preferredTabId: null, reuseExisting: true, createIfNeeded: true }])
    await expect(manager.revealTarget({ sessionAgentId: 'session-1', profileId: 'profile-1' }, 'external-tab-1'))
      .resolves.toEqual({ targetAffinity: 'external-chrome', revealed: true, tabId: 'external-tab-1' })
    expect(transport.reveals).toHaveLength(1)
  })

  it('routes every advertised External Chrome operation through the bounded v2 transport', async () => {
    const transport = new FakeExternalChromeTransport()
    const adapter = new ExternalChromeTargetAdapter(transport)
    const inputs: Record<(typeof EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS)[number], Record<string, unknown>> = {
      status: {}, open: { show: false, reuseExistingTab: false },
      navigate: { url: 'https://example.test/', readiness: 'load', timeoutMs: 1_000 },
      snapshot: {}, click: { x: 10, y: 20, timeoutMs: 1_000 },
      type: { text: 'test', clear: false, timeoutMs: 1_000 }, press: { key: 'Enter' },
      scroll: { deltaY: 100 }, evaluate: { expression: '1 + 1', awaitPromise: true, returnByValue: true },
      waitFor: { text: 'External Chrome fake', timeoutMs: 1_000 },
    }

    for (const operation of EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS) {
      const response = await adapter.execute(request(operation, inputs[operation], operation === 'status' || operation === 'open' ? null : 'external-tab-1'))
      expect(response).toMatchObject({ ok: true, operation })
      expect(response.updatedTab).toMatchObject({ targetAffinity: 'external-chrome' })
    }
    expect(transport.requests.map(({ operation }) => operation)).toEqual(EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS)
  })

  it.each(['resize', 'recordingStart', 'recordingStop'] as const)('returns typed unsupported-operation for %s without touching transport', async (operation) => {
    const transport = new FakeExternalChromeTransport()
    const adapter = new ExternalChromeTargetAdapter(transport)
    const response = await adapter.execute(request(operation, operation === 'resize' ? { mode: 'fill', timeoutMs: 1_000 } : {}, 'external-tab-1'))
    expect(response).toMatchObject({ ok: false, error: { code: 'unsupported-operation', retryable: false } })
    expect(transport.requests).toHaveLength(0)
  })

  it('enforces the fake transport response bound', async () => {
    const adapter = new ExternalChromeTargetAdapter(new FakeExternalChromeTransport(10))
    await expect(adapter.execute(request('status', {}, null))).resolves.toMatchObject({ ok: false, error: { code: 'response-too-large' } })
  })
})

function request(operation: BrowserAutomationOperation, input: Record<string, unknown>, tabId: string | null): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}`, sessionAgentId: 'session-1', profileId: 'profile-1',
    tabId, hostId: 'automatic-host', hostGeneration: 1, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    artifactDirectory: null, operation, input,
  } as BrowserAutomationRequest
}
