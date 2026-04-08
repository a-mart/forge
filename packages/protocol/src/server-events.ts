import type {
  AgentStatusEvent,
  AgentsSnapshotEvent,
  SessionWorkersSnapshotEvent,
} from './agent-events.js'
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
  StopAllAgentsResultEvent,
} from './manager-events.js'
import type {
  UnreadCountUpdateEvent,
  UnreadCountsSnapshotEvent,
  UnreadNotificationEvent,
} from './notification-events.js'
import type {
  PlaywrightDiscoverySettingsUpdatedEvent,
  PlaywrightDiscoverySnapshotEvent,
  PlaywrightDiscoveryUpdatedEvent,
} from './playwright-events.js'
import type { ProfileRenamedEvent, ProfilesSnapshotEvent } from './profile-events.js'
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
  SessionClearedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionForkedEvent,
  SessionMemoryMergeFailedEvent,
  SessionMemoryMergedEvent,
  SessionMemoryMergeStartedEvent,
  SessionPinnedEvent,
  SessionRenamedEvent,
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

export type ServerEvent =
  | ReadyEvent
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
  | ManagerModelUpdatedEvent
  | ManagerCwdUpdatedEvent
  | SessionCreatedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionDeletedEvent
  | SessionClearedEvent
  | SessionRenamedEvent
  | SessionPinnedEvent
  | SessionProjectAgentUpdatedEvent
  | ProjectAgentRecommendationsEvent
  | ProjectAgentRecommendationsErrorEvent
  | ProjectAgentConfigEvent
  | ProjectAgentReferencesEvent
  | ProjectAgentReferenceEvent
  | ProjectAgentReferenceSavedEvent
  | ProjectAgentReferenceDeletedEvent
  | ProfileRenamedEvent
  | SessionForkedEvent
  | SessionMemoryMergeStartedEvent
  | SessionMemoryMergedEvent
  | SessionMemoryMergeFailedEvent
  | StopAllAgentsResultEvent
  | DirectoriesListedEvent
  | DirectoryValidatedEvent
  | DirectoryPickedEvent
  | TelegramStatusEvent
  | PlaywrightDiscoverySnapshotEvent
  | PlaywrightDiscoveryUpdatedEvent
  | PlaywrightDiscoverySettingsUpdatedEvent
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

