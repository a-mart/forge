/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RemoteUpdateAwarenessIncomingInspection,
  RemoteUpdateAwarenessProjectSnapshot,
} from '@forge/protocol'
import { RemoteUpdateAwarenessBanner, RemoteUpdateAwarenessIncoming } from './RemoteUpdateAwarenessIncoming'
import { createRemoteUpdateAwarenessMutationTarget } from './remote-update-awareness-mutation'

const api = vi.hoisted(() => ({
  dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(),
  fetchRemoteUpdateAwarenessIncoming: vi.fn(),
  refreshRemoteUpdateAwarenessProject: vi.fn(),
}))
vi.mock('@/components/settings/remote-update-awareness-api', () => api)

let root: Root | null = null
let container: HTMLDivElement
const snapshot = {
  projectId: 'project-1',
  override: 'inherit' as const,
  globalEnabled: true,
  effectiveEnabled: true,
  state: 'update_available' as const,
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: true,
  dismissalTarget: { generation: 7 },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function incoming(generation: number, subject: string): RemoteUpdateAwarenessIncomingInspection {
  return {
    projectId: 'project-1',
    remoteDisplayName: 'origin',
    defaultBranchDisplay: 'main',
    observedTipOid: null,
    generation,
    observedAt: null,
    freshnessCheckedAt: null,
    staleAfter: null,
    state: 'update_available',
    failureCode: null,
    attentionRequired: false,
    commits: {
      commitCount: 1,
      commitLimit: 20,
      hasMore: false,
      commits: [{ subject, committedAt: null }],
    },
    fileChanges: null,
  }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.clearAllMocks()
})

function render(element: ReturnType<typeof createElement>) {
  container ??= document.createElement('div')
  if (!container.isConnected) document.body.appendChild(container)
  root ??= createRoot(container)
  act(() => root?.render(element))
}

