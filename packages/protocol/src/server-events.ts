import type {
  AgentStatusEvent,
  AgentsSnapshotEvent,
  SessionWorkersSnapshotEvent,
} from './agent-events.js'
import type { BuilderSidebarOrderUpdatedEvent } from './builder-sidebar-order.js'
import type { BrowserServerEvent } from './browser-automation.js'
import type { CliServerEvent } from './cli.js'
import type { CodexElicitationDismissedEvent, CodexElicitationRequestEvent } from './codex-elicitation.js'
import type {
  ConversationEntry,
  MessagePinnedEvent,
} from './conversation-events.js'
import type {
  CortexPromptSurfaceChangedEvent,
  ModelConfigChangedEvent,
  PromptChangedEvent,
  SpecialistRosterChangedEvent,
  ModelCacheVisualizationSettingsChangedEvent,
} from './config-events.js'
import type {
  CollaborationBootstrapEvent,
  CollaborationCategoryCreatedEvent,
  CollaborationCategoryDeletedEvent,
  CollaborationCategoryReorderedEvent,
  CollaborationCategoryUpdatedEvent,
  CollaborationChannelActivityUpdatedEvent,
  CollaborationChannelArchivedEvent,
  CollaborationChannelCreatedEvent,
  CollaborationChannelHistoryEvent,
  CollaborationChannelMessageEvent,
  CollaborationChannelReadyEvent,
  CollaborationChannelReorderedEvent,
  CollaborationChannelStatusEvent,
  CollaborationChannelUpdatedEvent,
  CollaborationChoiceRequestEvent,
  CollaborationMessagePinnedEvent,
  CollaborationReadStateUpdatedEvent,
  CollaborationSessionActivityEvent,
  CollaborationSessionActivitySnapshotEvent,
  CollaborationSessionAgentStatusEvent,
  CollaborationSessionWorkersSnapshotEvent,
} from './collaboration.js'
import type {
  DirectoriesListedEvent,
  DirectoryCreatedEvent,
  DirectoryPickedEvent,
  DirectoryValidatedEvent,
} from './directory-events.js'
import type {
  ManagerCreatedEvent,
  ManagerCwdUpdatedEvent,
  ManagerDeletedEvent,
  ManagerModelUpdatedEvent,
  ProfileDefaultModelUpdatedEvent,
  ProjectDelegationDefaultsUpdatedEvent,
  StopAllAgentsResultEvent,
} from './manager-events.js'
import type {
  RepositoryProjectCreatedEvent,
  RepositoryProjectCreationCancelResultEvent,
  RepositoryProjectCreationCancelledEvent,
  RepositoryProjectCreationProgressEvent,
} from './repository-project.js'
import type {
  UnreadCountUpdateEvent,
  UnreadCountsSnapshotEvent,
  UnreadNotificationEvent,
} from './notification-events.js'
import type {
  ProfileArchivedEvent,
  ProfileRenamedEvent,
  ProfileRestoredEvent,
  ProfilesSnapshotEvent,
} from './profile-events.js'
import type {
  ProjectAgentConfigEvent,
  ProjectAgentExternalDirectoryEvent,
  ProjectAgentRecommendationsErrorEvent,
  ProjectAgentRecommendationsEvent,
  ProjectAgentReferenceDeletedEvent,
  ProjectAgentReferenceEvent,
  ProjectAgentReferencesEvent,
  ProjectAgentReferenceSavedEvent,
  ProjectAgentSharingEvent,
  ProjectAgentSharingUpdatedEvent,
  SessionProjectAgentUpdatedEvent,
} from './project-agent-events.js'
import type {
  ArchiveLastUsedHydratedEvent,
  SessionArchivedEvent,
  SessionClearedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionDelegationUpdatedEvent,
  SessionForkedEvent,
  SessionMemoryMergeFailedEvent,
  SessionMemoryMergedEvent,
  SessionMemoryMergeStartedEvent,
  SessionModelUpdatedEvent,
  SessionPinnedEvent,
  SessionRenamedEvent,
  SessionRestoredEvent,
  SessionResumedEvent,
  SessionStoppedEvent,
} from './session-events.js'
import type { SessionPlanSnapshotEvent } from './plans.js'
import type { SessionGoalSnapshotEvent } from './goals.js'
import type {
  TerminalClosedEvent,
  TerminalCreatedEvent,
  TerminalsSnapshotEvent,
  TerminalUpdatedEvent,
} from './terminal-types.js'
import type {
  ApiProxyResponseEvent,
  BootstrapFailedEvent,
  ConversationHistoryEvent,
  ConversationPageEvent,
  ConversationResetEvent,
  ErrorEvent,
  PendingChoicesSnapshotEvent,
  ReadyEvent,
} from './transport-events.js'
import type { ProjectPresenceEvent } from './presence.js'
import type { RestartRecoverySnapshotEvent } from './restart-recovery.js'
import type {
  RemoteUpdateAwarenessProjectChangedEvent,
  RemoteUpdateAwarenessProjectClearedEvent,
} from './remote-update-awareness.js'
import type {
  SecureSecretCatalogChangedEvent,
  SecureSessionSnapshotEvent,
} from './secure-sessions.js'
import type { StreamDeckNavigationRequestedEvent } from './stream-deck.js'
import type {
  GenerationThroughputEvent,
  GenerationThroughputSnapshotEvent,
} from './generation-throughput.js'
import type { ManagerToolActivityEvent } from './manager-tool-activity.js'

