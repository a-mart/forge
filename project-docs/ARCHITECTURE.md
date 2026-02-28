# Architecture

Middleman is a local-first multi-agent orchestration platform with three runtime components: a Node.js backend, a React SPA frontend, and AI agent runtimes (Pi or Codex).

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Middleman Platform                           │
│                                                                     │
│  ┌──────────────┐    WebSocket     ┌──────────────────────────────┐ │
│  │   React UI   │◄───────────────►│     Node.js Backend          │ │
│  │  (Vite/TSR)  │    + HTTP API    │                              │ │
│  │  port 47188  │                  │  ┌────────────────────────┐  │ │
│  └──────────────┘                  │  │    SwarmManager         │  │ │
│                                    │  │  ┌──────┐  ┌────────┐  │  │ │
│  ┌──────────────┐   Slack API      │  │  │Manager│  │Workers │  │  │ │
│  │    Slack      │◄───────────────►│  │  │Agent  │──│(0..N)  │  │  │ │
│  │  Workspace   │  Socket Mode     │  │  └──────┘  └────────┘  │  │ │
│  └──────────────┘                  │  └────────────────────────┘  │ │
│                                    │                              │ │
│  ┌──────────────┐   Telegram API   │  ┌────────────────────────┐  │ │
│  │  Telegram    │◄───────────────►│  │  Integration Registry   │  │ │
│  │    Bot       │  Long Polling    │  │  Cron Scheduler         │  │ │
│  └──────────────┘                  │  └────────────────────────┘  │ │
│                                    │  port 47187                  │ │
│                                    └──────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    ~/.middleman (data)                        │   │
│  │  agents.json │ sessions/ │ memory/ │ schedules/ │ secrets    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Monorepo Structure

```
middleman/
├── apps/
│   ├── backend/          # Node.js HTTP + WebSocket server
│   ├── ui/               # React SPA (TanStack Start + Vite)
│   └── site/             # Marketing landing page
├── packages/
│   └── protocol/         # Shared TypeScript types (@middleman/protocol)
├── scripts/              # Production daemon management
├── docs/                 # Upstream documentation
├── project-docs/         # Our documentation (this directory)
└── data/                 # Runtime state (local only)
```

**Workspace tool:** pnpm with `pnpm-workspace.yaml` linking `apps/*` and `packages/*`.

## Component Relationships

### Backend Core

```
┌─────────────────────────────────────────────────────┐
│ index.ts (entry point)                              │
│   boots: SwarmManager → WS Server → Scheduler →    │
│          Integration Registry                       │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        ▼            ▼                ▼
┌──────────────┐ ┌────────┐ ┌─────────────────┐
│ SwarmManager │ │  WS    │ │  Integration    │
│              │ │ Server │ │  Registry       │
│ • Agent CRUD │ │        │ │                 │
│ • Routing    │ │ • HTTP │ │ • Slack         │
│ • Persistence│ │ • WS   │ │ • Telegram      │
│ • Settings   │ │ • CORS │ │ • Per-manager   │
└──────┬───────┘ └───┬────┘ └─────────────────┘
       │             │
       ▼             ▼
┌──────────────┐ ┌──────────────────────┐
│ Runtime      │ │ Route Handlers       │
│ Factory      │ │ ├─ agent-routes      │
│              │ │ ├─ conversation      │
│ Creates:     │ │ ├─ manager-routes    │
│ • AgentRT    │ │ ├─ file-routes       │
│ • CodexRT    │ │ ├─ health-routes     │
└──────┬───────┘ │ ├─ scheduler-routes  │
       │         │ ├─ integration-routes│
       ▼         │ ├─ settings-routes   │
┌──────────────┐ │ └─ transcription     │
│ Conversation │ └──────────────────────┘
│ Projector    │
│              │
│ Events →     │
│ Persistence →│
│ Broadcast    │
└──────────────┘
```

### Frontend Core

```
┌─────────────────────────────────────────────┐
│ routes/index.tsx (main page)                │
│                                             │
│  Hooks:                    Components:      │
│  ├─ useWsConnection()     ├─ AgentSidebar   │
│  ├─ useRouteState()       ├─ ChatHeader     │
│  ├─ useManagerActions()   ├─ MessageList    │
│  ├─ useVisibleMessages()  ├─ MessageInput   │
│  ├─ useContextWindow()    ├─ ArtifactsSidebar│
│  ├─ usePendingResponse()  ├─ SettingsDialog │
│  └─ useFileDrop()         └─ Manager CRUD   │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌──────────────────────────┐
│ ManagerWsClient          │
│ (lib/ws-client.ts)       │
│                          │
│ • Connect / reconnect    │
│ • Subscribe to agent     │
│ • Send commands          │
│ • Track request/response │
│ • State → listener push  │
└──────────────────────────┘
```

## Data Flow Diagrams

### User Sends a Chat Message

