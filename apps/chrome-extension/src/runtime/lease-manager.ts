import type { ChromeApi, ChromeTab } from './chrome-api.js'
import { restrictedTargetReason } from './restricted-target.js'

const SESSION_AUTHORITY_KEY = 'forge.externalChrome.tabAuthority.v2'
const LEGACY_SESSION_RELEASE_RECEIPTS_KEY = 'forge.externalChrome.releaseReceipts.v1'
const DURABLE_RELEASE_RECEIPTS_KEY = 'forge.externalChrome.releaseReceipts.v2'
const MAX_AUTHORITIES = 128
const MAX_RELEASE_RECEIPTS = 128
const MAX_RELEASE_RECEIPT_TAB_IDS = 128
const MAX_RELEASE_RECEIPT_BYTES = 64 * 1_024
const MAX_RELEASE_RECEIPT_TTL_MS = 15 * 60_000

export type TabAuthorityState = 'human' | 'agent' | 'lost'

/** A durable CAS record for one Chrome tab. No record grants profile- or window-wide authority. */
export interface TabAuthorityRecord {
  tabId: number
  ownerId: string
  ownerEpoch: number
  sessionAgentId: string
  state: TabAuthorityState
  controlEpoch: number
  createdByForge: boolean
  payloadVersion: string
  expiresAt: number
}

interface ReleaseReceipt {
  ownerId: string
  ownerEpoch: number
  tabIds: number[]
  releasedAt: number
  expiresAt: number
}

interface PersistedReleaseReceipts {
  schemaVersion: 1
  receipts: ReleaseReceipt[]
}

export class LeaseError extends Error {
  constructor(readonly code: 'lease-conflict' | 'lease-lost' | 'restricted-target' | 'target-not-found' | 'scope-mismatch', message: string) {
    super(message)
    this.name = 'LeaseError'
  }
}

function validRecord(value: unknown): value is TabAuthorityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Partial<TabAuthorityRecord>
  return Number.isSafeInteger(record.tabId) && typeof record.ownerId === 'string' && record.ownerId.length > 0 &&
    Number.isSafeInteger(record.ownerEpoch) && (record.ownerEpoch as number) > 0 && typeof record.sessionAgentId === 'string' &&
    ['human', 'agent', 'lost'].includes(String(record.state)) && Number.isSafeInteger(record.controlEpoch) &&
    typeof record.createdByForge === 'boolean' && typeof record.payloadVersion === 'string' && Number.isFinite(record.expiresAt)
}

function validReceipt(value: unknown): value is ReleaseReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'expiresAt,ownerEpoch,ownerId,releasedAt,tabIds') return false
  return typeof record.ownerId === 'string' && record.ownerId.length > 0 && record.ownerId.length <= 128 && !record.ownerId.includes('\0') &&
    Number.isSafeInteger(record.ownerEpoch) && (record.ownerEpoch as number) > 0 && Array.isArray(record.tabIds) &&
    record.tabIds.length > 0 && record.tabIds.length <= MAX_RELEASE_RECEIPT_TAB_IDS &&
    record.tabIds.every((tabId) => Number.isSafeInteger(tabId) && (tabId as number) >= 0) &&
    new Set(record.tabIds).size === record.tabIds.length && Number.isFinite(record.releasedAt) && (record.releasedAt as number) >= 0 &&
    Number.isFinite(record.expiresAt) && (record.expiresAt as number) > (record.releasedAt as number) &&
    (record.expiresAt as number) - (record.releasedAt as number) <= MAX_RELEASE_RECEIPT_TTL_MS
}

