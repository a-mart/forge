import type {
  AgentDescriptor,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  RepositoryProjectCreationErrorCode as ProtocolErrorCode,
  RepositoryProjectCreationStage,
} from '@forge/protocol'
import type { WebSocket } from 'ws'
import {
  GitCloneError,
  GitCloneRunner,
  parseAndValidateRepositoryUrl,
  validateRepositoryFolder,
} from '../versioning/git-clone-runner.js'
import {
  RepositorySettingsService,
  RepositorySettingsValidationError,
} from './repository-settings-service.js'
import type { SwarmManager } from './swarm-manager.js'

export type RepositoryProjectCreationErrorCode =
  | ProtocolErrorCode
  | 'CREATE_REPOSITORY_PROJECT_FAILED'
  | 'UNKNOWN_AGENT'

export class RepositoryProjectCreationError extends Error {
  readonly code: RepositoryProjectCreationErrorCode
  readonly repositoryPath?: string

  constructor(
    code: RepositoryProjectCreationErrorCode,
    message: string,
    options?: { repositoryPath?: string },
  ) {
    super(message)
    this.name = 'RepositoryProjectCreationError'
    this.code = code
    this.repositoryPath = options?.repositoryPath
  }
}

export interface CreateRepositoryProjectInput {
  requestId: string
  name: string
  repositoryUrl: string
  repositoryBasePath: string
  repositoryFolder: string
  modelSelection: ManagerExactModelSelection
  reasoningLevel?: ManagerReasoningLevel
  managerContextId: string
  socket: WebSocket
}

export interface CreateRepositoryProjectResult {
  manager: AgentDescriptor
  repositoryPath: string
}

export interface CancelRepositoryProjectResult {
  accepted: boolean
  tooLate: boolean
}

type OperationPhase =
  | 'validating'
  | 'cloning'
  | 'publishing'
  | 'creating_manager'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'failed_after_clone'

type ServiceLifecycle = 'open' | 'closing' | 'closed'

interface OperationState {
  requestId: string
  socket: WebSocket
  destinationKey: string
  phase: OperationPhase
  abortController: AbortController
  publishedPath: string | null
}

export interface RepositoryProjectCreationServiceOptions {
  swarmManager: SwarmManager
  settingsService: RepositorySettingsService
  cloneRunner?: GitCloneRunner
  sendToSocket: (socket: WebSocket, event: import('@forge/protocol').ServerEvent) => void
}

export class RepositoryProjectCreationService {
  private readonly swarmManager: SwarmManager
  private readonly settingsService: RepositorySettingsService
  private readonly cloneRunner: GitCloneRunner
  private readonly sendToSocket: RepositoryProjectCreationServiceOptions['sendToSocket']
  private readonly operations = new Map<string, OperationState>()
  private readonly destinations = new Map<string, string>()
  /** In-flight create() settlement promises — including preflight — awaited by shutdown(). */
  private readonly settlements = new Map<string, Promise<void>>()
  private settlementSeq = 0
  /** Synchronously flipped to closing at shutdown start so late creates cannot register. */
  private lifecycle: ServiceLifecycle = 'open'

  constructor(options: RepositoryProjectCreationServiceOptions) {
    this.swarmManager = options.swarmManager
    this.settingsService = options.settingsService
    this.cloneRunner = options.cloneRunner ?? new GitCloneRunner()
    this.sendToSocket = options.sendToSocket
  }

  async create(input: CreateRepositoryProjectInput): Promise<CreateRepositoryProjectResult> {
    this.assertAcceptingCreates()

    const tracking = this.beginTrackedCall(input.requestId.trim() || `preflight-${++this.settlementSeq}`)
    try {
      const name = input.name.trim()
      if (!name) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'Project name is required.',
        )
      }

