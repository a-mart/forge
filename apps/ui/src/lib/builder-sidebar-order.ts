import type { BuilderSidebarOrderRef } from '@forge/protocol'

/** Collision-safe tuple key used by React and dnd-kit for a project row. */
export function builderSidebarOrderKey(ref: BuilderSidebarOrderRef): string {
  return JSON.stringify([ref.originId, ref.profileId])
}

export function parseBuilderSidebarOrderKey(value: string): BuilderSidebarOrderRef | null {
  try {
    const tuple = JSON.parse(value) as unknown
    if (
      !Array.isArray(tuple)
      || tuple.length !== 2
      || typeof tuple[0] !== 'string'
      || typeof tuple[1] !== 'string'
    ) {
      return null
    }
    return { originId: tuple[0], profileId: tuple[1] }
  } catch {
    return null
  }
}

export function sameBuilderSidebarOrderRef(
  left: BuilderSidebarOrderRef,
  right: BuilderSidebarOrderRef,
): boolean {
  return left.originId === right.originId && left.profileId === right.profileId
}

export function builderSidebarOrdersEqual(
  left: readonly BuilderSidebarOrderRef[],
  right: readonly BuilderSidebarOrderRef[],
): boolean {
  return left.length === right.length && left.every((ref, index) => (
    right[index] !== undefined && sameBuilderSidebarOrderRef(ref, right[index])
  ))
}

/**
 * Reconcile currently discovered projects into the durable preference.
 *
 * Stored references are never removed merely because an origin/profile is not
 * currently visible; they remain hidden anchors for reconnects, disabled
 * origins, and archived projects. New references are inserted next to the
 * closest same-origin natural neighbor (the legacy `sortOrder` sequence), and
 * entirely new origins append without disturbing existing mixed ordering.
 */
export function reconcileBuilderSidebarOrder(
  storedOrder: readonly BuilderSidebarOrderRef[],
  discoveredNaturalOrder: readonly BuilderSidebarOrderRef[],
): BuilderSidebarOrderRef[] {
  const result = dedupeRefs(storedOrder)
  const discovered = dedupeRefs(discoveredNaturalOrder)
  const naturalByOrigin = new Map<string, BuilderSidebarOrderRef[]>()

  for (const ref of discovered) {
    const group = naturalByOrigin.get(ref.originId)
    if (group) group.push(ref)
    else naturalByOrigin.set(ref.originId, [ref])
  }

  for (const natural of naturalByOrigin.values()) {
    for (let index = 0; index < natural.length; index += 1) {
      const ref = natural[index]!
      if (findRefIndex(result, ref) >= 0) continue

      let insertAt = -1
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const previousIndex = findRefIndex(result, natural[previous]!)
        if (previousIndex >= 0) {
          insertAt = previousIndex + 1
          break
        }
      }

      if (insertAt < 0) {
        for (let next = index + 1; next < natural.length; next += 1) {
          const nextIndex = findRefIndex(result, natural[next]!)
          if (nextIndex >= 0) {
            insertAt = nextIndex
            break
          }
        }
      }

      if (insertAt < 0) {
        const lastSameOrigin = findLastIndex(result, (candidate) => candidate.originId === ref.originId)
        insertAt = lastSameOrigin >= 0 ? lastSameOrigin + 1 : result.length
      }

      result.splice(insertAt, 0, { ...ref })
    }
  }

  return result
}

/** Resolve a DnD move without parsing delimiter-ambiguous IDs. */
export function resolveBuilderSidebarDragMove(
  activeId: string,
  overId: string,
  visibleRefs: readonly BuilderSidebarOrderRef[],
): { active: BuilderSidebarOrderRef; over: BuilderSidebarOrderRef } | null {
  const active = parseBuilderSidebarOrderKey(activeId)
  const over = parseBuilderSidebarOrderKey(overId)
  if (!active || !over || sameBuilderSidebarOrderRef(active, over)) return null
  const visibleKeys = new Set(visibleRefs.map(builderSidebarOrderKey))
  if (!visibleKeys.has(activeId) || !visibleKeys.has(overId)) return null
  return { active, over }
}

/** Move one composite project reference to another's current index. */
export function moveBuilderSidebarOrder(
  order: readonly BuilderSidebarOrderRef[],
  active: BuilderSidebarOrderRef,
  over: BuilderSidebarOrderRef,
): BuilderSidebarOrderRef[] | null {
  if (sameBuilderSidebarOrderRef(active, over)) return null
  const activeIndex = findRefIndex(order, active)
  const overIndex = findRefIndex(order, over)
  if (activeIndex < 0 || overIndex < 0) return null

  const next = order.map((ref) => ({ ...ref }))
  const [moved] = next.splice(activeIndex, 1)
  if (!moved) return null
  next.splice(overIndex, 0, moved)
  return next
}

export function dedupeBuilderSidebarOrderRefs(
  refs: readonly BuilderSidebarOrderRef[],
): BuilderSidebarOrderRef[] {
  return dedupeRefs(refs)
}

function dedupeRefs(refs: readonly BuilderSidebarOrderRef[]): BuilderSidebarOrderRef[] {
  const result: BuilderSidebarOrderRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = identityKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...ref })
  }
  return result
}

function identityKey(ref: BuilderSidebarOrderRef): string {
  // JSON tuple encoding is collision-safe even if either ID contains the
  // display-oriented `::` separator used by compositeKey.
  return JSON.stringify([ref.originId, ref.profileId])
}

function findRefIndex(
  refs: readonly BuilderSidebarOrderRef[],
  target: BuilderSidebarOrderRef,
): number {
  return refs.findIndex((ref) => sameBuilderSidebarOrderRef(ref, target))
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index
  }
  return -1
}
