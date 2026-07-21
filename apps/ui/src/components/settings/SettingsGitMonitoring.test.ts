/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsGitMonitoring } from './SettingsGitMonitoring'

const api = vi.hoisted(() => ({
  fetchRemoteUpdateAwarenessSettings: vi.fn(),
  updateRemoteUpdateAwarenessSettings: vi.fn(),
  updateRemoteUpdateAwarenessProjectOverride: vi.fn(),
}))
vi.mock('./remote-update-awareness-api', () => api)

let root: Root | null = null
let container: HTMLDivElement
const settings = {
  settings: { globalEnabled: false, updatedAt: null },
  projects: [{ projectId: 'project-1', override: 'inherit' as const, effectiveEnabled: false }],
}

afterEach(() => { act(() => root?.unmount()); root = null; container?.remove(); vi.clearAllMocks() })

describe('SettingsGitMonitoring', () => {
  it('uses a safe global default and exposes only eligible projects with inherit/on/off controls', async () => {
    api.fetchRemoteUpdateAwarenessSettings.mockResolvedValue(settings)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(SettingsGitMonitoring, { wsUrl: 'ws://localhost:47188', profiles: [{ profileId: 'project-1', displayName: 'Local project' }] as never })) })

    await waitFor(() => expect(container.textContent).toContain('Local project'))
    expect(container.textContent).toContain('Archived and non-Git projects are excluded.')
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('data-state')).toBe('unchecked')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.updateRemoteUpdateAwarenessSettings).toHaveBeenCalledWith('ws://localhost:47188', true))
  })
})
