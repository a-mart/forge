import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { ChromeDebuggerSession } from '../src/runtime/chrome-api.js'
import { FakeStorage, fakeChrome } from './fakes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const TAB = { id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/', title: 'Fixture' }

class ContentPort {
  readonly sent: unknown[] = []
  disconnected = false
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  constructor(
    readonly name: string,
    readonly sender: { tab: { id: number }; frameId: number; documentId: string },
  ) {}
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => { this.messageListeners.push(listener) },
    removeListener: (listener: (message: unknown) => void): void => {
      const index = this.messageListeners.indexOf(listener)
      if (index >= 0) this.messageListeners.splice(index, 1)
    },
  }
  readonly onDisconnect = {
    addListener: (listener: () => void): void => { this.disconnectListeners.push(listener) },
  }
  postMessage(message: unknown): void { this.sent.push(structuredClone(message)) }
  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const listener of [...this.disconnectListeners]) listener()
  }
  emit(message: unknown): void { for (const listener of [...this.messageListeners]) listener(message) }
}

describe('service-worker control-session lifecycle', () => {
  it('reuses one attachment across five calls, reports agent-idle, and detaches at turn end', async () => {
    const { chrome, runtime, execute, release, attachCalls, detachCalls } = await harness()

    for (let index = 1; index <= 5; index += 1) {
      await expect(execute(`call-${index}`, `evaluate-${index}`)).resolves.toMatchObject({
        ok: true, result: { value: `call-${index}` },
      })
    }
    await expect(status(runtime)).resolves.toMatchObject({
      ok: true,
      result: { selectedTab: { controller: 'agent-idle' } },
    })
    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    expect(chrome.attached).toEqual(new Set([7]))
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ tabId: 7, state: 'idle' }],
      debuggerMetrics: { attachments: 1, attachmentReuses: 4, activeAttachments: 1, maximumObservedAttachments: 1 },
    })

    await expect(release('turn-ended')).resolves.toMatchObject({ releasedTabIds: [7] })
    expect(chrome.attached).toEqual(new Set())
    expect(detachCalls()).toBe(1)
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [],
      debuggerMetrics: { activeAttachments: 0, detachments: 1, detachReasons: { 'release:turn-ended': 1 } },
    })
    await expect(release('retry-after-lost-ack')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('detaches at physical idle timeout without releasing logical authority, then reattaches on demand', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { chrome, runtime, execute, release, attachCalls } = await harness({
      debuggerIdleTimeoutMs: 20,
      debuggerMaximumLifetimeMs: 100,
    })
    await execute('before-idle-timeout')
    expect(chrome.attached).toEqual(new Set([7]))

    await vi.advanceTimersByTimeAsync(20)
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ tabId: 7, state: 'idle' }],
      debuggerMetrics: { activeAttachments: 0, detachReasons: { 'idle-timeout': 1 } },
    })

    await expect(execute('after-idle-timeout', 'evaluate-after-idle')).resolves.toMatchObject({ ok: true })
    expect(attachCalls()).toBe(2)
    expect(chrome.attached).toEqual(new Set([7]))
    await release('idle')
  })

  it('revokes and detaches after a bounded executor failure instead of retaining an ambiguous session', async () => {
    const { chrome, runtime, execute, release } = await harness({
      evaluate: async () => ({
        result: { type: 'undefined' },
        exceptionDetails: { text: 'fixture evaluation failed' },
      }),
    })

    await expect(execute('throw new Error()')).resolves.toMatchObject({ ok: false, error: { code: 'evaluation-failed' } })
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ state: 'idle' }],
      debuggerMetrics: { activeAttachments: 0, detachReasons: { 'operation-failed': 1 } },
    })
    await release('idle')
  })

  it('settles a collided command, preserves attached-idle authority, and requires re-observation without replay', async () => {
    let resolvePending!: (result: unknown) => void
    const { chrome, runtime, execute, release, attachCalls, detachCalls } = await harness({
      evaluate: (expression) => expression === 'pending'
        ? new Promise((resolve) => { resolvePending = resolve })
        : Promise.resolve(value(expression)),
    })
    const operation = execute('pending')
    await vi.waitFor(() => expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'pending')).toBe(true))
    const staleQueuedOperation = execute('queued-before-human', 'evaluate-queued-before-human')

    const guard = bridge(7, 0, 'document-active', 1)
    runtime.onShellEvent('runtime.connect', [guard.port])
    guard.ready()
    guard.human(0)
    resolvePending(value('late-result'))

    await expect(operation).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'control-interrupted',
        details: { mutationState: 'possible', noReplay: true, requiresReobserve: true, authorityState: 'attached-idle' },
      },
    })
    await expect(staleQueuedOperation).resolves.toMatchObject({ ok: false, error: { code: 'request-cancelled' } })
    expect(chrome.attached).toEqual(new Set([7]))
    expect(runtime.diagnostics().authorities).toEqual([
      expect.objectContaining({ tabId: 7, state: 'idle' }),
    ])
    expect((runtime as unknown as {
      authorities: { forTab(tabId: number): { requiresObservation: boolean; controlEpoch: number } | null }
    }).authorities.forTab(7)).toMatchObject({ requiresObservation: true, controlEpoch: 1 })
    expect(chrome.commands.filter(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'pending')).toHaveLength(1)
    expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'queued-before-human')).toBe(false)
    expect(guard.port.sent).toContainEqual(expect.objectContaining({ type: 'status', state: 'attached-idle', controlEpoch: 1 }))

    await expect(execute('blocked-until-observed', 'evaluate-blocked')).resolves.toMatchObject({
      ok: false,
      error: { code: 'request-cancelled', details: { mutationState: 'not-started', noReplay: true, requiresReobserve: true } },
    })
    expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'blocked-until-observed')).toBe(false)
    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    await release('take-control')
    expect(chrome.attached).toEqual(new Set())
    expect(detachCalls()).toBe(1)
  })

  it('keeps attached-idle authority when collaborative input wins before the first page command', async () => {
    const { chrome, runtime, execute, release, detachCalls } = await harness()
    const guard = bridge(7, 0, 'document-before-dispatch', 2)
    runtime.onShellEvent('runtime.connect', [guard.port])
    guard.ready()

    const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting)
    let signalInjectionStarted!: () => void
    let resumeInjection!: () => void
    const injectionStarted = new Promise<void>((resolve) => { signalInjectionStarted = resolve })
    const injectionGate = new Promise<void>((resolve) => { resumeInjection = resolve })
    chrome.scripting.executeScript = async (injection) => {
      signalInjectionStarted()
      await injectionGate
      return originalExecuteScript(injection)
    }

    const operation = execute('must-not-dispatch-after-input')
    await injectionStarted
    guard.human(0)
    await vi.waitFor(() => expect((runtime as unknown as {
      authorities: { forTab(tabId: number): { controlEpoch: number; requiresObservation: boolean } | null }
    }).authorities.forTab(7)).toMatchObject({ controlEpoch: 1, requiresObservation: true }))
    resumeInjection()

    await expect(operation).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'control-interrupted',
        details: { mutationState: 'not-started', noReplay: true, requiresReobserve: true, authorityState: 'attached-idle' },
      },
    })
    expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' &&
      params?.expression === 'must-not-dispatch-after-input')).toBe(false)
    expect(chrome.attached).toEqual(new Set([7]))
    expect(detachCalls()).toBe(0)
    await release('take-control')
  })

  it('lets explicit Take Control terminally release active physical work', async () => {
    let rejectPending: ((error: Error) => void) | null = null
    const { chrome, execute, release, detachCalls } = await harness({
      evaluate: (expression) => expression === 'active-before-take-control'
        ? new Promise((_resolve, reject) => { rejectPending = reject })
        : Promise.resolve(value(expression)),
      onDetach: () => { rejectPending?.(new Error('debugger detached by Take Control')); rejectPending = null },
    })
    const active = execute('active-before-take-control')
    await vi.waitFor(() => expect(chrome.commands.some(({ method, params }) =>
      method === 'Runtime.evaluate' && params?.expression === 'active-before-take-control')).toBe(true))

    await expect(release('take-control')).resolves.toMatchObject({ releasedTabIds: [7] })
    await expect(active).resolves.toMatchObject({ ok: false })
    expect(chrome.attached).toEqual(new Set())
    expect(detachCalls()).toBe(1)
  })

  it('cancels and detaches one timed-out command before allowing a later same-lease operation', async () => {
    let rejectPending: ((error: Error) => void) | null = null
    let pending = true
    const { chrome, runtime, execute, release, attachCalls } = await harness({
      evaluate: (expression) => expression === 'pending-timeout' && pending
        ? new Promise((_resolve, reject) => { rejectPending = reject })
        : Promise.resolve(value(expression)),
      onDetach: () => { rejectPending?.(new Error('debugger detached')); rejectPending = null },
    })

    await expect(execute('pending-timeout', 'timeout-operation', 25)).resolves.toMatchObject({
      ok: false, error: { code: 'timeout' },
    })
    expect(chrome.attached).toEqual(new Set())
    expect(chrome.commands.filter(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'pending-timeout')).toHaveLength(1)
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ state: 'idle' }],
      debuggerMetrics: { activeAttachments: 0, detachReasons: { 'operation-cancelled': 1 } },
    })

    pending = false
    await expect(execute('after-timeout', 'after-timeout')).resolves.toMatchObject({ ok: true })
    expect(attachCalls()).toBe(2)
    await release('idle')
  })

  it('serializes prepareUpdate behind an already-admitted acquisition and receipts its exact scope', async () => {
    const chrome = configuredChrome([TAB])
    const get = chrome.tabs.get.bind(chrome.tabs)
    let enteredGet!: () => void
    let continueGet!: () => void
    const getEntered = new Promise<void>((resolve) => { enteredGet = resolve })
    const getGate = new Promise<void>((resolve) => { continueGet = resolve })
    chrome.tabs.get = async (tabId) => { enteredGet(); await getGate; return get(tabId) }
    const runtime = new Runtime({ chrome })
    const request = (message: Record<string, unknown>) => (runtime as unknown as {
      handleDesktopRequest(value: Record<string, unknown>): Promise<Record<string, unknown>>
    }).handleDesktopRequest(message)

    const acquiring = request({
      jsonrpc: '2.0', id: 'acquire-before-prepare', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'lease', leaseEpoch: 1, tabId: 7, createIfNeeded: false },
    })
    await getEntered
    const preparing = request({
      jsonrpc: '2.0', id: 'prepare-after-acquire', method: 'forge.runtime.prepareUpdate',
      params: { protocolVersion: 1, payloadVersion: 'next', sha256: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 5_000).toISOString() },
    })
    continueGet()

    await expect(acquiring).resolves.toMatchObject({ leaseId: 'lease', leaseEpoch: 1, tab: { tabId: 7 } })
    await expect(preparing).resolves.toMatchObject({ quiesced: true })
    expect(runtime.diagnostics().authorities).toEqual([])
    await expect(releaseOwner(runtime, 'lease', 1, 'lost-prepare-ack')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('serializes shutdown cleanup behind an admitted acquisition so the new authority is receipted', async () => {
    const chrome = configuredChrome([TAB])
    const get = chrome.tabs.get.bind(chrome.tabs)
    let enteredGet!: () => void
    let continueGet!: () => void
    const getEntered = new Promise<void>((resolve) => { enteredGet = resolve })
    const getGate = new Promise<void>((resolve) => { continueGet = resolve })
    chrome.tabs.get = async (tabId) => { enteredGet(); await getGate; return get(tabId) }
    const runtime = new Runtime({ chrome })
    const request = (message: Record<string, unknown>) => (runtime as unknown as {
      handleDesktopRequest(value: Record<string, unknown>): Promise<Record<string, unknown>>
    }).handleDesktopRequest(message)

    const acquiring = request({
      jsonrpc: '2.0', id: 'acquire-before-shutdown', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'lease-shutdown', leaseEpoch: 4, tabId: 7, createIfNeeded: false },
    })
    await getEntered
    const shuttingDown = runtime.shutdown()
    let shutdownSettled = false
    void shuttingDown.finally(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    continueGet()

    await expect(acquiring).resolves.toMatchObject({ leaseId: 'lease-shutdown', leaseEpoch: 4, tab: { tabId: 7 } })
    await expect(shuttingDown).resolves.toBeUndefined()
    expect(runtime.diagnostics().authorities).toEqual([])
    await expect(releaseOwner(runtime, 'lease-shutdown', 4, 'lost-shutdown-ack')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('does not orphan a debugger when terminal release races an in-progress physical attach', async () => {
    const chrome = configuredChrome([TAB])
    const attach = chrome.debugger.attach.bind(chrome.debugger)
    let continueAttach!: () => void
    const gate = new Promise<void>((resolve) => { continueAttach = resolve })
    chrome.debugger.attach = async (target, version) => { await gate; await attach(target, version) }
    const runtime = new Runtime({ chrome })
    await acquire(runtime, 7, 'lease-1', 1)

    const operation = runEvaluate(runtime, 7, 'lease-1', 1, 'attach-race')
    await vi.waitFor(() => expect((runtime as unknown as {
      debuggers: { state(tabId: number): string }
    }).debuggers.state(7)).toBe('ATTACHING'))
    const releasing = releaseOwner(runtime, 'lease-1', 1, 'transport-uncertain')
    continueAttach()

    await expect(releasing).resolves.toMatchObject({ releasedTabIds: [7] })
    await expect(operation).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics()).toMatchObject({ authorities: [], debuggerSessions: [], debuggerMetrics: { activeAttachments: 0 } })
  })

  it('retains one attachment across a trusted click navigation and positively adopts its replacement root', async () => {
    let rootTargetId = 'root-before-click'
    const { chrome, runtime, execute, release, attachCalls, detachCalls } = await harness({
      rootTargetId: () => rootTargetId,
    })
    await expect(execute('before-trusted-link')).resolves.toMatchObject({ ok: true })
    const guard = bridge(7, 0, 'document-before-link', 3)
    runtime.onShellEvent('runtime.connect', [guard.port])
    guard.ready()
    guard.human(0)
    await vi.waitFor(() => expect(authorityFor(runtime)).toMatchObject({ controlEpoch: 1, requiresObservation: true }))

    rootTargetId = 'root-after-click'
    await chrome.tabs.update(7, { url: 'https://navigated-by-click.invalid/' })
    runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'replacement-frame', url: 'https://navigated-by-click.invalid/' },
    }])
    runtime.onShellEvent('navigation.committed', [{
      tabId: 7, frameId: 0, documentId: 'document-after-link', url: 'https://navigated-by-click.invalid/',
    }])

    await vi.waitFor(() => expect((runtime as unknown as {
      debuggers: { targetId(tabId: number): string | undefined }
    }).debuggers.targetId(7)).toBe('root-after-click'))
    await vi.waitFor(() => expect(authorityFor(runtime)).toMatchObject({ controlEpoch: 2, requiresObservation: true }))
    expect(chrome.attached).toEqual(new Set([7]))
    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    expect(runtime.diagnostics().debuggerMetrics).toMatchObject({ attachments: 1, activeAttachments: 1 })
    await vi.waitFor(() => expect(chrome.injections.some(({ target }) => target.allFrames === true)).toBe(true))

    const replacementGuard = bridge(7, 0, 'document-after-link', 4)
    runtime.onShellEvent('runtime.connect', [replacementGuard.port])
    replacementGuard.ready()
    expect(replacementGuard.port.sent).toContainEqual(expect.objectContaining({ type: 'status', state: 'attached-idle', controlEpoch: 2 }))
    await expect(execute('blocked-after-trusted-link')).resolves.toMatchObject({
      ok: false,
      error: { code: 'request-cancelled', details: { mutationState: 'not-started', noReplay: true, requiresReobserve: true } },
    })
    expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'blocked-after-trusted-link')).toBe(false)

    await expect(runSnapshot(runtime, 'snapshot-after-trusted-link')).resolves.toMatchObject({ ok: true })
    expect(authorityFor(runtime)).toMatchObject({ requiresObservation: false })
    await expect(execute('after-trusted-link-observation')).resolves.toMatchObject({ ok: true })
    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    await release('take-control')
  })

  it('retains attached-idle authority across ordinary eligible page navigation and reload', async () => {
    const { chrome, runtime, execute, release, attachCalls, detachCalls } = await harness()
    await expect(execute('before-page-navigation')).resolves.toMatchObject({ ok: true })

    for (const [index, url] of ['https://page-navigation.invalid/', 'https://page-navigation.invalid/'].entries()) {
      await chrome.tabs.update(7, { url })
      runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Page.frameNavigated', {
        frame: { id: 'frame-tab-7', url },
      }])
      runtime.onShellEvent('navigation.committed', [{
        tabId: 7, frameId: 0, documentId: `ordinary-document-${index}`, url,
      }])
      if (index === 0) {
        await expect(execute('while-page-navigation-is-revalidated')).resolves.toMatchObject({
          ok: false,
          error: { code: 'request-cancelled', details: { requiresReobserve: true } },
        })
        expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' &&
          params?.expression === 'while-page-navigation-is-revalidated')).toBe(false)
      }
      await vi.waitFor(() => expect(authorityFor(runtime)).toMatchObject({
        controlEpoch: index + 1,
        requiresObservation: true,
      }))
      await vi.waitFor(() => expect(runtime.diagnostics().debuggerMetrics.attachmentReuses).toBeGreaterThanOrEqual(index * 2 + 1))
      expect(chrome.attached).toEqual(new Set([7]))
      await expect(execute(`blocked-after-ordinary-navigation-${index}`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'request-cancelled', details: { requiresReobserve: true } },
      })
      await expect(runSnapshot(runtime, `snapshot-after-ordinary-navigation-${index}`)).resolves.toMatchObject({ ok: true })
    }

    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    expect(runtime.diagnostics().debuggerMetrics).toMatchObject({ attachments: 1, activeAttachments: 1 })
    await release('take-control')
  })

  it('terminally detaches and receipts a retained attachment that navigates into a restricted target', async () => {
    const { chrome, runtime, execute, release } = await harness()
    await execute('before-restricted-navigation')
    await chrome.tabs.update(7, { url: 'chrome://settings/' })
    runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-tab-7', url: 'chrome://settings/' },
    }])

    await vi.waitFor(() => expect(runtime.diagnostics().authorities).toEqual([]))
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics().debuggerMetrics.detachReasons).toMatchObject({ 'restricted-target': 1 })
    await expect(execute('stale-after-restricted')).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    await expect(release('desktop-retry')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('terminally receipts an attachment when root identity can no longer be proven', async () => {
    let rootTargetId: string | null = 'root-valid'
    const { chrome, runtime, execute, release } = await harness({
      rootTargetId: () => rootTargetId ?? '',
    })
    await execute('before-identity-loss')
    const send = chrome.debugger.sendCommand.bind(chrome.debugger)
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Target.getTargetInfo' && rootTargetId === null) {
        chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
        return { targetInfo: { type: 'page', attached: false } }
      }
      return send(target, method, params)
    }
    rootTargetId = null
    await chrome.tabs.update(7, { url: 'https://unproven-navigation.invalid/' })
    runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'unproven-frame', url: 'https://unproven-navigation.invalid/' },
    }])

    await vi.waitFor(() => expect(runtime.diagnostics().authorities).toEqual([]))
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics().debuggerMetrics.detachReasons).toMatchObject({ 'identity-loss': 1 })
    await expect(release('desktop-retry')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('cancels active work, terminally receipts DevTools preemption, and requires reacquisition', async () => {
    let rejectActive!: (error: Error) => void
    const { chrome, runtime, execute, release } = await harness({
      evaluate: (expression) => expression === 'active-at-devtools'
        ? new Promise((_resolve, reject) => { rejectActive = reject })
        : Promise.resolve(value(expression)),
    })
    const active = execute('active-at-devtools')
    await vi.waitFor(() => expect(chrome.commands.some(({ method, params }) =>
      method === 'Runtime.evaluate' && params?.expression === 'active-at-devtools')).toBe(true))
    const queued = execute('queued-at-devtools', 'queued-at-devtools')
    chrome.attached.delete(7)
    runtime.onShellEvent('debugger.detach', [{ tabId: 7 }, 'replaced_with_devtools'])
    rejectActive(new Error('debugger detached during active work'))

    await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'request-cancelled' } })
    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    expect(chrome.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params?.expression === 'queued-at-devtools')).toBe(false)

    const authorities = runtime as unknown as {
      authorities: {
        forTab(tabId: number): unknown
        releaseScope(ownerId: string, ownerEpoch: number): number[]
      }
    }
    await vi.waitFor(() => expect(authorities.authorities.forTab(7)).toBeNull())
    expect(authorities.authorities.releaseScope('lease-1', 1)).toEqual([7])
    expect(runtime.diagnostics().debuggerMetrics).toMatchObject({
      activeAttachments: 0,
      preemptions: 1,
      detachReasons: { 'devtools-preemption': 1 },
    })
    await expect(execute('stale-after-devtools')).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    await expect(release('desktop-retry')).resolves.toMatchObject({ releasedTabIds: [7] })

    await acquire(runtime, 7, 'lease-after-devtools', 2)
    await expect(runEvaluate(runtime, 7, 'lease-after-devtools', 2, 'after-devtools-closed')).resolves.toMatchObject({ ok: true })
    await releaseOwner(runtime, 'lease-after-devtools', 2, 'idle')
  })

  it('retains one physical attachment across a positively re-proven navigation target identity', async () => {
    let rootTargetId = 'root-before'
    const { chrome, runtime, execute, release, attachCalls } = await harness({ rootTargetId: () => rootTargetId })
    await execute('before-navigation')
    rootTargetId = 'root-after'
    runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Target.targetInfoChanged', {
      targetInfo: { targetId: rootTargetId, type: 'page', attached: true },
    }])
    await vi.waitFor(() => expect((runtime as unknown as {
      debuggers: { targetId(tabId: number): string | undefined }
    }).debuggers.targetId(7)).toBe(rootTargetId))

    await expect(execute('after-navigation', 'evaluate-after-navigation')).resolves.toMatchObject({ ok: true })
    expect(attachCalls()).toBe(1)
    expect(chrome.attached).toEqual(new Set([7]))
    expect(runtime.diagnostics().debuggerMetrics).toMatchObject({ attachments: 1, attachmentReuses: 1 })
    await release('idle')
  })

  it('bounds physical attachments across tabs until the existing session detaches', async () => {
    const tabs = [TAB, { ...TAB, id: 8, url: 'https://second.invalid/' }]
    const chrome = configuredChrome(tabs)
    const runtime = new Runtime({ chrome, maximumDebuggerAttachments: 1 })
    await acquire(runtime, 7, 'lease-1', 1)
    await acquire(runtime, 8, 'lease-2', 2)

    await expect(runEvaluate(runtime, 7, 'lease-1', 1, 'tab-one')).resolves.toMatchObject({ ok: true })
    await expect(runEvaluate(runtime, 8, 'lease-2', 2, 'tab-two')).resolves.toMatchObject({
      ok: false,
      error: { code: 'debugger-unavailable', details: { limitation: 'simultaneous-debugger-attachment-bound', maximumAttachments: 1 } },
    })
    expect(chrome.attached).toEqual(new Set([7]))
    expect(runtime.diagnostics().debuggerMetrics).toMatchObject({
      maximumObservedAttachments: 1,
      attachmentLimitRejections: 1,
    })

    await releaseOwner(runtime, 'lease-1', 1, 'idle')
    await expect(runEvaluate(runtime, 8, 'lease-2', 2, 'tab-two-retry')).resolves.toMatchObject({ ok: true })
    expect(chrome.attached).toEqual(new Set([8]))
    await releaseOwner(runtime, 'lease-2', 2, 'idle')
  })

  it('cancels before synthetic input when the singleton guard disconnects without acknowledgement', async () => {
    const { chrome, runtime, release } = await harness()
    const guard = bridge(7, 0, 'document-click', 1)
    runtime.onShellEvent('runtime.connect', [guard.port]); guard.ready()
    const click = (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
      protocolVersion: 1, requestId: 'click-guard-disconnect', leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
      operation: 'click', input: { x: 0, y: 0, timeoutMs: 1_000 },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    })
    await vi.waitFor(() => expect(guard.port.sent).toContainEqual(expect.objectContaining({ type: 'synthetic-start' })))
    guard.port.disconnect()

    await expect(click).resolves.toMatchObject({ ok: false, error: { code: 'execution-failed' } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics().authorities).toEqual([expect.objectContaining({ state: 'idle' })])
    await release('idle')
  })

  it('enforces one service-worker bridge per exact frame document and a bounded tab cardinality', async () => {
    const { runtime, release } = await harness()
    const first = bridge(7, 0, 'document-a', 1)
    const duplicate = bridge(7, 0, 'document-a', 2)
    runtime.onShellEvent('runtime.connect', [first.port]); first.ready()
    runtime.onShellEvent('runtime.connect', [duplicate.port])
    expect(duplicate.port.disconnected).toBe(true)

    const replacement = bridge(7, 0, 'document-b', 3)
    runtime.onShellEvent('runtime.connect', [replacement.port]); replacement.ready()
    expect(first.port.disconnected).toBe(true)
    for (let frameId = 1; frameId < 64; frameId += 1) {
      const entry = bridge(7, frameId, `document-${frameId}`, frameId + 3)
      runtime.onShellEvent('runtime.connect', [entry.port])
    }
    const overflow = bridge(7, 64, 'document-overflow', 100)
    runtime.onShellEvent('runtime.connect', [overflow.port])
    expect(overflow.port.disconnected).toBe(true)
    expect(runtime.diagnostics().bridges).toMatchObject({
      active: 64,
      maximumObserved: 64,
      duplicatesRejected: 1,
      boundRejections: 1,
    })

    await release('idle')
    expect(runtime.diagnostics().bridges.active).toBe(0)
  })

  it('retries a failed durable tab-close receipt and returns the original exact tab ID', async () => {
    class FailOnceStorage extends FakeStorage {
      fail = true
      override async set(items: Record<string, unknown>): Promise<void> {
        if (this.fail) { this.fail = false; throw new Error('local storage unavailable') }
        await super.set(items)
      }
    }
    const local = new FailOnceStorage()
    const chrome = configuredChrome([TAB], { local })
    const runtime = new Runtime({ chrome })
    await acquire(runtime, 7, 'lease-1', 1)
    await runEvaluate(runtime, 7, 'lease-1', 1, 'before-close')
    chrome.attached.delete(7)
    await chrome.tabs.remove(7)
    runtime.onShellEvent('tab.removed', [7])

    await vi.waitFor(() => expect(runtime.diagnostics().cleanup.pendingClosedTabReceipts).toBe(1))
    expect(runtime.diagnostics().debuggerMetrics.detachReasons).toMatchObject({ 'tab-closed': 1 })
    runtime.onShellEvent('alarm', [{ name: 'forge.externalChrome.cleanupRetry.v1' }])
    await vi.waitFor(() => expect(runtime.diagnostics().cleanup.pendingClosedTabReceipts).toBe(0))
    expect(runtime.diagnostics().authorities).toEqual([])
    await expect(releaseOwner(runtime, 'lease-1', 1, 'tab-close-retry')).resolves.toMatchObject({ releasedTabIds: [7] })
    expect(local.values['forge.externalChrome.releaseReceipts.v2']).toMatchObject({
      receipts: [expect.objectContaining({ ownerId: 'lease-1', ownerEpoch: 1, tabIds: [7] })],
    })
  })
})

