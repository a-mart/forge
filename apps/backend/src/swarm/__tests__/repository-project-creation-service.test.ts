import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import {
  RepositoryProjectCreationService,
  RepositoryProjectCreationError,
} from '../repository-project-creation-service.js'
import { RepositorySettingsService } from '../repository-settings-service.js'
import { GitCloneError, GitCloneRunner } from '../../versioning/git-clone-runner.js'

function fakeSocket(): WebSocket {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    readyState: 1,
    send: vi.fn(),
  }) as unknown as WebSocket
}

describe('RepositoryProjectCreationService remediation', () => {
  let dataDir = ''
  let home = ''

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
      dataDir = ''
    }
  })

  async function setup() {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-create-svc-'))
    home = join(dataDir, 'home')
    await mkdir(home)
    const settingsService = new RepositorySettingsService({ dataDir, homeDir: home })
    await settingsService.load()
    return settingsService
  }

  it('rejects duplicate active request IDs', async () => {
    const settingsService = await setup()
    let releaseClone!: () => void
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })

    const cloneRunner = {
      clone: vi.fn(async () => {
        await cloneGate
        return { repositoryPath: join(home, 'repo'), stagingPath: '' }
      }),
    } as unknown as GitCloneRunner

    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager: vi.fn() } as never,
      settingsService,
      cloneRunner,
      sendToSocket: vi.fn(),
    })

    const socket = fakeSocket()
    const first = service.create({
      requestId: 'req-dup',
      name: 'Proj',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryBasePath: home,
      repositoryFolder: 'repo-a',
      modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      managerContextId: 'mgr-1',
      socket,
    })

    await vi.waitFor(() => expect(service.getOperationPhase('req-dup')).toBe('cloning'))

    await expect(
      service.create({
        requestId: 'req-dup',
        name: 'Other',
        repositoryUrl: 'https://github.com/org/other.git',
        repositoryBasePath: home,
        repositoryFolder: 'repo-b',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
        managerContextId: 'mgr-1',
        socket,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_operation' })

    releaseClone()
    await first.catch(() => undefined)
  })

  it('authorizes cancel by owning socket and marks tooLate after publish boundary', async () => {
    const settingsService = await setup()
    let releaseBeforePublish!: (allowed: boolean) => void
    const beforePublishGate = new Promise<boolean>((resolve) => {
      releaseBeforePublish = resolve
    })

    const cloneRunner = {
      clone: vi.fn(async (options: { beforePublish?: () => boolean | Promise<boolean> }) => {
        const allowed = await options.beforePublish?.()
        if (!allowed) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
        const stillAllowed = await beforePublishGate
        if (!stillAllowed) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
        return { repositoryPath: join(home, 'repo'), stagingPath: '' }
      }),
    } as unknown as GitCloneRunner

    const service = new RepositoryProjectCreationService({
      swarmManager: {
        createManager: vi.fn(async () => ({
          agentId: 'm1',
          role: 'manager',
          name: 'Proj',
          cwd: join(home, 'repo'),
        })),
      } as never,
      settingsService,
      cloneRunner,
      sendToSocket: vi.fn(),
    })

    const owner = fakeSocket()
    const other = fakeSocket()
    const createPromise = service.create({
      requestId: 'req-own',
      name: 'Proj',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryBasePath: home,
      repositoryFolder: 'repo',
      modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      managerContextId: 'mgr-1',
      socket: owner,
    })

    await vi.waitFor(() => expect(service.getOperationPhase('req-own')).toBe('publishing'))
    expect(service.cancel('req-own', other)).toEqual({ accepted: false, tooLate: true })
    expect(service.cancel('req-own', owner)).toEqual({ accepted: false, tooLate: true })

    releaseBeforePublish(true)
    await expect(createPromise).resolves.toMatchObject({ repositoryPath: join(home, 'repo') })
  })

  it('cancel before publish boundary is accepted and prevents create completion', async () => {
    const settingsService = await setup()
    let releaseClone!: () => void
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })

    const cloneRunner = {
      clone: vi.fn(async (options: {
        signal?: AbortSignal
        beforePublish?: () => boolean | Promise<boolean>
      }) => {
        await cloneGate
        if (options.signal?.aborted) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
        const allowed = await options.beforePublish?.()
        if (allowed === false) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
        return { repositoryPath: join(home, 'repo'), stagingPath: '' }
      }),
    } as unknown as GitCloneRunner

    const createManager = vi.fn()
    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager } as never,
      settingsService,
      cloneRunner,
      sendToSocket: vi.fn(),
    })

    const socket = fakeSocket()
    const createPromise = service.create({
      requestId: 'req-cancel',
      name: 'Proj',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryBasePath: home,
      repositoryFolder: 'repo',
      modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      managerContextId: 'mgr-1',
      socket,
    })

    await vi.waitFor(() => expect(service.getOperationPhase('req-cancel')).toBe('cloning'))
    expect(service.cancel('req-cancel', socket)).toEqual({ accepted: true, tooLate: false })

    releaseClone()
    await expect(createPromise).rejects.toMatchObject({ code: 'clone_cancelled' })
    expect(createManager).not.toHaveBeenCalled()
  })

  it('surfaces typed preflight URL and folder errors', async () => {
    const settingsService = await setup()
    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager: vi.fn() } as never,
      settingsService,
      cloneRunner: { clone: vi.fn() } as never,
      sendToSocket: vi.fn(),
    })

    await expect(
      service.create({
        requestId: 'req-url',
        name: 'Proj',
        repositoryUrl: 'http://example.com/repo.git',
        repositoryBasePath: home,
        repositoryFolder: 'repo',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
        managerContextId: 'mgr-1',
        socket: fakeSocket(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_repository_url' })

    await expect(
      service.create({
        requestId: 'req-folder',
        name: 'Proj',
        repositoryUrl: 'https://github.com/org/repo.git',
        repositoryBasePath: home,
        repositoryFolder: '../escape',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
        managerContextId: 'mgr-1',
        socket: fakeSocket(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_repository_folder' })
  })

  it('shutdown aborts active ops and awaits settlement before resolving', async () => {
    const settingsService = await setup()
    let releaseClone!: () => void
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })

    const cloneRunner = {
      clone: vi.fn(async (options: { signal?: AbortSignal }) => {
        await cloneGate
        if (options.signal?.aborted) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
        return { repositoryPath: join(home, 'repo'), stagingPath: '' }
      }),
    } as unknown as GitCloneRunner

    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager: vi.fn() } as never,
      settingsService,
      cloneRunner,
      sendToSocket: vi.fn(),
    })

    const createPromise = service.create({
      requestId: 'req-shutdown',
      name: 'Proj',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryBasePath: home,
      repositoryFolder: 'repo',
      modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      managerContextId: 'mgr-1',
      socket: fakeSocket(),
    })

    await vi.waitFor(() => expect(service.getOperationPhase('req-shutdown')).toBe('cloning'))

    let shutdownDone = false
    const shutdownPromise = service.shutdown().then(() => {
      shutdownDone = true
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(shutdownDone).toBe(false)

    releaseClone()
    await expect(createPromise).rejects.toBeInstanceOf(RepositoryProjectCreationError)
    await shutdownPromise
    expect(shutdownDone).toBe(true)
    expect(service.getOperationPhase('req-shutdown')).toBeUndefined()
  })

  it('shutdown during validateBasePath never starts clone and awaits settlement', async () => {
    const settingsService = await setup()
    let releaseValidate!: () => void
    const validateGate = new Promise<void>((resolve) => {
      releaseValidate = resolve
    })

    const gatedSettings = {
      validateBasePath: vi.fn(async (input: string) => {
        await validateGate
        return settingsService.validateBasePath(input)
      }),
      recordLastUsedBasePath: settingsService.recordLastUsedBasePath.bind(settingsService),
    }

    const cloneRunner = {
      clone: vi.fn(async () => {
        throw new Error('clone must not start after shutdown during validation')
      }),
    } as unknown as GitCloneRunner

    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager: vi.fn() } as never,
      settingsService: gatedSettings as never,
      cloneRunner,
      sendToSocket: vi.fn(),
    })

    const createPromise = service.create({
      requestId: 'req-preflight-shutdown',
      name: 'Proj',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryBasePath: home,
      repositoryFolder: 'repo',
      modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      managerContextId: 'mgr-1',
      socket: fakeSocket(),
    })

    await vi.waitFor(() => expect(gatedSettings.validateBasePath).toHaveBeenCalled())
    expect(service.getLifecycle()).toBe('open')
    expect(cloneRunner.clone).not.toHaveBeenCalled()

    let shutdownDone = false
    const shutdownPromise = service.shutdown().then(() => {
      shutdownDone = true
    })
    expect(service.getLifecycle()).toBe('closing')

    await new Promise((r) => setTimeout(r, 15))
    expect(shutdownDone).toBe(false)
    expect(cloneRunner.clone).not.toHaveBeenCalled()

    releaseValidate()
    await expect(createPromise).rejects.toMatchObject({ code: 'clone_cancelled' })
    await shutdownPromise
    expect(shutdownDone).toBe(true)
    expect(service.getLifecycle()).toBe('closed')
    expect(cloneRunner.clone).not.toHaveBeenCalled()
    expect(service.getOperationPhase('req-preflight-shutdown')).toBeUndefined()
  })

  it('shutdown is a no-op when nothing is active', async () => {
    const settingsService = await setup()
    const service = new RepositoryProjectCreationService({
      swarmManager: { createManager: vi.fn() } as never,
      settingsService,
      cloneRunner: { clone: vi.fn() } as never,
      sendToSocket: vi.fn(),
    })
    await expect(service.shutdown()).resolves.toBeUndefined()
  })
})

void RepositoryProjectCreationError
