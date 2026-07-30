import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  EXTERNAL_CHROME_NAVIGATION_NOT_DISPATCHED_DETAILS,
  externalChromeControlCollisionDetails,
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

  it('classifies only exact debugger attach-conflict evidence as pre-mutation fallback authority', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'debugger-unavailable', message: 'Another debugger is already attached', retryable: true,
        details: EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
      },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)

    const execution = await adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })
    expect(execution).toMatchObject({
      response: { ok: false, error: { code: 'debugger-unavailable' } },
      failure: { phase: 'acquisition', mutationState: 'not-started', fallbackReason: 'foreign-debugger' },
    })
    expect(execution.response.ok || execution.response.error.details).toBeUndefined()
  })

  it('reports an exact pre-dispatch navigation timeout as not-started and non-replayable', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'timeout', message: 'Navigation timed out before dispatch', retryable: true,
        details: EXTERNAL_CHROME_NAVIGATION_NOT_DISPATCHED_DETAILS,
      },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)

    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('navigate', { url: 'https://example.test/', readiness: 'load', timeoutMs: 1_000 }, 'external-tab-1'),
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'timeout', details: EXTERNAL_CHROME_NAVIGATION_NOT_DISPATCHED_DETAILS } },
      failure: { phase: 'execution', mutationState: 'not-started', noReplay: true },
    })
  })

  it('preserves authority only for exact collaborative collision evidence', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'control-interrupted', message: 'Trusted input interrupted execution', retryable: true,
        details: externalChromeControlCollisionDetails('possible'),
      },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)

    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'control-interrupted' } },
      failure: {
        phase: 'execution', mutationState: 'possible', fallbackReason: 'authority-conflict',
        noReplay: true, preserveAuthority: true, requiresReobserve: true,
      },
    })

    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'control-interrupted', message: 'Malformed collision', retryable: true,
        details: { ...externalChromeControlCollisionDetails('possible'), authorityState: 'lost' },
      },
    })
    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'malformed-response', retryable: false } },
      failure: { phase: 'execution', mutationState: 'possible' },
    })
  })

  it('does not treat the debugger-unavailable code alone as replay-safe for a click', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: { code: 'debugger-unavailable', message: 'Another debugger is already attached', retryable: true },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)

    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'debugger-unavailable' } },
      failure: { phase: 'execution', mutationState: 'possible' },
    })
  })

  it('preserves canonical screenshot overflow details and read-only no-replay semantics', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'response-too-large', message: 'External Chrome screenshot exceeds the decoded PNG byte limit.', retryable: false,
        details: {
          limitation: 'screenshot-only-envelope-overflow', screenshotBytes: 196_632, screenshotByteUnit: 'decoded-png',
          maximumBytes: 196_608, maximumByteUnit: 'decoded-png',
        },
      },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)
    const requestValue = request('snapshot', {}, 'external-tab-1')

    await expect(adapter.execute(requestValue)).resolves.toMatchObject({
      ok: false, operation: 'snapshot', error: { code: 'response-too-large', retryable: false, details: { limitation: 'screenshot-only-envelope-overflow', screenshotByteUnit: 'decoded-png' } },
    })
    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' }, request: requestValue,
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'response-too-large', details: { limitation: 'screenshot-only-envelope-overflow' } } },
      failure: { phase: 'execution', mutationState: 'not-started' },
    })
  })

  it('classifies mutating execution failures as possible while read-only failures remain replay-safe', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({ ok: false, error: { code: 'execution-failed', message: 'failed', retryable: true } })
    const adapter = new ExternalChromeTargetAdapter(transport)

    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })).resolves.toMatchObject({ failure: { phase: 'execution', mutationState: 'possible' } })
    await expect(adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('snapshot', {}, 'external-tab-1'),
    })).resolves.toMatchObject({ failure: { phase: 'execution', mutationState: 'not-started' } })
  })

  it('fails malformed attach-conflict evidence closed without exposing it', async () => {
    const transport = new FakeExternalChromeTransport()
    transport.execute = async () => ({
      ok: false,
      error: {
        code: 'debugger-unavailable', message: 'failed', retryable: true,
        details: { ...EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS, mutationState: 'possible' },
      },
    })
    const adapter = new ExternalChromeTargetAdapter(transport)

    const execution = await adapter.executeWithAuthority({
      authority: { ownerEpoch: 1, tabId: 'external-tab-1' },
      request: request('click', { x: 1, y: 1, timeoutMs: 1_000 }, 'external-tab-1'),
    })
    expect(execution).toMatchObject({
      response: { ok: false, error: { code: 'malformed-response', retryable: false } },
      failure: { phase: 'execution', mutationState: 'possible' },
    })
    expect(execution.response.ok || execution.response.error.details).toBeUndefined()
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