async function harness(options: {
  debuggerIdleTimeoutMs?: number
  debuggerMaximumLifetimeMs?: number
  evaluate?: (expression: string) => Promise<unknown>
  onDetach?: () => void
  rootTargetId?: () => string
} = {}): Promise<{
  chrome: ReturnType<typeof configuredChrome>
  runtime: Runtime
  execute(expression: string, requestId?: string, timeoutMs?: number): Promise<unknown>
  release(reason: string): Promise<Record<string, unknown>>
  attachCalls(): number
  detachCalls(): number
}> {
  const chrome = configuredChrome([TAB], options)
  let attaches = 0
  let detaches = 0
  const attach = chrome.debugger.attach.bind(chrome.debugger)
  chrome.debugger.attach = async (target, version) => { attaches += 1; await attach(target, version) }
  const detach = chrome.debugger.detach.bind(chrome.debugger)
  chrome.debugger.detach = async (target) => {
    detaches += 1
    await detach(target)
    options.onDetach?.()
  }
  const runtime = new Runtime({
    chrome,
    ...(options.debuggerIdleTimeoutMs === undefined ? {} : { debuggerIdleTimeoutMs: options.debuggerIdleTimeoutMs }),
    ...(options.debuggerMaximumLifetimeMs === undefined ? {} : { debuggerMaximumLifetimeMs: options.debuggerMaximumLifetimeMs }),
  })
  await acquire(runtime, 7, 'lease-1', 1)
  return {
    chrome,
    runtime,
    execute: (expression, requestId, timeoutMs) => runEvaluate(runtime, 7, 'lease-1', 1, expression, requestId, timeoutMs),
    release: (reason) => releaseOwner(runtime, 'lease-1', 1, reason),
    attachCalls: () => attaches,
    detachCalls: () => detaches,
  }
}

