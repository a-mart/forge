import type {
  AgentStatusEvent,
  AgentsSnapshotEvent,
  SessionWorkersSnapshotEvent,
} from './agent-events.js'
import type { CliServerEvent } from './cli.js'
import type {
  ConversationEntry,
  MessagePinnedEvent,
} from './conversation-events.js'
import type {
  CortexPromptSurfaceChangedEvent,
  ModelConfigChangedEvent,
  PromptChangedEvent,
  SpecialistRosterChangedEvent,
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
  DirectoryPickedEvent,
  DirectoryValidatedEvent,
} from './directory-events.js'
import type { TelegramStatusEvent } from './integration-events.js'
import type {
  ManagerCreatedEvent,
  ManagerCwdUpdatedEvent,
  ManagerDeletedEvent,
  ManagerModelUpdatedEvent,
  ProfileDefaultModelUpdatedEvent,
  StopAllAgentsResultEvent,
} from './manager-events.js'
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
  ProjectAgentRecommendationsErrorEvent,
  ProjectAgentRecommendationsEvent,
  ProjectAgentReferenceDeletedEvent,
  ProjectAgentReferenceEvent,
  ProjectAgentReferencesEvent,
  ProjectAgentReferenceSavedEvent,
  SessionProjectAgentUpdatedEvent,
} from './project-agent-events.js'
import type {
  SessionArchivedEvent,
  SessionClearedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
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
import type {
  TerminalClosedEvent,
  TerminalCreatedEvent,
  TerminalsSnapshotEvent,
  TerminalUpdatedEvent,
} from './terminal-types.js'
import type {
  ApiProxyResponseEvent,
  ConversationHistoryEvent,
  ConversationResetEvent,
  ErrorEvent,
  PendingChoicesSnapshotEvent,
  ReadyEvent,
} from './transport-events.js'

// Compatibility re-exports from leaf modules
export * from './conversation-events.js'
export * from './agent-events.js'
export * from './cli.js'
export * from './manager-events.js'
export * from './session-events.js'
export * from './project-agent-events.js'
export * from './profile-events.js'
export * from './directory-events.js'
export * from './notification-events.js'
export * from './integration-events.js'
export * from './config-events.js'
export * from './transport-events.js'

export type ServerEvent =
  | CliServerEvent
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
  | PendingChoicesSnapshotEvent
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
  | ManagerModelUpdatedEvent
  | ManagerCwdUpdatedEvent
  | SessionCreatedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionArchivedEvent
  | SessionRestoredEvent
  | SessionDeletedEvent
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
  | DirectoryPickedEvent
  | TelegramStatusEvent
  | PromptChangedEvent
  | CortexPromptSurfaceChangedEvent
  | TerminalCreatedEvent
  | TerminalUpdatedEvent
  | TerminalClosedEvent
  | TerminalsSnapshotEvent
  | SpecialistRosterChangedEvent
  | ModelConfigChangedEvent
  | ApiProxyResponseEvent
  | MessagePinnedEvent
  | ErrorEvent

