/** @vitest-environment jsdom */

import { act, createElement, type FormEvent, type MutableRefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { AgentDescriptor } from '@forge/protocol'
import { useManagerActions } from './use-manager-actions'

vi.mock('@/components/file-browser/use-file-browser-queries', () => ({
  seedProjectResources: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/components/settings/repository-settings-api', () => ({
  fetchRepositorySettings: vi.fn(() => Promise.resolve({ effectiveBasePath: '/tmp' })),
}))
vi.mock('@/lib/ws-client', () => ({ ManagerWsClient: class {} }))

let container: HTMLDivElement
let root: Root | null = null
let latest: ReturnType<typeof useManagerActions> | null = null

const client = {
  createRepositoryProject: vi.fn(),
  subscribeToAgent: vi.fn(),
} as unknown as ManagerWsClient
const clientRef = { current: client } as MutableRefObject<ManagerWsClient | null>

function createdManager(agentId: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-07-25T16:00:00.000Z',
    updatedAt: '2026-07-25T16:00:00.000Z',
    cwd: '/tmp/project',
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'high' },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function captureLatest(actions: ReturnType<typeof useManagerActions>) {
  latest = actions
}

function Harness() {
  const actions = useManagerActions({
    wsUrl: 'ws://localhost:47187',
    clientRef,
    agents: [],
    activeAgent: null,
    activeAgentId: null,
    isActiveManager: false,
    navigateToRoute: vi.fn(),
    setState: vi.fn() as unknown as (update: React.SetStateAction<ManagerWsState>) => void,
    clearPendingResponseForAgent: vi.fn(),
  })
  return createElement('div', { ref: () => captureLatest(actions) })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function renderHarness() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  expect(latest).toBeTruthy()
}

async function prepareClone() {
  await act(async () => latest!.handleOpenCreateManagerDialog())
  await act(async () => {
    latest!.handleNewManagerNameChange('  Clone manager  ')
    latest!.handleNewManagerModelSelectionChange({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' })
    latest!.handleCreateProjectSourceModeChange('clone_repository')
    latest!.handleRepositoryUrlChange('https://github.com/example/project.git')
    latest!.handleRepositoryFolderChange('project')
    latest!.handleRepositoryBasePathChange('/tmp')
  })
}

function submitEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>
}

beforeEach(() => {
  vi.clearAllMocks()
  clientRef.current = client
  latest = null
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
})

describe('useManagerActions clone cancellation', () => {
  it('keeps cancellation pending through accepted acknowledgement until create rejects', async () => {
    const create = deferred<{ manager: AgentDescriptor; repositoryPath: string }>()
    const cancel = deferred<{ accepted: boolean; tooLate: boolean; operationRequestId: string }>()
    client.createRepositoryProject = vi.fn(() => ({ requestId: 'clone-1', promise: create.promise, cancel: () => cancel.promise }))

    await renderHarness()
    await prepareClone()
    await act(async () => { void latest!.handleCreateManager(submitEvent()) })
    expect(latest!.isCreatingManager).toBe(true)
    expect(latest!.cloneCancellable).toBe(true)

    let cancelPromise!: Promise<void>
    await act(async () => { cancelPromise = latest!.handleCancelClone() })
    expect(latest!.isCancellingClone).toBe(true)
    expect(latest!.isCreatingManager).toBe(true)

    await act(async () => cancel.resolve({ accepted: true, tooLate: false, operationRequestId: 'clone-1' }))
    await act(async () => { await cancelPromise })
    expect(latest!.isCancellingClone).toBe(true)
    expect(latest!.isCreatingManager).toBe(true)

    await act(async () => create.reject(new Error('clone_cancelled: Clone was cancelled.')))
    expect(latest!.isCancellingClone).toBe(false)
    expect(latest!.isCreatingManager).toBe(false)
    expect(latest!.createManagerError).toBeNull()
  })

  it('clears cancelling immediately for a too-late negative acknowledgement while create settles later', async () => {
    const create = deferred<{ manager: AgentDescriptor; repositoryPath: string }>()
    const cancel = deferred<{ accepted: boolean; tooLate: boolean; operationRequestId: string }>()
    client.createRepositoryProject = vi.fn(() => ({ requestId: 'clone-2', promise: create.promise, cancel: () => cancel.promise }))

    await renderHarness()
    await prepareClone()
    await act(async () => { void latest!.handleCreateManager(submitEvent()) })
    let cancelPromise!: Promise<void>
    await act(async () => { cancelPromise = latest!.handleCancelClone() })
    await act(async () => cancel.resolve({ accepted: false, tooLate: true, operationRequestId: 'clone-2' }))
    await act(async () => { await cancelPromise })

    expect(latest!.isCancellingClone).toBe(false)
    expect(latest!.isCreatingManager).toBe(true)
    expect(latest!.createManagerError).toContain('Cancellation was too late')

    await act(async () => create.resolve({ manager: createdManager('created-after-cancel'), repositoryPath: '/tmp/project-2' }))
    expect(latest!.isCreatingManager).toBe(false)
  })

  it('clears cancelling and reports a rejected cancellation request', async () => {
    const create = deferred<{ manager: AgentDescriptor; repositoryPath: string }>()
    const cancel = deferred<{ accepted: boolean; tooLate: boolean; operationRequestId: string }>()
    client.createRepositoryProject = vi.fn(() => ({ requestId: 'clone-3', promise: create.promise, cancel: () => cancel.promise }))

    await renderHarness()
    await prepareClone()
    await act(async () => { void latest!.handleCreateManager(submitEvent()) })
    let cancelPromise!: Promise<void>
    await act(async () => { cancelPromise = latest!.handleCancelClone() })
    await act(async () => cancel.reject(new Error('cancel request failed')))
    await act(async () => { await cancelPromise })

    expect(latest!.isCancellingClone).toBe(false)
    expect(latest!.createManagerError).toBe('cancel request failed')
    await act(async () => create.reject(new Error('clone_cancelled')))
    expect(latest!.isCreatingManager).toBe(false)
  })
})
