import { describe, expect, it } from 'vitest'
import { DebuggerAttachConflictError, DebuggerController, OopifAncestryTracker } from '../src/runtime/debugger-controller.js'
import { fakeChrome } from './fakes.js'

describe('Chrome debugger ownership with unadvertised OOPIF ancestry hardening', () => {
  it('attaches only the leased root and enables flattened discovery from a proven real target', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(21)
    expect(controller.state(21)).toBe('ATTACHED')
    expect(chrome.commands).toEqual([
      { target: { tabId: 21 }, method: 'Page.enable' },
      { target: { tabId: 21 }, method: 'Target.getTargetInfo' },
      { target: { tabId: 21 }, method: 'Page.getFrameTree' },
      { target: { tabId: 21 }, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } },
    ])
    await controller.detach(21)
    expect(controller.state(21)).toBe('UNATTACHED')
  })

  it('tracks root -> OOPIF -> nested OOPIF ancestry and rejects orphan sessions', () => {
    const tracker = new OopifAncestryTracker()
    tracker.registerRoot('root', 'frame-root')
    expect(tracker.attached(undefined, { sessionId: 'unknown-root-child', targetInfo: { targetId: 'unknown-frame', type: 'iframe' } })).toMatchObject({ accepted: false })
    expect(tracker.attached(undefined, { sessionId: 'page-child', targetInfo: { targetId: 'page-target', type: 'page' } })).toMatchObject({ accepted: false })
    expect(tracker.frameAttached('frame-a', 'frame-root')).toBe(true)
    expect(tracker.attached(undefined, { sessionId: 'session-a', targetInfo: { targetId: 'frame-a', type: 'iframe' } })).toEqual({ accepted: true, sessionId: 'session-a', targetId: 'frame-a' })
    expect(tracker.frameAttached('frame-b', 'frame-a')).toBe(true)
    expect(tracker.attached('session-a', { sessionId: 'session-b', targetInfo: { targetId: 'frame-b', type: 'iframe' } })).toEqual({ accepted: true, sessionId: 'session-b', targetId: 'frame-b' })
    expect(tracker.ancestry('frame-b')).toEqual(['frame-b', 'frame-a', 'root'])
    expect(tracker.attached('orphan-parent', { sessionId: 'orphan', targetInfo: { targetId: 'frame-x', type: 'iframe' } })).toMatchObject({ accepted: false, sessionId: 'orphan' })
    expect(tracker.acceptsSession('orphan')).toBe(false)
    expect(tracker.validatesTargetInfo('session-b', { targetId: 'frame-b', type: 'iframe', attached: true })).toBe(true)
    expect(tracker.validatesTargetInfo('session-b', { targetId: 'migrated-frame', type: 'iframe', attached: true })).toBe(false)
    tracker.detached('session-a')
    expect(tracker.acceptsSession('session-a')).toBe(false)
    expect(tracker.acceptsSession('session-b')).toBe(false)
  })

  it('recursively configures only a frame-proven child session and preserves target/session IDs', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(6)
    expect(await controller.onEvent({ tabId: 6 }, 'Page.frameAttached', { frameId: 'frame-child', parentFrameId: 'frame-tab-6' })).toMatchObject({ accepted: true })
    expect(await controller.onEvent({ tabId: 6 }, 'Target.attachedToTarget', {
      sessionId: 'session-child', targetInfo: { targetId: 'frame-child', type: 'iframe' },
    })).toEqual({ accepted: true, targetId: 'frame-child', sessionId: 'session-child' })
    expect(controller.targetId(6, 'session-child')).toBe('frame-child')
    expect(chrome.commands.at(-1)).toEqual({
      target: { tabId: 6, sessionId: 'session-child' }, method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    })
    expect(await controller.onEvent({ tabId: 6, sessionId: 'session-child' }, 'Target.targetInfoChanged', {
      targetInfo: { targetId: 'migrated-frame', type: 'iframe', attached: true },
    })).toEqual({ accepted: false, rejectedSessionId: 'session-child' })
  })

  it('waits for the requested navigation readiness signal instead of echoing it early', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(9)
    let settled = false
    const navigation = controller.navigateAndWait(9, 'https://fixture.invalid/', 'domContentLoaded', Date.now() + 1_000, () => true)
      .then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await controller.onEvent({ tabId: 9 }, 'Page.domContentEventFired', {})
    await navigation
    expect(settled).toBe(true)
    expect(chrome.commands).toContainEqual({ target: { tabId: 9 }, method: 'Page.navigate', params: { url: 'https://fixture.invalid/' } })
  })

  it('times out readiness and continuously rejects interrupted lease authority', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(10)
    await expect(controller.navigateAndWait(10, 'https://fixture.invalid/', 'load', Date.now() + 5, () => true)).rejects.toThrow(/timed out/u)
    let authorized = true
    const interrupted = controller.navigateAndWait(10, 'https://fixture.invalid/next', 'load', Date.now() + 1_000, () => authorized)
    authorized = false
    await expect(interrupted).rejects.toThrow(/authority was interrupted/u)
  })

  it('fails cleanly on debugger contention and reports DevTools detach as LOST', async () => {
    const chrome = fakeChrome()
    chrome.attached.add(7)
    const controller = new DebuggerController(chrome.debugger)
    await expect(controller.attach(7)).rejects.toBeInstanceOf(DebuggerAttachConflictError)
    expect(controller.state(7)).toBe('UNATTACHED')
    chrome.attached.delete(7)
    await controller.attach(7)
    expect(controller.onDetach({ tabId: 7 }, 'replaced_with_devtools')).toEqual({ tabId: 7, reason: 'replaced_with_devtools', devtoolsContention: true })
    expect(controller.state(7)).toBe('LOST')
  })

  it('best-effort detaches every tab while retaining failed debugger ownership for retry', async () => {
    const failures = new Set<number>([7])
    const chrome = fakeChrome({ detachFailures: failures })
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(7)
    await controller.attach(8)
    chrome.attached.delete(7)
    controller.onDetach({ tabId: 7 }, 'replaced')
    await controller.detachAll()
    expect(controller.state(7)).toBe('LOST')
    expect(controller.state(8)).toBe('UNATTACHED')
    expect(chrome.attached.has(8)).toBe(false)
    failures.clear()
    await controller.detach(7)
    expect(controller.state(7)).toBe('UNATTACHED')
  })

  it('rejects CDP events from unknown child sessions', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(5)
    expect(await controller.onEvent({ tabId: 5, sessionId: 'unknown' }, 'Runtime.consoleAPICalled', {})).toEqual({ accepted: false })
  })
})
