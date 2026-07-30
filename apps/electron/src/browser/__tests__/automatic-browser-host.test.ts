import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserAutomationFailure,
  BrowserAutomationOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostLifecycleRequest,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
} from '@forge/protocol'
import {
  BROWSER_AUTOMATION_OPERATIONS,
  EXTERNAL_CHROME_DESKTOP_AUTHORITY_IDLE_TIMEOUT_MS,
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  externalChromeControlCollisionDetails,
} from '@forge/protocol'
import { AutomaticBrowserHost } from '../automatic-browser-host.js'
import type {
  AutomaticExternalBrowserAdapter,
  BrowserTargetAdapter,
  BrowserTargetExecution,
  BrowserTargetSession,
  ExternalBrowserAcquireInput,
  ExternalBrowserAcquireResult,
  ExternalBrowserInventory,
  ExternalBrowserTargetAuthority,
} from '../browser-target-adapter.js'

class FakeManagedAdapter implements BrowserTargetAdapter {
  readonly targetAffinity = 'managed-electron' as const
  readonly capabilities = { supportedOperations: BROWSER_AUTOMATION_OPERATIONS, physicalViewport: true, recording: true, reveal: false } as const
  readonly requests: BrowserAutomationRequest[] = []
  readonly ended: Array<{ session: BrowserTargetSession; turnId: string }> = []
  readonly released: Array<{ session: BrowserTargetSession; reason: string }> = []

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    this.requests.push(structuredClone(request))
    return success(request, 'managed-electron')
  }
  async endTurn(session: BrowserTargetSession, turnId: string): Promise<void> { this.ended.push({ session, turnId }) }
  async releaseSession(session: BrowserTargetSession, reason: string): Promise<void> { this.released.push({ session, reason }) }
}

class FakeExternalAdapter implements AutomaticExternalBrowserAdapter {
  readonly targetAffinity = 'external-chrome' as const
  readonly capabilities = { supportedOperations: EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS, physicalViewport: false, recording: false, reveal: true } as const
  readonly acquisitions: ExternalBrowserAcquireInput[] = []
  readonly executions: BrowserAutomationRequest[] = []
  readonly authorityReleases: Array<{ authority: ExternalBrowserTargetAuthority; reason: string }> = []
  readonly targetAuthorityReleases: Array<{ session: BrowserTargetSession; tabId: string; reason: string }> = []
  readonly ended: Array<{ session: BrowserTargetSession; turnId: string }> = []
  readonly sessionReleases: Array<{ session: BrowserTargetSession; reason: string }> = []
  readonly reveals: Array<{ session: BrowserTargetSession; tabId: string }> = []
  readonly inventoryRequests: BrowserTargetSession[] = []
  inventoryResults: ExternalBrowserInventory[] = []
  acquireResults: ExternalBrowserAcquireResult[] = []
  executionResults: BrowserTargetExecution[] = []
  releaseFailures: Error[] = []
  revealFailures: Error[] = []
  recoveredTargetRelease = false
  sequence = 0

  async listEligibleTabs(session: BrowserTargetSession): Promise<ExternalBrowserInventory> {
    this.inventoryRequests.push(structuredClone(session))
    return this.inventoryResults.shift() ?? { tabs: [], truncated: false }
  }
  async acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult> {
    this.acquisitions.push(structuredClone(input))
    return this.acquireResults.shift() ?? {
      ok: true,
      authority: { ownerEpoch: input.ownerEpoch, tabId: input.preferredTabId ?? `chrome-tab-${++this.sequence}` },
    }
  }
  async executeWithAuthority(input: { authority: ExternalBrowserTargetAuthority; request: BrowserAutomationRequest }): Promise<BrowserTargetExecution> {
    this.executions.push(structuredClone(input.request))
    return this.executionResults.shift() ?? { response: success(input.request, 'external-chrome') }
  }
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return Promise.resolve(success(request, 'external-chrome'))
  }
  async releaseAuthority(_session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: string): Promise<void> {
    this.authorityReleases.push({ authority: structuredClone(authority), reason })
    const failure = this.releaseFailures.shift()
    if (failure) throw failure
  }
  async releaseTargetAuthority(session: BrowserTargetSession, tabId: string, reason: 'take-control'): Promise<boolean> {
    this.targetAuthorityReleases.push({ session: structuredClone(session), tabId, reason })
    return this.recoveredTargetRelease
  }
  async revealTarget(session: BrowserTargetSession, tabId: string) {
    this.reveals.push({ session: structuredClone(session), tabId })
    const failure = this.revealFailures.shift()
    if (failure) throw failure
    return { revealed: true as const, tabId }
  }
  async endTurn(session: BrowserTargetSession, turnId: string): Promise<void> { this.ended.push({ session, turnId }) }
  async releaseSession(session: BrowserTargetSession, reason: string): Promise<void> { this.sessionReleases.push({ session, reason }) }
}