export class LeaseManager {
  private readonly authorities = new Map<number, TabAuthorityRecord>()
  private readonly releaseReceipts = new Map<string, ReleaseReceipt>()
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly chrome: ChromeApi,
    private readonly payloadVersion: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 15 * 60_000,
  ) {}

  all(): TabAuthorityRecord[] {
    return [...this.authorities.values()].map((record) => structuredClone(record)).sort((a, b) => a.tabId - b.tabId)
  }

  forTab(tabId: number): TabAuthorityRecord | null {
    const record = this.authorities.get(tabId)
    return record === undefined ? null : structuredClone(record)
  }

  /** Only live exact authority may trigger debugger cleanup; receipts are acknowledgement proof only. */
  activeReleaseScope(ownerId: string, ownerEpoch: number): number[] {
    return this.all().filter((record) => record.ownerId === ownerId && record.ownerEpoch === ownerEpoch).map((record) => record.tabId)
  }

  /** Exact active-or-receipted scope makes release retryable after a lost acknowledgement. */
  releaseScope(ownerId: string, ownerEpoch: number): number[] {
    const active = this.activeReleaseScope(ownerId, ownerEpoch)
    const receipt = this.releaseReceipts.get(releaseKey(ownerId, ownerEpoch))
    return active.length > 0 ? active : receipt !== undefined && receipt.expiresAt > this.now() ? [...receipt.tabIds] : []
  }

  async focusedEligibleTab(): Promise<ChromeTab | null> {
    const windows = await this.chrome.windows.getAll({ populate: true })
    const focused = windows.filter((window) => window.focused)
    if (focused.length !== 1) return null
    const active = (focused[0]!.tabs ?? []).filter((tab) => tab.active === true && tab.id !== undefined)
    if (active.length !== 1 || restrictedTargetReason(active[0]!.url) !== null) return null
    return active[0]!
  }

  async allocateAutomaticTab(input: { reuseFocused: boolean; url?: string }): Promise<{ tab: ChromeTab; createdByForge: boolean }> {
    const focused = input.reuseFocused ? await this.focusedEligibleTab() : null
    if (focused !== null) return { tab: focused, createdByForge: false }
    if (input.url !== undefined && restrictedTargetReason(input.url) !== null) throw new LeaseError('restricted-target', 'requested URL is restricted')
    const created = await this.chrome.tabs.create({ url: input.url ?? 'https://forge.invalid/', active: true })
    if (created.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return a created tab ID')
    // Real Chrome may resolve tabs.create while the new tab still has no observable URL.
    // Never weaken acquire's restricted-target check; wait until Chrome can prove the
    // created target identity instead.
    const tab = await this.waitForCreatedTarget(created.id)
    return { tab, createdByForge: true }
  }

  acquire(input: {
    tabId: number
    ownerId: string
    ownerEpoch: number
    sessionAgentId: string
    expectedOwnerEpoch?: number
    createdByForge?: boolean
  }): Promise<{ authority: TabAuthorityRecord; tab: ChromeTab }> {
    return this.mutate(async () => {
      this.validateRouting(input)
      let tab: ChromeTab
      try { tab = await this.chrome.tabs.get(input.tabId) } catch { throw new LeaseError('target-not-found', 'tab no longer exists') }
      const restriction = restrictedTargetReason(tab.url)
      if (restriction !== null) throw new LeaseError('restricted-target', `tab is restricted (${restriction})`)
      const existing = this.authorities.get(input.tabId)
      if (existing !== undefined) {
        const exact = existing.ownerId === input.ownerId && existing.ownerEpoch === input.ownerEpoch &&
          existing.sessionAgentId === input.sessionAgentId && existing.state !== 'lost'
        if (!exact) throw new LeaseError(existing.state === 'lost' ? 'lease-lost' : 'lease-conflict', 'tab authority compare-and-set failed')
        return { authority: structuredClone(existing), tab }
      }
      if (input.expectedOwnerEpoch !== undefined && input.expectedOwnerEpoch !== 0) {
        throw new LeaseError('lease-conflict', 'tab authority compare-and-set expected an existing epoch')
      }
      if (this.authorities.size >= MAX_AUTHORITIES) throw new LeaseError('scope-mismatch', 'tab authority bound reached')
      const authority: TabAuthorityRecord = {
        tabId: input.tabId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        sessionAgentId: input.sessionAgentId,
        state: 'human',
        controlEpoch: 0,
        createdByForge: input.createdByForge === true,
        payloadVersion: this.payloadVersion,
        expiresAt: this.now() + this.ttlMs,
      }
      this.authorities.set(input.tabId, authority)
      await this.persistAuthorities()
      return { authority: structuredClone(authority), tab }
    })
  }

  beginAgentControl(ownerId: string, ownerEpoch: number, tabId: number, expectedControlEpoch?: number): Promise<number> {
    return this.mutate(async () => {
      const authority = this.assertScope(ownerId, ownerEpoch, tabId)
      if (expectedControlEpoch !== undefined && authority.controlEpoch !== expectedControlEpoch) {
        throw new LeaseError('lease-lost', 'human input changed queued operation authority')
      }
      this.authorities.set(tabId, { ...authority, state: 'agent', expiresAt: this.now() + this.ttlMs })
      await this.persistAuthorities()
      return authority.controlEpoch
    })
  }

  trustedHumanInput(tabId: number): Promise<TabAuthorityRecord | null> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return null
      const interrupted = { ...authority, state: 'human' as const, controlEpoch: authority.controlEpoch + 1 }
      this.authorities.set(tabId, interrupted)
      await this.persistAuthorities()
      return structuredClone(interrupted)
    })
  }

  isOperationCurrent(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): boolean {
    const authority = this.authorities.get(tabId)
    return authority?.ownerId === ownerId && authority.ownerEpoch === ownerEpoch && authority.controlEpoch === controlEpoch && authority.state === 'agent'
  }

  finishAgentControl(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.isOperationCurrent(ownerId, ownerEpoch, tabId, controlEpoch)) return false
      const authority = this.authorities.get(tabId)!
      this.authorities.set(tabId, { ...authority, state: 'human' })
      await this.persistAuthorities()
      return true
    })
  }

  assertScope(ownerId: string, ownerEpoch: number, tabId: number): TabAuthorityRecord {
    const authority = this.authorities.get(tabId)
    if (authority === undefined || authority.state === 'lost' || authority.ownerId !== ownerId || authority.ownerEpoch !== ownerEpoch) {
      throw new LeaseError('lease-lost', 'tab authority is missing or stale')
    }
    return structuredClone(authority)
  }

  markLost(tabId: number): Promise<void> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return
      this.authorities.set(tabId, { ...authority, state: 'lost', controlEpoch: authority.controlEpoch + 1 })
      await this.persistAuthorities()
    })
  }

  release(ownerId: string, ownerEpoch: number, tabId: number): Promise<boolean> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return false
      if (authority.ownerId !== ownerId || authority.ownerEpoch !== ownerEpoch) throw new LeaseError('lease-lost', 'exact tab release compare-and-set failed')
      this.authorities.delete(tabId)
      await this.persistAuthorities()
      return true
    })
  }

  releaseOwner(ownerId: string, ownerEpoch: number): Promise<number[]> {
    return this.mutate(async () => {
      const key = releaseKey(ownerId, ownerEpoch)
      const matches = this.all().filter((record) => record.ownerId === ownerId && record.ownerEpoch === ownerEpoch)
      if (matches.length === 0) {
        const receipt = this.releaseReceipts.get(key)
        return receipt !== undefined && receipt.expiresAt > this.now() ? [...receipt.tabIds] : []
      }
      const released = matches.map((record) => record.tabId)
      const nextReceipts = this.withReleaseReceipt(this.releaseReceipts, ownerId, ownerEpoch, released)
      // Establish durable idempotency before forgetting or acknowledging exact authority.
      await this.persistReceipts(nextReceipts)
      this.replaceReceipts(nextReceipts)
      for (const record of matches) this.authorities.delete(record.tabId)
      try {
        await this.persistAuthorities()
      } catch (error) {
        for (const record of matches) this.authorities.set(record.tabId, record)
        throw error
      }
      return released
    })
  }

  async recover(): Promise<TabAuthorityRecord[]> {
    return this.mutate(async () => {
      const [sessionStored, localStored] = await Promise.all([
        this.chrome.storage.session.get([SESSION_AUTHORITY_KEY, LEGACY_SESSION_RELEASE_RECEIPTS_KEY]),
        this.chrome.storage.local.get(DURABLE_RELEASE_RECEIPTS_KEY),
      ])
      const records = Array.isArray(sessionStored[SESSION_AUTHORITY_KEY]) ? sessionStored[SESSION_AUTHORITY_KEY] as unknown[] : []
      const nextReceipts = this.parseDurableReceipts(localStored[DURABLE_RELEASE_RECEIPTS_KEY])
      this.migrateLegacyReceipts(nextReceipts, sessionStored[LEGACY_SESSION_RELEASE_RECEIPTS_KEY])
      for (const [key, receipt] of nextReceipts) if (receipt.expiresAt <= this.now()) nextReceipts.delete(key)

      const nextAuthorities = new Map<number, TabAuthorityRecord>()
      for (const record of records.filter(validRecord).slice(0, MAX_AUTHORITIES)) {
        if (record.payloadVersion !== this.payloadVersion || record.expiresAt <= this.now()) continue
        try {
          const tab = await this.chrome.tabs.get(record.tabId)
          if (restrictedTargetReason(tab.url) !== null) continue
        } catch { continue }
        // MV3 restart never assumes a debugger survived. Durable ownership resumes human/unattached.
        nextAuthorities.set(record.tabId, { ...record, state: record.state === 'lost' ? 'lost' : 'human' })
      }
      await this.persistReceipts(nextReceipts)
      await this.chrome.storage.session.remove(LEGACY_SESSION_RELEASE_RECEIPTS_KEY)
      this.authorities.clear()
      for (const [tabId, authority] of nextAuthorities) this.authorities.set(tabId, authority)
      this.replaceReceipts(nextReceipts)
      await this.persistAuthorities()
      return this.all()
    })
  }

  async expire(): Promise<TabAuthorityRecord[]> {
    return this.mutate(async () => {
      const expired = this.all().filter((record) => record.expiresAt <= this.now())
      if (expired.length === 0) return []
      let nextReceipts = new Map(this.releaseReceipts)
      for (const record of expired) nextReceipts = this.withReleaseReceipt(nextReceipts, record.ownerId, record.ownerEpoch, [record.tabId])
      await this.persistReceipts(nextReceipts)
      this.replaceReceipts(nextReceipts)
      for (const record of expired) this.authorities.delete(record.tabId)
      await this.persistAuthorities()
      return expired
    })
  }

  private async waitForCreatedTarget(tabId: number): Promise<ChromeTab> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let tab: ChromeTab
      try { tab = await this.chrome.tabs.get(tabId) } catch { throw new LeaseError('target-not-found', 'created tab no longer exists') }
      const restriction = restrictedTargetReason(tab.url)
      if (restriction === null) return tab
      if (restriction !== 'missing-url') throw new LeaseError('restricted-target', `created tab is restricted (${restriction})`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new LeaseError('target-not-found', 'created tab URL did not become observable')
  }

  private validateRouting(input: { ownerId: string; ownerEpoch: number; sessionAgentId: string; tabId: number }): void {
    if (!input.ownerId || input.ownerId.length > 128 || input.ownerId.includes('\0') || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1 ||
      !input.sessionAgentId || input.sessionAgentId.length > 128 || input.sessionAgentId.includes('\0') || !Number.isSafeInteger(input.tabId) || input.tabId < 0) {
      throw new LeaseError('scope-mismatch', 'tab authority routing is invalid')
    }
  }

  private withReleaseReceipt(
    receipts: Map<string, ReleaseReceipt>,
    ownerId: string,
    ownerEpoch: number,
    tabIds: number[],
  ): Map<string, ReleaseReceipt> {
    const key = releaseKey(ownerId, ownerEpoch)
    const existing = receipts.get(key)
    const combined = [...new Set([...(existing?.tabIds ?? []), ...tabIds])].sort((left, right) => left - right)
    if (combined.length === 0 || combined.length > MAX_RELEASE_RECEIPT_TAB_IDS) throw new LeaseError('scope-mismatch', 'release receipt tab bound reached')
    const next = new Map(receipts)
    next.delete(key)
    const releasedAt = this.now()
    next.set(key, {
      ownerId,
      ownerEpoch,
      tabIds: combined,
      releasedAt,
      expiresAt: releasedAt + Math.min(this.ttlMs, MAX_RELEASE_RECEIPT_TTL_MS),
    })
    while (next.size > MAX_RELEASE_RECEIPTS) next.delete(next.keys().next().value!)
    return next
  }

  private parseDurableReceipts(value: unknown): Map<string, ReleaseReceipt> {
    if (value === undefined) return new Map()
    let bytes: number
    try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { throw new Error('durable release receipts are not serializable') }
    if (bytes > MAX_RELEASE_RECEIPT_BYTES || typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('durable release receipts exceed their storage bound')
    }
    const persisted = value as Record<string, unknown>
    if (Object.keys(persisted).sort().join(',') !== 'receipts,schemaVersion' || persisted.schemaVersion !== 1 ||
      !Array.isArray(persisted.receipts) || persisted.receipts.length > MAX_RELEASE_RECEIPTS || !persisted.receipts.every(validReceipt) ||
      persisted.receipts.some((receipt) => receipt.releasedAt > this.now())) {
      throw new Error('durable release receipts have an invalid schema')
    }
    const receipts = new Map<string, ReleaseReceipt>()
    for (const receipt of persisted.receipts) {
      const key = releaseKey(receipt.ownerId, receipt.ownerEpoch)
      if (receipts.has(key)) throw new Error('durable release receipts contain a duplicate owner epoch')
      receipts.set(key, structuredClone(receipt))
    }
    return receipts
  }

  private migrateLegacyReceipts(receipts: Map<string, ReleaseReceipt>, value: unknown): void {
    if (!Array.isArray(value)) return
    for (const item of value.slice(-MAX_RELEASE_RECEIPTS)) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Array.isArray(item[1]) ||
        item[1].length === 0 || item[1].length > MAX_RELEASE_RECEIPT_TAB_IDS ||
        !item[1].every((tabId) => Number.isSafeInteger(tabId) && tabId >= 0)) continue
      const separator = item[0].lastIndexOf('\0')
      const ownerId = item[0].slice(0, separator)
      const ownerEpoch = Number(item[0].slice(separator + 1))
      if (separator < 1 || ownerId.length > 128 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) continue
      const migrated = this.withReleaseReceipt(receipts, ownerId, ownerEpoch, item[1])
      receipts.clear()
      for (const [key, receipt] of migrated) receipts.set(key, receipt)
    }
  }

  private replaceReceipts(receipts: Map<string, ReleaseReceipt>): void {
    this.releaseReceipts.clear()
    for (const [key, receipt] of receipts) this.releaseReceipts.set(key, structuredClone(receipt))
  }

  private async persistAuthorities(): Promise<void> {
    const records = this.all()
    if (records.length > 0) await this.chrome.storage.session.set({ [SESSION_AUTHORITY_KEY]: records })
    else await this.chrome.storage.session.remove(SESSION_AUTHORITY_KEY)
  }

  private async persistReceipts(receipts: Map<string, ReleaseReceipt>): Promise<void> {
    const value: PersistedReleaseReceipts = { schemaVersion: 1, receipts: [...receipts.values()] }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RELEASE_RECEIPT_BYTES) {
      throw new LeaseError('scope-mismatch', 'release receipt storage bound reached')
    }
    if (value.receipts.length > 0) await this.chrome.storage.local.set({ [DURABLE_RELEASE_RECEIPTS_KEY]: value })
    else await this.chrome.storage.local.remove(DURABLE_RELEASE_RECEIPTS_KEY)
  }

  private mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function releaseKey(ownerId: string, ownerEpoch: number): string {
  return `${ownerId}\0${ownerEpoch}`
}
