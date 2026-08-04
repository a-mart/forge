/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import { HelpProvider } from '@/components/help/HelpProvider'
import type {
  AgentDescriptor,
  AgentStatus,
  BuilderSidebarOrderRef,
  ManagerProfile,
} from '@forge/protocol'
import type { RemoteSidebarOrigin } from './agent-sidebar/types'
import { originRegistry } from '@/lib/origin-store'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: 'worker',
  }
}

let container: HTMLDivElement
let root: Root | null = null

// Provide a working localStorage stub for the test environment
const localStorageStore = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageStore.set(key, value),
  removeItem: (key: string) => localStorageStore.delete(key),
  clear: () => localStorageStore.clear(),
  get length() { return localStorageStore.size },
  key: (index: number) => [...localStorageStore.keys()][index] ?? null,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorageStore.clear()
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ scan: { summary: { needsReview: 0 } } }),
  })))
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  vi.unstubAllGlobals()
  originRegistry.destroyAll()
  root = null
  container.remove()
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function profileFor(agent: AgentDescriptor): ManagerProfile {
  return {
    profileId: agent.agentId,
    displayName: agent.displayName || agent.agentId,
    defaultSessionAgentId: agent.agentId,
    defaultModel: { ...agent.model },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }
}

function sessionManager(
  agentId: string,
  profileId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    profileId,
    sessionLabel: agentId === profileId ? 'Main' : agentId,
  }
}

function renderSidebar({
  agents,
  profiles,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenSettings = vi.fn(),
  onOpenProjectSecrets,
  onOpenArchive,
  onArchiveSession,
  onArchiveProfile,
  isSettingsActive = false,
  statuses = {},
  unreadCounts = {},
  onCreateSession,
  wsUrl,
  remoteOrigins,
  builderSidebarOrder,
  onMoveBuilderProject,
  activeOriginId,
  onSelectRemoteAgent,
  onRemoteOriginSignIn,
  collaborationModeSwitch,
  isMobileOpen,
  onMobileClose,
}: {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  onOpenProjectSecrets?: (profileId: string) => void
  onOpenArchive?: () => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
  unreadCounts?: Record<string, number>
  onCreateSession?: (profileId: string, name?: string) => void
  wsUrl?: string
  remoteOrigins?: RemoteSidebarOrigin[]
  builderSidebarOrder?: BuilderSidebarOrderRef[]
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  activeOriginId?: string
  onSelectRemoteAgent?: (originId: string, agentId: string) => void
  onRemoteOriginSignIn?: (originId: string) => void
  collaborationModeSwitch?: { activeSurface: 'builder' | 'collab'; onSelectSurface: (surface: 'builder' | 'collab') => void }
  isMobileOpen?: boolean
  onMobileClose?: () => void
}) {
  // Auto-generate profiles from managers if not explicitly provided
  const resolvedProfiles = profiles ?? agents
    .filter((a) => a.role === 'manager')
    .map(profileFor)

  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(AgentSidebar, {
          connected: true,
          wsUrl,
          agents,
          profiles: resolvedProfiles,
          statuses,
          unreadCounts,
          collaborationModeSwitch,
          selectedAgentId,
          onAddManager: vi.fn(),
          onSelectAgent,
          onDeleteAgent,
          onDeleteManager,
          onOpenSettings,
          onOpenProjectSecrets,
          onOpenArchive,
          onArchiveSession,
          onArchiveProfile,
          onCreateSession,
          isSettingsActive,
          isMobileOpen,
          onMobileClose,
          remoteOrigins,
          builderSidebarOrder,
          onMoveBuilderProject,
          activeOriginId,
          onSelectRemoteAgent,
          onRemoteOriginSignIn,
        }),
      ),
    )
  })
}

/**
 * Helper: the sidebar renders both a desktop and mobile instance.
 * Get the desktop sidebar (the first <aside>) for scoped queries.
 */
function getDesktopSidebar(): HTMLElement {
  const asides = container.querySelectorAll('aside')
  expect(asides.length).toBeGreaterThanOrEqual(1)
  return asides[0] as HTMLElement
}

