import { EXTERNAL_CHROME_MAX_CANDIDATE_TABS, type ExternalChromeChildPolicy } from '@forge/protocol'
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
    const [windows, groups] = await Promise.all([
      this.chrome.windows.getAll({ populate: true }),
      this.chrome.tabGroups.query({}),
    ])
    return windows
      .flatMap((window) => window.id === undefined ? [] : [{
        windowId: window.id,
        focused: window.focused,
        groups: groups
          .filter((group) => group.windowId === window.id)
          .map((group) => ({ groupId: group.id, title: group.title ?? '', collapsed: group.collapsed }))
          .sort((left, right) => left.groupId - right.groupId),
        tabs: (window.tabs ?? [])
          .flatMap((tab) => {
            const ids = requiredTabFields(tab)
            if (ids === null) return []
            return [{
              ...ids,
              groupId: tab.groupId === undefined || tab.groupId < 0 ? null : tab.groupId,
              title: tab.title ?? '',
              origin: candidateOrigin(tab.url),
              active: tab.active === true,
              attached: this.active?.tabIds.includes(ids.tabId) === true,
              restricted: restrictedTargetReason(tab.url) !== null,
            }]
          })
          .sort((left, right) => left.tabId - right.tabId),
      }])
      .sort((left, right) => left.windowId - right.windowId)
  }

  async claim(input: {
    leaseId: string
    leaseEpoch: number
    sessionAgentId: string
    tabIds: number[]
    groupId?: number
    childPolicy: ExternalChromeChildPolicy
  }): Promise<{ lease: LeaseRecord; tabs: ChromeTab[] }> {
    if (this.active !== null && (this.active.leaseId !== input.leaseId || this.active.leaseEpoch !== input.leaseEpoch)) {
      throw new LeaseError('lease-conflict', 'another local session already owns this extension instance')
    }
    const tabIds = [...new Set(input.tabIds)].sort((left, right) => left - right)
    if (tabIds.length === 0 || tabIds.length > EXTERNAL_CHROME_MAX_CANDIDATE_TABS) {
      throw new LeaseError('scope-mismatch', 'claim must contain a bounded non-empty tab set')
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

  async create(input: { leaseId: string; leaseEpoch: number; sessionAgentId: string; url?: string; groupTitle: string }): Promise<{ lease: LeaseRecord; tab: ChromeTab }> {
    if (input.url !== undefined && restrictedTargetReason(input.url) !== null) {
      throw new LeaseError('restricted-target', 'the requested URL cannot be controlled')
    }
    const tab = await this.chrome.tabs.create({ ...(input.url === undefined ? {} : { url: input.url }), active: true })
    if (tab.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return the created tab ID')
    const groupId = await this.chrome.tabs.group({ tabIds: [tab.id], ...(tab.windowId === undefined ? {} : { createProperties: { windowId: tab.windowId } }) })
    await this.chrome.tabGroups.update(groupId, { title: input.groupTitle, color: 'blue', collapsed: false })
    tab.groupId = groupId
    const claimed = await this.claim({ ...input, tabIds: [tab.id], groupId, childPolicy: 'manual' })
    return { lease: claimed.lease, tab }
  }

  assertScope(leaseId: string, leaseEpoch: number, tabId: number): LeaseRecord {
    const lease = this.active
    if (lease === null || lease.state === 'LOST' || lease.leaseId !== leaseId || lease.leaseEpoch !== leaseEpoch) {
      throw new LeaseError('lease-lost', 'the lease is not active at this epoch')
    }
    if (!lease.tabIds.includes(tabId)) throw new LeaseError('scope-mismatch', 'tab is outside the lease')
    return structuredClone(lease)
  }

  async beginAgentControl(leaseId: string, leaseEpoch: number, tabId: number): Promise<number> {
    const lease = this.assertScope(leaseId, leaseEpoch, tabId)
    this.active = { ...lease, state: 'CONTROLLING_AGENT' }
    await this.persist()
    return lease.controlEpoch
  }

  async trustedHumanInput(tabId: number): Promise<LeaseRecord | null> {
    if (this.active === null || !this.active.tabIds.includes(tabId)) return null
    this.active = { ...this.active, state: 'LEASED_HUMAN', controlEpoch: this.active.controlEpoch + 1 }
    await this.persist()
    return structuredClone(this.active)
  }

  isOperationCurrent(leaseId: string, leaseEpoch: number, controlEpoch: number): boolean {
    return this.active?.leaseId === leaseId && this.active.leaseEpoch === leaseEpoch && this.active.controlEpoch === controlEpoch && this.active.state === 'CONTROLLING_AGENT'
  }

  async markLost(): Promise<void> {
    if (this.active === null) return
    this.active = { ...this.active, state: 'LOST' }
    await this.persist()
  }

  async release(leaseId: string, leaseEpoch: number): Promise<number[]> {
    if (this.active === null) return []
    if (this.active.leaseId !== leaseId || this.active.leaseEpoch !== leaseEpoch) throw new LeaseError('lease-lost', 'cannot release a stale lease epoch')
    const released = [...this.active.tabIds]
    this.active = null
    await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
    return released
  }

  async recover(): Promise<LeaseRecord | null> {
    const stored = await this.chrome.storage.session.get(SESSION_LEASE_KEY)
    const lease = assertLeaseRecord(stored[SESSION_LEASE_KEY])
    if (lease === null || lease.payloadVersion !== this.payloadVersion || lease.expiresAt <= this.now() || lease.state === 'LOST') {
      await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
      this.active = null
      return null
    }
    try {
      const tabs = await Promise.all(lease.tabIds.map((tabId) => this.chrome.tabs.get(tabId)))
      if (tabs.some((tab) => restrictedTargetReason(tab.url) !== null)) throw new Error('restricted')
    } catch {
      await this.chrome.storage.session.remove(SESSION_LEASE_KEY)
      this.active = null
      return null
    }
    this.active = lease
    return structuredClone(lease)
  }

  private async persist(): Promise<void> {
    if (this.active !== null) await this.chrome.storage.session.set({ [SESSION_LEASE_KEY]: this.active })
  }
}
