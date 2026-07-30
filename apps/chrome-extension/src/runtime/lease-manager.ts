import {
  BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS,
  EXTERNAL_CHROME_MAX_LABEL_LENGTH,
  EXTERNAL_CHROME_MAX_URL_LENGTH,
  type ExternalChromeInventoryTab,
} from '@forge/protocol'
import type { ChromeApi, ChromeTab } from './chrome-api.js'
import { restrictedTargetReason } from './restricted-target.js'

const SESSION_AUTHORITY_KEY = 'forge.externalChrome.tabAuthority.v2'
const NEUTRAL_TARGETS_KEY = 'forge.externalChrome.neutralTargets.v1'
const LEGACY_SESSION_RELEASE_RECEIPTS_KEY = 'forge.externalChrome.releaseReceipts.v1'
const DURABLE_RELEASE_RECEIPTS_KEY = 'forge.externalChrome.releaseReceipts.v2'
const MAX_AUTHORITIES = 128
const MAX_NEUTRAL_TARGETS = 128
const MAX_RELEASE_RECEIPTS = 128
const MAX_RELEASE_RECEIPT_TAB_IDS = 128
const MAX_RELEASE_RECEIPT_BYTES = 64 * 1_024
const MAX_RELEASE_RECEIPT_TTL_MS = 15 * 60_000
const NEUTRAL_INITIAL_URL = 'about:blank'

export type TabAuthorityState = 'idle' | 'agent' | 'lost'

/** A durable CAS record for one Chrome tab. No record grants profile- or window-wide authority. */
export interface TabAuthorityRecord {
  tabId: number
  ownerId: string
  ownerEpoch: number
  sessionAgentId: string
  state: TabAuthorityState
  controlEpoch: number
  createdByForge: boolean
  initialNavigationPending: boolean
  payloadVersion: string
  expiresAt: number
}

