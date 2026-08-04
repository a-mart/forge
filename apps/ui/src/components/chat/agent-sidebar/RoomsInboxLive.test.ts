/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { originRegistry } from '@/lib/origin-store'
import { RoomsInboxLive } from './RoomsInboxLive'
import { ROOMS_INBOX_ACK_STORAGE_KEY } from './rooms-inbox-ack'
import type { RoomsInboxOriginInput } from './rooms-inbox-selectors'

let root: Root | null = null
let container: HTMLDivElement

function Harness({ initialUnreadCount = 2 }: { initialUnreadCount?: number }) {
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount)
  const origins: RoomsInboxOriginInput[] = [{
    originId: 'local',
    connected: true,
    inventoryReady: true,
    sessions: [{
      identity: { originId: 'local', profileId: 'project-a', sessionAgentId: 'session-a' },
      label: 'Session A',
      profileName: 'Project A',
      agentStatus: 'idle',
      activeWorkerCount: 0,
      pendingChoiceCount: 0,
      unreadCount,
      contextRecoveryInProgress: false,
      updatedAt: '2026-08-03T11:00:00.000Z',
      createdAt: '2026-08-01T12:00:00.000Z',
    }],
    projects: [],
  }]

  return createElement(RoomsInboxLive, {
    mode: 'inbox',
    onModeChange: () => {},
    searchQuery: '',
    hideCliSessions: false,
    onSelectLocal: () => setUnreadCount(0),
    onNewProject: () => {},
    fallbackOrigins: origins,
  })
}

