import {
  EXTERNAL_CHROME_MAX_ARRAY_ITEMS,
  EXTERNAL_CHROME_MAX_CANDIDATE_TABS,
  EXTERNAL_CHROME_MAX_LABEL_LENGTH,
  EXTERNAL_CHROME_MAX_URL_LENGTH,
  type ExternalChromeChildPolicy,
} from '@forge/protocol'
import type { ChromeApi, ChromeTab } from './chrome-api.js'
import { candidateOrigin, restrictedTargetReason } from './restricted-target.js'

const SESSION_LEASE_KEY = 'forge.externalChrome.activeLease.v1'

export type LeaseState = 'LEASED_HUMAN' | 'CONTROLLING_AGENT' | 'INTERRUPTING' | 'LOST'

export interface LeaseRecord {
  leaseId: string
  leaseEpoch: number
  sessionAgentId: string
  tabIds: number[]
  groupId: number | null
  childPolicy: ExternalChromeChildPolicy
  state: LeaseState
  controlEpoch: number
  payloadVersion: string
  expiresAt: number
}

export class LeaseError extends Error {
  constructor(readonly code: 'lease-conflict' | 'lease-lost' | 'restricted-target' | 'target-not-found' | 'scope-mismatch', message: string) {
    super(message)
    this.name = 'LeaseError'
  }
}

export interface CandidateTab {
  windowId: number
  tabId: number
  groupId: number | null
  title: string
  origin: string
  active: boolean
  attached: boolean
  restricted: boolean
  debuggerConflict: boolean
}

export interface CandidateWindow {
  windowId: number
  focused: boolean
  groups: Array<{ groupId: number; title: string; collapsed: boolean }>
  tabs: CandidateTab[]
}

function requiredTabFields(tab: ChromeTab): { tabId: number; windowId: number } | null {
  return tab.id === undefined || tab.windowId === undefined ? null : { tabId: tab.id, windowId: tab.windowId }
}

function assertLeaseRecord(value: unknown): LeaseRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Partial<LeaseRecord>
  if (
    typeof candidate.leaseId !== 'string' ||
    !Number.isSafeInteger(candidate.leaseEpoch) ||
    typeof candidate.sessionAgentId !== 'string' ||
    !Array.isArray(candidate.tabIds) ||
    candidate.tabIds.some((tabId) => !Number.isSafeInteger(tabId)) ||
    (candidate.groupId !== null && !Number.isSafeInteger(candidate.groupId)) ||
    (candidate.childPolicy !== 'manual' && candidate.childPolicy !== 'include-opened-by-leased-tabs') ||
    !['LEASED_HUMAN', 'CONTROLLING_AGENT', 'INTERRUPTING', 'LOST'].includes(String(candidate.state)) ||
    !Number.isSafeInteger(candidate.controlEpoch) ||
    typeof candidate.payloadVersion !== 'string' ||
    !Number.isFinite(candidate.expiresAt)
  ) return null
  return candidate as LeaseRecord
}

