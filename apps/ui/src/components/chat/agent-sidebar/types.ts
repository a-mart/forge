import type {
  AgentContextUsage,
  AgentDescriptor,
  BuilderSidebarOrderRef,
  AgentStatus,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  ManagerProfile,
  ProjectAgentCapability,
  ProjectAgentConfigSourceSnapshot,
  ProjectAgentInfo,
  ProjectAgentShareEligibleTarget,
  ProjectAgentShareGrantInfo,
  PersistedProjectAgentConfig,
  SessionModelUpdateMode,
} from '@forge/protocol'
import type { DirectoryValidationResult } from '@/lib/ws-client'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'

export type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
}

export type StatusMap = Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage; contextRecoveryInProgress?: boolean }>

export interface RemoteSidebarOrigin {
  originId: string
  connected: boolean
  /** Prebuilt once from this origin's structural agents/profile slices. */
  treeRows: ProfileTreeRow[]
  /** Used only before origin meta is available (tests/connection bootstrap). */
  instanceName?: string
}

export interface AgentSidebarProps {
  connected: boolean
  wsUrl?: string
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  /** Prebuilt structural rows supplied by AgentSidebarConnected. */
  treeRows?: ProfileTreeRow[]
  statuses: StatusMap
  unreadCounts: Record<string, number>
  collaborationModeSwitch?: {
    activeSurface: ActiveSurface
    onSelectSurface: (surface: ActiveSurface) => void
  }
  terminalScopeId?: string | null
  terminalCount?: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isStatsActive?: boolean
  isArchiveActive?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onOpenProjectSecrets?: (profileId: string) => void
  onOpenStats?: () => void
  onOpenArchive?: () => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  onRenameSession?: (agentId: string, label: string) => void
  onPinSession?: (agentId: string, pinned: boolean) => void
  onRenameProfile?: (profileId: string, displayName: string) => void
  onForkSession?: (sourceAgentId: string, name?: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onUpdateManagerModel?: (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onUpdateSessionModel?: (sessionAgentId: string, mode: SessionModelUpdateMode, modelSelection?: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onUpdateManagerCwd?: (managerId: string, cwd: string) => Promise<void>
  onBrowseDirectory?: (defaultPath: string) => Promise<string | null>
  onValidateDirectory?: (path: string) => Promise<DirectoryValidationResult>
  /** Same-origin hosted collaboration Builder uses the server folder browser. */
  directServerDirectoryBrowser?: { canCreateDirectory: boolean }
  onRequestSessionWorkers?: (sessionId: string) => void
  /** Reconciled local-instance authority, including hidden/offline anchors. */
  builderSidebarOrder?: BuilderSidebarOrderRef[]
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  onSetSessionProjectAgent?: (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: ProjectAgentCapability[] } | null) => Promise<void>
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: PersistedProjectAgentConfig; systemPrompt: string | null; references: string[]; source?: ProjectAgentConfigSourceSnapshot }>
  onGetProjectAgentSharing?: (agentId: string) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[] }>
  onSetProjectAgentSharing?: (agentId: string, targetProfileIds: string[]) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[]; addedTargetProfileIds: string[]; removedTargetProfileIds: string[] }>
  onListProjectAgentReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetProjectAgentReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string }>
  onSetProjectAgentReference?: (agentId: string, fileName: string, content: string) => Promise<{ agentId: string; fileName: string }>
  onDeleteProjectAgentReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string }>
  onRequestProjectAgentRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
  onCreateAgentCreator?: (profileId: string) => void
  /** Remote origin snapshots used in the unified mixed project list. */
  remoteOrigins?: RemoteSidebarOrigin[]
  /** The origin whose builder surface is active (selection highlight scoping). */
  activeOriginId?: string
  onSelectRemoteAgent?: (originId: string, agentId: string) => void
  onRemoteOriginSignIn?: (originId: string) => void
  onRemoteOriginRetry?: (originId: string) => void
}

export interface WorkerRowProps {
  agent: AgentDescriptor
  liveStatus: AgentLiveStatus
  isSelected: boolean
  onSelect: () => void
  onDelete?: () => void
  onStop?: () => void
  onResume?: () => void
  highlightQuery?: string
}

