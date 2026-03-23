# Pi Extensions in Forge — Internal Reference

> This document covers Pi extension integration details relevant to Forge backend developers.
> For user-facing documentation, see `docs/PI_EXTENSIONS.md`.

## Tool Collision Precedence

Forge passes its swarm tools as `customTools` to Pi's `createAgentSession()`. Pi's `_buildRuntime()` builds the tool registry by processing extension-registered tools first, then SDK custom tools. Because entries are set by name (last write wins), **Forge's `customTools` silently override any same-name extension tool**.

There is no warning or diagnostic when this happens. If a user installs an extension that registers a tool named `list_agents`, Forge's built-in swarm tool wins silently.

### Reserved Tool Names

These names are used by Forge's swarm orchestration tools and must not be overridden by extensions:

- `list_agents`
- `send_message_to_agent`
- `spawn_agent`
- `kill_agent`
- `speak_to_user`

Any extension tool registered with one of these names will be silently replaced by Forge's implementation.

## Extension Tools and the System Prompt

Pi's `_rebuildSystemPrompt()` filters the "selected tools" section to tools in the `_baseToolRegistry` (Pi's built-in tools like `read`, `bash`, `edit`, `write`). Extension-registered and SDK custom tools are **not listed** in that section.

However, extension tools **are** included in the tool schema sent to the model via the API, so the model can still call them. They just won't appear in the human-readable tool listing within the system prompt.

## Headless Mode Caveats

Forge runs Pi in library/headless mode (no TUI). Extensions should check `ctx.hasUI` before attempting UI operations.

| API | Behavior in Forge |
|-----|-------------------|
| `ctx.hasUI` | Always `false` |
| `ctx.ui.select()` | Returns `undefined` |
| `ctx.ui.confirm()` | Returns `false` |
| `ctx.ui.input()` | Returns `undefined` |
| `ctx.ui.editor()` | Returns `undefined` |
| `ctx.ui.notify()` | No-op |
| `ctx.ui.setStatus()` | No-op |
| `ctx.ui.setWidget()` | No-op |
| `ctx.ui.setFooter()` | No-op |
| `ctx.ui.custom()` | Returns `undefined` |
| Command helpers (`ctx.waitForIdle()`, `ctx.newSession()`, `ctx.fork()`, etc.) | Stubs / no-op defaults |

Extensions that gate behavior on `ctx.hasUI` will work correctly. Extensions that unconditionally call UI methods will silently receive default/no-op results.

## Extension Lifecycle in Forge

1. **Load**: Extensions are loaded during `DefaultResourceLoader.reload()` via jiti (TypeScript transpilation at runtime).
2. **Session start**: `session.bindExtensions()` emits `session_start` to all loaded extensions.
3. **Runtime**: Event handlers (`tool_call`, `tool_result`, `context`, `before_agent_start`, etc.) fire normally during agent turns.
4. **Shutdown**: `session_shutdown` is emitted before `session.dispose()` when a Forge agent runtime is terminated or recycled.

## File Locations

Pi auto-discovers extensions and skills from:

- `~/.forge/agent/extensions/` — all workers
- `~/.forge/agent/manager/extensions/` — all managers
- `<cwd>/.pi/extensions/` — project-local (agents with that CWD)
- `~/.forge/agent/skills/` — all workers
- `~/.forge/agent/manager/skills/` — all managers
- `<cwd>/.pi/skills/` — project-local

Pi also reads package settings from:

- `~/.forge/agent/settings.json` — workers (global packages)
- `~/.forge/agent/manager/settings.json` — managers (global packages)
- `<cwd>/.pi/settings.json` — project-local packages

These files do not need to exist — Pi handles missing files gracefully (returns empty settings).
