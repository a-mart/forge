import type { ChromeApi, ChromeTab } from './chrome-api.js'
import { restrictedTargetReason } from './restricted-target.js'

const SESSION_AUTHORITY_KEY = 'forge.externalChrome.tabAuthority.v2'
const RELEASE_RECEIPTS_KEY = 'forge.externalChrome.releaseReceipts.v1'
const MAX_AUTHORITIES = 128
const MAX_RELEASE_RECEIPTS = 128

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

export class LeaseManager {
  private readonly authorities = new Map<number, TabAuthorityRecord>()
  private readonly releaseReceipts = new Map<string, number[]>()
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

  /** Exact active-or-receipted scope makes release retryable after a lost acknowledgement. */
  releaseScope(ownerId: string, ownerEpoch: number): number[] {
    const active = this.all().filter((record) => record.ownerId === ownerId && record.ownerEpoch === ownerEpoch).map((record) => record.tabId)
    return active.length > 0 ? active : [...(this.releaseReceipts.get(releaseKey(ownerId, ownerEpoch)) ?? [])]
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
      await this.persist()
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
      await this.persist()
      return authority.controlEpoch
    })
  }

  trustedHumanInput(tabId: number): Promise<TabAuthorityRecord | null> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return null
      const interrupted = { ...authority, state: 'human' as const, controlEpoch: authority.controlEpoch + 1 }
      this.authorities.set(tabId, interrupted)
      await this.persist()
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
      await this.persist()
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
      await this.persist()
    })
  }

  release(ownerId: string, ownerEpoch: number, tabId: number): Promise<boolean> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return false
      if (authority.ownerId !== ownerId || authority.ownerEpoch !== ownerEpoch) throw new LeaseError('lease-lost', 'exact tab release compare-and-set failed')
      this.authorities.delete(tabId)
      await this.persist()
      return true
    })
  }

  releaseOwner(ownerId: string, ownerEpoch: number): Promise<number[]> {
    return this.mutate(async () => {
      const key = releaseKey(ownerId, ownerEpoch)
      const matches = this.all().filter((record) => record.ownerId === ownerId && record.ownerEpoch === ownerEpoch)
      const released = matches.length > 0 ? matches.map((record) => record.tabId) : [...(this.releaseReceipts.get(key) ?? [])]
      for (const record of matches) this.authorities.delete(record.tabId)
      if (matches.length > 0) this.rememberRelease(key, released)
      await this.persist()
      return released
    })
  }

  async recover(): Promise<TabAuthorityRecord[]> {
    return this.mutate(async () => {
      const stored = await this.chrome.storage.session.get([SESSION_AUTHORITY_KEY, RELEASE_RECEIPTS_KEY])
      const records = Array.isArray(stored[SESSION_AUTHORITY_KEY]) ? stored[SESSION_AUTHORITY_KEY] as unknown[] : []
      const receipts = Array.isArray(stored[RELEASE_RECEIPTS_KEY]) ? stored[RELEASE_RECEIPTS_KEY] as unknown[] : []
      this.authorities.clear()
      this.releaseReceipts.clear()
      for (const value of receipts.slice(-MAX_RELEASE_RECEIPTS)) {
        if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[1]) || !value[1].every(Number.isSafeInteger)) continue
        this.releaseReceipts.set(value[0], [...value[1]])
      }
      for (const record of records.filter(validRecord).slice(0, MAX_AUTHORITIES)) {
        if (record.payloadVersion !== this.payloadVersion || record.expiresAt <= this.now()) continue
        try {
          const tab = await this.chrome.tabs.get(record.tabId)
          if (restrictedTargetReason(tab.url) !== null) continue
        } catch { continue }
        // MV3 restart never assumes a debugger survived. Durable ownership resumes human/unattached.
        this.authorities.set(record.tabId, { ...record, state: record.state === 'lost' ? 'lost' : 'human' })
      }
      await this.persist()
      return this.all()
    })
  }

  async expire(): Promise<TabAuthorityRecord[]> {
    return this.mutate(async () => {
      const expired = this.all().filter((record) => record.expiresAt <= this.now())
      for (const record of expired) this.authorities.delete(record.tabId)
      for (const record of expired) this.rememberRelease(releaseKey(record.ownerId, record.ownerEpoch), [record.tabId])
      if (expired.length > 0) await this.persist()
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
    if (!input.ownerId || input.ownerId.length > 128 || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1 ||
      !input.sessionAgentId || input.sessionAgentId.length > 128 || !Number.isSafeInteger(input.tabId) || input.tabId < 0) {
      throw new LeaseError('scope-mismatch', 'tab authority routing is invalid')
    }
  }

  private rememberRelease(key: string, tabIds: number[]): void {
    const combined = [...new Set([...(this.releaseReceipts.get(key) ?? []), ...tabIds])].sort((left, right) => left - right)
    this.releaseReceipts.delete(key)
    this.releaseReceipts.set(key, combined)
    while (this.releaseReceipts.size > MAX_RELEASE_RECEIPTS) this.releaseReceipts.delete(this.releaseReceipts.keys().next().value!)
  }

  private async persist(): Promise<void> {
    const records = this.all()
    const receipts = [...this.releaseReceipts.entries()]
    const updates: Record<string, unknown> = {}
    if (records.length > 0) updates[SESSION_AUTHORITY_KEY] = records
    if (receipts.length > 0) updates[RELEASE_RECEIPTS_KEY] = receipts
    if (Object.keys(updates).length > 0) await this.chrome.storage.session.set(updates)
    const removals = [
      ...(records.length === 0 ? [SESSION_AUTHORITY_KEY] : []),
      ...(receipts.length === 0 ? [RELEASE_RECEIPTS_KEY] : []),
    ]
    if (removals.length > 0) await this.chrome.storage.session.remove(removals)
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
