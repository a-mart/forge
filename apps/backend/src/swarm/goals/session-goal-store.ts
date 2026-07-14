import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SessionGoalControlAction, TokenUsageTotals } from '@forge/protocol'
import { appendJsonl, writeJsonFileAtomic } from '../../utils/atomic-files.js'
import { getSessionGoalHistoryPath, getSessionGoalPath } from '../storage/data-paths.js'
import { renameWithRetry } from '../retry-rename.js'
import {
  MIN_BLOCKED_GOAL_TURNS,
  SessionGoalValidationError,
  closeActiveElapsed,
  createEmptySessionGoalState,
  isUnfinishedGoalStatus,
  normalizeGoalObjective,
  normalizeGoalTokenBudget,
  normalizeSessionGoalState,
  type SessionGoalState,
  type StoredSessionGoal,
} from './session-goal-state.js'

const goalStoreLocks = new Map<string, Promise<void>>()

export class SessionGoalStore {
  readonly filePath: string
  readonly historyFilePath: string

  constructor(private readonly options: {
    dataDir: string
    profileId: string
    sessionAgentId: string
    now?: () => string
    randomId?: () => string
    appendHistory?: typeof appendJsonl
  }) {
    this.filePath = resolve(getSessionGoalPath(options.dataDir, options.profileId, options.sessionAgentId))
    this.historyFilePath = resolve(
      getSessionGoalHistoryPath(options.dataDir, options.profileId, options.sessionAgentId),
    )
  }

