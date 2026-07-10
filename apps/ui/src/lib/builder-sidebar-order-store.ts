import {
  type BuilderSidebarOrderRef,
  type BuilderSidebarOrderState,
} from '@forge/protocol'
import {
  BuilderSidebarOrderApiConflictError,
  type BuilderSidebarOrderApi,
} from '@/lib/builder-sidebar-order-api'
import {
  builderSidebarOrderKey,
  builderSidebarOrdersEqual,
  dedupeBuilderSidebarOrderRefs,
  moveBuilderSidebarOrder,
  reconcileBuilderSidebarOrder,
} from '@/lib/builder-sidebar-order'

type Listener = () => void
type DesiredOrderBuilder = (
  baseOrder: BuilderSidebarOrderRef[],
) => BuilderSidebarOrderRef[] | null

const MAX_INVALIDATION_REFRESH_ATTEMPTS = 2

/**
 * External store coordinating authoritative GET/PUT state, optimistic DnD,
 * revision invalidations, additive discovery, and one conflict replay. It is always
 * constructed with the local Builder API.
 */
export class BuilderSidebarOrderStore {
  private state: BuilderSidebarOrderState | null = null
  private authoritativeState: BuilderSidebarOrderState | null = null
  private readonly listeners = new Set<Listener>()
  private refreshQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<void> = Promise.resolve()
  private latestDiscovery: BuilderSidebarOrderRef[] = []
  private hasDiscoverySnapshot = false
  private failedAutomaticWriteKey: string | null = null
  private readonly pendingAutomaticWrites = new Map<string, Promise<void>>()

