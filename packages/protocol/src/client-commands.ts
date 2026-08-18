import type { ConversationAttachment } from './attachments.js'
import type { BrowserClientCommand } from './browser-automation.js'
import type { ConversationReplyTargetInput } from './conversation-events.js'
import type { BuilderTimelineChannelView } from './builder-timeline-visibility.js'
import type { SessionProjectAgentInput } from './agents.js'
import type { CodexElicitationDecision, CodexElicitationPersistScope } from './codex-elicitation.js'
import type { SessionGoalControlAction } from './goals.js'
import type { DismissSessionAttentionCommand } from './session-attention.js'
import type {
  CollaborationBootstrapCommand,
  CollaborationChoiceCancelCommand,
  CollaborationChoiceResponseCommand,
  CollaborationMarkChannelReadCommand,
  CollaborationPinMessageCommand,
  CollaborationSubscribeChannelCommand,
  CollaborationUnsubscribeChannelCommand,
  CollaborationUserMessageCommand,
} from './collaboration.js'
import type {
  CancelRepositoryProjectCreationCommandFields,
  CreateRepositoryProjectCommandFields,
} from './repository-project.js'
import type {
  AgentSessionPurpose,
  ChoiceAnswer,
  ManagerPosture,
  DeliveryMode,
  ManagerExactModelSelection,
  ManagerModelPreset,
  ManagerReasoningLevel,
} from './shared-types.js'

export interface ApiProxyCommand {
  type: 'api_proxy'
  requestId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string
}

type ManagerModelSelectionInput = {
  model?: ManagerModelPreset
  modelSelection?: ManagerExactModelSelection
}