export interface SessionRowItemProps {
  session: SessionRow
  statuses: StatusMap
  unreadCount: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  isWorkerListExpanded: boolean
  onToggleCollapse: () => void
  onToggleWorkerListExpanded: () => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onStop?: () => void
  onResume?: () => void
  onDelete?: () => void
  onArchive?: () => void
  archiveDisabledReason?: string
  onRename?: () => void
  onFork?: () => void
  onMarkUnread?: () => void
  onStopWorker?: (agentId: string) => void
  onResumeWorker?: (agentId: string) => void
  highlightQuery?: string
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: () => void
  onOpenProjectAgentSharing?: () => void
  onOpenProjectAgentSettings?: () => void
  onDemoteProjectAgent?: () => void
  onViewCreationHistory?: () => void
  onChangeSessionModel?: () => void
  onUseProjectDefault?: () => void
  isMutedSession?: boolean
  onToggleMute?: () => void
  getCreatorAttribution?: (creatorAgentId: string) => string | null
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
}

export interface ProfileGroupProps {
  treeRow: ProfileTreeRow
  statuses: StatusMap
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  visibleSessionLimit: number
  expandedWorkerListSessionIds: Set<string>
  onToggleProfileCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onShowMoreSessions: () => void
  onShowLessSessions: () => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onOpenProjectSecrets?: (profileId: string) => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onRequestRenameProfile?: (profileId: string) => void
  onForkSession?: (sourceAgentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onChangeModel?: (profileId: string) => void
  onChangeSessionModel?: (sessionAgentId: string) => void
  onUseProjectDefault?: (sessionAgentId: string) => void
  onChangeCwd?: (profileId: string) => void
  showModelIcons?: boolean
  highlightQuery?: string
  dragHandleRef?: (element: HTMLElement | null) => void
  dragHandleListeners?: DraggableSyntheticListeners
  dragHandleAttributes?: DraggableAttributes
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: (agentId: string) => void
  onOpenProjectAgentSharing?: (agentId: string) => void
  onOpenProjectAgentSettings?: (agentId: string) => void
  onDemoteProjectAgent?: (agentId: string) => void | Promise<void>
  onCreateAgentCreator?: (profileId: string) => void
  mutedAgents?: Set<string>
  onToggleMute?: (agentId: string) => void
  onMuteAllSessions?: (sessionAgentIds: string[], mute: boolean) => void
  getCreatorAttribution?: (creatorAgentId: string) => string | null
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
  inactiveRepoProjectAgents?: import('@/hooks/use-inactive-repo-project-agents').RepoProjectAgentSidebarEntry[]
  selectedInactiveRepoEntryKey?: string | null
  onSelectInactiveRepoProjectAgent?: (entry: import('@/hooks/use-inactive-repo-project-agents').RepoProjectAgentSidebarEntry) => void
}

export interface CortexSectionProps {
  cortexRow: ProfileTreeRow
  statuses: StatusMap
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  visibleSessionLimit: number
  expandedWorkerListSessionIds: Set<string>
  onToggleCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onShowMoreSessions: () => void
  onShowLessSessions: () => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onOpenSettings: () => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  highlightQuery?: string
  mutedAgents?: Set<string>
  onToggleMute?: (agentId: string) => void
  onMuteAllSessions?: (sessionAgentIds: string[], mute: boolean) => void
}

export interface ProjectAgentSettingsSheetProps {
  agentId: string
  sessionLabel: string
  currentProjectAgent: ProjectAgentInfo | null
  onSave: (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: ProjectAgentCapability[] }) => Promise<void>
  onDemote: (agentId: string) => Promise<void>
  onClose: () => void
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: PersistedProjectAgentConfig; systemPrompt: string | null; references: string[]; source?: ProjectAgentConfigSourceSnapshot }>
  onGetProjectAgentSharing?: (agentId: string) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[] }>
  onSetProjectAgentSharing?: (agentId: string, targetProfileIds: string[]) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[]; addedTargetProfileIds: string[]; removedTargetProfileIds: string[] }>
  onListReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string }>
  onSetReference?: (agentId: string, fileName: string, content: string) => Promise<{ agentId: string; fileName: string }>
  onDeleteReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string }>
  onRequestRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
}
