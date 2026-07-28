import { describe, expect, it } from 'vitest'
import { LeaseManager } from '../src/runtime/lease-manager.js'
import { FakeStorage, fakeChrome } from './fakes.js'

const tab = (id: number, active = false) => ({ id, windowId: 1, active, title: `Tab ${id}`, url: `https://tab-${id}.invalid/` })

describe('per-tab compare-and-set authority', () => {
  it('allows independent owners on different tabs and rejects a conflicting owner on the same tab', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true), tab(2)] })
    const manager = new LeaseManager(chrome, 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner-a', ownerEpoch: 1, sessionAgentId: 'session-a', expectedOwnerEpoch: 0 })
    await manager.acquire({ tabId: 2, ownerId: 'owner-b', ownerEpoch: 1, sessionAgentId: 'session-b', expectedOwnerEpoch: 0 })
    await expect(manager.acquire({ tabId: 1, ownerId: 'owner-b', ownerEpoch: 1, sessionAgentId: 'session-b', expectedOwnerEpoch: 0 }))
      .rejects.toMatchObject({ code: 'lease-conflict' })
    expect(manager.all().map(({ tabId, ownerId }) => ({ tabId, ownerId }))).toEqual([
      { tabId: 1, ownerId: 'owner-a' }, { tabId: 2, ownerId: 'owner-b' },
    ])
  })

  it('releases only the exact owner epoch and leaves concurrent tab authority intact', async () => {
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1), tab(2)] }), 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await manager.acquire({ tabId: 2, ownerId: 'other', ownerEpoch: 9, sessionAgentId: 'other-session', expectedOwnerEpoch: 0 })
    await expect(manager.release('owner', 3, 1)).rejects.toMatchObject({ code: 'lease-lost' })
    await manager.release('owner', 4, 1)
    expect(manager.all()).toEqual([expect.objectContaining({ tabId: 2, ownerId: 'other' })])
  })

  it('persists an opaque exact release receipt across payload and full browser restart', async () => {
    const session = new FakeStorage()
    const local = new FakeStorage()
    const tabs = [tab(1)]
    const first = new LeaseManager(fakeChrome({ tabs, session, local }), 'payload-a')
    await first.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await expect(first.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(first.all()).toEqual([])
    expect(JSON.stringify(local.values)).not.toMatch(/https:|Tab 1|session/u)

    // A full Chrome restart clears storage.session but preserves storage.local.
    const restarted = new LeaseManager(fakeChrome({ tabs, session: new FakeStorage(), local }), 'payload-b')
    await restarted.recover()
    expect(restarted.all()).toEqual([])
    expect(restarted.releaseScope('owner', 4)).toEqual([1])
    await expect(restarted.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(restarted.all()).toEqual([])
  })

  it('does not forget authority or acknowledge release when durable receipt storage fails', async () => {
    class FailingStorage extends FakeStorage {
      failNextSet = true
      override async set(items: Record<string, unknown>): Promise<void> {
        if (this.failNextSet) { this.failNextSet = false; throw new Error('durable write failed') }
        await super.set(items)
      }
    }
    const session = new FakeStorage()
    const local = new FailingStorage()
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1)], session, local }), 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })

    await expect(manager.releaseOwner('owner', 4)).rejects.toThrow('durable write failed')
    expect(manager.all()).toEqual([expect.objectContaining({ tabId: 1, ownerId: 'owner' })])
    expect(manager.releaseScope('owner', 4)).toEqual([1])
    await expect(manager.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(manager.all()).toEqual([])
  })

  it('writes the durable receipt before attempting to remove session authority', async () => {
    class FailingRemovalStorage extends FakeStorage {
      failNextRemove = false
      override async remove(keys: string | string[]): Promise<void> {
        if (this.failNextRemove) { this.failNextRemove = false; throw new Error('session removal failed') }
        await super.remove(keys)
      }
    }
    const session = new FailingRemovalStorage()
    const local = new FakeStorage()
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1)], session, local }), 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    session.failNextRemove = true

    await expect(manager.releaseOwner('owner', 4)).rejects.toThrow('session removal failed')
    expect(manager.all()).toEqual([expect.objectContaining({ tabId: 1, ownerId: 'owner' })])
    expect(local.values['forge.externalChrome.releaseReceipts.v2']).toMatchObject({
      schemaVersion: 1, receipts: [expect.objectContaining({ ownerId: 'owner', ownerEpoch: 4, tabIds: [1] })],
    })
    await expect(manager.releaseOwner('owner', 4)).resolves.toEqual([1])
  })

  it('expires durable receipts and never uses one as live authority for another owner', async () => {
    let now = 1_000
    const local = new FakeStorage()
    const chrome = fakeChrome({ tabs: [tab(1)], local })
    const manager = new LeaseManager(chrome, 'payload', () => now, 100)
    await manager.acquire({ tabId: 1, ownerId: 'old-owner', ownerEpoch: 1, sessionAgentId: 'old-session', expectedOwnerEpoch: 0 })
    await manager.releaseOwner('old-owner', 1)
    await manager.acquire({ tabId: 1, ownerId: 'new-owner', ownerEpoch: 2, sessionAgentId: 'new-session', expectedOwnerEpoch: 0 })
    expect(manager.activeReleaseScope('old-owner', 1)).toEqual([])
    expect(manager.releaseScope('old-owner', 1)).toEqual([1])
    expect(manager.assertScope('new-owner', 2, 1)).toMatchObject({ ownerId: 'new-owner' })

    now += 101
    expect(manager.releaseScope('old-owner', 1)).toEqual([])
    const restarted = new LeaseManager(fakeChrome({ tabs: [tab(1)], session: new FakeStorage(), local }), 'payload', () => now, 100)
    await restarted.recover()
    expect(restarted.releaseScope('old-owner', 1)).toEqual([])
  })

  it('bounds durable receipts and fails closed when an evicted receipt is retried', async () => {
    const tabs = Array.from({ length: 129 }, (_, index) => tab(index + 1))
    const manager = new LeaseManager(fakeChrome({ tabs }), 'payload')
    for (let index = 0; index < tabs.length; index += 1) {
      await manager.acquire({ tabId: index + 1, ownerId: `owner-${index}`, ownerEpoch: 1, sessionAgentId: `session-${index}`, expectedOwnerEpoch: 0 })
      await manager.releaseOwner(`owner-${index}`, 1)
    }
    expect(manager.releaseScope('owner-0', 1)).toEqual([])
    expect(manager.releaseScope('owner-1', 1)).toEqual([2])
    expect(manager.releaseScope('owner-128', 1)).toEqual([129])
  })

  it.each([
    { schemaVersion: 2, receipts: [] },
    { schemaVersion: 1, receipts: [{ ownerId: 'owner', ownerEpoch: 1, tabIds: [1], releasedAt: 1, expiresAt: 1, extra: true }] },
    { schemaVersion: 1, receipts: Array.from({ length: 129 }, (_, index) => ({ ownerId: `owner-${index}`, ownerEpoch: 1, tabIds: [index], releasedAt: 1, expiresAt: 2 })) },
    { schemaVersion: 1, receipts: [{ ownerId: 'x'.repeat(70_000), ownerEpoch: 1, tabIds: [1], releasedAt: 1, expiresAt: 2 }] },
  ])('fails recovery closed on malformed, unbounded, or unknown-version durable receipts', async (persisted) => {
    const local = new FakeStorage()
    local.values['forge.externalChrome.releaseReceipts.v2'] = persisted
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1)], local }), 'payload')
    await expect(manager.recover()).rejects.toThrow(/durable release receipts/u)
    await expect(manager.recover()).rejects.toThrow(/durable release receipts/u)
    expect(manager.all()).toEqual([])
  })

  it('interrupts active control immediately by advancing the tab-local control epoch', async () => {
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1)] }), 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 2, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const epoch = await manager.beginAgentControl('owner', 2, 1)
    expect(manager.isOperationCurrent('owner', 2, 1, epoch)).toBe(true)
    await manager.trustedHumanInput(1)
    expect(manager.isOperationCurrent('owner', 2, 1, epoch)).toBe(false)
  })

  it('recovers durable CAS records without assuming debugger control survived worker restart', async () => {
    const session = new FakeStorage()
    const chrome = fakeChrome({ tabs: [tab(1)], session })
    const first = new LeaseManager(chrome, 'payload')
    await first.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 2, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await first.beginAgentControl('owner', 2, 1)
    const restarted = new LeaseManager(chrome, 'payload')
    await restarted.recover()
    expect(restarted.forTab(1)).toMatchObject({ ownerId: 'owner', ownerEpoch: 2, state: 'human' })
    expect(chrome.attached.size).toBe(0)
  })

  it('recovers only exact Forge-created neutral authority and completes it after an eligible commit', async () => {
    const session = new FakeStorage()
    const tabs = [{ id: 1, windowId: 1, active: false, url: 'about:blank' }]
    const chrome = fakeChrome({ tabs, session })
    const first = new LeaseManager(chrome, 'payload')
    await first.acquire({
      tabId: 1, ownerId: 'owner', ownerEpoch: 2, sessionAgentId: 'session', expectedOwnerEpoch: 0, createdByForge: true,
    })

    await first.releaseOwner('owner', 2)
    const recovered = new LeaseManager(chrome, 'payload')
    await expect(recovered.recover()).resolves.toEqual([])
    await expect(recovered.acquire({
      tabId: 1, ownerId: 'next-owner', ownerEpoch: 3, sessionAgentId: 'session', expectedOwnerEpoch: 0,
    })).resolves.toMatchObject({ authority: { createdByForge: true, initialNavigationPending: true, state: 'human' } })
    await chrome.tabs.update(1, { url: 'https://fixture.invalid/ready' })
    await expect(recovered.completeInitialNavigation('next-owner', 3, 1)).resolves.toMatchObject({ initialNavigationPending: false })
  })

  it('reports and reuses only one focused eligible tab without exposing an inventory', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true), tab(2)], windows: [{ id: 1, focused: true, tabs: [tab(1, true), tab(2)] }] })
    const manager = new LeaseManager(chrome, 'payload')
    await expect(manager.focusedEligibleTab()).resolves.toMatchObject({ id: 1, active: true })
    await expect(manager.allocateAutomaticTab({ reuseFocused: true })).resolves.toMatchObject({
      tab: { id: 1, active: true }, createdByForge: false,
    })
  })

  it('allocates a neutral background tab when focused reuse is unavailable', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true)], windows: [{ id: 1, focused: false, tabs: [tab(1, true)] }] })
    const manager = new LeaseManager(chrome, 'payload')
    const allocated = await manager.allocateAutomaticTab({ reuseFocused: true })
    expect(allocated).toMatchObject({
      tab: { id: 2, active: false, url: 'about:blank' }, createdByForge: true,
    })
    await expect(manager.acquire({
      tabId: 2, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0, createdByForge: true,
    })).resolves.toMatchObject({ authority: { createdByForge: true, initialNavigationPending: true } })
  })

  it('blocks ordinary restricted tabs without exact Forge-created neutral authority', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 1, windowId: 1, active: true, url: 'about:blank' }] })
    const manager = new LeaseManager(chrome, 'payload')
    await expect(manager.acquire({
      tabId: 1, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0,
    })).rejects.toMatchObject({ code: 'restricted-target' })
    expect(manager.all()).toEqual([])
  })

  it('keeps a URL-bearing allocation neutral and inactive while Chrome exposes its created-tab URL', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true)], windows: [{ id: 1, focused: false, tabs: [tab(1, true)] }] })
    const create = chrome.tabs.create
    chrome.tabs.create = async (properties) => ({ ...await create(properties), url: undefined })
    const manager = new LeaseManager(chrome, 'payload')

    await expect(manager.allocateAutomaticTab({ reuseFocused: false, url: 'https://fixture.invalid/' })).resolves.toMatchObject({
      tab: { id: 2, active: false, url: 'about:blank' }, createdByForge: true,
    })
  })
})