export type ClientCommand =
  | {
      type: 'subscribe'
      agentId?: string
      messageCount?: number
      /** Correlates this request with its conversation bootstrap snapshots. */
      subscriptionId?: string
      /** New clients advertise this so older clients retain the legacy bootstrap contract. */
      conversationPaging?: true
      /** Paging view is cursor-bound; switching views starts a fresh replace bootstrap. */
      conversationView?: BuilderTimelineChannelView
      /** Advertises support for request-correlated session goal control results. */
      goalControlRequestId?: true
    }
  | { type: 'resume_restart_recovery'; requestId?: string }
  | { type: 'dismiss_restart_recovery'; requestId?: string }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
      replyTo?: ConversationReplyTargetInput
      /**
       * Client-generated id echoed back on the resulting broadcast
       * `conversation_message` so the sender can replace its optimistic
       * entry instead of appending a duplicate (multi-writer dedup).
       */
      clientRequestId?: string
    }
  | CollaborationBootstrapCommand
  | CollaborationSubscribeChannelCommand
  | CollaborationUnsubscribeChannelCommand
  | CollaborationUserMessageCommand
  | CollaborationMarkChannelReadCommand
  | CollaborationChoiceResponseCommand
  | CollaborationChoiceCancelCommand
  | CollaborationPinMessageCommand
  | BrowserClientCommand
  | ApiProxyCommand
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_all_agents'; managerId: string; requestId?: string }
  | ({ type: 'create_manager'; name: string; cwd: string; reasoningLevel?: ManagerReasoningLevel; requestId?: string } & ManagerModelSelectionInput)
  | ({ type: 'create_repository_project' } & CreateRepositoryProjectCommandFields)
  | ({ type: 'cancel_repository_project_creation' } & CancelRepositoryProjectCreationCommandFields)
  | { type: 'delete_manager'; managerId: string; requestId?: string }
  | ({
      type: 'update_profile_default_model'
      profileId: string
      reasoningLevel?: ManagerReasoningLevel
      requestId?: string
    } & ManagerModelSelectionInput)
  | {
      type: 'update_project_delegation_defaults'
      profileId: string
      managerPosture?: ManagerPosture | null
      delegationRosterId?: string | null
      requestId?: string
    }
  | ({
      type: 'update_manager_model'
      managerId: string
      reasoningLevel?: ManagerReasoningLevel
      requestId?: string
    } & ManagerModelSelectionInput)
  | { type: 'update_manager_cwd'; managerId: string; cwd: string; requestId?: string }
  | ({
      type: 'update_session_model'
      sessionAgentId: string
      mode: 'inherit' | 'override'
      reasoningLevel?: ManagerReasoningLevel
      requestId?: string
    } & ManagerModelSelectionInput)
  | { type: 'create_session'; profileId: string; label?: string; name?: string; sessionPurpose?: AgentSessionPurpose; requestId?: string }
  | {
      type: 'update_session_delegation'
      sessionAgentId: string
      managerPosture?: { mode: 'inherit' } | { mode: 'override'; value: ManagerPosture }
      delegationRoster?: { mode: 'inherit' } | { mode: 'override'; rosterId: string }
      requestId?: string
    }
  | { type: 'stop_session'; agentId: string; requestId?: string }
  | { type: 'resume_session'; agentId: string; requestId?: string }
  | { type: 'hydrate_archive_last_used'; requestId?: string }
  | { type: 'archive_session'; agentId: string; requestId?: string }
  | { type: 'restore_session'; agentId: string; requestId?: string }
  | { type: 'delete_session'; agentId: string; requestId?: string }
  | { type: 'rename_session'; agentId: string; label: string; requestId?: string }
  | { type: 'pin_session'; agentId: string; pinned: boolean; requestId?: string }
  | {
      type: 'set_session_project_agent'
      agentId: string
      projectAgent: SessionProjectAgentInput | null
      requestId?: string
    }
  | {
      type: 'get_project_agent_config'
      agentId: string
      requestId?: string
    }
  | {
      type: 'list_project_agent_references'
      agentId: string
      requestId?: string
    }
  | {
      type: 'get_project_agent_reference'
      agentId: string
      fileName: string
      requestId?: string
    }
  | {
      type: 'set_project_agent_reference'
      agentId: string
      fileName: string
      content: string
      requestId?: string
    }
  | {
      type: 'delete_project_agent_reference'
      agentId: string
      fileName: string
      requestId?: string
    }
  | {
      type: 'request_project_agent_recommendations'
      agentId: string
      requestId?: string
    }
  | {
      type: 'get_project_agent_sharing'
      agentId: string
      requestId?: string
    }
  | {
      type: 'set_project_agent_sharing'
      agentId: string
      targetProfileIds: string[]
      requestId?: string
    }
  | {
      type: 'get_project_agent_external_directory'
      requestId?: string
    }
  | {
      type: 'fork_session'
      sourceAgentId: string
      label?: string
      fromMessageId?: string
      requestId?: string
    }
  | { type: 'clear_session'; agentId: string; requestId?: string }
  | DismissSessionAttentionCommand
  | ({ type: 'session_goal_control'; agentId: string; requestId?: string } & SessionGoalControlAction)
  | { type: 'pin_message'; agentId: string; messageId: string; pinned: boolean }
  | { type: 'clear_all_pins'; agentId: string }
  | { type: 'merge_session_memory'; agentId: string; requestId?: string }
  | { type: 'get_session_workers'; sessionAgentId: string; requestId?: string }
  | {
      type: 'get_conversation_page'
      agentId: string
      cursor: string
      limit?: number
      view?: BuilderTimelineChannelView
      requestId: string
    }
  | { type: 'list_directories'; path?: string; requestId?: string }
  | { type: 'validate_directory'; path: string; requestId?: string }
  | { type: 'create_directory'; parentPath: string; name: string; requestId?: string }
  | { type: 'pick_directory'; defaultPath?: string; requestId?: string }
  | { type: 'rename_profile'; profileId: string; displayName: string; requestId?: string }
  | { type: 'archive_profile'; profileId: string; requestId?: string }
  | { type: 'restore_profile'; profileId: string; requestId?: string }
  | { type: 'reorder_profiles'; profileIds: string[]; requestId?: string }
  | { type: 'choice_response'; agentId: string; choiceId: string; answers: ChoiceAnswer[] }
  | { type: 'choice_cancel'; agentId: string; choiceId: string }
  | { type: 'codex_elicitation_response'; agentId: string; elicitationId: string; decision: CodexElicitationDecision; values?: Record<string, unknown>; persistScope?: CodexElicitationPersistScope }
  | { type: 'mark_unread'; agentId: string; requestId?: string }
  | { type: 'mark_all_read'; profileId: string; requestId?: string }
  | { type: 'ping' }