describe('remote update Incoming', () => {
  it('uses a visible, explained Dismiss action for only the exact generation', async () => {
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockResolvedValue({
      snapshot: { ...snapshot, attentionRequired: false },
    })
    const changed = vi.fn()
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot,
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))

    const dismiss = getByRole(container, 'button', { name: 'Dismiss' })
    expect(dismiss.textContent).toBe('Dismiss')
    expect(dismiss.getAttribute('title')).toBe(
      'Hide this notification until the remote default branch advances again.',
    )
    fireEvent.click(dismiss)

    await waitFor(() => expect(api.dismissRemoteUpdateAwarenessProjectUpdate).toHaveBeenCalledWith(
      'ws://localhost:47188',
      'project-1',
      7,
    ))
    expect(changed).toHaveBeenCalledWith(
      { ...snapshot, attentionRequired: false },
      createRemoteUpdateAwarenessMutationTarget(snapshot, 1),
    )
  })

  it('keeps dismissed Incoming truth inspectable without claiming an integration action', async () => {
    api.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: incoming(7, 'Remote change') })
    render(createElement(RemoteUpdateAwarenessIncoming, {
      wsUrl: 'ws://localhost:47188',
      projectId: 'project-1',
      generation: 7,
    }))

    await waitFor(() => expect(container.textContent).toContain('Remote change'))
    expect(container.textContent).toContain('Inspection only')
    expect(container.textContent).not.toContain('Fast-forward')
  })

  it('clears stale evidence and refetches when the same project generation changes', async () => {
    let resolveNext!: (value: { incoming: RemoteUpdateAwarenessIncomingInspection }) => void
    api.fetchRemoteUpdateAwarenessIncoming
      .mockResolvedValueOnce({ incoming: incoming(7, 'Old generation') })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNext = resolve
      }))

    render(createElement(RemoteUpdateAwarenessIncoming, {
      wsUrl: 'ws://localhost:47188',
      projectId: 'project-1',
      generation: 7,
    }))
    await waitFor(() => expect(container.textContent).toContain('Old generation'))

    render(createElement(RemoteUpdateAwarenessIncoming, {
      wsUrl: 'ws://localhost:47188',
      projectId: 'project-1',
      generation: 8,
    }))
    await waitFor(() => expect(container.textContent).toContain('Loading incoming changes'))
    expect(container.textContent).not.toContain('Old generation')
    expect(api.fetchRemoteUpdateAwarenessIncoming).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveNext({ incoming: incoming(8, 'New generation') })
    })
    expect(container.textContent).toContain('New generation')
  })

  it('handles refresh and stale-dismissal failures with inline retry guidance', async () => {
    api.refreshRemoteUpdateAwarenessProject.mockRejectedValueOnce(new Error('offline'))
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockRejectedValueOnce(
      new Error('The remote update dismissal target is stale'),
    )
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot,
      onInspect: vi.fn(),
      onSnapshotChange: vi.fn(),
    }))

    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('Could not check'))
    expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(false)

    fireEvent.click(getByRole(container, 'button', { name: 'Dismiss' }))
    await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('Check now, then retry'))
    expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false)
  })

  it('ignores a delayed project response after the projected project changes', async () => {
    const response = deferred<{ snapshot: typeof snapshot }>()
    api.refreshRemoteUpdateAwarenessProject.mockReturnValue(response.promise)
    const changed = vi.fn()
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot,
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))

    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot: { ...snapshot, projectId: 'project-2', dismissalTarget: { generation: 3 } },
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))
    await act(async () => response.resolve({ snapshot }))

    expect(changed).not.toHaveBeenCalled()
    expect(queryByRole(container, 'alert')).toBeNull()
  })

  it('clears pending mutation state across A to B to A so the original target can retry', async () => {
    const obsoleteResponse = deferred<{ snapshot: typeof snapshot }>()
    const retryResponse = deferred<{ snapshot: typeof snapshot }>()
    api.refreshRemoteUpdateAwarenessProject
      .mockReturnValueOnce(obsoleteResponse.promise)
      .mockReturnValueOnce(retryResponse.promise)
    const changed = vi.fn()
    const renderBanner = (projectSnapshot: typeof snapshot) => render(createElement(
      RemoteUpdateAwarenessBanner,
      {
        wsUrl: 'ws://localhost:47188',
        snapshot: projectSnapshot,
        onInspect: vi.fn(),
        onSnapshotChange: changed,
      },
    ))

    renderBanner(snapshot)
    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(true)
    })

    renderBanner({ ...snapshot, projectId: 'project-2' })
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(false)
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false)
    })
    await act(async () => obsoleteResponse.resolve({ snapshot }))
    expect(changed).not.toHaveBeenCalled()

    renderBanner(snapshot)
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(false)
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    expect(api.refreshRemoteUpdateAwarenessProject).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(true)
    })

    await act(async () => retryResponse.resolve({ snapshot }))
  })

  it('ignores an obsolete null-generation refresh after a newer WS projection arrives', async () => {
    const staleSnapshot: RemoteUpdateAwarenessProjectSnapshot = {
      ...snapshot,
      dismissalTarget: null,
      state: 'stale',
      lastObservedAt: '2026-07-21T10:00:00.000Z',
      attentionRequired: false,
    }
    const newerErrorSnapshot: RemoteUpdateAwarenessProjectSnapshot = {
      ...staleSnapshot,
      state: 'error',
      lastObservedAt: '2026-07-21T10:01:00.000Z',
      failureCode: 'transport',
    }
    const obsoleteResponse = deferred<{ snapshot: RemoteUpdateAwarenessProjectSnapshot }>()
    api.refreshRemoteUpdateAwarenessProject.mockReturnValue(obsoleteResponse.promise)
    const changed = vi.fn()

    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot: staleSnapshot,
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))
    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))

    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot: newerErrorSnapshot,
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))
    await act(async () => obsoleteResponse.resolve({ snapshot: staleSnapshot }))

    expect(changed).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Remote check could not complete.')
    expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(false)
  })

  it('ignores a delayed generation-7 dismissal after generation 8 is projected', async () => {
    const response = deferred<{ snapshot: typeof snapshot }>()
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockReturnValue(response.promise)
    const changed = vi.fn()
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot,
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))

    fireEvent.click(getByRole(container, 'button', { name: 'Dismiss' }))
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot: { ...snapshot, dismissalTarget: { generation: 8 } },
      onInspect: vi.fn(),
      onSnapshotChange: changed,
    }))
    await act(async () => response.resolve({
      snapshot: { ...snapshot, attentionRequired: false },
    }))

    expect(changed).not.toHaveBeenCalled()
    expect(queryByRole(container, 'alert')).toBeNull()
  })

  it('mutually excludes refresh and dismissal while either request is running', async () => {
    const refreshResponse = deferred<{ snapshot: typeof snapshot }>()
    const dismissResponse = deferred<{ snapshot: typeof snapshot }>()
    api.refreshRemoteUpdateAwarenessProject.mockReturnValue(refreshResponse.promise)
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockReturnValue(dismissResponse.promise)
    render(createElement(RemoteUpdateAwarenessBanner, {
      wsUrl: 'ws://localhost:47188',
      snapshot,
      onInspect: vi.fn(),
      onSnapshotChange: vi.fn(),
    }))

    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true)
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(true)
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Dismiss' }))
    expect(api.dismissRemoteUpdateAwarenessProjectUpdate).not.toHaveBeenCalled()
    await act(async () => refreshResponse.resolve({ snapshot }))

    fireEvent.click(getByRole(container, 'button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true)
      expect(getByRole(container, 'button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(true)
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    expect(api.refreshRemoteUpdateAwarenessProject).toHaveBeenCalledTimes(1)
    await act(async () => dismissResponse.resolve({
      snapshot: { ...snapshot, attentionRequired: false },
    }))
  })

  it('clears an Incoming failure while retrying a new generation', async () => {
    api.fetchRemoteUpdateAwarenessIncoming
      .mockRejectedValueOnce(new Error('Evidence failed'))
      .mockResolvedValueOnce({ incoming: incoming(8, 'Recovered evidence') })

    render(createElement(RemoteUpdateAwarenessIncoming, {
      wsUrl: 'ws://localhost:47188',
      projectId: 'project-1',
      generation: 7,
    }))
    await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('Evidence failed'))

    render(createElement(RemoteUpdateAwarenessIncoming, {
      wsUrl: 'ws://localhost:47188',
      projectId: 'project-1',
      generation: 8,
    }))
    await waitFor(() => expect(container.textContent).toContain('Recovered evidence'))
    expect(queryByRole(container, 'alert')).toBeNull()
  })
})
