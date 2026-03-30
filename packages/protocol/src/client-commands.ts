import type { ConversationAttachment } from './attachments.js'
import type { AgentSessionPurpose, ChoiceAnswer, DeliveryMode, ManagerModelPreset, ManagerReasoningLevel } from './shared-types.js'

export interface ApiProxyCommand {
  type: 'api_proxy'
  requestId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string
}

export type ClientCommand =
  | { type: 'subscribe'; agentId?: string; messageCount?: number }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
    }
  | ApiProxyCommand
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_all_agents'; managerId: string; requestId?: string }
  | { type: 'create_manager'; name: string; cwd: string; model?: ManagerModelPreset; requestId?: string }
  | { type: 'delete_manager'; managerId: string; requestId?: string }
  | { type: 'update_manager_model'; managerId: string; model: ManagerModelPreset; reasoningLevel?: ManagerReasoningLevel; requestId?: string }
  | { type: 'create_session'; profileId: string; label?: string; name?: string; sessionPurpose?: AgentSessionPurpose; requestId?: string }
  | { type: 'stop_session'; agentId: string; requestId?: string }
  | { type: 'resume_session'; agentId: string; requestId?: string }
  | { type: 'delete_session'; agentId: string; requestId?: string }
  | { type: 'rename_session'; agentId: string; label: string; requestId?: string }
  | {
      type: 'set_session_project_agent'
      agentId: string
      projectAgent: { whenToUse: string; systemPrompt?: string } | null
      requestId?: string
    }
  | {
      type: 'request_project_agent_recommendations'
      agentId: string
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
  | { type: 'pin_message'; agentId: string; messageId: string; pinned: boolean }
  | { type: 'merge_session_memory'; agentId: string; requestId?: string }
  | { type: 'get_session_workers'; sessionAgentId: string; requestId?: string }
  | { type: 'list_directories'; path?: string; requestId?: string }
  | { type: 'validate_directory'; path: string; requestId?: string }
  | { type: 'pick_directory'; defaultPath?: string; requestId?: string }
  | { type: 'rename_profile'; profileId: string; displayName: string; requestId?: string }
  | { type: 'reorder_profiles'; profileIds: string[]; requestId?: string }
  | { type: 'choice_response'; agentId: string; choiceId: string; answers: ChoiceAnswer[] }
  | { type: 'choice_cancel'; agentId: string; choiceId: string }
  | { type: 'mark_unread'; agentId: string; requestId?: string }
  | { type: 'ping' }
