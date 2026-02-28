# API Reference

## WebSocket Protocol

The frontend communicates with the backend over a single WebSocket connection. The shared types are defined in `@middleman/protocol` (`packages/protocol/src/`).

### Connection

- **Dev**: `ws://127.0.0.1:47187`
- **Prod**: `ws://127.0.0.1:47287`
- HTTPS auto-upgrades to `wss://`
- Auto-reconnect on disconnect (1.2s backoff)
- Keep-alive via `ping` command

### Client Commands (UI → Backend)

#### subscribe
```json
{ "type": "subscribe", "agentId": "optional-agent-id" }
```
Subscribe to an agent's events. Omit `agentId` to subscribe to the default manager. Response: `ready` + `agents_snapshot` + `conversation_history`.

#### user_message
```json
{
  "type": "user_message",
  "text": "Hello",
  "agentId": "target-agent-id",
  "delivery": "auto",
  "attachments": [
    { "mimeType": "image/png", "data": "base64..." },
    { "type": "text", "mimeType": "text/plain", "text": "file contents" },
    { "type": "binary", "mimeType": "application/pdf", "data": "base64..." }
  ]
}
```
Send a message to an agent. `delivery` is `"auto"` | `"followUp"` | `"steer"`.

#### kill_agent
```json
{ "type": "kill_agent", "agentId": "worker-id" }
```

#### stop_all_agents
```json
{ "type": "stop_all_agents", "managerId": "manager-id", "requestId": "optional" }
```

#### create_manager
```json
{
  "type": "create_manager",
  "name": "My Manager",
  "cwd": "/path/to/project",
  "model": "pi-opus",
  "requestId": "optional"
}
```

#### delete_manager
```json
{ "type": "delete_manager", "managerId": "manager-id", "requestId": "optional" }
```

#### list_directories
```json
{ "type": "list_directories", "path": "/optional/path", "requestId": "optional" }
```

#### validate_directory
```json
{ "type": "validate_directory", "path": "/path/to/check", "requestId": "optional" }
```

#### pick_directory
```json
{ "type": "pick_directory", "defaultPath": "/optional/default", "requestId": "optional" }
```
Opens native OS directory picker dialog.

#### ping
```json
{ "type": "ping" }
```

---

### Server Events (Backend → UI)

#### ready
```json
{ "type": "ready", "agentId": "subscribed-agent-id", "serverTime": "ISO" }
```

#### conversation_history
```json
{
  "type": "conversation_history",
  "agentId": "agent-id",
  "entries": [ /* ConversationEntryEvent[] */ ]
}
```
Sent on subscribe. Contains up to 2000 most recent entries.

#### conversation_message
```json
{
  "type": "conversation_message",
  "agentId": "agent-id",
  "role": "user" | "assistant" | "system",
  "text": "message text",
  "timestamp": "ISO",
  "source": "user_input" | "speak_to_user" | "system",
  "sourceContext": { "channel": "web" | "slack" | "telegram", ... },
  "attachments": [ /* optional */ ]
}
```

#### conversation_log
```json
{
  "type": "conversation_log",
  "agentId": "agent-id",
  "timestamp": "ISO",
  "source": "runtime_log",
  "kind": "message_start" | "message_end" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "auto_compaction_start" | "auto_compaction_end" | "runtime_error",
  "toolName": "optional",
  "toolCallId": "optional",
  "text": "log text",
  "isError": false
}
```

#### conversation_reset
```json
{ "type": "conversation_reset", "agentId": "agent-id" }
```

#### agent_message
```json
{
  "type": "agent_message",
  "agentId": "context-agent-id",
  "timestamp": "ISO",
  "source": "user_to_agent" | "agent_to_agent",
  "fromAgentId": "sender",
  "toAgentId": "receiver",
  "text": "message",
  "requestedDelivery": "auto",
  "acceptedMode": "prompt",
  "attachmentCount": 0
}
```

#### agent_tool_call
```json
{
  "type": "agent_tool_call",
  "agentId": "context-agent-id",
  "actorAgentId": "executing-agent",
  "timestamp": "ISO",
  "kind": "tool_start" | "tool_update" | "tool_end",
  "toolName": "bash",
  "toolCallId": "call-id",
  "text": "execution details",
  "isError": false
}
```

#### agent_status
```json
{
  "type": "agent_status",
  "agentId": "agent-id",
  "status": "idle" | "streaming" | "terminated" | "stopped" | "error",
  "pendingCount": 0,
  "contextUsage": { "tokens": 5000, "contextWindow": 200000, "percent": 2.5 }
}
```

