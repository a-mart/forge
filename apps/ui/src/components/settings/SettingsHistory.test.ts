/** @vitest-environment jsdom */
import { fireEvent, getByRole } from '@testing-library/dom'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryIndexStatus } from '@forge/protocol'
import { SettingsHistory } from './SettingsHistory'

const api = vi.hoisted(() => ({ fetchHistoryIndex: vi.fn(), setHistoryIndexPaused: vi.fn() }))
vi.mock('./history-index-api', () => api)
const snapshot: HistoryIndexStatus = {
  paused: false, activity: 'idle', catalogHydration: 'complete', eligibleSources: 1, schemaVersion: '4',
  statistics: { discoveredSources: 1, pendingSources: 0, runnableSources: 0, unreadableSources: 0, omittedSources: 0,
    transcriptBytes: 2048, processedBytes: 2048, lastUpdatedAt: null },
  storage: { databaseBytes: 1024, walBytes: 0 }, observedAt: '2026-09-07T00:00:00Z', error: null,
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  api.fetchHistoryIndex.mockResolvedValue(snapshot)
  api.setHistoryIndexPaused.mockImplementation(async (_wsUrl: string, paused: boolean) => ({ ...snapshot, paused, activity: paused ? 'paused' : 'idle' }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })
async function render(url = 'ws://localhost:47188') {
  await act(async () => { root.render(createElement(StrictMode, null, createElement(SettingsHistory, { wsUrl: url }))) })
}

describe('SettingsHistory', () => {
  it('shows byte metrics, persists pause/resume, and keeps cached-history copy', async () => {
    await render()
    expect(container.textContent).toContain('1 KiB')
    expect(container.textContent).toContain('2 KiB')
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Pause indexing' })) })
    expect(api.setHistoryIndexPaused).toHaveBeenLastCalledWith('ws://localhost:47188', true)
    expect(container.textContent).toContain('cached search results remain available')
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Resume indexing' })) })
    expect(api.setHistoryIndexPaused).toHaveBeenLastCalledWith('ws://localhost:47188', false)
  })
  it('polls once per interval even in StrictMode, stops when hidden/unmounted', async () => {
    await render()
    const initial = api.fetchHistoryIndex.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.fetchHistoryIndex).toHaveBeenCalledTimes(initial + 1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(api.fetchHistoryIndex).toHaveBeenCalledTimes(initial + 1)
    act(() => root.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(api.fetchHistoryIndex).toHaveBeenCalledTimes(initial + 1)
  })
  it('disables controls while saving and preserves confirmed state on failure', async () => {
    await render()
    let reject!: (error: Error) => void
    api.setHistoryIndexPaused.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Pause indexing' })) })
    expect((getByRole(container, 'button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { reject(new Error('Unable to save')) })
    expect(getByRole(container, 'alert').textContent).toContain('Unable to save')
    expect(getByRole(container, 'button', { name: 'Pause indexing' })).toBeTruthy()
  })
  it('ignores stale reads after a mutation and responses from an old origin', async () => {
    await render()
    let resolveRead!: (value: HistoryIndexStatus) => void
    api.fetchHistoryIndex.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve }))
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Refresh' })) })
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Pause indexing' })) })
    await act(async () => { resolveRead(snapshot) })
    expect(getByRole(container, 'button', { name: 'Resume indexing' })).toBeTruthy()
    let resolveWrite!: (value: HistoryIndexStatus) => void
    api.setHistoryIndexPaused.mockReturnValueOnce(new Promise((resolve) => { resolveWrite = resolve }))
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Resume indexing' })) })
    await render('ws://localhost:9999')
    await act(async () => { resolveWrite({ ...snapshot, paused: true, activity: 'paused' }) })
    expect(getByRole(container, 'button', { name: 'Pause indexing' })).toBeTruthy()
    expect(api.fetchHistoryIndex).toHaveBeenLastCalledWith('ws://localhost:9999', expect.any(AbortSignal))
  })
  it('shows unavailable and degraded diagnostics without claiming complete coverage', async () => {
    api.fetchHistoryIndex.mockResolvedValue({ ...snapshot, statistics: { ...snapshot.statistics, unreadableSources: 1 } })
    await render()
    expect(container.textContent).toContain('Idle · limited coverage')
    api.fetchHistoryIndex.mockRejectedValue(new Error('Not supported'))
    await act(async () => { fireEvent.click(getByRole(container, 'button', { name: 'Refresh' })) })
    expect(getByRole(container, 'alert').textContent).toContain('out of date')
  })
})
