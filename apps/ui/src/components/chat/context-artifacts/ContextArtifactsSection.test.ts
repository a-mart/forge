/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextArtifacts } from '@forge/protocol'
import { ContextArtifactsSection } from './ContextArtifactsSection'

let root: Root
let container: HTMLDivElement
const fetchMock = vi.fn()
function snapshot(text = '# Current task\nComplete the inspector.', revision = 1): SessionContextArtifacts {
  return { revision, contextMode: { sessionAgentId: 'manager', profileId: 'project', projectDefault: 'fresh',
    effectiveMode: 'fresh', appliedMode: 'fresh', freshSupported: true }, files: [{
    path: 'checkpoint.md', kind: 'checkpoint', text, revision, bytes: text.length,
    digest: 'a'.repeat(64), updatedAt: '2026-09-08T12:00:00Z',
  }] }
}
function respond(value: SessionContextArtifacts) { return { ok: true, json: async () => value } }
async function mount(managerId = 'manager', wsUrl = 'ws://localhost:47187') {
  await act(async () => { root.render(createElement(ContextArtifactsSection, { key: `${wsUrl}:${managerId}`, wsUrl, managerId })) })
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(label) || node.getAttribute('aria-label') === label)
  expect(button, label).toBeTruthy()
  await act(async () => { button!.click() })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchMock.mockReset().mockResolvedValue(respond(snapshot()))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() }); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
})
describe('Context v2 artifact reader', () => {
  it('loads canonical files, shows complete source and keeps the reader selected through refresh', async () => {
    const text = '# Current task\n' + 'full content '.repeat(1800) + '<script>not executable</script>'
    fetchMock.mockResolvedValueOnce(respond(snapshot(text)))
    await mount()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:47187/api/agents/manager/context-artifacts')
    expect(container.textContent).toContain('Using Context v2')
    await click('checkpoint.md'); await click('Show source')
    expect(document.querySelector('[aria-label="Context file contents"] pre')?.textContent).toBe(text)
    expect(document.querySelector('[role="dialog"] script')).toBeNull()
    fetchMock.mockResolvedValue(respond(snapshot('updated content', 2)))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Revision 2')
    expect(document.querySelector('pre')?.textContent).toBe('updated content')
  })
  it('labels stale contents after failure and reflects cleared notes on retry', async () => {
    await mount(); await click('checkpoint.md')
    fetchMock.mockRejectedValueOnce(new Error('Offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('last loaded version')
    fetchMock.mockResolvedValue(respond({ ...snapshot(), files: [] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('no longer present')
    expect(document.querySelector('[aria-label="Context file contents"]')).toBeNull()
  })
  it('does not leak the previous session or accept a response for a different manager', async () => {
    await mount(); await click('checkpoint.md')
    fetchMock.mockResolvedValue(respond(snapshot()))
    await mount('other', 'ws://remote.test:47187')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).not.toContain('checkpoint.md')
    expect(container.textContent).toContain('Invalid context files response')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://remote.test:47187/api/agents/other/context-artifacts')
  })
  it('returns keyboard focus to the file button when the reader closes', async () => {
    await mount()
    const fileButton = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('checkpoint.md'))
    await click('checkpoint.md')
    await click('Close')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(document.activeElement).toBe(fileButton)
  })

  it('aborts pending reads and stops refreshing when unmounted', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    await mount()
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    await act(async () => { root.render(null) })
    expect(signal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('distinguishes saved Context v2 preference from the applied Summary mode', async () => {
    const value = snapshot(); value.contextMode.appliedMode = 'summary'
    fetchMock.mockResolvedValue(respond(value))
    await mount()
    expect(container.textContent).toContain('Using Summary')
    expect(container.textContent).toContain('Context v2 saved')
  })
})
