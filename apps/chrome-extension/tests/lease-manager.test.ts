import { describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_MAX_ARRAY_ITEMS, EXTERNAL_CHROME_MAX_CANDIDATE_TABS, EXTERNAL_CHROME_MAX_LABEL_LENGTH } from '@forge/protocol'
import { LeaseError, LeaseManager } from '../src/runtime/lease-manager.js'
import { candidateOrigin, restrictedTargetReason } from '../src/runtime/restricted-target.js'
import { FakeStorage, fakeChrome } from './fakes.js'

const normalTabs = [
  { id: 3, windowId: 1, groupId: 7, active: true, title: 'Synthetic app', url: 'https://fixture.invalid/path?secret=not-listed' },
  { id: 4, windowId: 1, groupId: 7, active: false, title: 'Second tab', url: 'https://other.invalid/' },
]

describe('candidate picker and one-session leases', () => {
  it('enumerates only bounded origin metadata and deterministic groups', async () => {
    const chrome = fakeChrome({
      tabs: structuredClone(normalTabs),
      groups: [{ id: 7, windowId: 1, title: 'Forge · fixture', collapsed: false }],
    })
    const manager = new LeaseManager(chrome, 'm1-spike.1', () => 100)
    const windows = await manager.listCandidates()
    expect(windows).toEqual([{
      windowId: 1,
      focused: true,
      groups: [{ groupId: 7, title: 'Forge · fixture', collapsed: false }],
      tabs: [
        { windowId: 1, tabId: 3, groupId: 7, title: 'Synthetic app', origin: 'https://fixture.invalid', active: true, attached: false, restricted: false },
        { windowId: 1, tabId: 4, groupId: 7, title: 'Second tab', origin: 'https://other.invalid', active: false, attached: false, restricted: false },
      ],
    }])
    expect(JSON.stringify(windows)).not.toContain('/path')
    expect(JSON.stringify(windows)).not.toContain('secret')
  })

  it('bounds and deterministically truncates windows, groups, tabs, and labels before transport', async () => {
    const windows = Array.from({ length: EXTERNAL_CHROME_MAX_ARRAY_ITEMS + 10 }, (_, index) => ({
      id: EXTERNAL_CHROME_MAX_ARRAY_ITEMS + 10 - index,
      focused: false,
      tabs: [{ id: 10_000 + index, windowId: EXTERNAL_CHROME_MAX_ARRAY_ITEMS + 10 - index, title: 'x'.repeat(EXTERNAL_CHROME_MAX_LABEL_LENGTH + 10), url: 'https://fixture.invalid/' }],
    }))
    const groups = windows.map((window, index) => ({ id: 20_000 + index, windowId: window.id, title: 'g'.repeat(EXTERNAL_CHROME_MAX_LABEL_LENGTH + 10), collapsed: false }))
    const manager = new LeaseManager(fakeChrome({ windows, groups }), 'm1-spike.1')
    const candidates = await manager.listCandidates()
    expect(candidates).toHaveLength(EXTERNAL_CHROME_MAX_ARRAY_ITEMS)
    expect(candidates.map((window) => window.windowId)).toEqual([...candidates.map((window) => window.windowId)].sort((a, b) => a - b))
    expect(candidates.reduce((total, window) => total + window.tabs.length, 0)).toBe(EXTERNAL_CHROME_MAX_CANDIDATE_TABS)
    expect(candidates.reduce((total, window) => total + window.groups.length, 0)).toBe(EXTERNAL_CHROME_MAX_ARRAY_ITEMS)
    expect(candidates[0]?.tabs[0]?.title).toHaveLength(EXTERNAL_CHROME_MAX_LABEL_LENGTH)
    expect(candidates[0]?.groups[0]?.title).toHaveLength(EXTERNAL_CHROME_MAX_LABEL_LENGTH)
  })

  it('enforces compare-and-set lease/group scope and releases without closing tabs', async () => {
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs), groups: [{ id: 7, windowId: 1, collapsed: false }] })
    const manager = new LeaseManager(chrome, 'm1-spike.1', () => 100)
    const claimed = await manager.claim({ leaseId: 'lease-a', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [4, 3], groupId: 7, childPolicy: 'manual' })
    expect(claimed.lease.tabIds).toEqual([3, 4])
    await expect(manager.claim({ leaseId: 'lease-b', leaseEpoch: 1, sessionAgentId: 'session-b', tabIds: [3], childPolicy: 'manual' })).rejects.toMatchObject({ code: 'lease-conflict' })
    expect(await manager.release('lease-a', 1)).toEqual([3, 4])
    expect(await chrome.tabs.get(3)).toMatchObject({ title: 'Synthetic app' })
  })

  it('treats same lease ID/epoch as idempotent only for every immutable claim field and exact membership', async () => {
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs) })
    const manager = new LeaseManager(chrome, 'm1-spike.1', () => 100)
    const original = { leaseId: 'lease-a', leaseEpoch: 3, sessionAgentId: 'session-a', tabIds: [4, 3], groupId: 7, childPolicy: 'manual' as const }
    const first = await manager.claim(original)
    expect((await manager.claim({ ...original, tabIds: [3, 4] })).lease).toEqual(first.lease)
    const mismatches = [
      { ...original, sessionAgentId: 'session-b' },
      { ...original, tabIds: [3] },
      { ...original, groupId: undefined },
      { ...original, childPolicy: 'include-opened-by-leased-tabs' as const },
    ]
    for (const mismatch of mismatches) {
      await expect(manager.claim(mismatch)).rejects.toMatchObject({ code: 'lease-conflict' })
      expect(manager.current()).toEqual(first.lease)
    }
    await expect(manager.claim({ ...original, tabIds: [3, 3] })).rejects.toMatchObject({ code: 'scope-mismatch' })
    expect(manager.current()).toEqual(first.lease)
  })

  it('creates a Forge-named group and leases only its new tab', async () => {
    const chrome = fakeChrome({ tabs: [], groups: [] })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    const created = await manager.create({
      leaseId: 'lease-created', leaseEpoch: 1, sessionAgentId: 'session-created',
      url: 'https://fixture.invalid/', groupTitle: 'Forge · synthetic session',
    })
    expect(created.tab).toMatchObject({ id: 1, groupId: 1, url: 'https://fixture.invalid/' })
    expect(created.lease).toMatchObject({ tabIds: [1], groupId: 1, childPolicy: 'manual' })
    expect((await chrome.tabGroups.query({}))[0]).toMatchObject({ title: 'Forge · synthetic session', collapsed: false })
  })

  it('rejects restricted and group-mismatched tabs on re-read', async () => {
    const chrome = fakeChrome({ tabs: [
      { id: 1, windowId: 1, groupId: -1, url: 'chrome://settings/' },
      { id: 2, windowId: 1, groupId: 9, url: 'devtools://devtools/bundled/inspector.html' },
      { id: 3, windowId: 1, groupId: 8, url: 'https://fixture.invalid/' },
    ] })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    await expect(manager.claim({ leaseId: 'a', leaseEpoch: 1, sessionAgentId: 's', tabIds: [1], childPolicy: 'manual' })).rejects.toMatchObject({ code: 'restricted-target' })
    await expect(manager.claim({ leaseId: 'a', leaseEpoch: 1, sessionAgentId: 's', tabIds: [2], childPolicy: 'manual' })).rejects.toMatchObject({ code: 'restricted-target' })
    await expect(manager.claim({ leaseId: 'a', leaseEpoch: 1, sessionAgentId: 's', tabIds: [3], groupId: 9, childPolicy: 'manual' })).rejects.toMatchObject({ code: 'scope-mismatch' })
  })

  it('recovers a worker suspension only for exact live payload/tab/epoch state', async () => {
    const session = new FakeStorage()
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs), session })
    const first = new LeaseManager(chrome, 'm1-spike.1', () => 1_000, 5_000)
    await first.claim({ leaseId: 'lease-a', leaseEpoch: 3, sessionAgentId: 'session-a', tabIds: [3], childPolicy: 'manual' })
    const resumed = new LeaseManager(chrome, 'm1-spike.1', () => 2_000, 5_000)
    expect(await resumed.recover()).toMatchObject({ leaseId: 'lease-a', leaseEpoch: 3, tabIds: [3] })
    const skewed = new LeaseManager(chrome, 'm1-spike.2', () => 2_000, 5_000)
    expect(await skewed.recover()).toBeNull()
  })

  it('interrupts only active synthetic work on trusted human input', async () => {
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs) })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    await manager.claim({ leaseId: 'lease-a', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [3], childPolicy: 'manual' })
    const operationEpoch = await manager.beginAgentControl('lease-a', 1, 3)
    expect(manager.isOperationCurrent('lease-a', 1, operationEpoch)).toBe(true)
    const interrupted = await manager.trustedHumanInput(3)
    expect(interrupted).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: operationEpoch + 1 })
    expect(manager.isOperationCurrent('lease-a', 1, operationEpoch)).toBe(false)
    expect(await manager.trustedHumanInput(999)).toBeNull()
  })
})

describe('restricted target classification', () => {
  it.each(['chrome://extensions', 'chrome-extension://abc/page.html', 'devtools://devtools/', 'about:blank'])('restricts %s', (url) => {
    expect(restrictedTargetReason(url)).not.toBeNull()
  })
  it('keeps candidate URLs origin-only', () => {
    expect(candidateOrigin('https://fixture.invalid/private?token=x')).toBe('https://fixture.invalid')
  })
  it('uses typed lease failures', () => {
    expect(new LeaseError('lease-lost', 'lost')).toMatchObject({ code: 'lease-lost', name: 'LeaseError' })
  })
})
