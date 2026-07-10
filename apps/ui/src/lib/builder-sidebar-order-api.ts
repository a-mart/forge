import {
  BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS,
  BUILDER_SIDEBAR_ORDER_MAX_REFS,
  BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES,
  BUILDER_SIDEBAR_ORDER_VERSION,
  type BuilderSidebarOrderState,
  type UpdateBuilderSidebarOrderRequest,
} from '@forge/protocol'
import {
  createSettingsApiClient,
  type SettingsApiClient,
} from '@/components/settings/settings-api-client'
import { createBuilderSettingsTarget } from '@/components/settings/settings-target'

export const BUILDER_SIDEBAR_ORDER_API_PATH = '/api/settings/builder-sidebar-order'

export interface BuilderSidebarOrderApi {
  get(): Promise<BuilderSidebarOrderState>
  put(request: UpdateBuilderSidebarOrderRequest): Promise<BuilderSidebarOrderState>
}

export class BuilderSidebarOrderApiConflictError extends Error {
  readonly current: BuilderSidebarOrderState

  constructor(current: BuilderSidebarOrderState) {
    super('Builder sidebar order changed since it was loaded.')
    this.name = 'BuilderSidebarOrderApiConflictError'
    this.current = cloneState(current)
  }
}

export class BuilderSidebarOrderApiUnavailableError extends Error {
  constructor() {
    super('Builder sidebar ordering is unavailable on this backend.')
    this.name = 'BuilderSidebarOrderApiUnavailableError'
  }
}

/** Construct the preference API from the local WS URL, never the active origin. */
export function createLocalBuilderSidebarOrderApi(localWsUrl: string): BuilderSidebarOrderApi {
  return createBuilderSidebarOrderApi(createSettingsApiClient(
    createBuilderSettingsTarget(localWsUrl),
  ))
}

/**
 * Create an API bound to the local Builder target. Passing a collaboration
 * target is rejected before fetch so unified ordering can never leak remotely.
 */
export function createBuilderSidebarOrderApi(client: SettingsApiClient): BuilderSidebarOrderApi {
  if (client.target.kind !== 'builder') {
    throw new Error('Builder sidebar order API requires the local Builder target.')
  }

  return {
    async get() {
      const response = await client.fetch(BUILDER_SIDEBAR_ORDER_API_PATH, { cache: 'no-store' })
      if (isUnavailableStatus(response.status)) throw new BuilderSidebarOrderApiUnavailableError()
      if (!response.ok) throw new Error(await client.readApiError(response))
      return parseState(await response.json())
    },

    async put(request) {
      const response = await client.fetch(BUILDER_SIDEBAR_ORDER_API_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (response.status === 409) {
        const payload = await response.json() as { current?: unknown }
        throw new BuilderSidebarOrderApiConflictError(parseState(payload.current))
      }
      if (isUnavailableStatus(response.status)) throw new BuilderSidebarOrderApiUnavailableError()
      if (!response.ok) throw new Error(await client.readApiError(response))
      return parseState(await response.json())
    },
  }
}

function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

function parseState(value: unknown): BuilderSidebarOrderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse()
  }
  const maybe = value as Partial<BuilderSidebarOrderState>
  if (
    maybe.version !== BUILDER_SIDEBAR_ORDER_VERSION
    || !Number.isSafeInteger(maybe.revision)
    || (maybe.revision ?? -1) < 0
    || !Array.isArray(maybe.order)
    || (
      maybe.updatedAt !== null
      && (
        typeof maybe.updatedAt !== 'string'
        || Number.isNaN(Date.parse(maybe.updatedAt))
      )
    )
    || (((maybe.revision as number) === 0) !== (maybe.updatedAt === null))
  ) {
    throw invalidResponse()
  }

  return {
    version: BUILDER_SIDEBAR_ORDER_VERSION,
    revision: maybe.revision as number,
    order: parseRefs(maybe.order),
    updatedAt: maybe.updatedAt,
  }
}

function parseRefs(value: unknown[]): BuilderSidebarOrderState['order'] {
  if (
    value.length > BUILDER_SIDEBAR_ORDER_MAX_REFS
    || new TextEncoder().encode(JSON.stringify(value)).byteLength
      > BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES
  ) {
    throw invalidResponse()
  }

  const seen = new Set<string>()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidResponse()
    const ref = entry as { originId?: unknown; profileId?: unknown }
    if (!validId(ref.originId) || !validId(ref.profileId)) throw invalidResponse()
    const key = JSON.stringify([ref.originId, ref.profileId])
    if (seen.has(key)) throw invalidResponse()
    seen.add(key)
    return { originId: ref.originId, profileId: ref.profileId }
  })
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS
    && !/\p{Cc}/u.test(value)
}

function invalidResponse(): Error {
  return new Error('Builder sidebar order response is invalid.')
}

function cloneState(state: BuilderSidebarOrderState): BuilderSidebarOrderState {
  return {
    ...state,
    order: state.order.map((ref) => ({ ...ref })),
  }
}