// Compatibility re-exports from leaf modules
export * from './builder-sidebar-order.js'
export * from './browser-automation.js'
export * from './conversation-events.js'
export * from './agent-events.js'
export * from './cli.js'
export * from './manager-events.js'
export * from './repository-project.js'
export * from './session-events.js'
export * from './project-agent-events.js'
export * from './profile-events.js'
export * from './directory-events.js'
export * from './notification-events.js'
export * from './config-events.js'
export * from './plans.js'
export * from './goals.js'
export * from './transport-events.js'
export * from './restart-recovery.js'
export * from './remote-update-awareness.js'
export * from './secure-sessions.js'

export type ServerEvent =
  | BuilderSidebarOrderUpdatedEvent
  | BrowserServerEvent
  | CliServerEvent
  | CodexElicitationRequestEvent
  | CodexElicitationDismissedEvent
  | ReadyEvent
  | CollaborationBootstrapEvent
  | CollaborationChannelReadyEvent
  | CollaborationChannelHistoryEvent
  | CollaborationChannelMessageEvent
  | CollaborationChannelStatusEvent
  | CollaborationSessionWorkersSnapshotEvent
  | CollaborationSessionActivitySnapshotEvent
  | CollaborationSessionActivityEvent
  | CollaborationSessionAgentStatusEvent
  | CollaborationChannelActivityUpdatedEvent
  | CollaborationReadStateUpdatedEvent
  | CollaborationChoiceRequestEvent
  | CollaborationMessagePinnedEvent
  | CollaborationChannelCreatedEvent
  | CollaborationChannelUpdatedEvent
  | CollaborationChannelArchivedEvent
  | CollaborationChannelReorderedEvent
  | CollaborationCategoryCreatedEvent
  | CollaborationCategoryUpdatedEvent
  | CollaborationCategoryDeletedEvent
  | CollaborationCategoryReorderedEvent
  | ConversationResetEvent
  | ConversationHistoryEvent
  | ConversationPageEvent
  | PendingChoicesSnapshotEvent
  | BootstrapFailedEvent
  | RestartRecoverySnapshotEvent
  | RemoteUpdateAwarenessProjectChangedEvent
  | RemoteUpdateAwarenessProjectClearedEvent
  | SecureSessionSnapshotEvent
  | SecureSecretCatalogChangedEvent
  | StreamDeckNavigationRequestedEvent
  | GenerationThroughputEvent
  | GenerationThroughputSnapshotEvent
  | ManagerToolActivityEvent
  | ProjectPresenceEvent
  | SessionPlanSnapshotEvent
  | SessionGoalSnapshotEvent
  | ConversationEntry
  | AgentStatusEvent
  | AgentsSnapshotEvent
  | SessionWorkersSnapshotEvent
  | ProfilesSnapshotEvent
  | UnreadNotificationEvent
  | UnreadCountsSnapshotEvent
  | UnreadCountUpdateEvent
  | ManagerCreatedEvent
  | ManagerDeletedEvent
  | ProfileDefaultModelUpdatedEvent
  | ProjectDelegationDefaultsUpdatedEvent
  | ManagerModelUpdatedEvent
  | ManagerCwdUpdatedEvent
  | RepositoryProjectCreationProgressEvent
  | RepositoryProjectCreatedEvent
  | RepositoryProjectCreationCancelledEvent
  | RepositoryProjectCreationCancelResultEvent
  | SessionCreatedEvent
  | ArchiveLastUsedHydratedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionArchivedEvent
  | SessionRestoredEvent
  | SessionDeletedEvent
  | SessionDelegationUpdatedEvent
  | SessionClearedEvent
  | SessionRenamedEvent
  | SessionPinnedEvent
  | SessionModelUpdatedEvent
  | SessionProjectAgentUpdatedEvent
  | ProjectAgentRecommendationsEvent
  | ProjectAgentRecommendationsErrorEvent
  | ProjectAgentConfigEvent
  | ProjectAgentReferencesEvent
  | ProjectAgentReferenceEvent
  | ProjectAgentReferenceSavedEvent
  | ProjectAgentReferenceDeletedEvent
  | ProjectAgentSharingEvent
  | ProjectAgentSharingUpdatedEvent
  | ProjectAgentExternalDirectoryEvent
  | ProfileRenamedEvent
  | ProfileArchivedEvent
  | ProfileRestoredEvent
  | SessionForkedEvent
  | SessionMemoryMergeStartedEvent
  | SessionMemoryMergedEvent
  | SessionMemoryMergeFailedEvent
  | StopAllAgentsResultEvent
  | DirectoriesListedEvent
  | DirectoryValidatedEvent
  | DirectoryCreatedEvent
  | DirectoryPickedEvent
  | PromptChangedEvent
  | CortexPromptSurfaceChangedEvent
  | TerminalCreatedEvent
  | TerminalUpdatedEvent
  | TerminalClosedEvent
  | TerminalsSnapshotEvent
  | SpecialistRosterChangedEvent
  | ModelCacheVisualizationSettingsChangedEvent
  | ModelConfigChangedEvent
  | ApiProxyResponseEvent
  | MessagePinnedEvent
  | ErrorEvent