#### agents_snapshot
```json
{
  "type": "agents_snapshot",
  "agents": [ /* AgentDescriptor[] */ ]
}
```

#### manager_created / manager_deleted
```json
{ "type": "manager_created", "agent": { /* AgentDescriptor */ } }
{ "type": "manager_deleted", "managerId": "deleted-id" }
```

#### stop_all_agents_result
```json
{ "type": "stop_all_agents_result", "managerId": "id", "requestId": "id", "stopped": ["agent1", "agent2"] }
```

#### slack_status / telegram_status
```json
{
  "type": "slack_status",
  "managerId": "id",
  "status": "connected" | "connecting" | "disconnected" | "error" | "disabled",
  "teamId": "T...",
  "botUserId": "U...",
  "updatedAt": "ISO"
}
```

#### error
```json
{ "type": "error", "code": "ERROR_CODE", "message": "description", "requestId": "optional" }
```

---

## HTTP API

### File Operations

#### Read File
```
GET  /api/read-file?path=/absolute/path
POST /api/read-file  { "path": "/absolute/path" }
```
Returns file content with appropriate MIME type. Max 2MB. Path must be within allowed roots (home directory, /tmp).

### Transcription

#### Transcribe Audio
```
POST /api/transcribe
Content-Type: multipart/form-data
Body: file=<audio file>
```
Accepts: webm, mp4, mpeg, wav, ogg. Max 4MB. Requires `OPENAI_API_KEY`. Returns `{ "text": "transcribed text" }`.

### Agent Operations

#### Compact Context
```
POST /api/agents/:agentId/compact
Body: { "customInstructions": "optional instructions" }
```
Compresses agent conversation history. Manager-only operation.

### Health

#### Reboot
```
POST /api/reboot
```
Triggers SIGUSR1 signal for graceful restart (daemon mode).

### Schedules

#### List Schedules
```
GET /api/managers/:managerId/schedules
```
Returns array of schedule objects.

#### Create/Update Schedule
```
POST /api/managers/:managerId/schedules
Body: { "name": "...", "cron": "...", "message": "...", "timezone": "...", "oneShot": false }
```

#### Delete Schedule
```
DELETE /api/managers/:managerId/schedules/:scheduleId
```

### Settings

#### Environment Variables
```
GET    /api/settings/env              # List all (with masking)
PUT    /api/settings/env              # Update: { "KEY": "value" }
DELETE /api/settings/env/:name        # Remove
```

#### Auth Providers
```
GET    /api/settings/auth             # List providers (with masking)
PUT    /api/settings/auth             # Update: { "provider": "key" }
DELETE /api/settings/auth/:provider   # Remove
```

#### OAuth Login
```
POST /api/settings/auth/login/:provider
```
Returns Server-Sent Events stream for OAuth flow.

### Integrations

See [Integrations > REST API](INTEGRATIONS.md#rest-api) for Slack and Telegram endpoints.

---

## Key Shared Types

### AgentDescriptor
```typescript
{
  agentId: string
  displayName: string
  role: "manager" | "worker"
  managerId: string
  archetypeId?: string
  status: "idle" | "streaming" | "terminated" | "stopped" | "error"
  createdAt: string        // ISO
  updatedAt: string        // ISO
  cwd: string
  model: {
    provider: string       // "anthropic" | "openai-codex-app-server"
    modelId: string        // "claude-opus" etc.
    thinkingLevel: string  // "high" | "x-high"
  }
  sessionFile: string
  contextUsage?: { tokens: number; contextWindow: number; percent: number }
}
```

### DeliveryMode
```typescript
// What the client requests:
type RequestedDeliveryMode = "auto" | "followUp" | "steer"

// What the runtime actually used:
type AcceptedDeliveryMode = "prompt" | "followUp" | "steer"
```

### MessageSourceContext
```typescript
{
  channel: "web" | "slack" | "telegram"
  channelId?: string
  userId?: string
  messageId?: string
  threadTs?: string
  integrationProfileId?: string
  channelType?: "dm" | "channel" | "group" | "mpim"
  teamId?: string
}
```

### Attachment Types
```typescript
// Image (base64 encoded)
{ mimeType: "image/png", data: "base64..." }

// Text (UTF-8 string)
{ type: "text", mimeType: "text/plain", text: "file contents" }

// Binary (base64 encoded)
{ type: "binary", mimeType: "application/pdf", data: "base64..." }
```