```
User types in MessageInput
        │
        ▼
IndexPage.handleSend(text, attachments)
        │
        ▼
ManagerWsClient.sendUserMessage()
        │
        ▼ (WebSocket)
WsHandler.handleSocketMessage()
        │
        ▼
parseClientCommand() ─── validates JSON + types
        │
        ▼
handleConversationCommand()
        │
        ▼
persistConversationAttachments() ─── writes files to disk
        │
        ▼
SwarmManager.handleUserMessage()
        │
        ▼
SwarmManager.sendMessage(fromAgent, targetAgent, text, delivery)
        │
        ▼
Runtime.sendMessage(input, requestedMode)
        │
        ├─── AgentRuntime.dispatchPrompt()      (Pi agents)
        │         │
        └─── CodexAgentRuntime.startTurn()       (Codex agents)
                  │
                  ▼
        AI processes, emits RuntimeSessionEvents
                  │
                  ▼
ConversationProjector.captureConversationEventFromRuntime()
                  │
                  ├─► conversation_message (user/assistant text)
                  ├─► conversation_log     (tool calls, errors)
                  ├─► agent_tool_call      (tool execution lifecycle)
                  └─► agent_message        (agent-to-agent routing)
                          │
                          ▼
              WsHandler.broadcastToSubscribed()
                          │
                          ▼ (WebSocket)
              ManagerWsClient state update
                          │
                          ▼
              React re-renders MessageList
```

### Integration Message Flow (Slack / Telegram)

```
External User (Slack/Telegram)
        │
        ▼
┌───────────────────────┐
│ Inbound Bridge        │
│ (Socket Mode/Polling) │
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│ Inbound Router        │
│ • Filter bot messages │
│ • Check wake words    │
│ • Check allowlists    │
│ • Extract attachments │
│ • Dedup (30min cache) │
└───────────┬───────────┘
            ▼
SwarmManager.handleUserMessage(text, sourceContext)
            │
            ▼
    Agent processes and responds
            │
            ▼
SwarmManager emits "conversation_message"
            │
            ▼
┌───────────────────────┐
│ Delivery Bridge       │
│ • Filter by manager   │
│ • Filter by channel   │
│ • Skip user_input src │
│ • Convert markdown    │
│ • Split at 4096 chars │
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│ API Client            │
│ • Rate limit retry    │
│ • Thread support      │
│ • Reply-to support    │
└───────────┬───────────┘
            ▼
External User sees response
```

### Agent Lifecycle

```
                    create_manager / spawnAgent
                            │
                            ▼
                  ┌──────────────────┐
                  │ Create Descriptor│
                  │ Save agents.json │
                  └────────┬─────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ RuntimeFactory   │
                  │ .createRuntime() │
                  └────────┬─────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌────────────────┐       ┌────────────────┐
     │ Pi Agent       │       │ Codex Agent    │
     │ (AgentRuntime) │       │ (CodexRuntime) │
     └────────┬───────┘       └────────┬───────┘
              │                        │
              ▼                        ▼
     Load skills, auth,        Spawn subprocess:
     memory, system prompt     codex app-server
              │                        │
              └────────┬───────────────┘
                       │
                       ▼
              Agent enters "idle" state
                       │
                       ▼
              Emit agents_snapshot
              (Manager: send bootstrap interview)
```

### Agent Status State Machine

```
                    ┌───────────┐
          ┌────────►│   idle    │◄────────┐
          │         └─────┬─────┘         │
          │               │               │
          │          sendMessage()    agent_end
          │               │               │
          │               ▼               │
          │         ┌───────────┐         │
          │         │ streaming │─────────┘
          │         └─────┬─────┘
          │               │
     restart()       error / terminate
          │               │
          │      ┌────────┴────────┐
          │      ▼                 ▼
     ┌─────────────┐       ┌───────────┐
     │ terminated  │       │   error   │
     └─────────────┘       └───────────┘
          ▲
          │
     ┌─────────┐
     │ stopped │
     └─────────┘
```

## Shared Protocol

The `@middleman/protocol` package defines the wire format between frontend and backend:

- **Client Commands** — Messages sent from UI → Backend (subscribe, user_message, create_manager, etc.)
- **Server Events** — Messages sent from Backend → UI (conversation_message, agent_status, agents_snapshot, etc.)
- **Shared Types** — AgentDescriptor, AgentStatus, DeliveryMode, MessageSourceContext, etc.
- **Attachments** — Image (base64), Text (UTF-8), Binary (base64)

Both apps depend on `@middleman/protocol` as a workspace dependency, ensuring type safety across the wire.

## Runtime Models

| Preset | Provider | Runtime Class | Context Window |
|--------|----------|---------------|----------------|
| `pi-opus` | Anthropic | AgentRuntime (Pi) | 200K tokens |
| `pi-codex` | Anthropic | AgentRuntime (Pi) | 1M tokens |
| `codex-app` | OpenAI Codex | CodexAgentRuntime | 1M tokens |

## Key Design Decisions

- **Manager/Worker hierarchy**: One persistent manager per project orchestrates ephemeral workers. Manager handles compaction on context overflow; workers terminate on overflow.
- **Local-first**: All data on disk (`~/.middleman`), no external database. Atomic file writes prevent corruption.
- **Real-time via WebSocket**: Single WS connection per client, subscribed to one agent at a time. HTTP API used only for stateless operations (file read, transcription, settings).
- **Multi-channel delivery**: Same agent can be reached from web UI, Slack, or Telegram. Responses route back to the originating channel.
- **Delivery modes**: `auto` (runtime decides), `followUp` (queue for next turn), `steer` (inject mid-turn).
