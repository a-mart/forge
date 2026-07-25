import { afterEach, describe, expect, it } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { DebuggerController } from '../src/runtime/debugger-controller.js'
import type { LeaseManager } from '../src/runtime/lease-manager.js'
import { fakeChrome } from './fakes.js'

const previousChrome = (globalThis as Record<string, unknown>).chrome

afterEach(() => {
  if (previousChrome === undefined) delete (globalThis as Record<string, unknown>).chrome
  else (globalThis as Record<string, unknown>).chrome = previousChrome
})

describe('leased-frame navigation observer recovery', () => {
  it('reinjects the trusted-input observer only into committed leased frames', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const leases = (runtime as unknown as { leases: LeaseManager }).leases
    await leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })

    runtime.onShellEvent('navigation.committed', [{ tabId: 10, frameId: 0 }])
    runtime.onShellEvent('navigation.committed', [{ tabId: 9, frameId: 7 }])
    await viFlush()

    expect(chrome.injections).toEqual([expect.objectContaining({
      target: { tabId: 9, frameIds: [7] },
      world: 'ISOLATED',
    })])
  })

  it.each(['success', 'failure', 'timeout'] as const)('CAS-returns navigation to human control after %s', async (exit) => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    if (exit === 'failure') {
      const original = chrome.debugger.sendCommand
      chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === 'Page.navigate') throw new Error('synthetic navigation failure')
        return original(target, method, params)
      }
    }
    const result = await internals.executeDesktopRequest(navigateParams(exit === 'timeout' ? 'load' : 'none', exit === 'timeout' ? 2 : 1_000))
    expect(result).toMatchObject({ ok: exit === 'success' })
    expect(internals.leases.current()).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: 0 })
  })

  it('does not overwrite a newer human interruption while cancelling navigation', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    let releaseNavigate!: () => void
    const original = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Page.navigate') await new Promise<void>((resolve) => { releaseNavigate = resolve })
      return original(target, method, params)
    }
    const navigating = internals.executeDesktopRequest(navigateParams('none', 1_000))
    while (internals.leases.current()?.state !== 'CONTROLLING_AGENT') await viFlush()
    await internals.leases.trustedHumanInput(9)
    releaseNavigate()
    await expect(navigating).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    expect(internals.leases.current()).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: 1 })
  })
})

function navigateParams(readiness: 'load' | 'none', timeoutMs: number): Record<string, unknown> {
  return {
    protocolVersion: 1, requestId: `request-${readiness}`, leaseId: 'lease-nav', leaseEpoch: 1,
    tabId: 9, operation: 'navigate', deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    input: { url: 'https://fixture.invalid/next', readiness, timeoutMs },
  }
}

async function viFlush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