function configuredChrome(
  tabs: Array<typeof TAB>,
  options: {
    local?: FakeStorage
    evaluate?: (expression: string) => Promise<unknown>
    rootTargetId?: () => string
  } = {},
): ReturnType<typeof fakeChrome> {
  const chrome = fakeChrome({ tabs: tabs.map((tab) => ({ ...tab })), ...(options.local === undefined ? {} : { local: options.local }) })
  const send = chrome.debugger.sendCommand.bind(chrome.debugger)
  chrome.debugger.sendCommand = async (target: ChromeDebuggerSession, method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.getTargetInfo' && options.rootTargetId !== undefined) {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { targetInfo: { targetId: options.rootTargetId(), type: 'page', attached: true } }
    }
    if (method === 'Runtime.evaluate') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      const expression = String(params?.expression ?? '')
      if (expression === 'window.devicePixelRatio') return value(1)
      if (expression.includes('interactiveElements')) {
        const tab = await chrome.tabs.get(target.tabId ?? 7)
        return value({
          url: tab.url ?? '', title: tab.title ?? 'Fixture', loading: false,
          visibleText: 'Observed after navigation', interactiveElements: [],
        })
      }
      return options.evaluate === undefined ? value(expression) : options.evaluate(expression)
    }
    if (method === 'Page.getLayoutMetrics') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { cssVisualViewport: { clientWidth: 320, clientHeight: 180, pageX: 0, pageY: 0 } }
    }
    if (method === 'Page.captureScreenshot') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { data: pngBase64(320, 180) }
    }
    if (method === 'Accessibility.getFullAXTree') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { nodes: [] }
    }
    return send(target, method, params)
  }
  return chrome
}