describe('AgentSidebar', () => {
  it('defaults to Classic and leaves room-card markup out of the project list', () => {
    const session = sessionManager('classic-session', 'classic-project')
    renderSidebar({ agents: [session] })

    const sidebar = getDesktopSidebar()
    expect(sidebar.getAttribute('data-sidebar-layout')).toBe('classic')
    expect(sidebar.querySelector('[data-room-card]')).toBeNull()
  })

  it('keeps the Classic search and Project View controls in their established separate rows', () => {
    renderSidebar({ agents: [sessionManager('classic-command', 'classic-command')] })

    const sidebar = getDesktopSidebar()
    expect(sidebar.querySelector('[data-testid="sidebar-command-row"]')).toBeNull()
    expect(sidebar.querySelector('input[placeholder="Search sessions… ⌘K"]')).not.toBeNull()
    expect(sidebar.querySelector('[aria-label="Project view: All projects"]')).not.toBeNull()
  })

  it('uses one Rooms Projects command row for search and the Project View chip', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    localStorageMock.setItem('forge-sidebar-rooms-mode', 'projects')
    renderSidebar({
      agents: [sessionManager('rooms-command', 'rooms-command')],
      collaborationModeSwitch: { activeSurface: 'builder', onSelectSurface: vi.fn() },
    })

    const sidebar = getDesktopSidebar()
    const commandRow = sidebar.querySelector('[data-testid="sidebar-command-row"]')
    expect(commandRow).not.toBeNull()
    expect(commandRow?.querySelector('input[placeholder="Search…"]')).not.toBeNull()
    expect(commandRow?.querySelector('[aria-label="Project view: All projects"]')).not.toBeNull()
    expect(sidebar.querySelectorAll('[aria-label="Project view: All projects"]')).toHaveLength(1)
    expect(sidebar.querySelector('[data-testid="rooms-sidebar-header"] button[aria-label="Add project"]')?.className).toContain('size-7')
    expect(getByRole(sidebar, 'button', { name: /builder/i })).toBeTruthy()
    expect(getByRole(sidebar, 'button', { name: /collab/i })).toBeTruthy()
  })

  it('persists the Rooms Inbox or Projects mode independently from Project Views', async () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    localStorageMock.setItem('forge-sidebar-project-views', JSON.stringify({
      version: 1,
      activeViewId: null,
      views: [],
    }))
    renderSidebar({ agents: [sessionManager('rooms-mode', 'rooms-mode')] })

    const sidebar = getDesktopSidebar()
    expect(getByRole(sidebar, 'button', { name: 'Inbox' }).getAttribute('aria-pressed')).toBe('true')
    click(getByRole(sidebar, 'button', { name: 'Projects' }))
    await flushEffects()
    expect(localStorageMock.getItem('forge-sidebar-rooms-mode')).toBe('projects')

    flushSync(() => root?.unmount())
    root = null
    renderSidebar({ agents: [sessionManager('rooms-mode', 'rooms-mode')] })
    expect(getByRole(getDesktopSidebar(), 'button', { name: 'Projects' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Inbox selected when an origin-scoped remote Inbox row is selected', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const onSelectRemoteAgent = vi.fn()
    const localSession = sessionManager('local-inbox', 'local-inbox')
    const remoteSession = {
      ...sessionManager('remote-inbox', 'remote-inbox'),
      pendingChoiceCount: 1,
      sessionLabel: 'Remote answer',
    }
    const remoteProfile = {
      ...profileFor(remoteSession),
      profileId: 'remote-inbox',
      displayName: 'Remote Project',
      defaultSessionAgentId: 'remote-inbox',
    }
    renderSidebar({
      agents: [localSession],
      remoteOrigins: [{
        originId: 'remote-inbox-origin',
        connected: true,
        treeRows: [{
          profile: remoteProfile,
          sessions: [{ sessionAgent: remoteSession, workers: [], isDefault: true }],
        }],
      }],
      onSelectRemoteAgent,
    })

    const sidebar = getDesktopSidebar()
    click(sidebar.querySelector('[data-inbox-row="remote-inbox-origin::remote-inbox"]') as HTMLElement)
    expect(onSelectRemoteAgent).toHaveBeenCalledWith('remote-inbox-origin', 'remote-inbox')
    expect(getByRole(sidebar, 'button', { name: /Inbox/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('renders local and remote project room cards in Rooms Projects mode', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    localStorageMock.setItem('forge-sidebar-rooms-mode', 'projects')
    const localSession = {
      ...sessionManager('local-session', 'local-project'),
      activeWorkerCount: 1,
    }
    const remoteSession = {
      ...sessionManager('remote-session', 'remote-project'),
      activeWorkerCount: 1,
    }
    const localProfile = {
      ...profileFor(localSession),
      profileId: 'local-project',
      displayName: 'Local Project',
      defaultSessionAgentId: 'local-session',
    }
    const remoteProfile = {
      ...profileFor(remoteSession),
      profileId: 'remote-project',
      displayName: 'Remote Project',
      defaultSessionAgentId: 'remote-session',
    }

    renderSidebar({
      agents: [localSession],
      profiles: [localProfile],
      builderSidebarOrder: [
        { originId: 'local', profileId: 'local-project' },
        { originId: 'remote-rooms', profileId: 'remote-project' },
      ],
      onMoveBuilderProject: vi.fn(),
      remoteOrigins: [{
        originId: 'remote-rooms',
        connected: true,
        instanceName: 'Remote Rooms',
        treeRows: [{
          profile: remoteProfile,
          sessions: [{ sessionAgent: remoteSession, workers: [], isDefault: true }],
        }],
      }],
      onSelectRemoteAgent: vi.fn(),
    })

    const sidebar = getDesktopSidebar()
    expect(sidebar.getAttribute('data-sidebar-layout')).toBe('rooms-v2')
    expect(sidebar.querySelector('[data-room-card="local"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-room-card="remote"]')).not.toBeNull()
    expect(sidebar.querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(2)
    expect(sidebar.querySelector('[aria-label="1 of 1 sessions actively working"]')?.textContent).toBe('1/1')
  })

  it('renders the real Rooms project tree inline in Inbox without changing modes on project actions', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const onCreateSession = vi.fn()
    const inlineSession = sessionManager('inline-session', 'inline-project')
    const inlineProfile = {
      ...profileFor(inlineSession),
      profileId: 'inline-project',
      displayName: 'Inline Project',
      defaultSessionAgentId: 'inline-session',
    }
    renderSidebar({
      agents: [inlineSession],
      profiles: [inlineProfile],
      unreadCounts: { 'inline-session': 3 },
      onCreateSession,
    })

    const sidebar = getDesktopSidebar()
    const projects = sidebar.querySelector('[data-inbox-section="projects"]') as HTMLElement
    expect(projects).toBeTruthy()
    expect(projects.querySelector('[data-room-card="local"]')).not.toBeNull()
    expect(projects.querySelector('[aria-label="3 unread messages in Inline Project"]')?.textContent).toBe('3')
    expect(projects.querySelector('[aria-label="0 of 1 sessions actively working"]')?.textContent).toBe('0/1')

    const inboxButton = getByRole(sidebar, 'button', { name: /^Inbox/ })
    const projectsButton = getByRole(sidebar, 'button', { name: 'Projects' })
    click(getByRole(projects, 'button', { name: 'New session for Inline Project' }))
    expect(inboxButton.getAttribute('aria-pressed')).toBe('true')
    expect(projectsButton.getAttribute('aria-pressed')).toBe('false')
    expect(onCreateSession).not.toHaveBeenCalled()
  })

  it('keeps session-only and worker-only search matches in the Inbox project tree', async () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const searchSession = {
      ...sessionManager('search-session', 'plain-project'),
      sessionLabel: 'Needle Session',
    }
    const searchWorker = {
      ...worker('search-worker', 'search-session'),
      displayName: 'Needle Worker',
    }
    const profile = {
      ...profileFor(searchSession),
      profileId: 'plain-project',
      displayName: 'Plain Project',
      defaultSessionAgentId: 'search-session',
    }
    renderSidebar({ agents: [searchSession, searchWorker], profiles: [profile] })

    const sidebar = getDesktopSidebar()
    const projects = sidebar.querySelector('[data-inbox-section="projects"]') as HTMLElement
    const searchInput = sidebar.querySelector('input[placeholder^="Search"]') as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'Needle Session' } })
    await waitFor(() => {
      expect(queryByText(projects, 'Plain Project')).toBeTruthy()
      expect(queryByText(projects, 'Needle Session')).toBeTruthy()
    })

    fireEvent.change(searchInput, { target: { value: 'w:Needle Worker' } })
    await waitFor(() => {
      // The worker-only match keeps its owning project in the same tree;
      // the worker itself remains governed by the shared row's expand state.
      expect(queryByText(projects, 'Plain Project')).toBeTruthy()
    })
  })

  it('keeps inactive Project Agent search matches in the Inbox project tree', async () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        resources: {
          projectAgents: {
            exists: true,
            count: 1,
            items: [{
              definitionId: 'docs-definition',
              handle: 'repo-docs',
              path: '/repo/.forge/project-agents/docs-definition',
              status: 'valid',
              problems: [],
              displayName: 'Repository Docs Agent',
              whenToUse: 'Use for handbook maintenance',
            }],
          },
        },
      }),
    })))
    const project = sessionManager('project-main', 'project-a')
    renderSidebar({
      agents: [project],
      profiles: [{
        ...profileFor(project),
        profileId: 'project-a',
        displayName: 'Project A',
        defaultSessionAgentId: 'project-main',
      }],
      wsUrl: 'ws://127.0.0.1:47187',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    const projects = sidebar.querySelector('[data-inbox-section="projects"]') as HTMLElement
    const searchInput = sidebar.querySelector('input[placeholder^="Search"]') as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'repo-docs' } })
    await waitFor(() => {
      expect(queryByText(projects, 'Project A')).toBeTruthy()
      expect(projects.querySelector('button[aria-label^="Repository Docs Agent"]')).toBeTruthy()
      expect(queryByText(projects, 'No matches found.')).toBeNull()
    })
  })

  it('renders the clear/New Project state when the supplied shared tree has no rows or remote status card', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    renderSidebar({ agents: [], profiles: [] })

    const sidebar = getDesktopSidebar()
    expect(sidebar.querySelector('[data-testid="rooms-inbox-empty"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-inbox-section="projects"]')).toBeNull()
    expect(queryByText(sidebar, 'No active agents.')).toBeNull()
    expect(getByRole(sidebar, 'button', { name: 'New Project' })).toBeTruthy()
  })

  it('renders an empty remote origin sign-in card inline in Inbox', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const onRemoteOriginSignIn = vi.fn()
    const remote = originRegistry.createOrigin({
      originId: 'remote-empty',
      wsUrl: 'ws://remote-empty.test',
      offline: true,
    })
    remote.patchMeta({
      connectionStatus: 'disconnected',
      authState: 'unauthorized',
      instanceName: 'Remote Empty',
    })
    renderSidebar({
      agents: [],
      profiles: [],
      remoteOrigins: [{ originId: 'remote-empty', connected: false, treeRows: [] }],
      onRemoteOriginSignIn,
    })

    const projects = getDesktopSidebar().querySelector('[data-inbox-section="projects"]') as HTMLElement
    expect(projects.querySelector('[data-testid="remote-origin-section-remote-empty"]')).not.toBeNull()
    click(getByRole(projects, 'button', { name: 'Sign in' }))
    expect(onRemoteOriginSignIn).toHaveBeenCalledWith('remote-empty')
  })

  it('does not mount enabled sortable controls for either responsive Inbox tree', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const first = sessionManager('first-session', 'first-project')
    const second = sessionManager('second-session', 'second-project')
    renderSidebar({
      agents: [first, second],
      profiles: [
        { ...profileFor(first), profileId: 'first-project', displayName: 'First Project', defaultSessionAgentId: 'first-session' },
        { ...profileFor(second), profileId: 'second-project', displayName: 'Second Project', defaultSessionAgentId: 'second-session' },
      ],
      onMoveBuilderProject: vi.fn(),
    })

    expect(container.querySelectorAll('aside')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(0)
  })

  it('opens Archive from the sidebar entry when archived items exist', () => {
    const onOpenArchive = vi.fn()
    const defaultSession = sessionManager('manager-alpha', 'manager-alpha')
    const archivedSession = {
      ...sessionManager('manager-alpha--archived', 'manager-alpha'),
      archivedAt: '2026-01-02T00:00:00.000Z',
    }
    renderSidebar({
      agents: [defaultSession, archivedSession],
      profiles: [profileFor(defaultSession)],
      onOpenArchive,
    })

    const archiveButton = getByRole(getDesktopSidebar(), 'button', { name: 'Archive' })
    const archiveInner = archiveButton.parentElement
    const archiveOuter = archiveInner?.parentElement
    expect(archiveOuter?.className).toContain('mt-auto')
    expect(archiveOuter?.className).toContain('pt-2.5')
    expect(archiveInner?.className).toContain('border-t')
    expect(archiveInner?.className).toContain('pt-1.5')
    click(archiveButton)

    expect(onOpenArchive).toHaveBeenCalledTimes(1)
  })

  it('keeps Cortex and Archive in the Rooms mobile overlay', () => {
    localStorageMock.setItem('forge-sidebar-layout', 'rooms-v2')
    const onOpenArchive = vi.fn()
    const cortexRoot = {
      ...sessionManager('cortex-root', 'cortex-project'),
      archetypeId: 'cortex',
      displayName: 'Cortex',
      sessionLabel: 'Main',
    }
    const cortexReview = {
      ...sessionManager('cortex-review', 'cortex-project'),
      archetypeId: 'cortex',
      displayName: 'Cortex',
      sessionLabel: 'Review Run',
    }
    const project = sessionManager('archived-project', 'archived-project')
    const archived = {
      ...sessionManager('archived-project--old', 'archived-project'),
      archivedAt: '2026-01-02T00:00:00.000Z',
    }

    renderSidebar({
      agents: [cortexRoot, cortexReview, project, archived],
      profiles: [
        { ...profileFor(cortexRoot), profileId: 'cortex-project', defaultSessionAgentId: 'cortex-root' },
        profileFor(project),
      ],
      isMobileOpen: true,
      onMobileClose: vi.fn(),
      onOpenArchive,
    })

    const mobileSidebar = container.querySelectorAll('aside')[1] as HTMLElement
    expect(mobileSidebar).toBeTruthy()
    expect(queryByText(mobileSidebar, 'Cortex')).toBeTruthy()
    expect(queryByText(mobileSidebar, 'Review Run')).toBeTruthy()
    click(getByRole(mobileSidebar, 'button', { name: 'Archive' }))
    expect(onOpenArchive).toHaveBeenCalledTimes(1)
  })

  it('hides the Archive sidebar entry when no archived items exist', () => {
    const onOpenArchive = vi.fn()
    renderSidebar({ agents: [sessionManager('manager-alpha', 'manager-alpha')], onOpenArchive })

    expect(queryByText(getDesktopSidebar(), 'Archive')).toBeNull()
  })

  it('shows archive actions and disables direct archive for the default session with explanatory copy', async () => {
    const onArchiveSession = vi.fn()
    const onArchiveProfile = vi.fn()
    const defaultSession = sessionManager('project-a', 'project-a')
    const extraSession = sessionManager('project-a--s2', 'project-a')
    const projectProfile: ManagerProfile = {
      ...profileFor(defaultSession),
      profileId: 'project-a',
      displayName: 'Project A',
      defaultSessionAgentId: 'project-a',
    }

    renderSidebar({
      agents: [defaultSession, extraSession],
      profiles: [projectProfile],
      selectedAgentId: 'project-a',
      onArchiveSession,
      onArchiveProfile,
    })
    const sidebar = getDesktopSidebar()

    const sessionRow = getByText(sidebar, 'project-a--s2')
    flushSync(() => {
      sessionRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    const archiveSessionItem = getAllByRole(document.body, 'menuitem').find((item) => item.textContent === 'Archive')
    expect(archiveSessionItem).toBeTruthy()
    click(archiveSessionItem as HTMLElement)
    expect(onArchiveSession).toHaveBeenCalledWith('project-a--s2')

    const defaultRow = getByText(sidebar, 'Main')
    flushSync(() => {
      defaultRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    expect(queryByText(document.body, 'The default session for a project can’t be archived directly.')).toBeTruthy()

    const profileHeader = getByText(sidebar, 'Project A').closest('button')
    expect(profileHeader).toBeTruthy()
    flushSync(() => {
      profileHeader!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    const archiveProjectItem = getAllByRole(document.body, 'menuitem').find((item) => item.textContent?.includes('Archive Project'))
    expect(archiveProjectItem).toBeTruthy()
    click(archiveProjectItem as HTMLElement)
    expect(onArchiveProfile).toHaveBeenCalledWith('project-a')
  })

  it('shows workers under sessions and allows collapsing profile groups via the project row', () => {
    const mgr = sessionManager('manager-alpha', 'manager-alpha')
    const wrk = worker('worker-alpha', 'manager-alpha')

    renderSidebar({ agents: [mgr, wrk] })

    const sidebar = getDesktopSidebar()

    // Profile header shows the displayName; dedicated project chevron controls are gone.
    expect(queryByText(sidebar, 'manager-alpha')).toBeTruthy()
    expect(sidebar.querySelector('button[aria-label="Expand manager-alpha"]')).toBeNull()
    expect(sidebar.querySelector('button[aria-label="Collapse manager-alpha"]')).toBeNull()

    // Ensure the profile group + session workers are expanded before checking worker visibility.
    const maybeExpandProfileButton = sidebar.querySelector(
      'button[aria-label="Expand project manager-alpha"]',
    ) as HTMLButtonElement | null
    if (maybeExpandProfileButton) {
      click(maybeExpandProfileButton)
    }

    const maybeExpandWorkersButton = sidebar.querySelector(
      'button[aria-label="Expand session workers"]',
    ) as HTMLButtonElement | null
    if (maybeExpandWorkersButton) {
      click(maybeExpandWorkersButton)
    }

    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()

    // Collapse the profile group by clicking the project row
    click(getByRole(sidebar, 'button', { name: 'Collapse project manager-alpha' }))
    // Session row and worker should be hidden
    expect(queryByText(sidebar, 'worker-alpha')).toBeNull()

    // Expand again via the project row
    click(getByRole(sidebar, 'button', { name: 'Expand project manager-alpha' }))
    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()
  })

  it('renders profile and worker rows for mixed model providers without relying on runtime icons', () => {
    const mgr = sessionManager('manager-pi', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.5' })
    const wrkOpus = worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' })
    const wrkCodex = worker('worker-codex', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.4' })

    renderSidebar({ agents: [mgr, wrkOpus, wrkCodex] })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'manager-pi')).toBeTruthy()

    const maybeExpandWorkersButton = sidebar.querySelector(
      'button[aria-label="Expand session workers"]',
    ) as HTMLButtonElement | null
    if (maybeExpandWorkersButton) {
      click(maybeExpandWorkersButton)
    }

    expect(queryByText(sidebar, 'worker-opus')).toBeTruthy()
    expect(queryByText(sidebar, 'worker-codex')).toBeTruthy()
  })

  it('keeps session selection working while project row click toggles expand/collapse', () => {
    const onSelectAgent = vi.fn()
    const mgr = sessionManager('manager-alpha', 'manager-alpha')
    const wrk = worker('worker-alpha', 'manager-alpha')

    renderSidebar({
      agents: [mgr, wrk],
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()

    // Clicking the project row toggles collapse (does not select a session)
    const profileButton = getByRole(sidebar, 'button', { name: 'Collapse project manager-alpha' })
    click(profileButton)
    expect(onSelectAgent).not.toHaveBeenCalled()
    expect(queryByText(sidebar, 'Main')).toBeNull()

    // Expand again, then select via the session row
    click(getByRole(sidebar, 'button', { name: 'Expand project manager-alpha' }))
    const sessionButton = getByText(sidebar, 'Main').closest('button') as HTMLButtonElement
    click(sessionButton)
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn()
    const mgr = sessionManager('manager-alpha', 'manager-alpha')

    renderSidebar({
      agents: [mgr],
      onOpenSettings,
    })

    const sidebar = getDesktopSidebar()

    // Use the bottom Settings button (aria-pressed attribute distinguishes it)
    const settingsButtons = getAllByRole(sidebar, 'button', { name: 'Settings' })
    // The last one is the bottom-nav settings button (not from context menus)
    const bottomSettingsBtn = settingsButtons[settingsButtons.length - 1]
    click(bottomSettingsBtn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('routes a project-header secrets action without selecting a session', async () => {
    const onOpenProjectSecrets = vi.fn()
    const onSelectAgent = vi.fn()
    const mgr = sessionManager('manager-alpha', 'project-alpha')

    renderSidebar({
      agents: [mgr],
      profiles: [{ ...profileFor(mgr), profileId: 'project-alpha' }],
      onOpenProjectSecrets,
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()
    fireEvent.contextMenu(
      getByRole(sidebar, 'button', { name: 'Collapse project manager-alpha' }),
    )
    const menuItem = await waitFor(() => getByText(document.body, 'Project Secrets'))
    click(menuItem)

    expect(onOpenProjectSecrets).toHaveBeenCalledWith('project-alpha')
    expect(onSelectAgent).not.toHaveBeenCalled()
  })

  it('renders multiple profiles sorted by createdAt', () => {
    const mgr1 = sessionManager('alpha-mgr', 'alpha-mgr')
    const mgr2 = {
      ...sessionManager('beta-mgr', 'beta-mgr'),
      displayName: 'beta-mgr',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }

    const p1: ManagerProfile = {
      profileId: 'alpha-mgr',
      displayName: 'alpha-mgr',
      defaultSessionAgentId: 'alpha-mgr',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const p2: ManagerProfile = {
      profileId: 'beta-mgr',
      displayName: 'beta-mgr',
      defaultSessionAgentId: 'beta-mgr',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [mgr1, mgr2],
      profiles: [p1, p2],
    })

    const sidebar = getDesktopSidebar()

    // Both profile names should be visible
    expect(queryByText(sidebar, 'alpha-mgr')).toBeTruthy()
    expect(queryByText(sidebar, 'beta-mgr')).toBeTruthy()
  })

  it('shows Cortex sessions directly without review-run badge indirection', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      wsUrl: 'ws://127.0.0.1:47187/ws',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    expect(getByText(sidebar, 'Review Run · Full Queue')).toBeTruthy()
    expect(queryByText(sidebar, /^Review \d+$/)).toBeNull()
    const cortexLabel = getByText(sidebar, 'Cortex')
    const cortexInset = cortexLabel.closest('.mt-2')
    expect(cortexInset).toBeTruthy()
  })

  it('hides the Cortex review badge when there are no outstanding sessions needing review', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot],
      profiles: [cortexProfile],
      wsUrl: 'ws://127.0.0.1:47187/ws',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, /^Review \d+$/)).toBeNull()
  })

  it('does not show a Cortex review-run running indicator', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      status: 'streaming',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      statuses: {
        'cortex--s2': { status: 'streaming', pendingCount: 0 },
      },
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'Running')).toBeNull()
  })

  it('hides CLI sessions when the hide-cli-sessions localStorage pref is set', () => {
    // Set the hide pref before rendering
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
    })

    const sidebar = getDesktopSidebar()

    // Regular session should be visible
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    // CLI session should be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()

  })

  it('toggles the project row without selecting when CLI sessions are hidden', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')
    const onSelectAgent = vi.fn()

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      updatedAt: '2026-01-02T00:00:00.000Z',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()

    click(getByRole(sidebar, 'button', { name: 'Collapse project My Project' }))
    expect(onSelectAgent).not.toHaveBeenCalled()
    expect(queryByText(sidebar, 'regular-session')).toBeNull()

    click(getByRole(sidebar, 'button', { name: 'Expand project My Project' }))
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()
  })

  it('keeps a selected CLI session visible even when hide-cli-sessions is set', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
      selectedAgentId: 'cli-session',
    })

    const sidebar = getDesktopSidebar()

    // Selected CLI session should still be visible
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('keeps a CLI session visible when one of its workers is selected', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const cliWorker = worker('cli-worker', 'cli-session')
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession, cliWorker],
      profiles: [profile],
      selectedAgentId: 'cli-worker',
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('toggles CLI session visibility at runtime when localStorage pref changes', async () => {
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
    })

    const sidebar = getDesktopSidebar()

    // Both sessions should be visible initially
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Simulate the toggle to hide: write to localStorage and dispatch the pref-change event
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')
    flushSync(() => {
      window.dispatchEvent(new CustomEvent('forge-sidebar-pref-change', { detail: { key: 'forge-sidebar-hide-cli-sessions', value: true } }))
    })
    await flushEffects()

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()

    // Toggle back to show: clear the pref and dispatch the event again
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'false')
    flushSync(() => {
      window.dispatchEvent(new CustomEvent('forge-sidebar-pref-change', { detail: { key: 'forge-sidebar-hide-cli-sessions', value: false } }))
    })
    await flushEffects()

    // CLI session should be visible again
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('toggleHideCliSessions correctly persists true under StrictMode (regression: double-invoke must not flip back)', async () => {
    // Renders under <StrictMode> so React 19 double-invokes state updaters.
    // The old implementation placed a localStorage side-effect inside a functional
    // updater (prev => !prev), which React called twice — the second call received
    // the first's result as prev, flipping true back to false. This test fails with
    // the old code and passes with the fixed direct-read-then-set approach.
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    // Render under StrictMode to trigger double-invocation of updaters
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(StrictMode, null,
          createElement(HelpProvider, null,
            createElement(AgentSidebar, {
              connected: true,
              agents: [regularSession, cliSession],
              profiles: [profile],
              statuses: {},
              unreadCounts: {},
              selectedAgentId: 'regular-session',
              onAddManager: vi.fn(),
              onSelectAgent: vi.fn(),
              onDeleteAgent: vi.fn(),
              onDeleteManager: vi.fn(),
              onOpenSettings: vi.fn(),
              isSettingsActive: false,
            }),
          ),
        ),
      )
    })

    const sidebar = getDesktopSidebar()

    // Both sessions should be visible initially
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
    expect(localStorageMock.getItem('forge-sidebar-hide-cli-sessions')).toBeNull()

    // Right-click the CLI session to open context menu, then click "Hide CLI Sessions"
    const cliRow = getByText(sidebar, 'CLI Run')
    const cliContextTrigger = cliRow.closest('[data-state]')?.parentElement ?? cliRow
    flushSync(() => {
      cliContextTrigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems = getAllByRole(document.body, 'menuitem')
    const hideMenuItem = menuItems.find((item) => item.textContent?.includes('Hide CLI Sessions'))
    expect(hideMenuItem).toBeTruthy()

    flushSync(() => {
      hideMenuItem!.click()
    })
    await flushEffects()

    // The localStorage pref must be 'true' after a single toggle — never 'false'.
    // With the old updater-side-effect implementation this would be 'false' under StrictMode.
    expect(localStorageMock.getItem('forge-sidebar-hide-cli-sessions')).toBe('true')
  })

  it('hides a previously-selected CLI session once selection moves to a non-CLI session', () => {
    // This verifies the complete hide-CLI-sessions UX lifecycle:
    // 1. CLI session is selected with hide pref ON → stays visible (selected exception)
    // 2. Selection moves to a non-CLI session → CLI session now properly hidden
    // In production, step 2 is triggered automatically by handleToggleHideCliSessions.
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const onSelectAgent = vi.fn()
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const sidebarProps = {
      connected: true,
      agents: [regularSession, cliSession],
      profiles: [profile],
      statuses: {} as Record<string, { status: AgentStatus; pendingCount: number }>,
      unreadCounts: {},
      onAddManager: vi.fn(),
      onSelectAgent,
      onDeleteAgent: vi.fn(),
      onDeleteManager: vi.fn(),
      onOpenSettings: vi.fn(),
      isSettingsActive: false,
    }

    // Phase 1: CLI session selected with hide ON — it stays visible (exception for selected)
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'cli-session',
      })))
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Phase 2: Selection moves to regular session (simulates auto-navigate)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'regular-session',
      })))
    })

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
  })

  it('hides a CLI session when selection moves away from its worker', () => {
    // Verifies the UX fix also works when a worker of a CLI session is selected:
    // auto-navigate should move selection to a non-CLI session.
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const onSelectAgent = vi.fn()
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const cliWorker = worker('cli-worker', 'cli-session')
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const sidebarProps = {
      connected: true,
      agents: [regularSession, cliSession, cliWorker],
      profiles: [profile],
      statuses: {} as Record<string, { status: AgentStatus; pendingCount: number }>,
      unreadCounts: {},
      onAddManager: vi.fn(),
      onSelectAgent,
      onDeleteAgent: vi.fn(),
      onDeleteManager: vi.fn(),
      onOpenSettings: vi.fn(),
      isSettingsActive: false,
    }

    // Phase 1: Worker of CLI session is selected — CLI session stays visible
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'cli-worker',
      })))
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Phase 2: Selection moves to regular session (simulates auto-navigate)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'regular-session',
      })))
    })

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
  })

  it('shows the selected Cortex review-run session so it stays directly reachable', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      selectedAgentId: 'cortex--s2',
    })

    const sidebar = getDesktopSidebar()
    expect(getByText(sidebar, 'Review Run · Full Queue')).toBeTruthy()
  })

  it('toggleHideCliSessions falls back to ref state when localStorage.getItem throws', async () => {
    // Verifies that when localStorage is completely unavailable (e.g. security
    // policy, quota error), the toggle still flips correctly using in-memory
    // ref state. We render under StrictMode to also exercise double-invoke.
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    // Start with hideCliSessions = false (default) via normal localStorage
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(StrictMode, null,
          createElement(HelpProvider, null,
            createElement(AgentSidebar, {
              connected: true,
              agents: [regularSession, cliSession],
              profiles: [profile],
              statuses: {},
              unreadCounts: {},
              selectedAgentId: 'regular-session',
              onAddManager: vi.fn(),
              onSelectAgent: vi.fn(),
              onDeleteAgent: vi.fn(),
              onDeleteManager: vi.fn(),
              onOpenSettings: vi.fn(),
              isSettingsActive: false,
            }),
          ),
        ),
      )
    })
    await flushEffects()

    // CLI session should be visible initially (hideCliSessions = false)
    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Now make localStorage.getItem throw (simulates security/quota errors)
    // Keep setItem working so storeHideCliSessionsPref can still write.
    const throwingGetItem = (_key: string): string | null => { throw new Error('SecurityError') }
    vi.stubGlobal('localStorage', { ...localStorageMock, getItem: throwingGetItem })

    // Toggle hide → should use ref fallback (false) and compute next = true
    const cliRow = getByText(sidebar, 'CLI Run')
    const cliContextTrigger = cliRow.closest('[data-state]')?.parentElement ?? cliRow
    flushSync(() => {
      cliContextTrigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems = getAllByRole(document.body, 'menuitem')
    const hideMenuItem = menuItems.find((item) => item.textContent?.includes('Hide CLI Sessions'))
    expect(hideMenuItem).toBeTruthy()

    flushSync(() => {
      hideMenuItem!.click()
    })
    await flushEffects()

    // Despite getItem throwing, the toggle should have flipped to true via ref fallback.
    // storeHideCliSessionsPref calls setItem (which works) and dispatches a pref-change event.
    // The ref was in sync with the React state (false), so next = !false = true.
    // Check that localStorage received 'true' (setItem still works):
    expect(localStorageStore.get('forge-sidebar-hide-cli-sessions')).toBe('true')

    // Restore getItem for the reverse toggle test
    vi.stubGlobal('localStorage', { ...localStorageMock, getItem: throwingGetItem })

    // Now the ref should have updated to true (via the useEffect sync).
    // Toggle again → should read ref (true) and compute next = false.
    // Re-open context menu on the regular session (CLI is now hidden).
    // Use the profile header context menu instead since CLI row may be gone.
    const profileHeader = getByText(sidebar, 'My Project').closest('button')
    expect(profileHeader).toBeTruthy()
    flushSync(() => {
      profileHeader!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems2 = getAllByRole(document.body, 'menuitem')
    const showMenuItem = menuItems2.find((item) => item.textContent?.includes('Show CLI Sessions'))
    expect(showMenuItem).toBeTruthy()

    flushSync(() => {
      showMenuItem!.click()
    })
    await flushEffects()

    // Reverse toggle should have flipped back to false
    expect(localStorageStore.get('forge-sidebar-hide-cli-sessions')).toBe('false')

    // Restore original localStorage for cleanup
    vi.stubGlobal('localStorage', localStorageMock)
  })

  it('intermixes local and remote projects by composite identity while keeping local Cortex fixed above them', () => {
    const localSession = {
      ...sessionManager('shared-session', 'same-profile'),
      sessionLabel: 'Local Session',
    }
    const cortexSession = {
      ...sessionManager('cortex', 'cortex'),
      archetypeId: 'cortex',
      displayName: 'Cortex',
    }
    const remoteSession = {
      ...sessionManager('shared-session', 'same-profile'),
      displayName: 'Remote Session',
      sessionLabel: 'Remote Session',
    }
    const localProfile: ManagerProfile = {
      ...profileFor(localSession),
      profileId: 'same-profile',
      displayName: 'Local Project',
      defaultSessionAgentId: localSession.agentId,
    }
    const cortexProfile: ManagerProfile = {
      ...profileFor(cortexSession),
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: cortexSession.agentId,
      profileType: 'system',
    }
    const remoteProfile: ManagerProfile = {
      ...profileFor(remoteSession),
      profileId: 'same-profile',
      displayName: 'Remote Project',
      defaultSessionAgentId: remoteSession.agentId,
    }

    renderSidebar({
      agents: [localSession, cortexSession],
      profiles: [localProfile, cortexProfile],
      activeOriginId: 'remote-a',
      selectedAgentId: 'shared-session',
      onSelectRemoteAgent: vi.fn(),
      remoteOrigins: [{
        originId: 'remote-a',
        connected: true,
        instanceName: 'Remote A',
        treeRows: [{
          profile: remoteProfile,
          sessions: [{ sessionAgent: remoteSession, workers: [], isDefault: true }],
        }],
      }],
      builderSidebarOrder: [
        { originId: 'remote-a', profileId: 'same-profile' },
        { originId: 'local', profileId: 'same-profile' },
      ],
      onMoveBuilderProject: vi.fn(),
    })

    const sidebar = getDesktopSidebar()
    const unifiedList = sidebar.querySelector('[data-testid="unified-project-list"]')
    expect(unifiedList).not.toBeNull()
    const text = unifiedList?.textContent ?? ''
    expect(text.indexOf('Remote Project')).toBeLessThan(text.indexOf('Local Project'))
    expect(sidebar.querySelector('[data-testid="remote-profile-row-remote-a::same-profile"]')).not.toBeNull()
    expect(unifiedList?.textContent).not.toContain('Cortex')
    expect((sidebar.textContent ?? '').indexOf('Cortex')).toBeLessThan(
      (sidebar.textContent ?? '').indexOf('Remote Project'),
    )
    const localSessionContainer = getByText(sidebar, 'Local Session').closest('div.relative')
    const remoteSessionButton = getByText(sidebar, 'Remote Session').closest('button')
    expect(localSessionContainer?.className).not.toContain('ring-1')
    expect(remoteSessionButton?.className).toContain('ring-1')
  })

  it('applies plain, s:, and w: search consistently across local and remote rows and hides status cards while searching', async () => {
    const localSession = {
      ...sessionManager('local-session', 'local-project'),
      sessionLabel: 'Needle Local Session',
    }
    const remoteSession = {
      ...sessionManager('remote-session', 'remote-project'),
      sessionLabel: 'Needle Remote Session',
    }
    const remoteWorker = {
      ...worker('remote-worker', 'remote-session'),
      displayName: 'Worker Needle Specialist',
    }
    const localProfile: ManagerProfile = {
      ...profileFor(localSession),
      profileId: 'local-project',
      displayName: 'Local Project',
      defaultSessionAgentId: localSession.agentId,
    }
    const remoteProfile: ManagerProfile = {
      ...profileFor(remoteSession),
      profileId: 'remote-project',
      displayName: 'Remote Project',
      defaultSessionAgentId: remoteSession.agentId,
    }

    renderSidebar({
      agents: [localSession],
      profiles: [localProfile],
      remoteOrigins: [
        {
          originId: 'remote-a',
          connected: true,
          instanceName: 'Remote A',
          treeRows: [{
            profile: remoteProfile,
            sessions: [{
              sessionAgent: remoteSession,
              workers: [remoteWorker],
              isDefault: true,
            }],
          }],
        },
        {
          originId: 'remote-empty',
          connected: false,
          instanceName: 'Remote Empty',
          treeRows: [],
        },
      ],
    })

    const sidebar = getDesktopSidebar()
    expect(sidebar.querySelector('[data-testid="remote-origin-section-remote-empty"]')).not.toBeNull()
    const searchInput = sidebar.querySelector('input[placeholder^="Search"]') as HTMLInputElement

    fireEvent.change(searchInput, { target: { value: 'Needle' } })
    await waitFor(() => {
      expect(sidebar.textContent).toContain('2 matches')
      expect(queryByText(sidebar, 'Local Project')).toBeTruthy()
      expect(queryByText(sidebar, 'Remote Project')).toBeTruthy()
      expect(sidebar.querySelector('[data-testid="remote-origin-sections"]')).toBeNull()
    })

    fireEvent.change(searchInput, { target: { value: 's:Remote' } })
    await waitFor(() => {
      expect(sidebar.textContent).toContain('1 match')
      expect(queryByText(sidebar, 'Local Project')).toBeNull()
      expect(queryByText(sidebar, 'Remote Project')).toBeTruthy()
    })

    fireEvent.change(searchInput, { target: { value: 'w:Worker Needle' } })
    await waitFor(() => {
      expect(sidebar.textContent).toContain('1 match')
      expect(queryByText(sidebar, 'Local Project')).toBeNull()
      expect(queryByText(sidebar, 'Remote Project')).toBeTruthy()
      expect(queryByText(sidebar, 'Needle Remote Session')).toBeTruthy()
    })

    fireEvent.change(searchInput, { target: { value: 'definitely absent' } })
    await waitFor(() => {
      expect(sidebar.textContent).toContain('0 matches')
      expect(queryByText(sidebar, 'No matches found.')).toBeTruthy()
      expect(queryByText(sidebar, 'Local Project')).toBeNull()
      expect(queryByText(sidebar, 'Remote Project')).toBeNull()
      expect(sidebar.querySelector('[data-testid="remote-origin-sections"]')).toBeNull()
    })
  })

  it('renders delimiter-adversarial local/remote sortable tuples as distinct accessible rows', () => {
    const localSession = sessionManager('local-session', 'nested::profile')
    const remoteSession = sessionManager('remote-session', 'profile')
    const localProfile: ManagerProfile = {
      ...profileFor(localSession),
      profileId: 'nested::profile',
      displayName: 'Delimiter Local',
      defaultSessionAgentId: localSession.agentId,
    }
    const remoteProfile: ManagerProfile = {
      ...profileFor(remoteSession),
      profileId: 'profile',
      displayName: 'Delimiter Remote',
      defaultSessionAgentId: remoteSession.agentId,
    }

    renderSidebar({
      agents: [localSession],
      profiles: [localProfile],
      remoteOrigins: [{
        originId: 'local::nested',
        connected: true,
        instanceName: 'Delimiter Instance',
        treeRows: [{
          profile: remoteProfile,
          sessions: [{ sessionAgent: remoteSession, workers: [], isDefault: true }],
        }],
      }],
      builderSidebarOrder: [
        { originId: 'local::nested', profileId: 'profile' },
        { originId: 'local', profileId: 'nested::profile' },
      ],
      onMoveBuilderProject: vi.fn(),
    })

    const sidebar = getDesktopSidebar()
    const list = sidebar.querySelector('[data-testid="unified-project-list"]')
    expect(list?.textContent).toContain('Delimiter Local')
    expect(list?.textContent).toContain('Delimiter Remote')
    const activators = list?.querySelectorAll('button[aria-roledescription="sortable"]') ?? []
    expect(activators).toHaveLength(2)
    expect(Array.from(activators).map((element) => element.getAttribute('aria-label'))).toEqual([
      'Collapse or drag remote project Delimiter Remote on Delimiter Instance',
      'Collapse or drag project Delimiter Local',
    ])
    expect(Array.from(list?.children ?? []).every((element) => !element.hasAttribute('aria-roledescription'))).toBe(true)
  })

  it('keeps profiles visible when sidebar search matches inactive repository project agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const profileId = url.searchParams.get('profileId')
      const item = profileId === 'project-a'
        ? {
            definitionId: 'docs-definition',
            handle: 'repo-docs',
            path: '/repo/.forge/project-agents/docs-definition',
            status: 'valid' as const,
            problems: [],
            displayName: 'Repository Docs Agent',
            whenToUse: 'Use for handbook maintenance',
          }
        : {
            definitionId: 'release-definition',
            handle: 'repo-release',
            path: '/repo/.forge/project-agents/release-definition',
            status: 'valid' as const,
            problems: [],
            displayName: 'Release Agent',
            whenToUse: 'Use for release notes',
          }
      return {
        ok: true,
        json: async () => ({
          resources: {
            projectAgents: {
              exists: true,
              count: 1,
              items: [item],
            },
          },
        }),
      }
    }))

    const projectA = sessionManager('project-a-main', 'project-a')
    const projectB = sessionManager('project-b-main', 'project-b')
    renderSidebar({
      agents: [projectA, projectB],
      profiles: [
        { ...profileFor(projectA), profileId: 'project-a', displayName: 'Project A', defaultSessionAgentId: 'project-a-main' },
        { ...profileFor(projectB), profileId: 'project-b', displayName: 'Project B', defaultSessionAgentId: 'project-b-main' },
      ],
      wsUrl: 'ws://127.0.0.1:47187',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    const searchInput = sidebar.querySelector('input[placeholder^="Search"]') as HTMLInputElement
    expect(searchInput).toBeTruthy()

    for (const query of ['repo-docs', 'Repository Docs', 'handbook maintenance']) {
      fireEvent.change(searchInput, { target: { value: query } })
      await waitFor(() => {
        expect(queryByText(sidebar, 'Project A')).toBeTruthy()
        expect(sidebar.querySelector('button[aria-label^="Repository Docs Agent"]')).toBeTruthy()
        expect(queryByText(sidebar, 'Project B')).toBeNull()
        expect(queryByText(sidebar, 'No matches found.')).toBeNull()
      })
    }
  })

  it('restores an active project view, hides every outside project and Cortex, and leaves an outside conversation', async () => {
    const customerSession = sessionManager('customer-main', 'customer-project')
    const privateSession = sessionManager('private-main', 'private-project')
    const cortexSession = {
      ...sessionManager('cortex-main', 'cortex'),
      archetypeId: 'cortex',
    }
    const onSelectAgent = vi.fn()
    localStorageMock.setItem('forge-sidebar-project-views', JSON.stringify({
      version: 1,
      activeViewId: 'customer-view',
      views: [{
        id: 'customer-view',
        name: 'Acme screen share',
        projectKeys: [JSON.stringify(['local', 'customer-project'])],
      }],
    }))

    renderSidebar({
      agents: [customerSession, privateSession, cortexSession],
      profiles: [
        { ...profileFor(customerSession), profileId: 'customer-project', displayName: 'Acme Project', defaultSessionAgentId: customerSession.agentId },
        { ...profileFor(privateSession), profileId: 'private-project', displayName: 'Private Project', defaultSessionAgentId: privateSession.agentId },
        { ...profileFor(cortexSession), profileId: 'cortex', displayName: 'Cortex', defaultSessionAgentId: cortexSession.agentId },
      ],
      selectedAgentId: privateSession.agentId,
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()
    expect(getByRole(sidebar, 'button', { name: 'Project view: Acme screen share' })).toBeTruthy()
    expect(queryByText(sidebar, 'Acme Project')).toBeTruthy()
    expect(queryByText(sidebar, 'Private Project')).toBeNull()
    expect(queryByText(sidebar, 'Cortex')).toBeNull()
    await waitFor(() => expect(onSelectAgent).toHaveBeenCalledWith(customerSession.agentId))
  })

  it('does not leave Settings to enforce an active project view', async () => {
    const customerSession = sessionManager('customer-main', 'customer-project')
    const privateSession = sessionManager('private-main', 'private-project')
    const onSelectAgent = vi.fn()
    localStorageMock.setItem('forge-sidebar-project-views', JSON.stringify({
      version: 1,
      activeViewId: 'customer-view',
      views: [{
        id: 'customer-view',
        name: 'Acme screen share',
        projectKeys: [JSON.stringify(['local', 'customer-project'])],
      }],
    }))

    renderSidebar({
      agents: [customerSession, privateSession],
      profiles: [
        { ...profileFor(customerSession), profileId: 'customer-project', displayName: 'Acme Project', defaultSessionAgentId: customerSession.agentId },
        { ...profileFor(privateSession), profileId: 'private-project', displayName: 'Private Project', defaultSessionAgentId: privateSession.agentId },
      ],
      selectedAgentId: privateSession.agentId,
      isSettingsActive: true,
      onSelectAgent,
    })

    await flushEffects()

    expect(getByRole(getDesktopSidebar(), 'button', { name: 'Project view: Acme screen share' })).toBeTruthy()
    expect(onSelectAgent).not.toHaveBeenCalled()
  })

  it('creates a named project view and can switch cleanly back to all projects', async () => {
    const customerSession = sessionManager('customer-main', 'customer-project')
    const privateSession = sessionManager('private-main', 'private-project')
    renderSidebar({
      agents: [customerSession, privateSession],
      profiles: [
        { ...profileFor(customerSession), profileId: 'customer-project', displayName: 'Acme Project', defaultSessionAgentId: customerSession.agentId },
        { ...profileFor(privateSession), profileId: 'private-project', displayName: 'Private Project', defaultSessionAgentId: privateSession.agentId },
      ],
    })

    const sidebar = getDesktopSidebar()
    fireEvent.pointerDown(getByRole(sidebar, 'button', { name: 'Project view: All projects' }), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => click(getByRole(document.body, 'menuitem', { name: 'New project view' })))

    const nameInput = getByRole(document.body, 'textbox', { name: 'View name' }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Acme screen share' } })
    click(getByRole(document.body, 'checkbox', { name: 'Include Acme Project' }))
    click(getByRole(document.body, 'button', { name: 'Create view' }))

    await waitFor(() => {
      expect(getByRole(sidebar, 'button', { name: 'Project view: Acme screen share' })).toBeTruthy()
      expect(queryByText(sidebar, 'Acme Project')).toBeTruthy()
      expect(queryByText(sidebar, 'Private Project')).toBeNull()
    })
    const stored = JSON.parse(localStorageMock.getItem('forge-sidebar-project-views') ?? '{}') as {
      activeViewId?: string | null
      views?: Array<{ name: string; projectKeys: string[] }>
    }
    expect(stored.activeViewId).toBeTruthy()
    expect(stored.views).toEqual([{
      name: 'Acme screen share',
      projectKeys: [JSON.stringify(['local', 'customer-project'])],
      id: stored.activeViewId,
    }])

    fireEvent.pointerDown(getByRole(sidebar, 'button', { name: 'Project view: Acme screen share' }), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => click(getByRole(document.body, 'menuitem', { name: /All projects/ })))
    await waitFor(() => {
      expect(queryByText(sidebar, 'Private Project')).toBeTruthy()
      expect(getByRole(sidebar, 'button', { name: 'Project view: All projects' })).toBeTruthy()
    })
    const restored = JSON.parse(localStorageMock.getItem('forge-sidebar-project-views') ?? '{}') as {
      activeViewId?: string | null
    }
    expect(restored.activeViewId).toBeNull()
  })

  it('edits and deletes the active project view without losing the all-projects fallback', async () => {
    const customerSession = sessionManager('customer-main', 'customer-project')
    const privateSession = sessionManager('private-main', 'private-project')
    localStorageMock.setItem('forge-sidebar-project-views', JSON.stringify({
      version: 1,
      activeViewId: 'customer-view',
      views: [{
        id: 'customer-view',
        name: 'Acme screen share',
        projectKeys: [JSON.stringify(['local', 'customer-project'])],
      }],
    }))
    renderSidebar({
      agents: [customerSession, privateSession],
      profiles: [
        { ...profileFor(customerSession), profileId: 'customer-project', displayName: 'Acme Project', defaultSessionAgentId: customerSession.agentId },
        { ...profileFor(privateSession), profileId: 'private-project', displayName: 'Private Project', defaultSessionAgentId: privateSession.agentId },
      ],
      selectedAgentId: customerSession.agentId,
    })

    const sidebar = getDesktopSidebar()
    fireEvent.pointerDown(getByRole(sidebar, 'button', { name: 'Project view: Acme screen share' }), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => click(getByRole(document.body, 'menuitem', { name: 'Edit current view' })))
    click(getByRole(document.body, 'checkbox', { name: 'Include Private Project' }))
    click(getByRole(document.body, 'button', { name: 'Save view' }))
    await waitFor(() => expect(queryByText(sidebar, 'Private Project')).toBeTruthy())

    fireEvent.pointerDown(getByRole(sidebar, 'button', { name: 'Project view: Acme screen share' }), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => click(getByRole(document.body, 'menuitem', { name: 'Edit current view' })))
    click(getByRole(document.body, 'button', { name: 'Delete' }))

    await waitFor(() => {
      expect(getByRole(sidebar, 'button', { name: 'Project view: All projects' })).toBeTruthy()
      expect(queryByText(sidebar, 'Acme Project')).toBeTruthy()
      expect(queryByText(sidebar, 'Private Project')).toBeTruthy()
    })
    const stored = JSON.parse(localStorageMock.getItem('forge-sidebar-project-views') ?? '{}') as {
      activeViewId?: string | null
      views?: unknown[]
    }
    expect(stored.activeViewId).toBeNull()
    expect(stored.views).toEqual([])
  })
})