afterEach(() => vi.useRealTimers())

describe('AutomaticBrowserHost', () => {
  it('routes explicit target affinity without silently moving browser identity', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('chrome-explicit', 'external-chrome')], 'chrome-explicit')])

    await expect(host.perform(request('snapshot', {}, 'chrome-explicit'))).resolves.toMatchObject({
      ok: true,
      updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-explicit' },
    })
    await expect(host.perform(request('resize', { mode: 'fill', timeoutMs: 1_000 }, 'chrome-explicit'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-operation', details: { mutationState: 'not-started', noReplay: false } },
    })
    expect(managed.requests).toHaveLength(0)
  })

  it('exposes External Chrome inventory even while the sticky selected tab is managed', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.inventoryResults.push({ tabs: [eligible('ext.instance.7')], truncated: false })
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('managed-selected', 'managed-electron')], 'managed-selected')])

    await expect(host.perform(request('status', {}, null))).resolves.toMatchObject({
      ok: true,
      result: {
        selectedTab: { tabId: 'managed-selected', targetAffinity: 'managed-electron' },
        eligibleTabs: [{ tabId: 'ext.instance.7', url: 'https://inventory.invalid/' }],
        eligibleTabsTruncated: false,
      },
    })
    expect(external.inventoryRequests).toMatchObject([{ sessionAgentId: 'session', profileId: 'profile' }])
  })

  it('adopts an explicit canonical inventory tab ID that is not yet in session state', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)

    await expect(host.perform(request('open', {
      tabId: 'ext.instance.9', show: false, reuseExistingTab: true,
    }, 'ext.instance.9'))).resolves.toMatchObject({
      ok: true,
      updatedTab: { targetAffinity: 'external-chrome', tabId: 'ext.instance.9' },
    })
    expect(external.acquisitions).toMatchObject([{
      preferredTabId: 'ext.instance.9', reuseExisting: true, createIfNeeded: false,
    }])
    expect(managed.requests).toEqual([])
  })

  it('preserves caller tab correlation while open, navigate, and snapshot allocate or target internally', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)

    const opened = await host.perform(request('open', { show: false, reuseExistingTab: true }, null))
    expect(opened).toMatchObject({ ok: true, tabId: null, result: { tab: { tabId: 'chrome-tab-1' } } })
    const navigated = await host.perform(request('navigate', { url: 'https://example.test', readiness: 'load', timeoutMs: 100 }, null))
    expect(navigated).toMatchObject({ ok: true, tabId: null, result: { tab: { tabId: 'chrome-tab-1' } } })
    const snapshot = await host.perform(request('snapshot', {}, null))
    expect(snapshot).toMatchObject({ ok: true, tabId: null, result: { tabId: 'chrome-tab-1' } })
    expect(external.executions.map((execution) => execution.tabId)).toEqual(['chrome-tab-1', 'chrome-tab-1', 'chrome-tab-1'])
  })

  it('honors reuseExistingTab=false and allocates a fresh target under automatic policy', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('selected', 'external-chrome')], 'selected')])

    await host.perform(request('open', { show: false, reuseExistingTab: false }, null))
    expect(external.acquisitions).toMatchObject([{ preferredTabId: null, reuseExisting: false, createIfNeeded: true }])
    expect(external.executions[0]?.tabId).not.toBe('selected')
  })

  it('reselects profile-wide Chrome inventory on explicit tabless open and keeps subsequent operations sticky', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    const stale = tab('chrome-neutral', 'external-chrome')
    stale.url = 'about:blank'
    host.synchronizeSessions([session([stale], stale.tabId)])

    await host.perform(request('snapshot', {}, stale.tabId))
    external.acquireResults.push({ ok: true, authority: { ownerEpoch: 2, tabId: 'chrome-focused' } })
    await expect(host.perform(request('open', { show: false, reuseExistingTab: true }, null))).resolves.toMatchObject({
      ok: true, updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-focused' },
    })
    expect(external.authorityReleases).toMatchObject([{ authority: { tabId: 'chrome-neutral' }, reason: 'idle' }])
    expect(external.acquisitions).toMatchObject([
      { preferredTabId: 'chrome-neutral', reuseExisting: true },
      { preferredTabId: null, reuseExisting: true },
    ])

    await host.perform(request('snapshot', {}, null))
    expect(external.acquisitions).toHaveLength(2)
    expect(external.executions.map(({ tabId }) => tabId)).toEqual(['chrome-neutral', 'chrome-focused', 'chrome-focused'])
  })

  it('reselects Chrome inventory from a managed fallback and keeps non-open operations sticky', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    const fallback = tab('managed-fallback', 'managed-electron')
    fallback.url = 'about:blank'
    host.synchronizeSessions([session([fallback], fallback.tabId)])
    external.acquireResults.push({ ok: true, authority: { ownerEpoch: 1, tabId: 'chrome-focused' } })

    await expect(host.perform(request('open', { show: false, reuseExistingTab: true }, null))).resolves.toMatchObject({
      ok: true, updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-focused' },
    })
    expect(external.acquisitions).toMatchObject([{
      preferredTabId: null, reuseExisting: true, createIfNeeded: true,
    }])
    expect(managed.requests).toEqual([])

    await expect(host.perform(request('snapshot', {}, null))).resolves.toMatchObject({
      ok: true, updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-focused' },
    })
    await expect(host.perform(request('status', {}, null))).resolves.toMatchObject({
      ok: true, updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-focused' },
    })
    expect(external.acquisitions).toHaveLength(1)
    expect(external.executions.map(({ operation, tabId }) => ({ operation, tabId }))).toEqual([
      { operation: 'open', tabId: 'chrome-focused' },
      { operation: 'snapshot', tabId: 'chrome-focused' },
      { operation: 'status', tabId: 'chrome-focused' },
    ])
    await host.endTurn({ sessionAgentId: 'session', profileId: 'profile' }, 'selection-complete')
    expect(external.authorityReleases).toMatchObject([{ authority: { tabId: 'chrome-focused' }, reason: 'turn-ended' }])
    expect(managed.requests).toEqual([])
  })

  it('lets another session explicitly select a profile-wide Chrome tab after exact prior turn release', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    const canonicalTabId = 'ext.instance.7'
    const sessionA = { sessionAgentId: 'session-a', profileId: 'profile' }
    const sessionB = { sessionAgentId: 'session-b', profileId: 'profile' }

    await expect(host.perform(request('open', {
      tabId: canonicalTabId, show: false, reuseExistingTab: true,
    }, canonicalTabId, sessionA.sessionAgentId))).resolves.toMatchObject({
      ok: true, updatedTab: { tabId: canonicalTabId, targetAffinity: 'external-chrome' },
    })
    await host.endTurn(sessionA, 'turn-a')
    expect(external.authorityReleases).toMatchObject([{
      authority: { tabId: canonicalTabId }, reason: 'turn-ended',
    }])

    external.inventoryResults.push({ tabs: [eligible(canonicalTabId)], truncated: false })
    await expect(host.perform(request('status', {}, null, sessionB.sessionAgentId))).resolves.toMatchObject({
      ok: true, result: { eligibleTabs: [{ tabId: canonicalTabId }] },
    })
    await expect(host.perform(request('open', {
      tabId: canonicalTabId, show: false, reuseExistingTab: true,
    }, canonicalTabId, sessionB.sessionAgentId))).resolves.toMatchObject({
      ok: true, updatedTab: { tabId: canonicalTabId, targetAffinity: 'external-chrome' },
    })
    await expect(host.perform(request('snapshot', {}, null, sessionB.sessionAgentId))).resolves.toMatchObject({
      ok: true, result: { tabId: canonicalTabId }, updatedTab: { tabId: canonicalTabId },
    })
    expect(external.acquisitions).toMatchObject([
      { sessionAgentId: 'session-a', preferredTabId: canonicalTabId, createIfNeeded: false },
      { sessionAgentId: 'session-b', preferredTabId: canonicalTabId, createIfNeeded: false },
    ])
    expect(external.executions.map(({ sessionAgentId, operation, tabId }) => ({ sessionAgentId, operation, tabId }))).toEqual([
      { sessionAgentId: 'session-a', operation: 'open', tabId: canonicalTabId },
      { sessionAgentId: 'session-b', operation: 'open', tabId: canonicalTabId },
      { sessionAgentId: 'session-b', operation: 'snapshot', tabId: canonicalTabId },
    ])

    await host.endTurn(sessionB, 'turn-b')
    expect(external.authorityReleases).toMatchObject([
      { authority: { tabId: canonicalTabId }, reason: 'turn-ended' },
      { authority: { tabId: canonicalTabId }, reason: 'turn-ended' },
    ])
  })

  it('keeps managed Electron tab IDs session-owned across explicit opens', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    const owned = { ...tab('managed-owned', 'managed-electron'), sessionAgentId: 'session-a' }
    host.synchronizeSessions([{ ...session([owned], owned.tabId), sessionAgentId: 'session-a' }])

    await expect(host.perform(request('open', {
      tabId: owned.tabId, show: false, reuseExistingTab: true,
    }, owned.tabId, 'session-b'))).resolves.toMatchObject({
      ok: false, error: { code: 'tab-session-mismatch' },
    })
    expect(external.acquisitions).toEqual([])
    expect(managed.requests).toEqual([])
  })

  it('retains the exact managed fallback when Chrome inventory acquisition fails before mutation', async () => {
      const fallbackReason = 'no-eligible-target' as const
      const managed = new FakeManagedAdapter()
      const external = new FakeExternalAdapter()
      external.acquireResults.push(acquireFailure(fallbackReason))
      const host = createHost(managed, external)
      const fallback = tab('managed-fallback', 'managed-electron')
      fallback.url = 'about:blank'
      host.synchronizeSessions([session([fallback], fallback.tabId)])

      await expect(host.perform(request('open', { show: false, reuseExistingTab: true }, null))).resolves.toMatchObject({
        ok: true, updatedTab: { targetAffinity: 'managed-electron', tabId: 'managed-fallback' },
      })
      expect(external.acquisitions).toMatchObject([{ createIfNeeded: true, reuseExisting: true }])
      expect(external.executions).toEqual([])
      expect(managed.requests).toMatchObject([{ operation: 'open', tabId: 'managed-fallback' }])
  })

  it('still allocates one automatic target for open reuse false from managed affinity', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('managed-selected', 'managed-electron')], 'managed-selected')])

    await expect(host.perform(request('open', { show: false, reuseExistingTab: false }, null))).resolves.toMatchObject({
      ok: true, updatedTab: { targetAffinity: 'external-chrome', tabId: 'chrome-tab-1' },
    })
    await host.perform(request('snapshot', {}, null))
    expect(external.acquisitions).toMatchObject([{
      preferredTabId: null, reuseExisting: false, createIfNeeded: true,
    }])
    expect(external.executions.map(({ tabId }) => tabId)).toEqual(['chrome-tab-1', 'chrome-tab-1'])
    expect(managed.requests).toEqual([])
  })

  it('decides managed-only operations before allocating even with Chrome session affinity', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const ensureManagedTarget = vi.fn(async () => 'managed-new')
    const host = createHost(managed, external, ensureManagedTarget)
    host.synchronizeSessions([session([tab('chrome-selected', 'external-chrome')], 'chrome-selected')])

    await expect(host.perform(request('recordingStart', {}, null))).resolves.toMatchObject({
      ok: true,
      updatedTab: { targetAffinity: 'managed-electron', tabId: 'managed-new' },
    })
    expect(external.acquisitions).toHaveLength(0)
    expect(ensureManagedTarget).toHaveBeenCalledOnce()
  })

  it('falls back to Managed without creating a hidden tab after a pre-mutation Chrome race', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.executionResults.push({
      response: failure(request('click', { x: 1, y: 1, timeoutMs: 100 }, 'chrome-tab-1'), 'debugger-unavailable'),
      failure: { phase: 'acquisition', mutationState: 'not-started', fallbackReason: 'foreign-debugger' },
    })
    const host = createHost(managed, external)

    await expect(host.perform(request('click', { x: 1, y: 1, timeoutMs: 100 }, null))).resolves.toMatchObject({ ok: true })
    expect(external.acquisitions).toHaveLength(1)
    expect(external.executions).toHaveLength(1)
    expect(managed.requests).toHaveLength(1)
  })

  it('does not retry a mutating debugger-unavailable failure without explicit safety metadata', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const original = request('click', { x: 1, y: 1, timeoutMs: 100 }, null)
    external.executionResults.push({
      response: failure({ ...original, tabId: 'chrome-tab-1' } as BrowserAutomationRequest, 'debugger-unavailable'),
    })
    const host = createHost(managed, external, vi.fn(async () => 'must-not-run'))

    await expect(host.perform(original)).resolves.toMatchObject({
      ok: false,
      error: { code: 'debugger-unavailable', details: { mutationState: 'possible', noReplay: true } },
    })
    expect(external.acquisitions).toHaveLength(1)
    expect(external.executions).toHaveLength(1)
    expect(managed.requests).toHaveLength(0)
  })

  it('falls back to Managed only while mutation is proven not started', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.acquireResults.push(acquireFailure('restricted-target'))
    const ensureManagedTarget = vi.fn(async () => 'managed-fallback')
    const host = createHost(managed, external, ensureManagedTarget)

    await expect(host.perform(request('navigate', { url: 'https://example.test', readiness: 'load', timeoutMs: 100 }, null))).resolves.toMatchObject({
      ok: true,
      updatedTab: { targetAffinity: 'managed-electron', tabId: 'managed-fallback' },
    })
    expect(external.acquisitions).toHaveLength(1)
    expect(external.acquisitions[0]).toMatchObject({ createIfNeeded: false })
    expect(managed.requests).toHaveLength(1)
  })

  it('never replays a failure after possible mutation and returns typed no-replay metadata', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const original = request('click', { x: 1, y: 1, timeoutMs: 100 }, null)
    external.executionResults.push({
      response: failure({ ...original, tabId: 'chrome-tab-1' } as BrowserAutomationRequest, 'host-disconnected'),
      failure: { phase: 'execution', mutationState: 'possible', fallbackReason: 'transport-disconnected' },
    })
    const host = createHost(managed, external, vi.fn(async () => 'must-not-run'))

    await expect(host.perform(original)).resolves.toMatchObject({
      ok: false,
      error: { details: { automaticPolicyPhase: 'execution', mutationState: 'possible', noReplay: true, fallbackReason: 'transport-disconnected' } },
    })
    expect(external.executions).toHaveLength(1)
    expect(managed.requests).toHaveLength(0)
    expect(external.authorityReleases).toMatchObject([{ reason: 'operation-failed' }])
  })

  it('retains authority for an adaptive operation burst, then releases at bounded idle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = new AutomaticBrowserHost({
      managedAdapter: managed,
      externalAdapter: external,
      authorityBurst: { initialIdleMs: 100, incrementMs: 50, maximumIdleMs: 200 },
    })

    const opened = await host.perform(request('open', { show: false, reuseExistingTab: true }, null))
    const tabId = opened.updatedTab?.tabId ?? null
    await vi.advanceTimersByTimeAsync(50)
    await host.perform(request('snapshot', {}, tabId))
    expect(external.acquisitions).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(149)
    expect(external.authorityReleases).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(external.authorityReleases).toMatchObject([{ reason: 'idle' }])
  })

  it('keeps one authority across five sub-bound calls and releases after 30 seconds of inactivity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)

    for (let index = 0; index < 5; index += 1) {
      await host.perform(request('snapshot', {}, null))
      if (index < 4) await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(external.acquisitions).toHaveLength(1)
    expect(external.authorityReleases).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(EXTERNAL_CHROME_DESKTOP_AUTHORITY_IDLE_TIMEOUT_MS - 1)
    expect(external.authorityReleases).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(external.authorityReleases).toMatchObject([{ reason: 'idle' }])
  })

  it('preserves attached-idle authority on collaborative collision until snapshot or Take Control', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    await host.perform(request('open', { show: false, reuseExistingTab: true }, null))
    const collided = request('click', { x: 5, y: 6, timeoutMs: 100 }, 'chrome-tab-1')
    external.executionResults.push({
      response: failure(collided, 'control-interrupted', externalChromeControlCollisionDetails('possible')),
      failure: {
        phase: 'execution', mutationState: 'possible', fallbackReason: 'authority-conflict',
        noReplay: true, preserveAuthority: true, requiresReobserve: true,
      },
    })

    await expect(host.perform(collided)).resolves.toMatchObject({
      ok: false,
      error: { code: 'control-interrupted', details: { mutationState: 'possible', noReplay: true, requiresReobserve: true } },
    })
    expect(external.authorityReleases).toHaveLength(0)
    expect(managed.requests).toHaveLength(0)
    await expect(host.perform(request('click', { x: 5, y: 6, timeoutMs: 100 }, 'chrome-tab-1'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'request-cancelled', details: { mutationState: 'not-started', noReplay: true, requiresReobserve: true } },
    })
    expect(external.executions).toHaveLength(2)

    await expect(host.perform(request('snapshot', {}, 'chrome-tab-1'))).resolves.toMatchObject({ ok: true })
    await expect(host.perform(request('click', { x: 5, y: 6, timeoutMs: 100 }, 'chrome-tab-1'))).resolves.toMatchObject({ ok: true })
    expect(external.acquisitions).toHaveLength(1)
    expect(external.executions).toHaveLength(4)

    await expect(host.takeControl({ sessionAgentId: 'session', profileId: 'profile' }, 'chrome-tab-1')).resolves.toEqual({
      released: true, tabId: 'chrome-tab-1',
    })
    expect(external.authorityReleases).toMatchObject([{ reason: 'take-control', authority: { tabId: 'chrome-tab-1' } }])
  })

  it('takes control through an exact durable tab checkpoint after in-memory host restart', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.recoveredTargetRelease = true
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('chrome-recovered', 'external-chrome')], 'chrome-recovered')])

    await expect(host.takeControl({ sessionAgentId: 'session', profileId: 'profile' }, 'chrome-recovered'))
      .resolves.toEqual({ released: true, tabId: 'chrome-recovered' })
    expect(external.targetAuthorityReleases).toEqual([{
      session: { sessionAgentId: 'session', profileId: 'profile' },
      tabId: 'chrome-recovered',
      reason: 'take-control',
    }])
  })

  it('releases collided authority instead of applying its re-observation gate to another explicit tab', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    await host.perform(request('open', { show: false, reuseExistingTab: true }, null))
    const collided = request('click', { x: 5, y: 6, timeoutMs: 100 }, 'chrome-tab-1')
    external.executionResults.push({
      response: failure(collided, 'control-interrupted', externalChromeControlCollisionDetails('possible')),
      failure: {
        phase: 'execution', mutationState: 'possible', fallbackReason: 'authority-conflict',
        noReplay: true, preserveAuthority: true, requiresReobserve: true,
      },
    })
    await host.perform(collided)
    host.adoptTarget(tab('chrome-tab-2', 'external-chrome'))

    await expect(host.perform(request('click', { x: 7, y: 8, timeoutMs: 100 }, 'chrome-tab-2')))
      .resolves.toMatchObject({ ok: true })
    expect(external.authorityReleases).toMatchObject([{ reason: 'idle', authority: { tabId: 'chrome-tab-1' } }])
    expect(external.acquisitions.at(-1)).toMatchObject({ preferredTabId: 'chrome-tab-2' })
  })

  it('retains a failed idle release, retries it exactly, and blocks acquisition until acknowledgement', async () => {
    vi.useFakeTimers()
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.releaseFailures.push(new Error('disconnected'))
    const host = new AutomaticBrowserHost({ managedAdapter: managed, externalAdapter: external, authorityBurst: { initialIdleMs: 10 } })
    await host.perform(request('snapshot', {}, null))
    await vi.advanceTimersByTimeAsync(10)
    expect(external.authorityReleases).toHaveLength(1)

    await expect(host.perform(request('snapshot', {}, null))).resolves.toMatchObject({ ok: true })
    expect(external.authorityReleases).toHaveLength(2)
    expect(external.authorityReleases[1]?.authority).toEqual(external.authorityReleases[0]?.authority)
    expect(external.acquisitions).toHaveLength(2)
  })

  it('keeps screenshot overflow read-only failures replay-safe through policy formatting', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const original = request('snapshot', {}, 'chrome-tab-1')
    external.executionResults.push({
      response: failure({ ...original, tabId: 'chrome-tab-1' } as BrowserAutomationRequest, 'response-too-large', {
        limitation: 'screenshot-only-envelope-overflow', screenshotBytes: 196_632, screenshotByteUnit: 'decoded-png',
        maximumBytes: 196_608, maximumByteUnit: 'decoded-png',
      }),
      failure: { phase: 'execution', mutationState: 'not-started' },
    })
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('chrome-tab-1', 'external-chrome')], 'chrome-tab-1')])

    await expect(host.perform(original)).resolves.toMatchObject({
      ok: false, tabId: 'chrome-tab-1',
      error: {
        code: 'response-too-large', retryable: false,
        details: {
          limitation: 'screenshot-only-envelope-overflow', screenshotByteUnit: 'decoded-png',
          mutationState: 'not-started', noReplay: false,
        },
      },
    })
    expect(external.authorityReleases).toHaveLength(1)
    expect(managed.requests).toHaveLength(0)
  })

  it('returns the original no-replay failure when post-mutation cleanup also fails', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const original = request('click', { x: 1, y: 1, timeoutMs: 100 }, null)
    external.executionResults.push({
      response: failure({ ...original, tabId: 'chrome-tab-1' } as BrowserAutomationRequest, 'execution-failed'),
      failure: { phase: 'execution', mutationState: 'possible' },
    })
    external.releaseFailures.push(new Error('release disconnected'))
    const host = createHost(managed, external)

    await expect(host.perform(original)).resolves.toMatchObject({
      ok: false, tabId: null, error: { code: 'execution-failed', details: { mutationState: 'possible', noReplay: true } },
    })
    expect(external.authorityReleases).toHaveLength(1)
    expect(managed.requests).toHaveLength(0)
    await expect(host.perform(request('snapshot', {}, null))).resolves.toMatchObject({ ok: true })
    expect(external.authorityReleases[1]?.authority).toEqual(external.authorityReleases[0]?.authority)
  })

  it('reveals an exact Chrome tab after idle and after turn-end release, and surfaces failed reacquire', async () => {
    vi.useFakeTimers()
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = new AutomaticBrowserHost({ managedAdapter: managed, externalAdapter: external, authorityBurst: { initialIdleMs: 10 } })
    const opened = await host.perform(request('open', { show: false, reuseExistingTab: true }, null))
    const tabId = opened.updatedTab!.tabId
    await vi.advanceTimersByTimeAsync(10)
    await expect(host.revealTarget({ sessionAgentId: 'session', profileId: 'profile' }, tabId)).resolves.toMatchObject({ revealed: true, tabId })

    await host.perform(request('snapshot', {}, tabId))
    await expect(host.handleLifecycle(lifecycle('turn-ended'))).resolves.toMatchObject({ ok: true })
    await expect(host.revealTarget({ sessionAgentId: 'session', profileId: 'profile' }, tabId)).resolves.toMatchObject({ revealed: true, tabId })

    external.revealFailures.push(new Error('exact reacquire failed'))
    await expect(host.revealTarget({ sessionAgentId: 'session', profileId: 'profile' }, tabId)).rejects.toThrow('exact reacquire failed')
    expect(external.reveals).toHaveLength(3)
  })

  it('retains failed turn cleanup and acknowledges only an exact retry', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.releaseFailures.push(new Error('turn disconnect'))
    const host = createHost(managed, external)
    await host.perform(request('snapshot', {}, null))

    await expect(host.handleLifecycle(lifecycle('turn-ended'))).resolves.toMatchObject({ ok: false, error: { code: 'execution-failed' } })
    expect(external.ended).toHaveLength(0)
    await expect(host.handleLifecycle(lifecycle('turn-ended'))).resolves.toMatchObject({ ok: true })
    expect(external.authorityReleases[1]?.authority).toEqual(external.authorityReleases[0]?.authority)
    expect(external.ended).toHaveLength(1)
  })

  it('centralizes generic turn/session cleanup and Show in Chrome reveal', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('chrome', 'external-chrome')], 'chrome')])
    await host.perform(request('snapshot', {}, 'chrome'))

    await expect(host.revealTarget({ sessionAgentId: 'session', profileId: 'profile' }, 'chrome')).resolves.toEqual({
      targetAffinity: 'external-chrome', revealed: true, tabId: 'chrome',
    })
    await expect(host.handleLifecycle(lifecycle('turn-ended'))).resolves.toMatchObject({ ok: true, kind: 'turn-ended', turnId: 'turn-1' })
    await expect(host.handleLifecycle(lifecycle('release-session'))).resolves.toMatchObject({ ok: true, kind: 'release-session', reason: 'archive' })
    expect(external.authorityReleases).toMatchObject([{ reason: 'idle' }])
    expect(external.ended).toHaveLength(1)
    expect(external.sessionReleases).toHaveLength(1)
    expect(managed.ended).toHaveLength(1)
    expect(managed.released).toHaveLength(1)
  })

  it('forgets terminal session state when exact browser release can no longer be acknowledged', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    external.releaseFailures.push(new Error('release disconnected'))
    const host = createHost(managed, external)
    host.synchronizeSessions([session([tab('chrome', 'external-chrome')], 'chrome')])
    await host.perform(request('snapshot', {}, 'chrome'))

    await expect(host.handleLifecycle(lifecycle('release-session', 'delete'))).resolves.toMatchObject({
      ok: true, kind: 'release-session', reason: 'delete',
    })
    expect(external.authorityReleases).toHaveLength(1)
    expect(external.sessionReleases).toMatchObject([{ reason: 'delete' }])
    await expect(host.perform(request('snapshot', {}, 'chrome'))).resolves.toMatchObject({
      ok: false, error: { code: 'tab-not-found' },
    })
  })

  it('advertises one v2 host with typed private target capabilities', () => {
    const host = createHost(new FakeManagedAdapter(), new FakeExternalAdapter())
    expect(host.capabilities).toMatchObject({
      protocolVersions: { minimum: 2, maximum: 2 },
      supportedOperations: BROWSER_AUTOMATION_OPERATIONS,
      targets: {
        'managed-electron': { available: true, physicalViewport: true, recording: true, reveal: false },
        'external-chrome': { available: true, physicalViewport: false, recording: false, reveal: true },
      },
    })
  })
})

