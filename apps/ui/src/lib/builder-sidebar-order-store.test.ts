import type {
  BuilderSidebarOrderRef,
  BuilderSidebarOrderState,
  UpdateBuilderSidebarOrderRequest,
} from '@forge/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  BuilderSidebarOrderApiConflictError,
  type BuilderSidebarOrderApi,
} from './builder-sidebar-order-api'
import { BuilderSidebarOrderStore } from './builder-sidebar-order-store'

const ref = (originId: string, profileId: string): BuilderSidebarOrderRef => ({ originId, profileId })
const state = (
  revision: number,
  order: BuilderSidebarOrderRef[],
): BuilderSidebarOrderState => ({
  version: 1,
  revision,
  order,
  updatedAt: revision === 0 ? null : `2026-07-09T12:00:${String(revision).padStart(2, '0')}.000Z`,
})

function fakeApi(initial: BuilderSidebarOrderState): BuilderSidebarOrderApi & {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
} {
  let current = initial
  return {
    get: vi.fn(async () => current),
    put: vi.fn(async (request: UpdateBuilderSidebarOrderRequest) => {
      current = state(current.revision + 1, request.order)
      return current
    }),
  }
}

describe('BuilderSidebarOrderStore', () => {
  it('persists discovery reconciliation without deleting offline anchors', async () => {
    const api = fakeApi(state(4, [
      ref('remote-offline', 'anchor'),
      ref('local', 'alpha'),
    ]))
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    await store.ensureDiscovered([
      ref('local', 'alpha'),
      ref('local', 'beta'),
    ])

    expect(api.put).toHaveBeenCalledWith({
      baseRevision: 4,
      order: [
        ref('remote-offline', 'anchor'),
        ref('local', 'alpha'),
        ref('local', 'beta'),
      ],
    })
    expect(store.getSnapshot()?.revision).toBe(5)
  })

  it('refetches past an in-flight stale GET when a higher invalidation arrives', async () => {
    let resolveFirst: ((value: BuilderSidebarOrderState) => void) | undefined
    const old = state(1, [ref('local', 'old')])
    const current = state(2, [ref('remote', 'new')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn()
        .mockImplementationOnce(() => new Promise<BuilderSidebarOrderState>((resolve) => {
          resolveFirst = resolve
        }))
        .mockResolvedValueOnce(current),
      put: vi.fn(),
    }
    const store = new BuilderSidebarOrderStore(api)

    const initialLoad = store.refresh()
    const invalidationLoad = store.refresh(2)
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
    resolveFirst?.(old)
    await Promise.all([initialLoad, invalidationLoad])

    expect(api.get).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual(current)
  })

  it('uses 409 current authority and replays a cross-origin move exactly once without a GET', async () => {
    const initial = state(1, [
      ref('local', 'alpha'),
      ref('remote', 'same'),
      ref('local', 'beta'),
    ])
    const conflicted = state(2, [
      ref('local', 'alpha'),
      ref('local', 'beta'),
      ref('remote', 'same'),
      ref('offline', 'anchor'),
    ])
    const committed = state(3, [
      ref('remote', 'same'),
      ref('local', 'alpha'),
      ref('local', 'beta'),
      ref('offline', 'anchor'),
    ])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => initial),
      put: vi.fn()
        .mockRejectedValueOnce(new BuilderSidebarOrderApiConflictError(conflicted))
        .mockResolvedValueOnce(committed),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    await store.move(
      ref('remote', 'same'),
      ref('local', 'alpha'),
      [ref('local', 'alpha'), ref('local', 'beta'), ref('remote', 'same')],
    )

    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(api.put).toHaveBeenNthCalledWith(2, {
      baseRevision: 2,
      order: committed.order,
    })
    expect(store.getSnapshot()).toEqual(committed)
  })

  it('rolls back from 409 current when a fallback GET and the replay PUT would fail', async () => {
    const initial = state(1, [ref('local', 'alpha'), ref('remote', 'beta')])
    const current = state(2, [ref('remote', 'beta')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockRejectedValueOnce(new Error('offline GET must not replace conflict authority')),
      put: vi.fn()
        .mockRejectedValueOnce(new BuilderSidebarOrderApiConflictError(current))
        .mockRejectedValueOnce(new Error('replay write failed')),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    await expect(store.move(
      ref('local', 'alpha'),
      ref('remote', 'beta'),
      [ref('local', 'alpha'), ref('remote', 'beta')],
    )).rejects.toThrow('replay write failed')

    expect(api.get).toHaveBeenCalledOnce()
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual(current)
  })

  it('cancels conflict replay when concurrent discovery no longer contains a dragged endpoint', async () => {
    const initial = state(1, [ref('local', 'alpha'), ref('remote', 'beta')])
    const current = state(2, [ref('remote', 'beta')])
    let rejectPut: ((error: unknown) => void) | undefined
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => initial),
      put: vi.fn(() => new Promise<BuilderSidebarOrderState>((_resolve, reject) => {
        rejectPut = reject
      })),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    const move = store.move(
      ref('local', 'alpha'),
      ref('remote', 'beta'),
      [ref('local', 'alpha'), ref('remote', 'beta')],
    )
    await vi.waitFor(() => expect(rejectPut).toBeTypeOf('function'))
    await store.ensureDiscovered([ref('remote', 'beta')])
    rejectPut?.(new BuilderSidebarOrderApiConflictError(current))
    await move

    expect(api.put).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toEqual(current)
  })

  it('exposes second-409 authority rather than leaving the second optimistic replay visible', async () => {
    const initial = state(1, [ref('local', 'alpha'), ref('remote', 'beta')])
    const firstCurrent = state(2, [ref('remote', 'beta'), ref('local', 'alpha')])
    const secondCurrent = state(3, [ref('local', 'gamma'), ref('remote', 'beta'), ref('local', 'alpha')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => initial),
      put: vi.fn()
        .mockRejectedValueOnce(new BuilderSidebarOrderApiConflictError(firstCurrent))
        .mockRejectedValueOnce(new BuilderSidebarOrderApiConflictError(secondCurrent)),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    await expect(store.move(
      ref('local', 'alpha'),
      ref('remote', 'beta'),
      [ref('local', 'alpha'), ref('remote', 'beta')],
    )).rejects.toBeInstanceOf(BuilderSidebarOrderApiConflictError)

    expect(api.get).toHaveBeenCalledOnce()
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual(secondCurrent)
  })

  it('quiesces an identical failed automatic reconciliation until authority or discovery changes', async () => {
    const initial = state(1, [ref('local', 'alpha')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => initial),
      put: vi.fn(async () => { throw new Error('persistent disk failure') }),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()
    const discovered = [ref('local', 'alpha'), ref('local', 'beta')]

    await expect(store.ensureDiscovered(discovered)).rejects.toThrow('persistent disk failure')
    await expect(store.ensureDiscovered(discovered)).resolves.toBeUndefined()

    expect(api.put).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toEqual(initial)
  })

  it('retries one quiesced automatic write after a successful reconnect/focus refresh', async () => {
    let current = state(1, [ref('local', 'alpha')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn()
        .mockRejectedValueOnce(new Error('temporarily offline'))
        .mockImplementationOnce(async (request: UpdateBuilderSidebarOrderRequest) => {
          current = state(2, request.order)
          return current
        }),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()
    const discovered = [ref('local', 'alpha'), ref('local', 'beta')]

    await expect(store.ensureDiscovered(discovered)).rejects.toThrow('temporarily offline')
    await store.refresh()

    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual(current)
  })

  it('converges asymmetric client discovery with one additive write and no prune/re-add ping-pong', async () => {
    let current = state(1, [ref('local', 'alpha')])
    const sharedPut = vi.fn(async (request: UpdateBuilderSidebarOrderRequest) => {
      current = state(current.revision + 1, request.order)
      return current
    })
    const createClientApi = (): BuilderSidebarOrderApi => ({
      get: vi.fn(async () => current),
      put: sharedPut,
    })
    const electron = new BuilderSidebarOrderStore(createClientApi())
    const browser = new BuilderSidebarOrderStore(createClientApi())
    await Promise.all([electron.load(), browser.load()])

    const electronDiscovery = [
      ref('local', 'alpha'),
      ref('electron-only-remote', 'project'),
    ]
    const browserDiscovery = [ref('local', 'alpha')]
    await electron.ensureDiscovered(electronDiscovery)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await browser.refresh(current.revision)
      await browser.ensureDiscovered(browserDiscovery)
      await electron.refresh(current.revision)
      await electron.ensureDiscovered(electronDiscovery)
    }

    expect(sharedPut).toHaveBeenCalledOnce()
    expect(current.revision).toBe(2)
    expect(current.order).toEqual(electronDiscovery)
    expect(browser.getSnapshot()?.order).toEqual(electronDiscovery)
    expect(electron.getSnapshot()?.order).toEqual(electronDiscovery)
  })

  it('accepts a lower revision only on an explicit reconnect authority reset', async () => {
    let current = state(5, [ref('remote', 'before-restart')])
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(),
    }
    const store = new BuilderSidebarOrderStore(api)
    await store.load()

    current = state(0, [])
    await store.refresh()
    expect(store.getSnapshot()?.revision).toBe(5)

    await store.refresh(0, { resetAuthority: true })
    expect(store.getSnapshot()).toEqual(current)
  })

  it('accepts newer HTTP authority and ignores a stale response', async () => {
    const api = fakeApi(state(1, [ref('local', 'alpha')]))
    const store = new BuilderSidebarOrderStore(api)
    await store.load()
    const listener = vi.fn()
    store.subscribe(listener)

    store.acceptServerState(state(3, [ref('remote', 'beta'), ref('local', 'alpha')]))
    store.acceptServerState(state(2, [ref('local', 'alpha')]))

    expect(store.getSnapshot()?.revision).toBe(3)
    expect(store.getSnapshot()?.order[0]).toEqual(ref('remote', 'beta'))
    expect(listener).toHaveBeenCalledOnce()
  })
})