type PersistedTabAuthorityRecord = Omit<TabAuthorityRecord, 'initialNavigationPending' | 'state'> & {
  initialNavigationPending?: boolean
  /** `human` is the pre-control-session name for operation-idle authority. */
  state: TabAuthorityState | 'human'
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

interface PersistedNeutralTargets {
  schemaVersion: 1
  tabIds: number[]
}

export class LeaseError extends Error {
  constructor(readonly code: 'lease-conflict' | 'lease-lost' | 'restricted-target' | 'target-not-found' | 'scope-mismatch', message: string) {
    super(message)
    this.name = 'LeaseError'
  }
}

function validRecord(value: unknown): value is PersistedTabAuthorityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Partial<PersistedTabAuthorityRecord>
  return Number.isSafeInteger(record.tabId) && (record.tabId as number) >= 0 &&
    typeof record.ownerId === 'string' && record.ownerId.length > 0 && record.ownerId.length <= 128 && !record.ownerId.includes('\0') &&
    Number.isSafeInteger(record.ownerEpoch) && (record.ownerEpoch as number) > 0 &&
    typeof record.sessionAgentId === 'string' && record.sessionAgentId.length > 0 && record.sessionAgentId.length <= 128 && !record.sessionAgentId.includes('\0') &&
    ['human', 'idle', 'agent', 'lost'].includes(String(record.state)) && Number.isSafeInteger(record.controlEpoch) && (record.controlEpoch as number) >= 0 &&
    typeof record.createdByForge === 'boolean' && (record.initialNavigationPending === undefined || typeof record.initialNavigationPending === 'boolean') &&
    typeof record.payloadVersion === 'string' && record.payloadVersion.length > 0 && record.payloadVersion.length <= 256 &&
    Number.isFinite(record.expiresAt) && (record.expiresAt as number) >= 0
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
  private readonly neutralTargets = new Set<number>()
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

  async eligibleTabs(sessionAgentId: string): Promise<{ tabs: ExternalChromeInventoryTab[]; truncated: boolean }> {
    const windows = await this.chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    const eligible = windows.flatMap((window) => {
      if (window.type !== 'normal' || !Number.isSafeInteger(window.id) || (window.id as number) < 0) return []
      return (window.tabs ?? []).flatMap((tab): ExternalChromeInventoryTab[] => {
        if (!Number.isSafeInteger(tab.id) || (tab.id as number) < 0 || tab.windowId !== window.id || restrictedTargetReason(tab.url) !== null) return []
        const authority = this.authorities.get(tab.id as number)
        if (authority && (authority.state === 'lost' || authority.sessionAgentId !== sessionAgentId)) return []
        return [{
          tabId: tab.id as number,
          windowId: window.id as number,
          title: (tab.title ?? '').slice(0, EXTERNAL_CHROME_MAX_LABEL_LENGTH),
          url: (tab.url ?? '').slice(0, EXTERNAL_CHROME_MAX_URL_LENGTH),
          active: tab.active === true,
          windowFocused: window.focused,
          lastAccessed: Number.isFinite(tab.lastAccessed) && (tab.lastAccessed as number) >= 0 ? tab.lastAccessed as number : 0,
        }]
      })
    }).sort(compareEligibleTabs)
    return {
      tabs: eligible.slice(0, BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS),
      truncated: eligible.length > BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS,
    }
  }

  async createNeutralTab(): Promise<{ tab: ChromeTab; createdByForge: true }> {
    const created = await this.chrome.tabs.create({
      url: NEUTRAL_INITIAL_URL,
      active: false,
    })
    if (created.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return a created tab ID')
    // Real Chrome may resolve tabs.create while the new tab still has no observable URL.
    // The exact background about:blank target is accepted only as a Forge-created,
    // one-transition authority; every ordinary acquisition keeps the restriction check.
    try {
      const tab = await this.waitForCreatedTarget(created.id, true)
      return { tab, createdByForge: true }
    } catch (error) {
      try { await this.chrome.tabs.remove(created.id) } catch { /* exact created tab already disappeared */ }
      throw error
    }
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
      const existing = this.authorities.get(input.tabId)
      const hasNeutralProvenance = input.createdByForge === true || this.neutralTargets.has(input.tabId)
        || existing?.createdByForge === true && existing.initialNavigationPending
      const initialNavigationPending = await this.observeNeutralInitialTarget(tab, hasNeutralProvenance)
      const restriction = restrictedTargetReason(tab.url)
      if (restriction !== null && !initialNavigationPending) throw new LeaseError('restricted-target', `tab is restricted (${restriction})`)
      const clearNeutralTarget = !initialNavigationPending && this.neutralTargets.has(input.tabId)
      if (initialNavigationPending && tab.url === undefined) tab = { ...tab, url: NEUTRAL_INITIAL_URL }
      if (existing !== undefined) {
        const exact = existing.ownerId === input.ownerId && existing.ownerEpoch === input.ownerEpoch &&
          existing.sessionAgentId === input.sessionAgentId && existing.state !== 'lost'
        if (!exact) throw new LeaseError(existing.state === 'lost' ? 'lease-lost' : 'lease-conflict', 'tab authority compare-and-set failed')
        const addNeutralTarget = initialNavigationPending && !this.neutralTargets.has(input.tabId)
        if (addNeutralTarget) this.addNeutralTarget(input.tabId)
        if (clearNeutralTarget) this.neutralTargets.delete(input.tabId)
        if (addNeutralTarget || clearNeutralTarget) {
          try {
            await this.persistAuthorities()
          } catch (error) {
            if (addNeutralTarget) this.neutralTargets.delete(input.tabId)
            if (clearNeutralTarget) this.neutralTargets.add(input.tabId)
            throw error
          }
        }
        return { authority: structuredClone(existing), tab }
      }
      if (input.expectedOwnerEpoch !== undefined && input.expectedOwnerEpoch !== 0) {
        throw new LeaseError('lease-conflict', 'tab authority compare-and-set expected an existing epoch')
      }
      if (this.authorities.size >= MAX_AUTHORITIES) throw new LeaseError('scope-mismatch', 'tab authority bound reached')
      if (initialNavigationPending) this.addNeutralTarget(input.tabId)
      if (clearNeutralTarget) this.neutralTargets.delete(input.tabId)
      const authority: TabAuthorityRecord = {
        tabId: input.tabId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        sessionAgentId: input.sessionAgentId,
        state: 'idle',
        controlEpoch: 0,
        createdByForge: input.createdByForge === true || initialNavigationPending,
        initialNavigationPending,
        payloadVersion: this.payloadVersion,
        expiresAt: this.now() + this.ttlMs,
      }
      this.authorities.set(input.tabId, authority)
      try {
        await this.persistAuthorities()
      } catch (error) {
        this.authorities.delete(input.tabId)
        if (initialNavigationPending) this.neutralTargets.delete(input.tabId)
        if (clearNeutralTarget) this.neutralTargets.add(input.tabId)
        throw error
      }
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
      try {
        await this.persistAuthorities()
      } catch (error) {
        this.authorities.set(tabId, authority)
        throw error
      }
      return authority.controlEpoch
    })
  }

  completeInitialNavigation(ownerId: string, ownerEpoch: number, tabId: number): Promise<TabAuthorityRecord> {
    return this.mutate(async () => {
      const authority = this.assertScope(ownerId, ownerEpoch, tabId)
      if (!authority.initialNavigationPending) return authority
      let tab: ChromeTab
      try { tab = await this.chrome.tabs.get(tabId) } catch { throw new LeaseError('target-not-found', 'tab no longer exists') }
      const restriction = restrictedTargetReason(tab.url)
      if (restriction !== null) throw new LeaseError('restricted-target', `initial navigation remained restricted (${restriction})`)
      const completed = { ...authority, initialNavigationPending: false }
      const hadNeutralTarget = this.neutralTargets.delete(tabId)
      this.authorities.set(tabId, completed)
      try {
        await this.persistAuthorities()
      } catch (error) {
        this.authorities.set(tabId, authority)
        if (hadNeutralTarget) this.neutralTargets.add(tabId)
        throw error
      }
      return structuredClone(completed)
    })
  }

  forgetNeutralTarget(tabId: number): Promise<void> {
    return this.mutate(async () => {
      if (!this.neutralTargets.delete(tabId)) return
      try { await this.persistAuthorities() }
      catch (error) { this.neutralTargets.add(tabId); throw error }
    })
  }

  trustedHumanInput(tabId: number): Promise<TabAuthorityRecord | null> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) return null
      const interrupted = { ...authority, state: 'idle' as const, controlEpoch: authority.controlEpoch + 1 }
      this.authorities.set(tabId, interrupted)
      await this.persistAuthorities()
      return structuredClone(interrupted)
    })
  }

  isAuthorityCurrent(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): boolean {
    const authority = this.authorities.get(tabId)
    return authority?.ownerId === ownerId && authority.ownerEpoch === ownerEpoch && authority.controlEpoch === controlEpoch && authority.state !== 'lost'
  }

  isOperationCurrent(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): boolean {
    return this.isAuthorityCurrent(ownerId, ownerEpoch, tabId, controlEpoch) && this.authorities.get(tabId)?.state === 'agent'
  }

  finishAgentControl(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.isOperationCurrent(ownerId, ownerEpoch, tabId, controlEpoch)) return false
      const authority = this.authorities.get(tabId)!
      this.authorities.set(tabId, { ...authority, state: 'idle' })
      try {
        await this.persistAuthorities()
      } catch (error) {
        this.authorities.set(tabId, authority)
        throw error
      }
      return true
    })
  }

  /**
   * Revokes one operation without releasing its logical lease. The epoch advances before debugger
   * detach, so a timed-out or navigation-stale command cannot regain authority, while a later
   * explicitly requested operation may reattach under the same exact owner epoch.
   */
  cancelAgentControl(ownerId: string, ownerEpoch: number, tabId: number, controlEpoch: number): Promise<boolean> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined || authority.ownerId !== ownerId || authority.ownerEpoch !== ownerEpoch ||
        authority.controlEpoch !== controlEpoch || authority.state !== 'agent') return false
      this.authorities.set(tabId, { ...authority, state: 'idle', controlEpoch: authority.controlEpoch + 1 })
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

  /**
   * Records proof that Chrome destroyed one exact target. The receipt is durable before session
   * authority is forgotten, so a later owner release can acknowledge the original tab ID even
   * after a worker or full browser restart.
   */
  recordClosedTab(ownerId: string, ownerEpoch: number, tabId: number): Promise<boolean> {
    return this.mutate(async () => {
      const authority = this.authorities.get(tabId)
      if (authority === undefined) {
        const receipt = this.releaseReceipts.get(releaseKey(ownerId, ownerEpoch))
        return receipt?.tabIds.includes(tabId) === true && receipt.expiresAt > this.now()
      }
      if (authority.ownerId !== ownerId || authority.ownerEpoch !== ownerEpoch) {
        throw new LeaseError('lease-lost', 'exact closed-tab release compare-and-set failed')
      }
      const nextReceipts = this.withReleaseReceipt(this.releaseReceipts, ownerId, ownerEpoch, [tabId])
      // If this write fails, session authority remains available for an alarm or restart retry.
      await this.persistReceipts(nextReceipts)
      this.replaceReceipts(nextReceipts)
      this.authorities.delete(tabId)
      try {
        await this.persistAuthorities()
      } catch (error) {
        this.authorities.set(tabId, authority)
        throw error
      }
      return true
    })
  }

  /** Compatibility facade for callers releasing the one exact tab leased by an owner epoch. */
  async release(ownerId: string, ownerEpoch: number, tabId: number): Promise<boolean> {
    const scope = this.releaseScope(ownerId, ownerEpoch)
    if (!scope.includes(tabId)) throw new LeaseError('lease-lost', 'exact tab release compare-and-set failed')
    await this.releaseOwner(ownerId, ownerEpoch)
    return true
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
      const exactReleasedScope = [...nextReceipts.get(key)!.tabIds]
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
      return exactReleasedScope
    })
  }

  /** Expiry is a revocation signal; Runtime must detach before creating a release receipt. */
  expired(): TabAuthorityRecord[] {
    return this.all().filter((record) => record.expiresAt <= this.now())
  }

  releaseReports(): Array<{ ownerId: string; ownerEpoch: number; state: 'acquired' | 'released'; tabIds: number[] }> {
    const active = new Map<string, { ownerId: string; ownerEpoch: number; tabIds: number[] }>()
    for (const authority of this.authorities.values()) {
      const key = releaseKey(authority.ownerId, authority.ownerEpoch)
      const report = active.get(key) ?? { ownerId: authority.ownerId, ownerEpoch: authority.ownerEpoch, tabIds: [] }
      report.tabIds.push(authority.tabId)
      active.set(key, report)
    }
    return [
      ...[...active.values()].map((report) => ({ ...report, state: 'acquired' as const, tabIds: report.tabIds.sort((a, b) => a - b) })),
      ...[...this.releaseReceipts.values()]
        .filter((receipt) => receipt.expiresAt > this.now() && !active.has(releaseKey(receipt.ownerId, receipt.ownerEpoch)))
        .map((receipt) => ({ ownerId: receipt.ownerId, ownerEpoch: receipt.ownerEpoch, state: 'released' as const, tabIds: [...receipt.tabIds] })),
    ].sort((left, right) => left.ownerId.localeCompare(right.ownerId) || left.ownerEpoch - right.ownerEpoch)
  }

  async recover(): Promise<TabAuthorityRecord[]> {
    return this.mutate(async () => {
      const [sessionStored, localStored] = await Promise.all([
        this.chrome.storage.session.get([SESSION_AUTHORITY_KEY, NEUTRAL_TARGETS_KEY, LEGACY_SESSION_RELEASE_RECEIPTS_KEY]),
        this.chrome.storage.local.get(DURABLE_RELEASE_RECEIPTS_KEY),
      ])
      const storedAuthorities = sessionStored[SESSION_AUTHORITY_KEY]
      if (storedAuthorities !== undefined && (!Array.isArray(storedAuthorities) || storedAuthorities.length > MAX_AUTHORITIES ||
        !storedAuthorities.every(validRecord) || new Set(storedAuthorities.map((record) => record.tabId)).size !== storedAuthorities.length)) {
        throw new Error('tab authority storage is invalid')
      }
      const records = (storedAuthorities ?? []) as PersistedTabAuthorityRecord[]
      const recoveredNeutralTargets = new Set<number>()
      for (const tabId of this.parseNeutralTargets(sessionStored[NEUTRAL_TARGETS_KEY])) {
        try {
          const tab = await this.chrome.tabs.get(tabId)
          if (await this.observeNeutralInitialTarget(tab, true)) recoveredNeutralTargets.add(tabId)
        } catch { /* stale session provenance is discarded */ }
      }
      let nextReceipts = this.parseDurableReceipts(localStored[DURABLE_RELEASE_RECEIPTS_KEY])
      this.migrateLegacyReceipts(nextReceipts, sessionStored[LEGACY_SESSION_RELEASE_RECEIPTS_KEY])
      for (const [key, receipt] of nextReceipts) if (receipt.expiresAt <= this.now()) nextReceipts.delete(key)

      const nextAuthorities = new Map<number, TabAuthorityRecord>()
      for (const record of records) {
        let tab: ChromeTab
        try {
          tab = await this.chrome.tabs.get(record.tabId)
        } catch {
          // Target destruction is physical detach proof. Persist the exact receipt before the
          // stale session record is removed; a failed local write leaves that record for retry.
          nextReceipts = this.withReleaseReceipt(nextReceipts, record.ownerId, record.ownerEpoch, [record.tabId])
          recoveredNeutralTargets.delete(record.tabId)
          continue
        }
        const initialNavigationPending = record.createdByForge &&
          await this.observeNeutralInitialTarget(tab, recoveredNeutralTargets.has(record.tabId)) && record.initialNavigationPending !== false
        if (!initialNavigationPending && record.initialNavigationPending === false) recoveredNeutralTargets.delete(record.tabId)
        const needsTerminalCleanup = record.payloadVersion !== this.payloadVersion || record.expiresAt <= this.now() ||
          record.state === 'lost' || restrictedTargetReason(tab.url) !== null && !initialNavigationPending
        // A live target that cannot safely resume remains exact lost authority. Runtime first
        // reconciles/detaches any debugger that survived, then writes its release receipt.
        nextAuthorities.set(record.tabId, {
          ...record,
          initialNavigationPending,
          state: needsTerminalCleanup ? 'lost' : 'idle',
        })
        if (initialNavigationPending) {
          if (!recoveredNeutralTargets.has(record.tabId) && recoveredNeutralTargets.size >= MAX_NEUTRAL_TARGETS) {
            throw new Error('neutral target provenance exceeds its storage bound')
          }
          recoveredNeutralTargets.add(record.tabId)
        }
      }
      await this.persistReceipts(nextReceipts)
      await this.chrome.storage.session.remove(LEGACY_SESSION_RELEASE_RECEIPTS_KEY)
      this.authorities.clear()
      for (const [tabId, authority] of nextAuthorities) this.authorities.set(tabId, authority)
      this.neutralTargets.clear()
      for (const tabId of recoveredNeutralTargets) this.neutralTargets.add(tabId)
      this.replaceReceipts(nextReceipts)
      await this.persistAuthorities()
      return this.all()
    })
  }

  async hasAuthorizedNeutralInitialTarget(tab: ChromeTab): Promise<boolean> {
    return this.observeNeutralInitialTarget(tab, tab.id !== undefined && this.neutralTargets.has(tab.id))
  }

  private async observeNeutralInitialTarget(tab: ChromeTab, hasProvenance: boolean): Promise<boolean> {
    if (!hasProvenance) return false
    if (isNeutralInitialTarget(tab)) return true
    if (tab.pendingUrl !== undefined || tab.id === undefined || restrictedTargetReason(tab.url) !== 'missing-url') return false
    try {
      const frame = await this.chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 })
      return frame?.url === NEUTRAL_INITIAL_URL
    } catch { return false }
  }

  private addNeutralTarget(tabId: number): void {
    if (this.neutralTargets.has(tabId)) return
    if (this.neutralTargets.size >= MAX_NEUTRAL_TARGETS) throw new LeaseError('scope-mismatch', 'neutral target provenance bound reached')
    this.neutralTargets.add(tabId)
  }

  private parseNeutralTargets(value: unknown): number[] {
    if (value === undefined) return []
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('neutral target provenance is invalid')
    const persisted = value as Partial<PersistedNeutralTargets>
    if (Object.keys(persisted).sort().join(',') !== 'schemaVersion,tabIds' || persisted.schemaVersion !== 1 ||
      !Array.isArray(persisted.tabIds) || persisted.tabIds.length > MAX_NEUTRAL_TARGETS ||
      !persisted.tabIds.every((tabId) => Number.isSafeInteger(tabId) && tabId >= 0) ||
      new Set(persisted.tabIds).size !== persisted.tabIds.length) {
      throw new Error('neutral target provenance is invalid')
    }
    return [...persisted.tabIds]
  }

  private async waitForCreatedTarget(tabId: number, allowNeutralInitialTarget: boolean): Promise<ChromeTab> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let tab: ChromeTab
      try { tab = await this.chrome.tabs.get(tabId) } catch { throw new LeaseError('target-not-found', 'created tab no longer exists') }
      const restriction = restrictedTargetReason(tab.url)
      if (restriction === null || (allowNeutralInitialTarget && isNeutralInitialTarget(tab))) return tab
      if (allowNeutralInitialTarget && restriction === 'missing-url') {
        if (tab.pendingUrl !== undefined) throw new LeaseError('restricted-target', 'created tab changed before neutral authority was established')
        let frame: { url: string } | null = null
        try { frame = await this.chrome.webNavigation.getFrame({ tabId, frameId: 0 }) } catch { /* not committed yet */ }
        if (frame?.url === NEUTRAL_INITIAL_URL) return { ...tab, url: NEUTRAL_INITIAL_URL }
        if (frame !== null) throw new LeaseError('restricted-target', 'created tab changed before neutral authority was established')
      }
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
    const neutral: PersistedNeutralTargets = { schemaVersion: 1, tabIds: [...this.neutralTargets].sort((left, right) => left - right) }
    const values: Record<string, unknown> = {}
    const removals: string[] = []
    if (records.length > 0) values[SESSION_AUTHORITY_KEY] = records
    else removals.push(SESSION_AUTHORITY_KEY)
    if (neutral.tabIds.length > 0) values[NEUTRAL_TARGETS_KEY] = neutral
    else removals.push(NEUTRAL_TARGETS_KEY)
    if (Object.keys(values).length > 0) await this.chrome.storage.session.set(values)
    if (removals.length > 0) await this.chrome.storage.session.remove(removals)
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

function isNeutralInitialTarget(tab: ChromeTab): boolean {
  return tab.url === NEUTRAL_INITIAL_URL || (tab.url === undefined && tab.pendingUrl === NEUTRAL_INITIAL_URL)
}

function compareEligibleTabs(left: ExternalChromeInventoryTab, right: ExternalChromeInventoryTab): number {
  return Number(right.active) - Number(left.active)
    || Number(right.windowFocused) - Number(left.windowFocused)
    || right.lastAccessed - left.lastAccessed
    || left.windowId - right.windowId
    || left.tabId - right.tabId
}

function releaseKey(ownerId: string, ownerEpoch: number): string {
  return `${ownerId}\0${ownerEpoch}`
}
