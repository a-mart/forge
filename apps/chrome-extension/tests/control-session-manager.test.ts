import { describe, expect, it, vi } from 'vitest'
import {
  ControlSessionManager,
  type ControlSessionScheduler,
  type PhysicalDebuggerDetachReason,
} from '../src/runtime/control-session-manager.js'
import { DebuggerController } from '../src/runtime/debugger-controller.js'
import { fakeChrome } from './fakes.js'

class ManualScheduler implements ControlSessionScheduler {
  private sequence = 0
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  constructor(readonly clock: { now: number }) {}
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence
    this.tasks.set(id, { at: this.clock.now + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number) }
  advanceTo(now: number): void {
    this.clock.now = now
    for (const [id, task] of [...this.tasks].sort((left, right) => left[1].at - right[1].at)) {
      if (task.at > now || !this.tasks.delete(id)) continue
      task.callback()
    }
  }
}

async function settle(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 500, interval: 1 })
}

describe('bounded reusable physical debugger control sessions', () => {
  it('reuses one exact attachment, resets its idle deadline, and records detach duration metrics', async () => {
    const clock = { now: 0 }
    const scheduler = new ManualScheduler(clock)
    const chrome = fakeChrome({ tabs: [{ id: 7, url: 'https://fixture.invalid/' }] })
    const controller = new DebuggerController(chrome.debugger)
    const manager = new ControlSessionManager(controller, {
      now: () => clock.now,
      scheduler,
      idleTimeoutMs: 20,
      maximumLifetimeMs: 100,
      onExpiry: async (tabId, reason) => { await manager.detach(tabId, reason) },
    })

    await expect(manager.ensure(7, 'lease', 1)).resolves.toBe('attached')
    manager.beginOperation(7, 'lease', 1)
    manager.finishOperation(7, 'lease', 1)
    scheduler.advanceTo(10)
    await expect(manager.ensure(7, 'lease', 1)).resolves.toBe('reused')
    manager.beginOperation(7, 'lease', 1)
    manager.finishOperation(7, 'lease', 1)

    scheduler.advanceTo(29)
    expect(chrome.attached).toEqual(new Set([7]))
    scheduler.advanceTo(30)
    await settle(() => {
      expect(chrome.attached).toEqual(new Set())
      expect(manager.forTab(7)).toBeNull()
    })
    expect(manager.metrics()).toMatchObject({
      attachAttempts: 1,
      attachments: 1,
      attachmentReuses: 1,
      detachments: 1,
      activeAttachments: 0,
      maximumObservedAttachments: 1,
      totalAttachedMs: 30,
      maximumAttachedMs: 30,
      detachReasons: { 'idle-timeout': 1 },
    })
  })

  it('enforces maximum physical lifetime even while an operation is active', async () => {
    const clock = { now: 0 }
    const scheduler = new ManualScheduler(clock)
    const chrome = fakeChrome({ tabs: [{ id: 7, url: 'https://fixture.invalid/' }] })
    const controller = new DebuggerController(chrome.debugger)
    const manager = new ControlSessionManager(controller, {
      now: () => clock.now,
      scheduler,
      idleTimeoutMs: 20,
      maximumLifetimeMs: 100,
      onExpiry: async (tabId, reason) => { await manager.detach(tabId, reason) },
    })
    await manager.ensure(7, 'lease', 1)
    manager.beginOperation(7, 'lease', 1)

    scheduler.advanceTo(100)
    await settle(() => expect(manager.forTab(7)).toBeNull())
    expect(manager.metrics()).toMatchObject({
      activeAttachments: 0,
      detachments: 1,
      detachReasons: { 'maximum-lifetime': 1 },
    })
  })

  it('does not adopt an attachment after terminal detach began during attach setup', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, url: 'https://fixture.invalid/' }] })
    const originalAttach = chrome.debugger.attach.bind(chrome.debugger)
    let continueAttach!: () => void
    const attachGate = new Promise<void>((resolve) => { continueAttach = resolve })
    chrome.debugger.attach = async (target, version) => {
      await attachGate
      await originalAttach(target, version)
    }
    const controller = new DebuggerController(chrome.debugger)
    const manager = new ControlSessionManager(controller, { onExpiry: () => undefined })

    const ensuring = manager.ensure(7, 'lease', 1)
    await vi.waitFor(() => expect(controller.state(7)).toBe('ATTACHING'))
    const detaching = manager.detach(7, 'transport-uncertain')
    continueAttach()

    await expect(ensuring).rejects.toThrow('released before the control session could adopt it')
    await expect(detaching).resolves.toBeUndefined()
    expect(manager.forTab(7)).toBeNull()
    expect(controller.state(7)).toBe('UNATTACHED')
    expect(chrome.attached).toEqual(new Set())
  })

  it('retains unacknowledged physical ownership for an exact detach retry', async () => {
    const failures = new Set([7])
    const chrome = fakeChrome({ tabs: [{ id: 7, url: 'https://fixture.invalid/' }], detachFailures: failures })
    const controller = new DebuggerController(chrome.debugger)
    const reasons: PhysicalDebuggerDetachReason[] = []
    const manager = new ControlSessionManager(controller, {
      onExpiry: (_tabId, reason) => { reasons.push(reason) },
    })
    await manager.ensure(7, 'lease', 1)

    await expect(manager.detach(7, 'runtime-shutdown')).rejects.toThrow('already detached')
    expect(manager.forTab(7)).toMatchObject({ debuggerState: 'ATTACHED' })
    expect(manager.metrics()).toMatchObject({ activeAttachments: 1, detachments: 0 })

    failures.delete(7)
    await expect(manager.detach(7, 'runtime-shutdown')).resolves.toBeUndefined()
    expect(manager.forTab(7)).toBeNull()
    expect(manager.metrics().detachReasons).toEqual({ 'runtime-shutdown': 1 })
    expect(reasons).toEqual([])
  })
})
