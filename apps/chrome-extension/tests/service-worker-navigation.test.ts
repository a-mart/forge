import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import { fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('service-worker navigation orchestration', () => {
  it('acquires before Runtime navigation, injects only after attach, and always detaches', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 7, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    const response = await execute(navigateRequest({ readiness: 'none' })) as Record<string, unknown>
    expect(response).toMatchObject({ ok: true, operation: 'navigate', result: { readiness: 'none' } })
    expect(chrome.injections).toHaveLength(1)
    expect(chrome.commands.map(({ method }) => method)).toContain('Page.navigate')
    expect(chrome.attached).toEqual(new Set())
    expect((runtime as unknown as { authorities: { forTab(id: number): { state: string } | null } }).authorities.forTab(7)).toMatchObject({ state: 'human' })
  })

  it('rejects an expired request without attaching, injecting, or replaying navigation', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 9, ownerId: 'owner', ownerEpoch: 3, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    await expect(execute(navigateRequest({ tabId: 9, leaseEpoch: 3, requestId: 'expired', deadlineAt: new Date(Date.now() - 1).toISOString() }))).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(chrome.injections).toEqual([])
    expect(chrome.commands).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })
})

function navigateRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: 'request-navigate',
    leaseId: 'owner',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'navigate',
    input: { url: 'https://fixture.invalid/next', readiness: 'none', timeoutMs: 1_000 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    ...overrides,
  }
}
