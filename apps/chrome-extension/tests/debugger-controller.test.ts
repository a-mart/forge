import { describe, expect, it } from 'vitest'
import { DebuggerController, OopifAncestryTracker } from '../src/runtime/debugger-controller.js'
import { fakeChrome } from './fakes.js'

describe('Chrome debugger ownership and flat OOPIF ancestry', () => {
  it('attaches only the leased root and enables recursive flattened sessions', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(21)
    expect(controller.state(21)).toBe('ATTACHED')
    expect(chrome.commands).toEqual([
      { target: { tabId: 21 }, method: 'Page.enable' },
      { target: { tabId: 21 }, method: 'Page.getFrameTree' },
      { target: { tabId: 21 }, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } },
    ])
    await controller.detach(21)
    expect(controller.state(21)).toBe('UNATTACHED')
  })

  it('tracks root -> OOPIF -> nested OOPIF ancestry and rejects orphan sessions', () => {
    const tracker = new OopifAncestryTracker()
    tracker.registerRoot('root', 'frame-root')
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

  it('fails cleanly on debugger contention and reports DevTools detach as LOST', async () => {
    const chrome = fakeChrome()
    chrome.attached.add(7)
    const controller = new DebuggerController(chrome.debugger)
    await expect(controller.attach(7)).rejects.toThrow('Another debugger')
    expect(controller.state(7)).toBe('UNATTACHED')
    chrome.attached.delete(7)
    await controller.attach(7)
    expect(controller.onDetach({ tabId: 7 }, 'replaced_with_devtools')).toEqual({ tabId: 7, reason: 'replaced_with_devtools', devtoolsContention: true })
    expect(controller.state(7)).toBe('LOST')
  })

  it('rejects CDP events from unknown child sessions', async () => {
    const chrome = fakeChrome()
    const controller = new DebuggerController(chrome.debugger)
    await controller.attach(5)
    expect(await controller.onEvent({ tabId: 5, sessionId: 'unknown' }, 'Runtime.consoleAPICalled', {})).toEqual({ accepted: false })
  })
})