function createHost(
  managed: FakeManagedAdapter,
  external: FakeExternalAdapter,
  ensureManagedTarget?: (request: BrowserAutomationRequest) => Promise<string | null>,
): AutomaticBrowserHost {
  return new AutomaticBrowserHost({ managedAdapter: managed, externalAdapter: external, ensureManagedTarget })
}

function request(
  operation: BrowserAutomationOperation,
  input: Record<string, unknown>,
  tabId: string | null,
  sessionAgentId = 'session',
): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}-${Math.random()}`, sessionAgentId, profileId: 'profile', tabId,
    hostId: 'automatic-host', hostGeneration: 1, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    artifactDirectory: null, operation, input,
  } as BrowserAutomationRequest
}

function tab(tabId: string, targetAffinity: BrowserTabSnapshot['targetAffinity']): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    targetAffinity, tabId, sessionAgentId: 'session', profileId: 'profile', url: 'https://example.test', title: 'Example',
    lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
    physicalVisible: targetAffinity === 'managed-electron', error: null, createdAt: now, updatedAt: now,
  }
}

function eligible(tabId: string) {
  return {
    targetAffinity: 'external-chrome' as const,
    tabId,
    browserProfileId: 'ext-profile.instance',
    windowId: 'ext-window.instance.1',
    title: 'Inventory',
    url: 'https://inventory.invalid/',
    active: true,
    windowFocused: false,
    lastAccessedAt: new Date(0).toISOString(),
  }
}

function session(tabs: BrowserTabSnapshot[], activeTabId: string | null): BrowserSessionSnapshot {
  const now = new Date(0).toISOString()
  return {
    schemaVersion: 2, sessionAgentId: 'session', profileId: 'profile', hostingState: 'hosted', tabs,
    activeTabId, defaultTabId: activeTabId, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now,
  }
}

function success(requestValue: BrowserAutomationRequest, targetAffinity: BrowserTabSnapshot['targetAffinity']): BrowserAutomationResponse {
  const target = {
    ...tab(requestValue.tabId ?? `${targetAffinity}-created`, targetAffinity),
    sessionAgentId: requestValue.sessionAgentId,
    profileId: requestValue.profileId,
  }
  const routing = {
    requestId: requestValue.requestId, sessionAgentId: requestValue.sessionAgentId, profileId: requestValue.profileId,
    tabId: target.tabId, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration,
    operation: requestValue.operation, elapsedMs: 1, updatedTab: target, ok: true as const,
  }
  if (requestValue.operation === 'open') return { ...routing, operation: 'open', result: { tab: target, created: true, panelRevealRequested: requestValue.input.show } }
  if (requestValue.operation === 'navigate') return { ...routing, operation: 'navigate', result: { tab: target, readiness: requestValue.input.readiness } }
  if (requestValue.operation === 'status') return { ...routing, operation: 'status', result: { available: true, host: { connected: true, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration, focused: true, capabilities: null, connectedAt: new Date(0).toISOString() }, panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: target, eligibleTabs: [], eligibleTabsTruncated: false } }
  return { ...routing, result: resultFor(requestValue.operation, target.tabId) } as BrowserAutomationResponse
}

function resultFor(operation: BrowserAutomationOperation, tabId: string): unknown {
  switch (operation) {
    case 'resize': return { tabId, setting: { mode: 'fill' }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
    case 'snapshot': return { tabId, url: '', title: '', loading: false, viewportSetting: { mode: 'fill' }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visibleText: '', interactiveElements: [], accessibility: null, consoleEntries: [], networkEntries: [], actionTimeline: [], screenshot: { mimeType: 'image/png', data: 'eA==', width: 1, height: 1 } }
    case 'click': return { tabId, point: { x: 1, y: 1 } }
    case 'type': return { tabId, characters: 1, cleared: false }
    case 'press': return { tabId, key: 'Enter', modifiers: [] }
    case 'scroll': return { tabId, deltaX: 0, deltaY: 1, scrollX: 0, scrollY: 1 }
    case 'evaluate': return { tabId, value: null, serializedBytes: 4 }
    case 'waitFor': return { tabId, matched: true, elapsedMs: 1 }
    case 'recordingStart': return { recordingId: 'recording', tabId, recording: true, startedAt: new Date(0).toISOString(), mimeType: 'video/webm', width: 800, height: 600 }
    case 'recordingStop': return { recordingId: 'recording', tabId, path: '/tmp/a.webm', mimeType: 'video/webm', extension: 'webm', sizeBytes: 1, width: 800, height: 600, createdAt: new Date(0).toISOString() }
    default: throw new Error(`unexpected ${operation}`)
  }
}

function failure(requestValue: BrowserAutomationRequest, code: BrowserAutomationFailure['code'], details?: NonNullable<BrowserAutomationFailure['details']>): BrowserAutomationResponse {
  return {
    requestId: requestValue.requestId, sessionAgentId: requestValue.sessionAgentId, profileId: requestValue.profileId,
    tabId: requestValue.tabId, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration,
    operation: requestValue.operation, ok: false, error: { code, message: code, retryable: code !== 'response-too-large', ...(details ? { details } : {}) }, elapsedMs: 1,
  }
}

function acquireFailure(fallbackReason: 'restricted-target' | 'no-eligible-target'): ExternalBrowserAcquireResult {
  const code = fallbackReason === 'restricted-target' ? 'restricted-target' : 'unavailable-host'
  return {
    ok: false,
    error: { code, message: fallbackReason, retryable: true },
    metadata: { phase: 'acquisition', mutationState: 'not-started', fallbackReason },
  }
}

function lifecycle(kind: 'turn-ended' | 'release-session', reason: 'archive' | 'delete' = 'archive'): BrowserHostLifecycleRequest {
  const routing = { requestId: `lifecycle-${kind}`, sessionAgentId: 'session', profileId: 'profile', hostId: 'automatic-host', hostGeneration: 1 }
  return kind === 'turn-ended' ? { ...routing, kind, turnId: 'turn-1' } : { ...routing, kind, reason }
}
