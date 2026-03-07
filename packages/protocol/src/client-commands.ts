import type { ConversationAttachment } from './attachments.js'
import type { DeliveryMode, ManagerModelPreset } from './shared-types.js'

export type ClientCommand =
  | { type: 'subscribe'; agentId?: string }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
    }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_all_agents'; managerId: string; requestId?: string }
  | { type: 'create_manager'; name: string; cwd: string; model?: ManagerModelPreset; requestId?: string }
  | { type: 'delete_manager'; managerId: string; requestId?: string }
  | { type: 'update_manager_model'; managerId: string; model: ManagerModelPreset; requestId?: string }
  | { type: 'create_session'; profileId: string; label?: string; name?: string; requestId?: string }
  | { type: 'stop_session'; agentId: string; requestId?: string }
  | { type: 'resume_session'; agentId: string; requestId?: string }
  | { type: 'delete_session'; agentId: string; requestId?: string }
  | { type: 'rename_session'; agentId: string; label: string; requestId?: string }
  | { type: 'fork_session'; sourceAgentId: string; label?: string; requestId?: string }
  | { type: 'merge_session_memory'; agentId: string; requestId?: string }
  | { type: 'list_directories'; path?: string; requestId?: string }
  | { type: 'validate_directory'; path: string; requestId?: string }
  | { type: 'pick_directory'; defaultPath?: string; requestId?: string }
  | { type: 'ping' }