      if (!input.modelSelection?.provider?.trim() || !input.modelSelection?.modelId?.trim()) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'A model must be selected.',
        )
      }

      if (!input.requestId.trim()) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'create_repository_project.requestId is required.',
        )
      }

      this.assertAcceptingCreates()

      try {
        parseAndValidateRepositoryUrl(input.repositoryUrl)
      } catch (error) {
        if (error instanceof GitCloneError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      let folder: string
      try {
        folder = validateRepositoryFolder(input.repositoryFolder)
      } catch (error) {
        if (error instanceof GitCloneError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      this.assertAcceptingCreates()

      let canonicalBase: string
      try {
        canonicalBase = await this.settingsService.validateBasePath(input.repositoryBasePath)
      } catch (error) {
        if (error instanceof RepositorySettingsValidationError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      // Recheck after every pre-registration await — never register/start clone after shutdown.
      this.assertAcceptingCreates()

      const destinationKey = normalizeDestinationKey(canonicalBase, folder)

      if (this.operations.has(input.requestId)) {
        throw new RepositoryProjectCreationError(
          'duplicate_operation',
          'An operation with this request id is already active.',
        )
      }

      if (this.destinations.has(destinationKey)) {
        throw new RepositoryProjectCreationError(
          'destination_exists',
          'Another clone operation is already targeting this destination.',
        )
      }

      const abortController = new AbortController()
      const operation: OperationState = {
        requestId: input.requestId,
        socket: input.socket,
        destinationKey,
        phase: 'validating',
        abortController,
        publishedPath: null,
      }

      this.operations.set(input.requestId, operation)
      this.destinations.set(destinationKey, input.requestId)

      const onSocketClose = () => {
        this.handleSocketDisconnect(input.socket)
      }
      input.socket.once('close', onSocketClose)

      try {
        this.emitProgress(input.socket, input.requestId, 'validating')

        if (abortController.signal.aborted || operation.phase === 'cancelled' || this.lifecycle !== 'open') {
          throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
        }

        operation.phase = 'cloning'
        this.emitProgress(input.socket, input.requestId, 'cloning', 0)

        let repositoryPath: string
        try {
          const result = await this.cloneRunner.clone({
            repositoryUrl: input.repositoryUrl,
            basePath: canonicalBase,
            folder,
            canonicalBasePath: canonicalBase,
            signal: abortController.signal,
            onProgress: (progress) => {
              this.emitProgress(input.socket, input.requestId, 'cloning', progress.percent)
            },
            beforePublish: () => this.tryBeginPublish(operation),
          })
          repositoryPath = result.repositoryPath
        } catch (error) {
          const phaseAfterClone = operation.phase as OperationPhase
          if (
            abortController.signal.aborted ||
            phaseAfterClone === 'cancelled' ||
            this.lifecycle !== 'open' ||
            (error instanceof GitCloneError && error.code === 'clone_cancelled')
          ) {
            operation.phase = 'cancelled'
            throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
          }
          if (error instanceof GitCloneError) {
            operation.phase = 'failed'
            throw new RepositoryProjectCreationError(error.code, error.message)
          }
          operation.phase = 'failed'
          throw new RepositoryProjectCreationError(
            'clone_failed',
            error instanceof Error ? error.message : 'Clone failed.',
          )
        }

        operation.publishedPath = repositoryPath
        this.emitProgress(input.socket, input.requestId, 'publishing')

        try {
          await this.settingsService.recordLastUsedBasePath(canonicalBase)
        } catch (error) {
          console.warn(
            `[repository-project-creation] Failed to persist last-used base path: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }

        operation.phase = 'creating_manager'
        this.emitProgress(input.socket, input.requestId, 'creating_manager')

        try {
          const manager = await this.swarmManager.createManager(input.managerContextId, {
            name,
            cwd: repositoryPath,
            modelSelection: input.modelSelection,
            ...(input.reasoningLevel !== undefined ? { reasoningLevel: input.reasoningLevel } : {}),
          })

          operation.phase = 'completed'
          return { manager, repositoryPath }
        } catch (error) {
          operation.phase = 'failed_after_clone'
          const message = error instanceof Error ? error.message : String(error)
          throw new RepositoryProjectCreationError(
            'manager_creation_failed_after_clone',
            `Repository cloned to ${repositoryPath}, but project creation failed: ${message}. Open Create Project → Use local folder with that path to retry.`,
            { repositoryPath },
          )
        }
      } finally {
        input.socket.off('close', onSocketClose)
        this.operations.delete(input.requestId)
        if (this.destinations.get(destinationKey) === input.requestId) {
          this.destinations.delete(destinationKey)
        }
      }
    } finally {
      tracking.settle()
    }
  }

  /**
   * Synchronously transition cloning → publishing. Cancel after this returns true
   * is always too late. Returns false when cancel already won.
   */
  tryBeginPublish(operation: OperationState): boolean {
    if (operation.phase === 'cancelled' || operation.abortController.signal.aborted) {
      return false
    }
    if (operation.phase !== 'cloning' && operation.phase !== 'validating') {
      return operation.phase === 'publishing' || operation.phase === 'creating_manager'
    }
    operation.phase = 'publishing'
    return true
  }

  cancel(operationRequestId: string, socket?: WebSocket): CancelRepositoryProjectResult {
    const operation = this.operations.get(operationRequestId)
    if (!operation) {
      return { accepted: false, tooLate: true }
    }

    if (socket && operation.socket !== socket) {
      return { accepted: false, tooLate: true }
    }

    if (
      operation.phase === 'publishing' ||
      operation.phase === 'creating_manager' ||
      operation.phase === 'completed' ||
      operation.publishedPath
    ) {
      return { accepted: false, tooLate: true }
    }

    if (operation.phase === 'cancelled' || operation.phase === 'failed') {
      return { accepted: false, tooLate: true }
    }

    operation.phase = 'cancelled'
    operation.abortController.abort()
    return { accepted: true, tooLate: false }
  }

  handleSocketDisconnect(socket: WebSocket): void {
    for (const operation of this.operations.values()) {
      if (operation.socket !== socket) {
        continue
      }
      if (
        operation.publishedPath ||
        operation.phase === 'publishing' ||
        operation.phase === 'creating_manager'
      ) {
        continue
      }
      operation.phase = 'cancelled'
      operation.abortController.abort()
    }
  }

  /**
   * Synchronously enter closing, abort active ops, and await every in-flight create
   * settlement (including preflight awaits) before resolving.
   */
  async shutdown(): Promise<void> {
    this.lifecycle = 'closing'
    const pendingSettlements = [...this.settlements.values()]
    for (const operation of this.operations.values()) {
      if (
        operation.publishedPath ||
        operation.phase === 'publishing' ||
        operation.phase === 'creating_manager'
      ) {
        continue
      }
      operation.phase = 'cancelled'
      operation.abortController.abort()
    }
    await Promise.allSettled(pendingSettlements)
    this.lifecycle = 'closed'
  }

  /** Test helper */
  getOperationPhase(requestId: string): OperationPhase | undefined {
    return this.operations.get(requestId)?.phase
  }

  /** Test helper */
  getLifecycle(): ServiceLifecycle {
    return this.lifecycle
  }

  private assertAcceptingCreates(): void {
    if (this.lifecycle !== 'open') {
      throw new RepositoryProjectCreationError(
        'clone_cancelled',
        'Repository project creation is shutting down.',
      )
    }
  }

  private beginTrackedCall(trackId: string): { settle: () => void } {
    let settle!: () => void
    const settlement = new Promise<void>((resolveSettle) => {
      settle = resolveSettle
    })
    // Prefer requestId key when available; fall back to unique preflight id.
    let key = trackId
    if (this.settlements.has(key)) {
      key = `${trackId}#${++this.settlementSeq}`
    }
    this.settlements.set(key, settlement)
    return {
      settle: () => {
        this.settlements.delete(key)
        settle()
      },
    }
  }

  private emitProgress(
    socket: WebSocket,
    requestId: string,
    stage: RepositoryProjectCreationStage,
    percent?: number,
  ): void {
    this.sendToSocket(socket, {
      type: 'repository_project_creation_progress',
      requestId,
      stage,
      ...(percent !== undefined ? { percent } : {}),
    })
  }
}

function normalizeDestinationKey(basePath: string, folder: string): string {
  const normalizedBase = basePath.replace(/[/\\]+$/, '').toLowerCase()
  return `${normalizedBase}::${folder.toLowerCase()}`
}
