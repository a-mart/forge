import { describe, expect, it } from 'vitest'
import { LeaseManager } from '../src/runtime/lease-manager.js'
import { FakeStorage, fakeChrome } from './fakes.js'

const tab = (id: number, active = false) => ({ id, windowId: 1, groupId: -1, active, title: `Tab ${id}`, url: `https://tab-${id}.invalid/` })

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

  it('reports and reuses only one focused eligible tab without exposing an inventory', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true), tab(2)], windows: [{ id: 1, focused: true, tabs: [tab(1, true), tab(2)] }] })
    const manager = new LeaseManager(chrome, 'payload')
    await expect(manager.focusedEligibleTab()).resolves.toMatchObject({ id: 1, active: true })
    await expect(manager.allocateAutomaticTab({ reuseFocused: true })).resolves.toMatchObject({
      tab: { id: 1, active: true }, createdByForge: false,
    })
  })

  it('allocates a dedicated ungrouped tab when focused reuse is requested but unavailable', async () => {
    const chrome = fakeChrome({ tabs: [tab(1, true)], windows: [{ id: 1, focused: false, tabs: [tab(1, true)] }] })
    const manager = new LeaseManager(chrome, 'payload')
    await expect(manager.allocateAutomaticTab({ reuseFocused: true })).resolves.toMatchObject({
      tab: { id: 2, groupId: -1, active: true, url: 'https://forge.invalid/' }, createdByForge: true,
    })
  })
})
