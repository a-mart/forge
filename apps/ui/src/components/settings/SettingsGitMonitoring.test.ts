/** @vitest-environment jsdom */

import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { Children, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SettingsGitMonitoring } from './SettingsGitMonitoring'

const api = vi.hoisted(() => ({
  fetchRemoteUpdateAwarenessSettings: vi.fn(),
  updateRemoteUpdateAwarenessSettings: vi.fn(),
  updateRemoteUpdateAwarenessProjectOverride: vi.fn(),
}))
vi.mock('./remote-update-awareness-api', () => api)
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, disabled, onValueChange, children }: { value: string; disabled?: boolean; onValueChange: (value: string) => void; children: ReactNode }) => {
    const parts = Children.toArray(children) as Array<{ props?: { children?: ReactNode; 'aria-label'?: string } }>
    const trigger = parts[0]?.props ?? {}
    const content = parts[1]?.props?.children
    return createElement('select', {
      'aria-label': trigger['aria-label'], value, disabled,
      onChange: (event: Event) => onValueChange((event.target as HTMLSelectElement).value),
    }, content)
  },
  SelectTrigger: ({ children, ...props }: { children?: ReactNode; 'aria-label'?: string }) => createElement('span', props, children),
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => createElement('option', { value }, children),
}))

let root: Root | null = null
let container: HTMLDivElement
const settings = {
  settings: { globalEnabled: false, updatedAt: null },
  projects: [{ projectId: 'project-1', override: 'inherit' as const, effectiveEnabled: false }],
}

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => { act(() => root?.unmount()); root = null; container?.remove(); vi.clearAllMocks() })

describe('SettingsGitMonitoring', () => {
  it('routes each project override and renders the returned project snapshot', async () => {
    api.fetchRemoteUpdateAwarenessSettings.mockResolvedValue(settings)
    api.updateRemoteUpdateAwarenessProjectOverride.mockImplementation(async (_wsUrl: string, projectId: string, override: string) => ({
      project: { projectId, override, effectiveEnabled: override === 'on' },
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(SettingsGitMonitoring, { wsUrl: 'ws://localhost:47188', profiles: [{ profileId: 'project-1', displayName: 'Local project' }] as never })) })
    await waitFor(() => expect(container.textContent).toContain('Local project'))

    const select = () => container.querySelector('[aria-label="Git monitoring for Local project"]') as HTMLButtonElement
    const chooseProjectOverride = async (override: string) => {
      await act(async () => { fireEvent.change(select(), { target: { value: override } }) })
    }
    for (const override of ['on', 'off', 'inherit'] as const) {
      await chooseProjectOverride(override)
      await waitFor(() => expect(api.updateRemoteUpdateAwarenessProjectOverride).toHaveBeenLastCalledWith('ws://localhost:47188', 'project-1', override))
      expect(select().textContent?.toLowerCase()).toContain(override)
    }
  })

  it('surfaces a project override rejection and disables controls during the write', async () => {
    api.fetchRemoteUpdateAwarenessSettings.mockResolvedValue(settings)
    let rejectUpdate!: (error: Error) => void
    api.updateRemoteUpdateAwarenessProjectOverride.mockReturnValue(new Promise((_resolve, reject) => { rejectUpdate = reject }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(SettingsGitMonitoring, { wsUrl: 'ws://localhost:47188', profiles: [{ profileId: 'project-1', displayName: 'Local project' }] as never })) })
    await waitFor(() => expect(container.textContent).toContain('Local project'))

    const select = container.querySelector('[aria-label="Git monitoring for Local project"]') as HTMLSelectElement
    await act(async () => { fireEvent.change(select, { target: { value: 'on' } }) })
    expect(select.disabled).toBe(true)
    await act(async () => rejectUpdate(new Error('project unavailable')))
    await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('project unavailable'))
    expect(select.disabled).toBe(false)
  })

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