async function acquire(runtime: Runtime, tabId: number, ownerId: string, ownerEpoch: number): Promise<void> {
  await (runtime as unknown as {
    authorities: { acquire(input: Record<string, unknown>): Promise<unknown> }
  }).authorities.acquire({ tabId, ownerId, ownerEpoch, sessionAgentId: `session-${ownerId}`, expectedOwnerEpoch: 0 })
}

function runEvaluate(
  runtime: Runtime,
  tabId: number,
  leaseId: string,
  leaseEpoch: number,
  expression: string,
  requestId = `evaluate-${expression}`,
  timeoutMs = 5_000,
): Promise<unknown> {
  return (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
    protocolVersion: 1,
    requestId,
    leaseId,
    leaseEpoch,
    tabId,
    operation: 'evaluate',
    input: { expression, awaitPromise: true, returnByValue: true },
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
  })
}

function runSnapshot(runtime: Runtime, requestId: string): Promise<unknown> {
  return (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
    protocolVersion: 1,
    requestId,
    leaseId: 'lease-1',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'snapshot',
    input: {},
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  })
}

function authorityFor(runtime: Runtime): { controlEpoch: number; requiresObservation: boolean } | null {
  return (runtime as unknown as {
    authorities: { forTab(tabId: number): { controlEpoch: number; requiresObservation: boolean } | null }
  }).authorities.forTab(7)
}

