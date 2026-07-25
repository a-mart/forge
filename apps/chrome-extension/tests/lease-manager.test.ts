import { describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_MAX_ARRAY_ITEMS, EXTERNAL_CHROME_MAX_CANDIDATE_TABS, EXTERNAL_CHROME_MAX_LABEL_LENGTH } from '@forge/protocol'
import { DebuggerController } from '../src/runtime/debugger-controller.js'
import { LeaseError, LeaseManager } from '../src/runtime/lease-manager.js'
import { externalChromeNavigationUrl, releaseLeaseDebuggerAuthority } from '../src/payload/service-worker/index.js'
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
        { windowId: 1, tabId: 3, groupId: 7, title: 'Synthetic app', origin: 'https://fixture.invalid', active: true, attached: false, restricted: false, debuggerConflict: false },
        { windowId: 1, tabId: 4, groupId: 7, title: 'Second tab', origin: 'https://other.invalid', active: false, attached: false, restricted: false, debuggerConflict: false },
      ],
    }])
    expect(JSON.stringify(windows)).not.toContain('/path')
    expect(JSON.stringify(windows)).not.toContain('secret')
  })

  it('distinguishes exact restricted-scheme and foreign-debugger conflicts for picker badges', async () => {
    const chrome = fakeChrome({
      tabs: [
        { id: 1, windowId: 1, url: 'chrome://settings/' },
        { id: 2, windowId: 1, url: 'https://conflict.invalid/' },
      ],
      debuggerTargets: [{ tabId: 2, attached: true, extensionId: 'some-other-debugger' }],
    })
    const tabs = (await new LeaseManager(chrome, 'm1-spike.1').listCandidates())[0]!.tabs
    expect(tabs).toEqual([
      expect.objectContaining({ tabId: 1, restricted: true, debuggerConflict: false }),
      expect.objectContaining({ tabId: 2, restricted: false, debuggerConflict: true }),
    ])
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

  it('serializes parallel conflicting claims as one compare-and-set winner', async () => {
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs) })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    const [first, second] = await Promise.allSettled([
      manager.claim({ leaseId: 'lease-a', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [3], childPolicy: 'manual' }),
      manager.claim({ leaseId: 'lease-b', leaseEpoch: 1, sessionAgentId: 'session-b', tabIds: [4], childPolicy: 'manual' }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(manager.current()?.leaseId).toBe(first.status === 'fulfilled' ? 'lease-a' : 'lease-b')
  })

  it('does not let a child mutation resurrect a lease released while Chrome work is pending', async () => {
    const chrome = fakeChrome({ tabs: [...structuredClone(normalTabs), { id: 5, windowId: 1, groupId: -1, openerTabId: 3, url: 'https://child.invalid/' }] })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    await manager.claim({ leaseId: 'children', leaseEpoch: 1, sessionAgentId: 'session', tabIds: [3], groupId: 7, childPolicy: 'include-opened-by-leased-tabs' })
    let continueGet!: () => void
    const originalGet = chrome.tabs.get
    chrome.tabs.get = async (tabId) => { if (tabId === 5) await new Promise<void>((resolve) => { continueGet = resolve }); return originalGet(tabId) }
    const include = manager.includeChild(5, 3)
    await Promise.resolve()
    const release = manager.release('children', 1)
    continueGet()
    await expect(include).resolves.toMatchObject({ tabIds: [3, 5] })
    await expect(release).resolves.toEqual([3, 5])
    expect(manager.current()).toBeNull()
  })

  it('keeps child tabs manual by default and includes only proven opener children when opted in', async () => {
    const tabs = [
      ...structuredClone(normalTabs),
      { id: 5, windowId: 1, groupId: -1, openerTabId: 3, url: 'https://child.invalid/' },
      { id: 6, windowId: 1, groupId: -1, openerTabId: 999, url: 'https://unrelated.invalid/' },
    ]
    const chrome = fakeChrome({ tabs, groups: [{ id: 7, windowId: 1, collapsed: false }] })
    const manual = new LeaseManager(chrome, 'm1-spike.1')
    await manual.claim({ leaseId: 'manual', leaseEpoch: 1, sessionAgentId: 'session', tabIds: [3], groupId: 7, childPolicy: 'manual' })
    expect(await manual.includeChild(5, 3)).toBeNull()
    await manual.release('manual', 1)

    const optedIn = new LeaseManager(chrome, 'm1-spike.1')
    await optedIn.claim({ leaseId: 'children', leaseEpoch: 2, sessionAgentId: 'session', tabIds: [3], groupId: 7, childPolicy: 'include-opened-by-leased-tabs' })
    expect(await optedIn.includeChild(5, 3)).toMatchObject({ tabIds: [3, 5], groupId: 7 })
    expect(await optedIn.includeChild(6, 3)).toBeNull()
    expect(await chrome.tabs.get(5)).toMatchObject({ groupId: 7 })
  })

  it('creates a Forge-owned child in the matching lease without a conflicting root claim', async () => {
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs), groups: [{ id: 7, windowId: 1, title: 'Forge · existing', collapsed: false }] })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    await manager.claim({ leaseId: 'lease-existing', leaseEpoch: 4, sessionAgentId: 'session', tabIds: [3], groupId: 7, childPolicy: 'manual' })
    const created = await manager.create({ leaseId: 'lease-existing', leaseEpoch: 4, sessionAgentId: 'session', url: 'https://child.invalid/', groupTitle: 'ignored' })
    expect(created.lease).toMatchObject({ leaseId: 'lease-existing', leaseEpoch: 4, groupId: 7, tabIds: [3, 5] })
    expect(created.tab).toMatchObject({ id: 5, groupId: 7 })
  })

  it('removes a created tab and group when a root claim cannot complete', async () => {
    const chrome = fakeChrome({ tabs: [], groups: [] })
    chrome.storage.session.set = async () => { throw new Error('persistence failed') }
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    await expect(manager.create({ leaseId: 'lease-created', leaseEpoch: 1, sessionAgentId: 'session', url: 'https://fixture.invalid/', groupTitle: 'Forge · fixture' })).rejects.toThrow('persistence failed')
    expect(await chrome.tabs.query({})).toEqual([])
    expect(await chrome.tabGroups.query({})).toEqual([])
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

  it('atomically expires authority without closing user tabs', async () => {
    let now = 100
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs) })
    const manager = new LeaseManager(chrome, 'm1-spike.1', () => now, 5_000)
    await manager.claim({ leaseId: 'lease-expiring', leaseEpoch: 1, sessionAgentId: 'session', tabIds: [3], childPolicy: 'manual' })
    expect(await manager.expireIfNeeded()).toBeNull()
    now = 5_101
    expect(await manager.expireIfNeeded()).toMatchObject({ leaseId: 'lease-expiring', tabIds: [3], state: 'LOST' })
    expect(manager.current()).toMatchObject({ leaseId: 'lease-expiring', state: 'LOST' })
    expect(await manager.completeRelease('lease-expiring', 1)).toEqual([3])
    expect(manager.current()).toBeNull()
    expect(await chrome.tabs.get(3)).toMatchObject({ title: 'Synthetic app' })
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

  it('CAS-finalizes agent control without overwriting a newer human interruption', async () => {
    const manager = new LeaseManager(fakeChrome({ tabs: structuredClone(normalTabs) }), 'm1-spike.1')
    await manager.claim({ leaseId: 'lease-a', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [3], childPolicy: 'manual' })
    const epoch = await manager.beginAgentControl('lease-a', 1, 3)
    await expect(manager.finishAgentControl('lease-a', 1, epoch)).resolves.toBe(true)
    expect(manager.current()).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: epoch })
    const interruptedEpoch = await manager.beginAgentControl('lease-a', 1, 3)
    await manager.trustedHumanInput(3)
    await expect(manager.finishAgentControl('lease-a', 1, interruptedEpoch)).resolves.toBe(false)
    expect(manager.current()).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: interruptedEpoch + 1 })
  })

  it('retains multi-tab release authority after a partial detach failure and retries all tabs', async () => {
    const failures = new Set([4])
    const chrome = fakeChrome({ tabs: structuredClone(normalTabs), detachFailures: failures })
    const manager = new LeaseManager(chrome, 'm1-spike.1')
    const debuggers = new DebuggerController(chrome.debugger)
    await manager.claim({ leaseId: 'lease-release', leaseEpoch: 2, sessionAgentId: 'session-a', tabIds: [3, 4], childPolicy: 'manual' })
    await debuggers.attach(3)
    await debuggers.attach(4)
    await expect(releaseLeaseDebuggerAuthority(manager, debuggers, 'lease-release', 2)).rejects.toThrow('already detached')
    expect(manager.current()).toMatchObject({ leaseId: 'lease-release', state: 'LOST', tabIds: [3, 4] })
    expect(debuggers.state(3)).toBe('UNATTACHED')
    expect(debuggers.state(4)).toBe('ATTACHED')
    await expect(manager.claim({ leaseId: 'new', leaseEpoch: 3, sessionAgentId: 'session-b', tabIds: [3], childPolicy: 'manual' }))
      .rejects.toMatchObject({ code: 'lease-lost' })

    // MV3 suspension/restart recovers the retry tombstone and positively adopts
    // only the debugger attachment still owned by this extension.
    const recoveredManager = new LeaseManager(chrome, 'm1-spike.1')
    await expect(recoveredManager.recover()).resolves.toMatchObject({ leaseId: 'lease-release', state: 'LOST', tabIds: [3, 4] })
    const recoveredDebuggers = new DebuggerController(chrome.debugger)
    await recoveredDebuggers.reconcileForRelease(3, chrome.runtime.id)
    await recoveredDebuggers.reconcileForRelease(4, chrome.runtime.id)
    expect(recoveredDebuggers.state(3)).toBe('UNATTACHED')
    expect(recoveredDebuggers.state(4)).toBe('ATTACHED')
    failures.clear()
    await expect(releaseLeaseDebuggerAuthority(recoveredManager, recoveredDebuggers, 'lease-release', 2)).resolves.toEqual([3, 4])
    expect(recoveredManager.current()).toBeNull()
    expect(recoveredDebuggers.state(4)).toBe('UNATTACHED')
  })
})

describe('External Chrome navigation target construction', () => {
  it('rejects restricted schemes before CDP and constructs loopback environment URLs', () => {
    expect(externalChromeNavigationUrl({ url: 'chrome://settings/' })).toBeNull()
    expect(externalChromeNavigationUrl({ url: 'javascript:alert(1)' })).toBeNull()
    expect(externalChromeNavigationUrl({ environmentPort: 4173, environmentProtocol: 'https', path: '/ready?q=1' }))
      .toBe('https://127.0.0.1:4173/ready?q=1')
    expect(externalChromeNavigationUrl({ environmentPort: 4173 })).toBe('http://127.0.0.1:4173/')
    for (const path of ['@evil.test/', '//evil.test/', '/\\evil.test/', '/%2f%2fevil.test/', '/%5cevil.test/', '/%40evil.test/']) {
      expect(externalChromeNavigationUrl({ environmentPort: 4173, path })).toBeNull()
    }
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