beforeEach(() => {
  originRegistry.destroyAll()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root?.unmount())
  root = null
  container.remove()
  originRegistry.destroyAll()
  localStorage.clear()
})

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('RoomsInboxLive acknowledgements', () => {
  it('keeps a Done unread session out of Needs You and Recent across rerender and reload', async () => {
    flushSync(() => root?.render(createElement(Harness)))
    await flushEffects()

    const row = container.querySelector('[data-inbox-row="local::session-a"]') as HTMLButtonElement
    expect(row).toBeTruthy()
    fireEvent.click(row)
    await flushEffects()

    expect(container.querySelector('[data-inbox-row="local::session-a"]')).not.toBeNull()
    fireEvent.click(getByRole(container, 'button', { name: 'Mark "Session A" done for Project A on local (session-a)' }))
    await flushEffects()
    const key = 'local::session-a'
    expect(container.querySelector('[data-inbox-row="local::session-a"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries[key]).toMatchObject({
      ackedAt: expect.any(Number),
      clearedAt: expect.any(Number),
    })

    // Simulate a normal rerender after the unread count has been cleared.
    flushSync(() => root?.render(createElement(Harness, { initialUnreadCount: 0 })))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::session-a"]')).toBeNull()
    expect(container.querySelector('[data-testid="rooms-inbox-empty"]')).not.toBeNull()

    // Reload with the same now-resolved server state: the persisted tombstone
    // must still keep the session out of both Needs You and Recent.
    flushSync(() => root?.unmount())
    root = createRoot(container)
    flushSync(() => root?.render(createElement(Harness, { initialUnreadCount: 0 })))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::session-a"]')).toBeNull()
    expect(container.querySelector('[data-testid="rooms-inbox-empty"]')).not.toBeNull()
  })

  it('does not clear a live dismissal while CLI visibility or search filters change', async () => {
    function FilterHarness() {
      const [hideCliSessions, setHideCliSessions] = useState(false)
      const [searchQuery, setSearchQuery] = useState('')
      const origins: RoomsInboxOriginInput[] = [{
        originId: 'local',
        connected: true,
        inventoryReady: true,
        sessions: [{
          identity: { originId: 'local', profileId: 'project-a', sessionAgentId: 'cli-choice' },
          label: 'CLI Choice',
          profileName: 'Project A',
          agentStatus: 'idle',
          activeWorkerCount: 0,
          pendingChoiceCount: 1,
          unreadCount: 0,
          contextRecoveryInProgress: false,
          updatedAt: '2026-08-03T11:00:00.000Z',
          createdAt: '2026-08-01T12:00:00.000Z',
          cli: true,
        }],
        projects: [],
      }]
      return createElement('div', null,
        createElement('button', { type: 'button', onClick: () => setHideCliSessions((hidden) => !hidden) }, 'toggle CLI visibility'),
        createElement('button', { type: 'button', onClick: () => setSearchQuery((query) => query ? '' : 'no match') }, 'toggle search filter'),
        createElement(RoomsInboxLive, {
          mode: 'inbox',
          onModeChange: () => {},
          searchQuery,
          hideCliSessions,
          onSelectLocal: () => {},
          onNewProject: () => {},
          fallbackOrigins: origins,
        }),
      )
    }

    flushSync(() => root?.render(createElement(FilterHarness)))
    await flushEffects()
    fireEvent.click(getByRole(container, 'button', { name: 'Mark "CLI Choice" done for Project A on local (cli-choice)' }))
    await flushEffects()

    fireEvent.click(getByRole(container, 'button', { name: 'toggle CLI visibility' }))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::cli-choice"]')).toBeNull()

    fireEvent.click(getByRole(container, 'button', { name: 'toggle CLI visibility' }))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::cli-choice"]')).toBeNull()

    fireEvent.click(getByRole(container, 'button', { name: 'toggle search filter' }))
    await flushEffects()
    fireEvent.click(getByRole(container, 'button', { name: 'toggle search filter' }))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::cli-choice"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries['local::cli-choice'])
      .toMatchObject({ ackedAt: expect.any(Number) })
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries['local::cli-choice'].clearedAt)
      .toBeUndefined()
  })

  it('does not clear or re-raise a dismissal across a disconnected origin', async () => {
    const key = 'remote::remote-choice'
    localStorage.setItem(ROOMS_INBOX_ACK_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: {
        [key]: {
          reason: 'awaiting_choice',
          signature: 'choice:1',
          raisedAt: Date.parse('2026-08-03T11:30:00.000Z'),
          ackedAt: Date.parse('2026-08-03T11:31:00.000Z'),
        },
      },
    }))

    function ReconnectHarness() {
      const [connected, setConnected] = useState(false)
      const origins: RoomsInboxOriginInput[] = [{
        originId: 'remote',
        connected,
        // Model a previously-ready cache that remains populated while offline.
        inventoryReady: true,
        sessions: [{
          identity: { originId: 'remote', profileId: 'project-a', sessionAgentId: 'remote-choice' },
          label: 'Remote Choice',
          profileName: 'Project A',
          agentStatus: 'idle',
          activeWorkerCount: 0,
          pendingChoiceCount: 1,
          unreadCount: 0,
          contextRecoveryInProgress: false,
          updatedAt: '2026-08-03T11:00:00.000Z',
          createdAt: '2026-08-01T12:00:00.000Z',
        }],
        projects: [],
      }]
      return createElement('div', null,
        createElement('button', { type: 'button', onClick: () => setConnected(true) }, 'reconnect'),
        createElement(RoomsInboxLive, {
          mode: 'inbox',
          onModeChange: () => {},
          searchQuery: '',
          hideCliSessions: false,
          onSelectLocal: () => {},
          onNewProject: () => {},
          fallbackOrigins: origins,
        }),
      )
    }

    flushSync(() => root?.render(createElement(ReconnectHarness)))
    await flushEffects()
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries[key])
      .toMatchObject({ ackedAt: expect.any(Number) })
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries[key].clearedAt)
      .toBeUndefined()

    fireEvent.click(getByRole(container, 'button', { name: 'reconnect' }))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="remote::remote-choice"]')).toBeNull()
  })

  it('keeps a pre-seeded dismissal through an unready empty bootstrap and hydrated same signal', async () => {
    const key = 'local::session-a'
    localStorage.setItem(ROOMS_INBOX_ACK_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: {
        [key]: {
          reason: 'unread_result',
          signature: 'unread:2:2026-08-03T11:00:00.000Z',
          raisedAt: Date.parse('2026-08-03T11:30:00.000Z'),
          ackedAt: Date.parse('2026-08-03T11:31:00.000Z'),
        },
      },
    }))

    function ColdBootstrapHarness() {
      const [hydrated, setHydrated] = useState(false)
      const origins: RoomsInboxOriginInput[] = [{
        originId: 'local',
        connected: true,
        inventoryReady: hydrated,
        sessions: hydrated ? [{
          identity: { originId: 'local', profileId: 'project-a', sessionAgentId: 'session-a' },
          label: 'Session A',
          profileName: 'Project A',
          agentStatus: 'idle',
          activeWorkerCount: 0,
          pendingChoiceCount: 0,
          unreadCount: 2,
          contextRecoveryInProgress: false,
          updatedAt: '2026-08-03T11:00:00.000Z',
          createdAt: '2026-08-01T12:00:00.000Z',
        }] : [],
        projects: [],
      }]
      return createElement('div', null,
        createElement('button', { type: 'button', onClick: () => setHydrated(true) }, 'hydrate'),
        createElement(RoomsInboxLive, {
          mode: 'inbox',
          onModeChange: () => {},
          searchQuery: '',
          hideCliSessions: false,
          onSelectLocal: () => {},
          onNewProject: () => {},
          fallbackOrigins: origins,
        }),
      )
    }

    flushSync(() => root?.render(createElement(ColdBootstrapHarness)))
    await flushEffects()
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries[key].ackedAt).toBeDefined()

    fireEvent.click(getByRole(container, 'button', { name: 'hydrate' }))
    await flushEffects()
    expect(container.querySelector('[data-inbox-row="local::session-a"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY) ?? '{}').entries[key].ackedAt).toBeDefined()
  })
})