function status(runtime: Runtime): Promise<unknown> {
  return (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
    protocolVersion: 1,
    requestId: 'status',
    leaseId: 'lease-1',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'status',
    input: {},
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  })
}

function releaseOwner(runtime: Runtime, leaseId: string, leaseEpoch: number, reason: string): Promise<Record<string, unknown>> {
  return (runtime as unknown as {
    handleDesktopRequest(message: Record<string, unknown>): Promise<Record<string, unknown>>
  }).handleDesktopRequest({
    jsonrpc: '2.0',
    id: `release-${leaseId}-${reason}`,
    method: 'forge.browser.release',
    params: { protocolVersion: 1, leaseId, leaseEpoch, reason },
  })
}

function bridge(tabId: number, frameId: number, documentId: string, index: number): {
  port: ContentPort
  ready(): void
  human(controlEpoch: number): void
} {
  const nonce = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const port = new ContentPort(`forge-leased-frame:${nonce}`, { tab: { id: tabId }, frameId, documentId })
  return {
    port,
    ready: () => port.emit({ type: 'content-ready', nonce }),
    human: (controlEpoch) => port.emit({ type: 'trusted-human-input', nonce, controlEpoch, event: 'pointer' }),
  }
}

function value(result: unknown): Record<string, unknown> {
  return { result: { type: typeof result, value: result } }
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}
