# Customization

## Skills

Skills are tools that agents can use during execution. Middleman ships with built-in skills and supports custom ones.

### Built-in Skills

| Skill | Description | Required Env Var |
|-------|-------------|------------------|
| `memory` | Persistent memory (read/write to memory file) | — |
| `brave-search` | Web search via Brave Search API | `BRAVE_API_KEY` |
| `cron-scheduling` | Create and manage scheduled tasks | — |
| `agent-browser` | Browser automation | — |
| `image-generation` | Generate images via Google Gemini | `GEMINI_API_KEY` |

### Custom Skills

Create skills in your project's `.swarm/skills/` directory:

```
.swarm/
└── skills/
    └── my-skill/
        ├── SKILL.md          # Required: frontmatter + documentation
        └── index.ts          # Implementation (if needed)
```

#### SKILL.md Format

```markdown
---
name: "My Custom Skill"
env:
  - name: MY_API_KEY
    description: "API key for the service"
    required: true
    helpUrl: "https://example.com/get-key"
---

# My Custom Skill

Instructions for the agent on how to use this skill.
The agent reads this documentation to understand capabilities.
```

The YAML frontmatter declares:
- **name**: Display name for the skill
- **env**: Environment variables the skill needs (shown in Settings > Environment Variables)

The markdown body is included in the agent's context as tool documentation.

### Skill Resolution Order

1. `.swarm/skills/` in the agent's working directory (highest priority)
2. `apps/backend/src/swarm/skills/builtins/` in the repo
3. Built-in fallback location

Project-specific skills override built-ins with the same name.

---

## Archetypes

Archetypes define the system prompt (personality and behavior) for agent roles.

### Default Archetypes

- **Manager**: Orchestrates workers, handles user communication, persists context across compactions
- **Worker**: Executes tasks using coding tools, reports back to manager, not user-facing

### Custom Archetypes

Override archetypes in your project's `.swarm/archetypes/` directory. Files here replace the built-in prompts of the same name.

### Manager System Prompt Highlights

The default manager prompt includes:
- Instructions for spawning and coordinating workers
- Memory skill workflow (read → update → save)
- User-facing communication guidelines
- Context compaction awareness

### Worker System Prompt Highlights

Workers receive:
- Tool access (read, write, edit, bash)
- Instructions to report back via `send_message_to_agent`
- Memory file path for persistent notes
- Awareness that they're not user-facing

---

## Memory Files

Profile-level memory lives at `~/.middleman/profiles/<profileId>/memory.md`. Non-root sessions have their own memory at `~/.middleman/profiles/<profileId>/sessions/<sessionId>/memory.md`. Workers no longer get their own memory files — they read their parent session/profile memory via `resolveMemoryOwnerAgentId()`. Agents access memory exclusively through the `SWARM_MEMORY_FILE` env var.

### Default Template

```markdown
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)

## Open Follow-ups
- (none yet)
```

Agents update this file through the memory skill. Content persists across sessions and compactions.

### Project-Level Memory

You can also place a `SWARM.md` file in your project's working directory. Its contents are merged into the agent's context alongside the memory file — useful for project-specific instructions that all agents should follow.

---

## Scheduled Tasks

Cron schedules send automated messages to a manager on a recurring basis.

### Creating Schedules

Schedules can be created via:
- The **cron-scheduling** skill (ask the manager to schedule something)
- The REST API: `POST /api/managers/:managerId/schedules`

### Schedule Format

```json
{
  "id": "unique-id",
  "name": "Daily standup",
  "cron": "0 9 * * 1-5",
  "message": "Run the daily standup check",
  "timezone": "America/New_York",
  "oneShot": false,
  "nextFireAt": "2026-03-01T14:00:00.000Z",
  "lastFiredAt": "2026-02-28T14:00:00.000Z"
}
```

### How Schedules Fire

1. The CronSchedulerService polls every 30 seconds
2. When `nextFireAt <= now`, it sends the message to the manager as a `handleUserMessage()` call
3. `nextFireAt` is advanced to the next cron occurrence
4. One-shot schedules are deleted after firing

---

## Adding a New Integration

To add a new messaging platform (e.g., Discord):

### 1. Define Types

Create `apps/backend/src/integrations/discord/discord-types.ts`:
- Config interface extending `{ profileId: string; enabled: boolean }`
- Status event type
- Any API-specific types

### 2. Create Configuration

`discord-config.ts` using `BaseConfigPersistence`:
- Default config factory
- Config merging and validation
- Sensitive field masking

### 3. Create Status Tracker

`discord-status.ts` extending `BaseStatusTracker`:
- Custom status fields (e.g., guildId, botUsername)

### 4. Create API Client

`discord-client.ts`:
- REST API calls
- Rate limit handling
- File download support

### 5. Create Integration Service

`discord-integration.ts` extending `BaseIntegrationService`:
- Implement abstract methods: `applyConfig()`, `stopRuntime()`, `startDeliveryBridge()`, `stopDeliveryBridge()`

### 6. Create Inbound Router

`discord-router.ts`:
- Filter events (ignore bots, check allowlists)
- Extract attachments
- Route to `SwarmManager.handleUserMessage()`
- 30-minute dedup cache

### 7. Create Delivery Bridge

`discord-delivery.ts`:
- Listen for `conversation_message` events
- Filter by manager/channel
- Convert markdown to platform format
- Split messages at platform limit

### 8. Register

Add to `IntegrationRegistryService`:
- New profile map
- Status event forwarding
- Config CRUD methods

The base classes handle most of the lifecycle complexity — focus your implementation on platform-specific API calls and message formatting.

---

## Model Presets

To add support for a new AI model:

### Backend

1. Add the preset name to `SwarmModelPreset` type in `apps/backend/src/swarm/types.ts`
2. Update `RuntimeFactory.createRuntimeForDescriptor()` to route to the correct runtime class
3. If it's a new runtime type, implement the `SwarmAgentRuntime` interface

### Frontend

1. Update `inferModelPreset()` in `apps/ui/src/lib/model-preset.ts`
2. Add context window size in `apps/ui/src/hooks/index-page/use-context-window.ts`
3. Add to `MANAGER_MODEL_PRESETS` in `CreateManagerDialog.tsx`
