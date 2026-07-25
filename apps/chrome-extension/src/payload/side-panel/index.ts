import { installedChrome } from '../../runtime/chrome-api.js'
import type { CandidateWindow, LeaseRecord } from '../../runtime/lease-manager.js'

interface LocalResponse<T> {
  ok: boolean
  result?: T
  error?: { code?: string; message?: string }
}

interface PickerState {
  windows: CandidateWindow[]
  lease: LeaseRecord | null
}

const chromeApi = installedChrome()
const leaseId = `side-panel-${crypto.randomUUID()}`
let leaseEpoch = 1
let activeLease: LeaseRecord | null = null
const groupByTab = new Map<number, number | null>()

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`missing side-panel element ${selector}`)
  return element
}

function status(message: string, error = false): void {
  const element = query<HTMLElement>('[data-forge-status]')
  element.textContent = message
  element.style.color = error ? '#ff9d9d' : '#8ee6ad'
}

async function request<T>(message: Record<string, unknown>): Promise<T> {
  const response = await chromeApi.runtime.sendMessage(message) as LocalResponse<T>
  if (!response.ok || response.result === undefined) throw new Error(response.error?.message ?? response.error?.code ?? 'extension request failed')
  return response.result
}

function renderCandidates(windows: CandidateWindow[]): void {
  const container = query<HTMLElement>('[data-forge-candidates]')
  container.replaceChildren()
  groupByTab.clear()
  for (const window of windows) {
    const heading = document.createElement('strong')
    heading.textContent = `Window ${window.windowId}${window.focused ? ' · focused' : ''}`
    container.append(heading)
    let renderedGroup: number | null | undefined
    const orderedTabs = [...window.tabs].sort((left, right) => (left.groupId ?? -1) - (right.groupId ?? -1) || left.tabId - right.tabId)
    for (const tab of orderedTabs) {
      if (renderedGroup !== tab.groupId) {
        renderedGroup = tab.groupId
        const groupHeading = document.createElement('small')
        const group = tab.groupId === null ? undefined : window.groups.find((candidate) => candidate.groupId === tab.groupId)
        groupHeading.textContent = tab.groupId === null ? 'Ungrouped tabs' : group?.title || `Group ${tab.groupId}`
        container.append(groupHeading)
      }
      groupByTab.set(tab.tabId, tab.groupId)
      const label = document.createElement('label')
      label.className = `candidate${tab.restricted || tab.attached || tab.debuggerConflict ? ' restricted' : ''}`
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.name = 'tabId'
      checkbox.value = String(tab.tabId)
      checkbox.disabled = tab.restricted || tab.attached || tab.debuggerConflict
      const text = document.createElement('span')
      text.textContent = tab.title || 'Untitled tab'
      const detail = document.createElement('small')
      detail.textContent = tab.restricted
        ? `${tab.origin || 'Restricted'} · restricted scheme`
        : tab.debuggerConflict
          ? `${tab.origin} · DevTools or another debugger is attached`
          : `${tab.origin} · window ${window.windowId}${tab.groupId === null ? '' : ` · group ${tab.groupId}`}`
      text.append(detail)
      label.append(checkbox, text)
      container.append(label)
    }
  }
  if (container.childElementCount === 0) container.textContent = 'No local tab candidates.'
}

async function refresh(): Promise<void> {
  const state = await request<PickerState>({ kind: 'picker.list' })
  activeLease = state.lease
  renderCandidates(state.windows)
  const control = activeLease?.state === 'CONTROLLING_AGENT' ? 'Agent' : activeLease?.state === 'LOST' ? 'Detached / lost' : 'Human'
  status(activeLease === null ? 'Detached · choose one or more local tabs.' : `Attached · ${activeLease.tabIds.length} tab(s) · ${control}`)
}

async function claim(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const tabIds = [...document.querySelectorAll<HTMLInputElement>('input[name="tabId"]:checked')].map((input) => Number(input.value))
  if (tabIds.length === 0) {
    status('Select at least one unrestricted tab.', true)
    return
  }
  const sessionLabel = query<HTMLInputElement>('[data-forge-session]').value.trim() || 'M1 spike'
  const selectedGroups = [...new Set(tabIds.map((tabId) => groupByTab.get(tabId) ?? null))]
  const groupId = selectedGroups.length === 1 && selectedGroups[0] !== null ? selectedGroups[0] : undefined
  status('Claiming and attaching Chrome debugger…')
  const result = await request<{ lease: LeaseRecord }>({
    kind: 'picker.claim', leaseId, leaseEpoch, sessionAgentId: `local:${sessionLabel}`.slice(0, 128), tabIds,
    ...(groupId === undefined ? {} : { groupId }),
    childPolicy: query<HTMLInputElement>('[data-forge-child-policy]').checked ? 'include-opened-by-leased-tabs' : 'manual',
  })
  activeLease = result.lease
  status(`Attached · ${result.lease.tabIds.length} tab(s) · human control`)
  await refresh()
}

async function createGroupedTab(): Promise<void> {
  if (activeLease !== null) {
    status('Detach the current lease before creating another grouped tab.', true)
    return
  }
  const sessionLabel = query<HTMLInputElement>('[data-forge-session]').value.trim() || 'Forge session'
  const result = await request<{ lease: LeaseRecord }>({
    kind: 'picker.create', leaseId, leaseEpoch, sessionAgentId: `local:${sessionLabel}`.slice(0, 128),
    groupTitle: `Forge · ${sessionLabel}`.slice(0, 512),
  })
  activeLease = result.lease
  status('Attached · Forge-owned grouped tab · human control')
  await refresh()
}

async function release(): Promise<void> {
  if (activeLease === null) {
    status('No active local lease.')
    return
  }
  await request({ kind: 'picker.release', leaseId: activeLease.leaseId, leaseEpoch: activeLease.leaseEpoch })
  activeLease = null
  leaseEpoch += 1
  status('Detached. User tabs were left open.')
  await refresh()
}

export function activateSidePanel(): void {
  query<HTMLFormElement>('[data-forge-picker]').addEventListener('submit', (event) => {
    void claim(event).catch((error: unknown) => status(error instanceof Error ? error.message : 'Claim failed', true))
  })
  query<HTMLButtonElement>('[data-forge-create]').addEventListener('click', () => {
    void createGroupedTab().catch((error: unknown) => status(error instanceof Error ? error.message : 'Create failed', true))
  })
  query<HTMLButtonElement>('[data-forge-release]').addEventListener('click', () => {
    void release().catch((error: unknown) => status(error instanceof Error ? error.message : 'Detach failed', true))
  })
  void refresh().catch((error: unknown) => status(error instanceof Error ? error.message : 'Picker failed', true))
}
