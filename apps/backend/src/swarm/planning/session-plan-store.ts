import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PlanStep } from '@forge/protocol'
import { appendJsonl, writeJsonFileAtomic } from '../../utils/atomic-files.js'
import { getSessionPlanHistoryPath, getSessionPlanPath } from '../storage/data-paths.js'
import {
  createEmptySessionPlanState,
  normalizeSessionPlanState,
  type SessionPlanState,
} from './session-plan-state.js'

const planStoreLocks = new Map<string, Promise<void>>()

export class SessionPlanStore {
  readonly filePath: string
  readonly historyFilePath: string

  constructor(private readonly options: {
    dataDir: string
    profileId: string
    sessionAgentId: string
    now?: () => Date
    randomId?: () => string
    appendHistory?: typeof appendJsonl
  }) {
    this.filePath = resolve(
      getSessionPlanPath(options.dataDir, options.profileId, options.sessionAgentId),
    )
    this.historyFilePath = resolve(
      getSessionPlanHistoryPath(options.dataDir, options.profileId, options.sessionAgentId),
    )
  }

  async load(): Promise<SessionPlanState> {
    try {
      return normalizeSessionPlanState(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return createEmptySessionPlanState()
      if (
        error instanceof SyntaxError
        || (error instanceof Error && error.name === 'SessionPlanValidationError')
      ) {
        await this.backupCorruptFile()
        return createEmptySessionPlanState()
      }
      throw error
    }
  }

  async update(input: { explanation?: string; plan: PlanStep[] }): Promise<SessionPlanState> {
    return withPlanStoreLock(this.filePath, async () => {
      const current = await this.load()
      const next: SessionPlanState = {
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        ...(input.explanation ? { explanation: input.explanation } : {}),
        plan: input.plan.map((step) => ({ ...step })),
      }
      await this.archiveCurrentState(current)
      await this.writeAtomically(next)
      return next
    })
  }

  async clear(): Promise<SessionPlanState> {
    return withPlanStoreLock(this.filePath, async () => {
      const current = await this.load()
      const next: SessionPlanState = {
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        plan: [],
      }
      await this.archiveCurrentState(current)
      await this.writeAtomically(next)
      return next
    })
  }

  private async backupCorruptFile(): Promise<void> {
    const suffix = (this.options.randomId ?? randomUUID)()
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString().replace(/:/g, '-')
    try {
      // eslint-disable-next-line no-restricted-syntax -- quarantine move, not a temp+rename content write
      await rename(this.filePath, `${this.filePath}.corrupt.${timestamp}.${suffix}`)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  private async writeAtomically(state: SessionPlanState): Promise<void> {
    await writeJsonFileAtomic(this.filePath, state)
  }

  private async archiveCurrentState(state: SessionPlanState): Promise<void> {
    if (state.revision === 0) return
    await (this.options.appendHistory ?? appendJsonl)(this.historyFilePath, state)
  }
}

async function withPlanStoreLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = planStoreLocks.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
  const queued = previous.catch(() => {}).then(() => current)
  planStoreLocks.set(key, queued)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release?.()
    if (planStoreLocks.get(key) === queued) planStoreLocks.delete(key)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === code
}