  async load(): Promise<SessionGoalState> {
    try {
      return normalizeSessionGoalState(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return createEmptySessionGoalState()
      if (error instanceof SyntaxError || error instanceof SessionGoalValidationError) {
        await this.backupCorruptFile()
        return createEmptySessionGoalState()
      }
      throw error
    }
  }

  async create(input: { objective: string; tokenBudget?: number }): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      if (current.goal && isUnfinishedGoalStatus(current.goal.status)) {
        throw new SessionGoalValidationError('Finish or cancel the current goal before creating another.')
      }
      const now = this.now()
      const next: SessionGoalState = {
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: now,
        goal: {
          id: (this.options.randomId ?? randomUUID)(),
          objective: normalizeGoalObjective(input.objective),
          status: 'active',
          createdAt: now,
          updatedAt: now,
          ...(input.tokenBudget === undefined
            ? {}
            : { tokenBudget: normalizeGoalTokenBudget(input.tokenBudget) }),
          activeElapsedMs: 0,
          activeSince: now,
          turnCount: 1,
        },
      }
      await this.write(next)
      return next
    })
  }

  async updateFromAgent(
    status: 'complete' | 'blocked',
    final?: { usage: TokenUsageTotals; coverage: 'complete' | 'partial' },
  ): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      const goal = requireGoal(current)
      if (goal.status !== 'active') {
        throw new SessionGoalValidationError('Only an active goal can be completed or blocked by the manager.')
      }
      const blockingAuditTurns = goal.turnCount - (goal.blockedAuditStartTurn ?? 0)
      if (status === 'blocked' && blockingAuditTurns < MIN_BLOCKED_GOAL_TURNS) {
        throw new SessionGoalValidationError(
          `A goal can be marked blocked only after at least ${MIN_BLOCKED_GOAL_TURNS} goal turns in the current blocking audit.`,
        )
      }
      const now = this.now()
      const nextGoal: StoredSessionGoal = {
        ...goal,
        status: status === 'complete' ? 'completed' : 'blocked',
        updatedAt: now,
        activeElapsedMs: closeActiveElapsed(goal, now),
        ...(status === 'complete' ? { endedAt: now } : {}),
        ...(status === 'complete' && final
          ? { finalUsage: final.usage, finalUsageCoverage: final.coverage }
          : {}),
      }
      delete nextGoal.activeSince
      delete nextGoal.pauseReason
      const next = nextState(current, nextGoal, now)
      if (nextGoal.status === 'completed') await this.appendTerminal(next)
      await this.write(next)
      return next
    })
  }

  async control(
    action: SessionGoalControlAction,
    final?: { usage: TokenUsageTotals; coverage: 'complete' | 'partial' },
  ): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      const goal = requireGoal(current)
      if (!isUnfinishedGoalStatus(goal.status)) {
        throw new SessionGoalValidationError('The current goal has already ended.')
      }
      const now = this.now()
      let nextGoal: StoredSessionGoal

      if (action.action === 'pause') {
        if (goal.status !== 'active') throw new SessionGoalValidationError('Only an active goal can be paused.')
        nextGoal = {
          ...goal,
          status: 'paused',
          pauseReason: 'user',
          updatedAt: now,
          activeElapsedMs: closeActiveElapsed(goal, now),
        }
        delete nextGoal.activeSince
      } else if (action.action === 'resume') {
        if (goal.status !== 'paused' && goal.status !== 'blocked') {
          throw new SessionGoalValidationError('Only a paused or blocked goal can be resumed.')
        }
        nextGoal = {
          ...goal,
          status: 'active',
          updatedAt: now,
          activeSince: now,
          ...(goal.status === 'blocked' ? { blockedAuditStartTurn: goal.turnCount } : {}),
        }
        delete nextGoal.pauseReason
      } else if (action.action === 'cancel') {
        nextGoal = {
          ...goal,
          status: 'cancelled',
          updatedAt: now,
          endedAt: now,
          activeElapsedMs: closeActiveElapsed(goal, now),
          ...(final ? { finalUsage: final.usage, finalUsageCoverage: final.coverage } : {}),
        }
        delete nextGoal.activeSince
        delete nextGoal.pauseReason
      } else {
        nextGoal = {
          ...goal,
          objective: normalizeGoalObjective(action.objective),
          updatedAt: now,
        }
        if ('tokenBudget' in action) {
          const tokenBudget = normalizeGoalTokenBudget(action.tokenBudget)
          if (tokenBudget === undefined) delete nextGoal.tokenBudget
          else nextGoal.tokenBudget = tokenBudget
        }
      }

      const next = nextState(current, nextGoal, now)
      if (nextGoal.status === 'cancelled') await this.appendTerminal(next)
      await this.write(next)
      return next
    })
  }

  async pauseForBudget(): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      const goal = requireGoal(current)
      if (goal.status !== 'active') return current
      const now = this.now()
      const nextGoal: StoredSessionGoal = {
        ...goal,
        status: 'paused',
        pauseReason: 'token_budget_exhausted',
        updatedAt: now,
        activeElapsedMs: closeActiveElapsed(goal, now),
      }
      delete nextGoal.activeSince
      const next = nextState(current, nextGoal, now)
      await this.write(next)
      return next
    })
  }

  async incrementTurn(): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      const goal = requireGoal(current)
      if (goal.status !== 'active') return current
      const now = this.now()
      const next = nextState(current, { ...goal, updatedAt: now, turnCount: goal.turnCount + 1 }, now)
      await this.write(next)
      return next
    })
  }

  async clear(final?: { usage: TokenUsageTotals; coverage: 'complete' | 'partial' }): Promise<SessionGoalState> {
    return withGoalStoreLock(this.filePath, async () => {
      const current = await this.load()
      const now = this.now()
      let revision = current.revision + 1
      if (current.goal && isUnfinishedGoalStatus(current.goal.status)) {
        const terminalGoal: StoredSessionGoal = {
          ...current.goal,
          status: 'cancelled',
          updatedAt: now,
          endedAt: now,
          activeElapsedMs: closeActiveElapsed(current.goal, now),
          ...(final ? { finalUsage: final.usage, finalUsageCoverage: final.coverage } : {}),
        }
        delete terminalGoal.activeSince
        delete terminalGoal.pauseReason
        await this.appendTerminal(nextState(current, terminalGoal, now))
        revision += 1
      }
      const next: SessionGoalState = {
        schemaVersion: 1,
        revision,
        updatedAt: now,
        goal: null,
      }
      await this.write(next)
      return next
    })
  }

  private async appendTerminal(state: SessionGoalState): Promise<void> {
    await (this.options.appendHistory ?? appendJsonl)(this.historyFilePath, state)
  }

  private async write(state: SessionGoalState): Promise<void> {
    await writeJsonFileAtomic(this.filePath, state)
  }

  private async backupCorruptFile(): Promise<void> {
    const suffix = (this.options.randomId ?? randomUUID)()
    const timestamp = this.now().replace(/:/g, '-')
    try {
      await renameWithRetry(
        this.filePath,
        `${this.filePath}.corrupt.${timestamp}.${suffix}`,
        { retries: 8, baseDelayMs: 15 },
      )
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))()
  }
}

function nextState(current: SessionGoalState, goal: StoredSessionGoal, now: string): SessionGoalState {
  return { schemaVersion: 1, revision: current.revision + 1, updatedAt: now, goal }
}

function requireGoal(state: SessionGoalState): StoredSessionGoal {
  if (!state.goal) throw new SessionGoalValidationError('There is no current goal.')
  return state.goal
}

async function withGoalStoreLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = goalStoreLocks.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
  const queued = previous.catch(() => {}).then(() => current)
  goalStoreLocks.set(key, queued)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release?.()
    if (goalStoreLocks.get(key) === queued) goalStoreLocks.delete(key)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === code
}