  constructor(private readonly api: BuilderSidebarOrderApi) {}

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): BuilderSidebarOrderState | null => this.state

  /** Initial load compatibility alias. */
  load(): Promise<void> {
    return this.refresh()
  }

  /**
   * Refetch local authority. Refreshes are serialized rather than collapsed,
   * so an invalidation/reconnect arriving during an older GET always performs
   * a later GET; each revision floor has at most two attempts.
   */
  refresh(
    minimumRevision = 0,
    options: { resetAuthority?: boolean } = {},
  ): Promise<void> {
    const operation = this.refreshQueue.then(
      () => this.runRefresh(minimumRevision, options.resetAuthority === true),
      () => this.runRefresh(minimumRevision, options.resetAuthority === true),
    )
    this.refreshQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Accept a successful local HTTP response. */
  acceptServerState(state: BuilderSidebarOrderState): void {
    const previous = this.authoritativeState
    if (previous && state.revision < previous.revision) return

    const next = cloneState(state)
    const authorityChanged = !previous || !statesEqual(previous, next)
    if (authorityChanged) {
      if (!previous || previous.revision !== next.revision) {
        this.failedAutomaticWriteKey = null
      }
      this.authoritativeState = next
    }

    // Even when authority is unchanged, this rolls an optimistic presentation
    // back to the validated server state after a conflict or failed PUT.
    if (!this.state || !statesEqual(this.state, next)) {
      this.state = cloneState(next)
      this.emit()
    }
  }

  /**
   * Add newly discovered projects without treating this client's omissions as
   * deletion authority. Identical pending or previously-failed desired writes
   * are quiescent. Explicit/backend-owned tombstones can be added separately
   * when a shared removal authority exists.
   */
  ensureDiscovered(discovered: readonly BuilderSidebarOrderRef[]): Promise<void> {
    this.latestDiscovery = dedupeBuilderSidebarOrderRefs(discovered)
    this.hasDiscoverySnapshot = true
    const base = this.authoritativeState
    if (!base) return Promise.resolve()

    const desired = reconcileBuilderSidebarOrder(base.order, this.latestDiscovery)
    if (builderSidebarOrdersEqual(desired, base.order)) return Promise.resolve()

    const key = automaticWriteKey(base.revision, desired)
    if (this.failedAutomaticWriteKey === key) return Promise.resolve()
    const pending = this.pendingAutomaticWrites.get(key)
    if (pending) return pending

    const operation = this.enqueue(async () => {
      try {
        await this.persistWithOneReplay((baseOrder) => (
          reconcileBuilderSidebarOrder(baseOrder, this.latestDiscovery)
        ))
      } catch (error) {
        const current = this.authoritativeState
        if (current) {
          const failedDesired = reconcileBuilderSidebarOrder(
            current.order,
            this.latestDiscovery,
          )
          this.failedAutomaticWriteKey = automaticWriteKey(current.revision, failedDesired)
        }
        throw error
      }
    })
    this.pendingAutomaticWrites.set(key, operation)
    void operation.finally(() => {
      if (this.pendingAutomaticWrites.get(key) === operation) {
        this.pendingAutomaticWrites.delete(key)
      }
    }).catch(() => undefined)
    return operation
  }

  move(
    active: BuilderSidebarOrderRef,
    over: BuilderSidebarOrderRef,
    discovered: readonly BuilderSidebarOrderRef[],
  ): Promise<void> {
    this.latestDiscovery = dedupeBuilderSidebarOrderRefs(discovered)
    this.hasDiscoverySnapshot = true
    return this.enqueue(async () => {
      await this.persistWithOneReplay((baseOrder) => {
        const visibleKeys = new Set(this.latestDiscovery.map(builderSidebarOrderKey))
        if (
          !visibleKeys.has(builderSidebarOrderKey(active))
          || !visibleKeys.has(builderSidebarOrderKey(over))
        ) {
          return null
        }
        const reconciled = reconcileBuilderSidebarOrder(baseOrder, this.latestDiscovery)
        return moveBuilderSidebarOrder(reconciled, active, over)
      })
    })
  }

  private async runRefresh(
    minimumRevision: number,
    resetAuthority: boolean,
  ): Promise<void> {
    let retryFailedAutomaticWrite = this.failedAutomaticWriteKey !== null
    if (resetAuthority) {
      // A backend restart can legitimately reload a missing/corrupt preference
      // at revision zero. Only the transport-open epoch uses this path; normal
      // concurrent GETs still reject lower stale revisions.
      this.authoritativeState = null
    }

    for (let attempt = 0; attempt < MAX_INVALIDATION_REFRESH_ATTEMPTS; attempt += 1) {
      retryFailedAutomaticWrite ||= this.failedAutomaticWriteKey !== null
      const state = await this.api.get()
      this.acceptServerState(state)
      if (state.revision >= minimumRevision) {
        if (
          retryFailedAutomaticWrite
          && this.hasDiscoverySnapshot
        ) {
          // A successful reconnect/focus GET is a bounded recovery signal for
          // one previously failed additive discovery write. If the PUT is
          // still unavailable, ensureDiscovered records the same terminal key
          // again and remains quiescent until the next explicit refresh.
          this.failedAutomaticWriteKey = null
          await this.ensureDiscovered(this.latestDiscovery)
        }
        return
      }
    }
    throw new Error(
      `Builder sidebar order did not reach invalidated revision ${minimumRevision}.`,
    )
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutationQueue.then(operation, operation)
    this.mutationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async persistWithOneReplay(buildDesired: DesiredOrderBuilder): Promise<void> {
    let base = await this.requireAuthoritativeState()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const desired = buildDesired(base.order.map((ref) => ({ ...ref })))
      if (!desired || builderSidebarOrdersEqual(desired, base.order)) {
        this.acceptServerState(base)
        return
      }

      this.setOptimisticOrder(base, desired)

      try {
        const committed = await this.api.put({
          baseRevision: base.revision,
          order: desired,
        })
        this.acceptServerState(committed)
        return
      } catch (error) {
        if (error instanceof BuilderSidebarOrderApiConflictError) {
          this.acceptServerState(error.current)
          base = cloneState(this.authoritativeState ?? error.current)
          if (attempt === 1) throw error
          continue
        }

        this.restoreAuthoritativePresentation()
        throw error
      }
    }
  }

  private async requireAuthoritativeState(): Promise<BuilderSidebarOrderState> {
    if (!this.authoritativeState) await this.refresh()
    if (!this.authoritativeState) {
      throw new Error('Builder sidebar order authority is unavailable.')
    }
    return cloneState(this.authoritativeState)
  }

  private setOptimisticOrder(
    base: BuilderSidebarOrderState,
    order: readonly BuilderSidebarOrderRef[],
  ): void {
    this.state = {
      ...cloneState(base),
      order: order.map((ref) => ({ ...ref })),
    }
    this.emit()
  }

  private restoreAuthoritativePresentation(): void {
    if (!this.authoritativeState) return
    const authoritative = cloneState(this.authoritativeState)
    if (this.state && statesEqual(this.state, authoritative)) return
    this.state = authoritative
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function automaticWriteKey(
  revision: number,
  order: readonly BuilderSidebarOrderRef[],
): string {
  return JSON.stringify([revision, order.map((ref) => [ref.originId, ref.profileId])])
}

function statesEqual(
  left: BuilderSidebarOrderState,
  right: BuilderSidebarOrderState,
): boolean {
  return left.version === right.version
    && left.revision === right.revision
    && left.updatedAt === right.updatedAt
    && builderSidebarOrdersEqual(left.order, right.order)
}

function cloneState(state: BuilderSidebarOrderState): BuilderSidebarOrderState {
  return {
    ...state,
    order: state.order.map((ref) => ({ ...ref })),
  }
}
