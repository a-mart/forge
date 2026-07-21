/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteUpdateAwarenessBanner, RemoteUpdateAwarenessIncoming } from './RemoteUpdateAwarenessIncoming'

const api = vi.hoisted(() => ({
  dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(), fetchRemoteUpdateAwarenessIncoming: vi.fn(), refreshRemoteUpdateAwarenessProject: vi.fn(),
}))
vi.mock('@/components/settings/remote-update-awareness-api', () => api)
let root: Root | null = null
let container: HTMLDivElement
const snapshot = { projectId: 'project-1', override: 'inherit' as const, globalEnabled: true, effectiveEnabled: true, state: 'update_available' as const, lastObservedAt: null, failureCode: null, attentionRequired: true, dismissalTarget: { generation: 7 } }
afterEach(() => { act(() => root?.unmount()); root = null; container?.remove(); vi.clearAllMocks() })

function render(element: ReturnType<typeof createElement>) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); act(() => root?.render(element)) }

describe('remote update Incoming', () => {
  it('dismisses only the exact projected generation while retaining Incoming inspection', async () => {
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockResolvedValue({ snapshot: { ...snapshot, attentionRequired: false } })
    const changed = vi.fn()
    render(createElement(RemoteUpdateAwarenessBanner, { wsUrl: 'ws://localhost:47188', snapshot, onInspect: vi.fn(), onSnapshotChange: changed }))
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Dismiss this exact remote tip')!)
    await waitFor(() => expect(api.dismissRemoteUpdateAwarenessProjectUpdate).toHaveBeenCalledWith('ws://localhost:47188', 'project-1', 7))
    expect(changed).toHaveBeenCalledWith({ ...snapshot, attentionRequired: false })
  })

  it('renders bounded inspection evidence after dismissal without claiming an integration action', async () => {
    api.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: { projectId: 'project-1', remoteDisplayName: 'origin', defaultBranchDisplay: 'main', observedTipOid: null, generation: 7, observedAt: null, freshnessCheckedAt: null, staleAfter: null, state: 'update_available', failureCode: null, attentionRequired: false, commits: { commitCount: 1, commitLimit: 20, hasMore: false, commits: [{ subject: 'Remote change', committedAt: null }] }, fileChanges: null } })
    render(createElement(RemoteUpdateAwarenessIncoming, { wsUrl: 'ws://localhost:47188', projectId: 'project-1' }))
    await waitFor(() => expect(container.textContent).toContain('Remote change'))
    expect(container.textContent).toContain('Inspection only')
    expect(container.textContent).not.toContain('Fast-forward')
  })
})