export class LeaseManager {
  private active: LeaseRecord | null = null
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly chrome: ChromeApi,
    private readonly payloadVersion: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 15 * 60_000,
  ) {}

  current(): LeaseRecord | null {
    return this.active === null ? null : structuredClone(this.active)
  }

  async listCandidates(): Promise<CandidateWindow[]> {
    const [rawWindows, rawGroups, debuggerTargets] = await Promise.all([
      this.chrome.windows.getAll({ populate: true }),
      this.chrome.tabGroups.query({}),
      this.chrome.debugger.getTargets(),
    ])
    const conflictingTabs = new Set(debuggerTargets.filter((target) => target.attached === true && target.extensionId !== this.chrome.runtime.id).flatMap((target) => target.tabId === undefined ? [] : [target.tabId]))
    const windows = rawWindows.filter((window) => window.id !== undefined)
      .sort((left, right) => (left.id as number) - (right.id as number))
      .slice(0, EXTERNAL_CHROME_MAX_ARRAY_ITEMS)
    const groups = rawGroups.slice().sort((left, right) => left.id - right.id)
    let remainingTabs = EXTERNAL_CHROME_MAX_CANDIDATE_TABS
    let remainingGroups = EXTERNAL_CHROME_MAX_ARRAY_ITEMS
    return windows.map((window) => {
      const windowId = window.id as number
      const windowGroups = groups.filter((group) => group.windowId === windowId).slice(0, remainingGroups)
      remainingGroups -= windowGroups.length
      const tabs = (window.tabs ?? []).flatMap((tab) => {
        const ids = requiredTabFields(tab)
        if (ids === null) return []
        return [{
          ...ids,
          groupId: tab.groupId === undefined || tab.groupId < 0 ? null : tab.groupId,
          title: (tab.title ?? '').slice(0, EXTERNAL_CHROME_MAX_LABEL_LENGTH),
          origin: candidateOrigin(tab.url).slice(0, EXTERNAL_CHROME_MAX_URL_LENGTH),
          active: tab.active === true,
          attached: this.active?.tabIds.includes(ids.tabId) === true,
          restricted: restrictedTargetReason(tab.url) !== null,
          debuggerConflict: conflictingTabs.has(ids.tabId),
        }]
      }).sort((left, right) => left.tabId - right.tabId).slice(0, remainingTabs)
      remainingTabs -= tabs.length
      return {
        windowId,
        focused: window.focused,
        groups: windowGroups.map((group) => ({
          groupId: group.id,
          title: (group.title ?? '').slice(0, EXTERNAL_CHROME_MAX_LABEL_LENGTH),
          collapsed: group.collapsed,
        })),
        tabs,
      }
    })
  }

  claim(input: {
    leaseId: string
    leaseEpoch: number
    sessionAgentId: string
    tabIds: number[]
    groupId?: number
    childPolicy: ExternalChromeChildPolicy
  }): Promise<{ lease: LeaseRecord; tabs: ChromeTab[] }> {
    return this.mutate(() => this.claimUnlocked(input))
  }

  private async claimUnlocked(input: {
    leaseId: string
    leaseEpoch: number
    sessionAgentId: string
    tabIds: number[]
    groupId?: number
    childPolicy: ExternalChromeChildPolicy
  }): Promise<{ lease: LeaseRecord; tabs: ChromeTab[] }> {
    if (!input.leaseId || input.leaseId.length > 128 || !Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1 ||
      !input.sessionAgentId || input.sessionAgentId.length > 128) {
      throw new LeaseError('scope-mismatch', 'lease routing fields are invalid')
    }
    const tabIds = [...new Set(input.tabIds)].sort((left, right) => left - right)
    if (tabIds.length === 0 || tabIds.length > EXTERNAL_CHROME_MAX_CANDIDATE_TABS || tabIds.length !== input.tabIds.length) {
      throw new LeaseError('scope-mismatch', 'claim must contain a bounded non-empty unique tab set')
    }
    if (this.active !== null) {
      if (this.active.state === 'LOST') throw new LeaseError('lease-lost', 'the existing lease has already lost debugger ownership')
      const sameRouting = this.active.leaseId === input.leaseId && this.active.leaseEpoch === input.leaseEpoch
      const exactClaim = sameRouting && this.active.sessionAgentId === input.sessionAgentId &&
        this.active.groupId === (input.groupId ?? null) && this.active.childPolicy === input.childPolicy &&
        this.active.tabIds.length === tabIds.length && this.active.tabIds.every((tabId, index) => tabId === tabIds[index])
      if (!exactClaim) {
        throw new LeaseError('lease-conflict', sameRouting
          ? 'same lease ID and epoch were reused with different immutable scope'
          : 'another local session already owns this extension instance')
      }
      const tabs = await Promise.all(tabIds.map((tabId) => this.chrome.tabs.get(tabId)))
      return { lease: structuredClone(this.active), tabs }
    }
    const tabs = await Promise.all(tabIds.map(async (tabId) => {
      try {
        return await this.chrome.tabs.get(tabId)
      } catch {
        throw new LeaseError('target-not-found', `tab ${tabId} no longer exists`)
      }
    }))
    for (const tab of tabs) {
      const reason = restrictedTargetReason(tab.url)
      if (reason !== null) throw new LeaseError('restricted-target', `tab ${String(tab.id)} is restricted (${reason})`)
      if (input.groupId !== undefined && tab.groupId !== input.groupId) {
        throw new LeaseError('scope-mismatch', `tab ${String(tab.id)} is not in the selected group`)
      }
    }
    const lease: LeaseRecord = {
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      sessionAgentId: input.sessionAgentId,
      tabIds,
      groupId: input.groupId ?? null,
      childPolicy: input.childPolicy,
      state: 'LEASED_HUMAN',
      controlEpoch: 0,
      payloadVersion: this.payloadVersion,
      expiresAt: this.now() + this.ttlMs,
    }
    this.active = lease
    await this.persist()
    return { lease: structuredClone(lease), tabs }
  }

  includeChild(tabId: number, openerTabId: number): Promise<LeaseRecord | null> {
    return this.mutate(() => this.includeChildUnlocked(tabId, openerTabId))
  }

  private async includeChildUnlocked(tabId: number, openerTabId: number): Promise<LeaseRecord | null> {
    const lease = this.active
    if (lease === null || lease.state === 'LOST' || lease.childPolicy !== 'include-opened-by-leased-tabs' ||
      !lease.tabIds.includes(openerTabId) || lease.groupId === null || lease.tabIds.includes(tabId)) return null
    if (lease.tabIds.length >= EXTERNAL_CHROME_MAX_CANDIDATE_TABS) throw new LeaseError('scope-mismatch', 'lease tab bound reached')
    let tab: ChromeTab
    try { tab = await this.chrome.tabs.get(tabId) } catch { return null }
    if (tab.openerTabId !== openerTabId || restrictedTargetReason(tab.url) !== null) return null
    await this.chrome.tabs.group({ tabIds: [tabId], groupId: lease.groupId })
    this.active = { ...lease, tabIds: [...lease.tabIds, tabId].sort((left, right) => left - right) }
    await this.persist()
    return structuredClone(this.active)
  }

  create(input: { leaseId: string; leaseEpoch: number; sessionAgentId: string; url?: string; groupTitle: string }): Promise<{ lease: LeaseRecord; tab: ChromeTab }> {
    return this.mutate(() => this.createUnlocked(input))
  }

  private async createUnlocked(input: { leaseId: string; leaseEpoch: number; sessionAgentId: string; url?: string; groupTitle: string }): Promise<{ lease: LeaseRecord; tab: ChromeTab }> {
    if (!input.leaseId || input.leaseId.length > 128 || !Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1 ||
      !input.sessionAgentId || input.sessionAgentId.length > 128 || !input.groupTitle || input.groupTitle.length > EXTERNAL_CHROME_MAX_LABEL_LENGTH) {
      throw new LeaseError('scope-mismatch', 'create routing fields are invalid')
    }
    if (input.url !== undefined && restrictedTargetReason(input.url) !== null) {
      throw new LeaseError('restricted-target', 'the requested URL cannot be controlled')
    }
    const existing = this.active
    if (existing !== null && existing.tabIds.length >= EXTERNAL_CHROME_MAX_CANDIDATE_TABS) {
      throw new LeaseError('scope-mismatch', 'lease tab bound reached')
    }
    if (existing !== null && (existing.state === 'LOST' || existing.leaseId !== input.leaseId ||
      existing.leaseEpoch !== input.leaseEpoch || existing.sessionAgentId !== input.sessionAgentId || existing.groupId === null)) {
      throw new LeaseError(existing.state === 'LOST' ? 'lease-lost' : 'lease-conflict', 'created tabs must use the matching active lease and Forge-owned group')
    }
    const tab = await this.chrome.tabs.create({ url: input.url ?? 'https://forge.invalid/', active: true })
    if (tab.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return the created tab ID')
    try {
      if (existing !== null) {
        await this.chrome.tabs.group({ tabIds: [tab.id], groupId: existing.groupId as number })
        tab.groupId = existing.groupId as number
        this.active = { ...existing, tabIds: [...existing.tabIds, tab.id].sort((left, right) => left - right) }
        await this.persist()
        return { lease: structuredClone(this.active), tab }
      }
      const groupId = await this.chrome.tabs.group({ tabIds: [tab.id], ...(tab.windowId === undefined ? {} : { createProperties: { windowId: tab.windowId } }) })
      await this.chrome.tabGroups.update(groupId, { title: input.groupTitle, color: 'blue', collapsed: false })
      tab.groupId = groupId
      const claimed = await this.claimUnlocked({ ...input, tabIds: [tab.id], groupId, childPolicy: 'manual' })
      return { lease: claimed.lease, tab }
    } catch (error) {
      if (this.active?.leaseId === input.leaseId && this.active.leaseEpoch === input.leaseEpoch && this.active.tabIds.includes(tab.id)) {
        const remaining = this.active.tabIds.filter((id) => id !== tab.id)
        this.active = remaining.length === 0 ? null : { ...this.active, tabIds: remaining }
        if (this.active === null) await this.chrome.storage.session.remove(SESSION_LEASE_KEY).catch(() => undefined)
        else await this.persist().catch(() => undefined)
      }
      await this.chrome.tabs.remove(tab.id).catch(() => undefined)
      throw error
    }
  }

  rollbackCreatedTab(tabId: number, leaseId: string, leaseEpoch: number): Promise<void> {
    return this.mutate(async () => {
      const lease = this.active
      if (lease?.leaseId === leaseId && lease.leaseEpoch === leaseEpoch && lease.tabIds.includes(tabId)) {
        const remaining = lease.tabIds.filter((id) => id !== tabId)
        if (remaining.length === 0) {
          this.active = null
          await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
        } else {
          this.active = { ...lease, tabIds: remaining }
          await this.persist()
        }
      }
      await this.chrome.tabs.remove(tabId).catch(() => undefined)
    })
  }

  assertScope(leaseId: string, leaseEpoch: number, tabId: number): LeaseRecord {
    const lease = this.active
    if (lease === null || lease.state === 'LOST' || lease.leaseId !== leaseId || lease.leaseEpoch !== leaseEpoch) {
      throw new LeaseError('lease-lost', 'the lease is not active at this epoch')
    }
    if (!lease.tabIds.includes(tabId)) throw new LeaseError('scope-mismatch', 'tab is outside the lease')
    return structuredClone(lease)
  }

  beginAgentControl(leaseId: string, leaseEpoch: number, tabId: number): Promise<number> {
    return this.mutate(async () => {
      const lease = this.assertScope(leaseId, leaseEpoch, tabId)
      this.active = { ...lease, state: 'CONTROLLING_AGENT' }
      await this.persist()
      return lease.controlEpoch
    })
  }

  trustedHumanInput(tabId: number): Promise<LeaseRecord | null> {
    return this.mutate(async () => {
      if (this.active === null || !this.active.tabIds.includes(tabId)) return null
      this.active = { ...this.active, state: 'LEASED_HUMAN', controlEpoch: this.active.controlEpoch + 1 }
      await this.persist()
      return structuredClone(this.active)
    })
  }

  isOperationCurrent(leaseId: string, leaseEpoch: number, controlEpoch: number): boolean {
    return this.active?.leaseId === leaseId && this.active.leaseEpoch === leaseEpoch && this.active.controlEpoch === controlEpoch && this.active.state === 'CONTROLLING_AGENT'
  }

  finishAgentControl(leaseId: string, leaseEpoch: number, controlEpoch: number): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.isOperationCurrent(leaseId, leaseEpoch, controlEpoch) || this.active === null) return false
      this.active = { ...this.active, state: 'LEASED_HUMAN' }
      await this.persist()
      return true
    })
  }

  markLost(): Promise<void> {
    return this.mutate(async () => {
      if (this.active === null) return
      this.active = { ...this.active, state: 'LOST' }
      await this.persist()
    })
  }

  beginRelease(leaseId: string, leaseEpoch: number): Promise<number[]> {
    return this.mutate(async () => {
      if (this.active === null) return []
      if (this.active.leaseId !== leaseId || this.active.leaseEpoch !== leaseEpoch) throw new LeaseError('lease-lost', 'cannot release a stale lease epoch')
      if (this.active.state !== 'LOST') {
        this.active = { ...this.active, state: 'LOST' }
        await this.persist()
      }
      return [...this.active.tabIds]
    })
  }

  completeRelease(leaseId: string, leaseEpoch: number): Promise<number[]> {
    return this.mutate(async () => {
      if (this.active === null) return []
      if (this.active.leaseId !== leaseId || this.active.leaseEpoch !== leaseEpoch) throw new LeaseError('lease-lost', 'cannot complete a stale lease epoch')
      const released = [...this.active.tabIds]
      this.active = null
      await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
      return released
    })
  }

  /** Immediate state-only release for claim rollback before debugger authority exists. */
  release(leaseId: string, leaseEpoch: number): Promise<number[]> {
    return this.completeRelease(leaseId, leaseEpoch)
  }

  expireIfNeeded(): Promise<LeaseRecord | null> {
    return this.mutate(async () => {
      if (this.active === null || (this.active.state !== 'LOST' && this.active.expiresAt > this.now())) return null
      if (this.active.state !== 'LOST') {
        this.active = { ...this.active, state: 'LOST' }
        await this.persist()
      }
      return structuredClone(this.active)
    })
  }

  recover(): Promise<LeaseRecord | null> {
    return this.mutate(() => this.recoverUnlocked())
  }

  private async recoverUnlocked(): Promise<LeaseRecord | null> {
    const stored = await this.chrome.storage.session.get(SESSION_LEASE_KEY)
    const lease = assertLeaseRecord(stored[SESSION_LEASE_KEY])
    if (lease === null || lease.payloadVersion !== this.payloadVersion) {
      await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
      this.active = null
      return null
    }
    try {
      const tabs = await Promise.all(lease.tabIds.map((tabId) => this.chrome.tabs.get(tabId)))
      if (lease.state !== 'LOST' && tabs.some((tab) => restrictedTargetReason(tab.url) !== null)) throw new Error('restricted')
    } catch {
      // Missing tabs no longer retain debugger ownership. Other release failures
      // remain represented by a valid LOST record and are retried by Runtime.
      await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
      this.active = null
      return null
    }
    this.active = lease.expiresAt <= this.now() && lease.state !== 'LOST' ? { ...lease, state: 'LOST' } : lease
    if (this.active !== lease) await this.persist()
    return structuredClone(this.active)
  }

  private async persist(): Promise<void> {
    if (this.active !== null) await this.chrome.storage.session.set({ [SESSION_LEASE_KEY]: this.active })
  }

  private mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
