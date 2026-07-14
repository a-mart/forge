# Pi Extensions in Forge — Internal Reference

> This document covers Pi extension integration details relevant to Forge backend developers.
> For user-facing documentation, see `docs/PI_EXTENSIONS.md`.

## Tool Collision Precedence

Forge passes its planned runtime tools as SDK `customTools` to Pi's `createAgentSession()`. In the pinned Pi `0.80.6` runtime, `_buildRuntime()` registers extension tools first and SDK custom tools afterward. Registry entries are keyed by name with last-write-wins behavior, so **a Forge tool present in that agent's runtime plan silently replaces a same-name Pi extension tool**. Pi emits no collision warning.

The Forge tool set is contextual rather than one universal reserved list:

- Ordinary workers normally receive `list_agents`, `send_message_to_agent`, and `knowledge`.
- Managers can additionally receive `update_plan`, `spawn_agent`, `retry_codex_plugin_worker`, `kill_agent`, `speak_to_user`, `present_choices`, and `save_learning`.
- Capabilities and session purpose can add `create_session` or `create_project_agent`, while Collaboration, Cortex, and capture-check contexts filter the normal set.
- A scoped Codex Plugin worker receives delegation-specific exact plugin tool names and may receive `export_scoped_codex_plugin_result`.

Treat every Forge or delegation tool name available in the target context as reserved. Do not rely on an extension implementation winning a collision, and re-check `buildSwarmTools()` plus `buildBaseRuntimeTools()` when Forge adds or filters tools. This precedence description is version-specific; audit the installed Pi source again when upgrading Pi.

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
- `<repo>/.forge/pi/extensions/` — project-local (trust-gated)
- `~/.forge/agent/skills/` — all workers
- `~/.forge/agent/manager/skills/` — all managers
- `<repo>/.forge/skills/` — project-local project skills

Pi also reads package settings from:

- `~/.forge/agent/settings.json` — workers (global packages)
- `~/.forge/agent/manager/settings.json` — managers (global packages)
- `<repo>/.forge/pi/settings.json` — project-local packages (trust-gated)

These files do not need to exist — Pi handles missing files gracefully (returns empty settings). Legacy exact-CWD `.pi` resources remain compatibility-only and are active only when inside or identical to the selected trusted `.forge` directory.
