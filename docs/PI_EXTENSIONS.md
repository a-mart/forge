# Pi Extensions & Packages in Forge

Forge uses [Pi](https://github.com/badlogic/pi-mono) as its agent runtime. Pi's extension and package systems are available to Forge users, allowing you to add custom tools, event handlers, skills, and more to your agent sessions.

> **Important:** Extensions and packages run with **full system access**. They can execute arbitrary code, read/write files, and run shell commands. Only install extensions and packages you trust.

## Quick Start

Drop a TypeScript file into `~/.forge/agent/extensions/` and it's loaded for all worker sessions:

```typescript
// ~/.forge/agent/extensions/protected-paths.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" && event.input?.path?.includes(".env")) {
      return { block: true, reason: "Blocked: .env files are protected" };
    }
  });
}
```

No build step. No restart. Extensions load per-session via [jiti](https://github.com/nicolo-ribaudo/jiti), so new extensions are picked up the next time an agent session starts.

## Overview

Pi extensions are TypeScript/JavaScript modules that hook into the agent lifecycle. They can:

- **Register custom tools** callable by the LLM
- **Intercept events** like `tool_call`, `tool_result`, and `context` to block, modify, or log agent behavior
- **Add skills and prompt templates** via the package system
- **Register custom model providers**

Forge runs Pi in headless/library mode (no terminal UI), so TUI-specific features like custom rendering, keyboard shortcuts, and interactive dialogs are not available. Extensions should check `ctx.hasUI` and adapt accordingly.

## Extension Auto-Discovery

Pi automatically discovers extensions and skills from well-known directories. Forge creates these directories on startup:

| Path | Scope | Affects |
|------|-------|---------|
| `~/.forge/agent/extensions/` | Global | All workers |
| `~/.forge/agent/manager/extensions/` | Global | All managers |
| `~/.forge/agent/skills/` | Global | All workers |
| `~/.forge/agent/manager/skills/` | Global | All managers |
| `<cwd>/.pi/extensions/` | Project-local | Agents with that CWD |
| `<cwd>/.pi/skills/` | Project-local | Agents with that CWD |
| `~/.forge/profiles/<id>/pi/extensions/` | Profile | Agents in that profile |
| `~/.forge/profiles/<id>/pi/skills/` | Profile | Agents in that profile |
| `~/.forge/profiles/<id>/pi/prompts/` | Profile | Agents in that profile |
| `~/.forge/profiles/<id>/pi/themes/` | Profile | Agents in that profile |

All global directories (`~/.forge/agent/extensions/`, `~/.forge/agent/manager/extensions/`, etc.) are **auto-created on startup**, so you can start dropping files in immediately.

### Profile Overlay Directories

Each Forge profile can have its own Pi resource directories under `~/.forge/profiles/<profileId>/pi/`. These are **additive** — they add to the global and project-local directories, they do not replace them.

Profile overlay directories are auto-created when a profile is created. Use them to scope extensions, skills, prompts, or themes to a specific profile without affecting other profiles.

```text
~/.forge/profiles/my-profile/pi/
  extensions/     # Extensions loaded only for this profile's sessions
  skills/         # Skills available only to this profile
  prompts/        # Prompt templates scoped to this profile
  themes/         # Themes scoped to this profile
```

**Precedence note:** Profile overlays are additive only in this release. If the same extension identity appears in both global and profile directories, Pi's own discovery and merge behavior determines which wins. To avoid surprises, keep resource names unique across global, profile, and project scopes.

**Extension file formats:**
- Single file: `extensions/my-ext.ts` or `extensions/my-ext.js`
- Directory with index: `extensions/my-ext/index.ts`
- Directory with package.json: `extensions/my-ext/package.json` (with `pi.extensions` manifest)

Discovery is shallow — top-level files and one-level subdirectories only.

## Writing an Extension

An extension is a TypeScript file that exports a default function receiving Pi's `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Run setup on session start
  pi.on("session_start", async (_event, ctx) => {
    console.log("[my-ext] Session started, headless:", !ctx.hasUI);
  });

  // Register a custom tool
  pi.registerTool({
    name: "lookup_ticket",
    label: "Lookup Ticket",
    description: "Look up a ticket by ID from the issue tracker",
    parameters: Type.Object({
      ticketId: Type.String({ description: "The ticket ID to look up" }),
    }),
    async execute(_toolCallId, params) {
      // Your implementation here
      const result = await fetchTicket(params.ticketId);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });
}
```

Save this to `~/.forge/agent/extensions/my-ext.ts` and it will be loaded for all worker sessions. Extensions are loaded via [jiti](https://github.com/nicolo-ribaudo/jiti) — TypeScript works without a build step.

### Headless Mode

Forge runs without a terminal UI. Extensions must handle this:

```typescript
pi.on("session_start", async (_event, ctx) => {
  if (ctx.hasUI) {
    // This won't run in Forge — ctx.hasUI is always false
    ctx.ui.notify("Extension loaded!", "info");
  }
  // This runs fine in Forge
  console.log("Extension loaded");
});
```

UI methods return safe defaults when called in headless mode: `select()` returns `undefined`, `confirm()` returns `false`, `notify()` is a no-op, etc. Command helpers like `ctx.waitForIdle()`, `ctx.newSession()`, and `ctx.fork()` are stubs.

### Event Interception

Extensions can intercept and modify agent behavior at key points:

```typescript
export default function (pi: ExtensionAPI) {
  // Block dangerous tool calls
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input?.command?.includes("rm -rf /")) {
      return { block: true, reason: "Blocked dangerous command" };
    }
  });

  // Modify context before each LLM call
  pi.on("context", async (messages) => {
    // Add a system reminder to every turn
    return [
      ...messages,
      { role: "user", content: "Remember: always explain your reasoning." },
    ];
  });

  // Log all tool results
  pi.on("tool_result", async (event) => {
    console.log(`[audit] ${event.toolName} completed, error: ${event.isError}`);
  });
}
```

### Available Events

| Event | When | Can Modify? |
|-------|------|-------------|
| `session_start` | Session begins | No |
| `session_shutdown` | Session ending | No |
| `before_agent_start` | Before each agent turn | Yes (inject messages, modify system prompt) |
| `context` | Before each LLM API call | Yes (modify message array) |
| `tool_call` | Before tool execution | Yes (block with `{ block: true }`) |
| `tool_result` | After tool execution | Yes (modify content/isError) |
| `input` | User message received | Yes (transform or handle) |
| `agent_start` / `agent_end` | Agent turn lifecycle | No |
| `turn_start` / `turn_end` | Individual turn boundaries | No |
| `message_start` / `message_update` / `message_end` | Streaming message events | No |

### Available Imports

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Extension types (`ExtensionAPI`, events, tool helpers) |
| `@sinclair/typebox` | Schema definitions for tool parameters |
| `@mariozechner/pi-ai` | AI utilities (e.g., `StringEnum` for Google-compatible enums) |
| Node.js built-ins | `node:fs`, `node:path`, `node:child_process`, etc. |

> **Note:** Use `StringEnum` from `@mariozechner/pi-ai` instead of `Type.Union(Type.Literal(...))` for string enum parameters — Google's API requires it.

## Pi Packages

Pi packages bundle extensions, skills, prompt templates, and themes into distributable units. They can be installed from npm, git, or local paths.

### Configuring Packages

Create or edit `settings.json` at the appropriate scope:

- **Workers (global):** `~/.forge/agent/settings.json`
- **Managers (global):** `~/.forge/agent/manager/settings.json`
- **Project-local:** `<cwd>/.pi/settings.json`

Example `settings.json`:

```json
{
  "packages": [
    "npm:@example/pi-tools",
    "npm:@example/pi-tools@1.2.3",
    "git:github.com/user/pi-extension",
    "/absolute/path/to/local/package"
  ]
}
```

These files do not need to exist by default — Pi handles missing settings files gracefully. Create them only when you want to configure packages.

### Package Source Formats

| Format | Example | Notes |
|--------|---------|-------|
| npm | `npm:@scope/name` | Installed globally via `npm install -g` |
| npm (pinned) | `npm:@scope/name@1.2.3` | Pinned version, skipped by updates |
| git (HTTPS) | `git:github.com/user/repo` | Cloned to `~/.forge/agent/git/` |
| git (tag) | `git:github.com/user/repo@v1` | Pinned to tag/commit |
| git (SSH) | `git:git@github.com:user/repo` | SSH authentication |
| Local path | `/absolute/path/to/package` | Referenced in place, no copy |

### Package Filtering

You can selectively control what loads from a package:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:@example/big-package",
      "extensions": ["extensions/useful.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

- Omit a key → load everything of that type
- `[]` → load nothing of that type
- `!pattern` → exclude matching paths
- `+path` → force-include
- `-path` → force-exclude

### Creating a Package

Add a `pi` manifest to your `package.json`:

```json
{
  "name": "my-forge-tools",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

Without a manifest, Pi auto-discovers from conventional directories: `extensions/`, `skills/`, `prompts/`, `themes/`.

### Package Deduplication

If the same package appears in both global and project settings, the **project version wins**. Identity is determined by:
- npm: package name
- git: repository URL (without ref)
- Local: resolved absolute path

## Skills via Pi Discovery

Pi discovers skills from `agentDir/skills/` and `<cwd>/.pi/skills/` directories, as well as from packages. These are separate from Forge's built-in skill system (`~/.forge/skills/`).

Both Pi-discovered skills and Forge skills end up in the agent's context. Pi deduplicates skills by path, so the same skill at different absolute paths could appear twice. Avoid placing identical skills in both `~/.forge/skills/` and `~/.forge/agent/skills/`.

## Reserved Tool Names

Forge registers these tools for swarm orchestration. They **cannot be overridden** by extensions — Forge's implementations silently take precedence:

- `list_agents` — List agents in the swarm
- `send_message_to_agent` — Send a message to another agent
- `spawn_agent` — Create a new worker agent
- `kill_agent` — Terminate an agent
- `speak_to_user` — Send a message to the end user (managers only)

If an extension registers a tool with one of these names, the extension's version will be silently replaced. Choose unique names for your extension tools.

## Extensions in the Settings UI

Forge provides a read-only **Extensions** tab in Settings that shows which extensions are currently loaded in active agent runtimes. This view reflects live runtime state — it shows extensions that are actually loaded, not a scan of what's on disk.

The Extensions tab does not install, remove, enable, or disable extensions. The filesystem is the configuration surface: drop files into the appropriate directory and start a new session. The Settings tab is for visibility and debugging.

Extension handler errors are surfaced as system messages in the chat conversation, so you'll see them inline when something goes wrong.

## Example Extensions

Forge ships example extensions in [`docs/examples/pi-extensions/`](examples/pi-extensions/) that demonstrate common patterns. Copy any of these into your extension directory to use them.

### `protected-paths.ts` — Tool Call Interception

Blocks `write` and `edit` tool calls targeting sensitive paths (`.env`, `.git/`, SSH keys). Demonstrates:
- Returning `{ block: true, reason }` from a `tool_call` handler
- Configurable protection rules
- The `ctx.hasUI` pattern for headless-safe notifications

### `failure-memory.ts` — File-Backed State and Recall

Records tool errors to a local JSON file and injects a summary of recent failures into the agent's context before each turn. Demonstrates:
- Using `tool_result` to observe outcomes
- Using `before_agent_start` to inject context
- Bounded append-only file patterns with safe JSON parsing

### `session-shutdown-cleanup.ts` — Lifecycle Hooks

Tracks session metrics (duration, tool call count) and writes a JSONL summary when the session shuts down. Demonstrates:
- The `session_start` / `session_shutdown` lifecycle pair
- Accumulating in-memory state across events
- Defensive shutdown handlers that never throw

## Troubleshooting

### Extension not loading?

1. Check the file is in the right directory for the agent role (worker vs manager)
2. Verify the file exports a default function: `export default function(pi: ExtensionAPI) { ... }`
3. Check backend logs for extension loading errors
4. For packages, verify `settings.json` contains valid JSON

### Tool not appearing?

Extension tools are sent to the model via the API tool schema but are **not** listed in Pi's system prompt "selected tools" section. The model can still call them — they just won't appear in the human-readable tool listing within the prompt.

### Headless UI calls returning defaults?

This is expected. Forge runs in headless mode. Check `ctx.hasUI` and provide non-interactive fallbacks.

### Debug logging

Set `FORGE_DEBUG=true` in your `.env` to enable extension tool-call logging. This surfaces tool invocations from extensions in the backend logs, which is useful for verifying that your extension is being called.

## Built-in Extensions

Forge ships with a built-in extension that enhances xAI/Grok model integration.

### xAI Responses Provider

**Location:** `apps/backend/src/swarm/extensions/xai-responses-provider.ts`

This extension re-registers all xAI models to use OpenAI's Responses API instead of the Chat Completions API. The Responses API provides better compatibility with Pi and enables xAI's native search capabilities across both the web and X.

**What it does:**

1. **API switching** — all Grok workers use `openai-responses` instead of `openai-completions`
2. **Native search** — injects the xAI `web_search` and `x_search` tools when enabled via specialist config
3. **Reasoning effort stripping** — removes `reasoningEffort` from requests (Pi compatibility workaround)

**Native search activation:**

Native search is controlled per specialist via the `webSearch: true` frontmatter field:

```markdown
---
displayName: Research Assistant
modelId: grok-4
webSearch: true
---
Your specialist prompt...
```

When `webSearch` is enabled:
- The extension injects `{ type: "web_search" }` and `{ type: "x_search" }` into the tools array for every API call
- Citations appear as inline markdown links in Grok's responses, including webpage and X post/profile URLs when used
- The toggle is visible in the specialist settings UI (Grok models only)
- For non-Grok models, the setting is coerced to `false` and the toggle is hidden

**Ad-hoc usage:**

The `spawn_agent` tool also supports `webSearch: true` for one-off Grok workers:

```typescript
spawn_agent({
  role: "worker",
  modelId: "grok-4",
  webSearch: true,
  instructions: "Research recent developments in quantum computing"
})
```

**Implementation notes:**

- The extension is instantiated per worker session with native search enablement determined by the specialist's `webSearch` flag
- The `before_provider_request` hook intercepts payloads heading to xAI's API
- Native search tool injection only happens if the tool isn't already present in the tools array
- The reasoning effort strip is applied to all xAI requests regardless of native search status

This extension is loaded automatically for all Grok workers. You cannot disable it — xAI models always use the Responses API in Forge.

## Ecosystem

Pi has a growing community of extensions and packages. Some highlights relevant to Forge:

| Package | What It Does |
|---------|-------------|
| Security / permission-gate patterns | Block dangerous bash commands, protect sensitive paths, redact secrets from output |
| Usage tracking (`@marckrenn/pi-sub-core`) | Token and cost tracking across providers via event bus |
| Tool auditing (`toolwatch`) | SQLite-backed audit log of every tool call |
| Subagent delegation (`pi-subagents`) | Advanced agent delegation with chains and parallel execution |
| LSP integration | Language Server Protocol access for type errors and diagnostics |
| Custom providers | Connect to enterprise proxies, Ollama, or novel model APIs |

**Discovering packages:**
- **Gallery:** [shittycodingagent.ai/packages](https://shittycodingagent.ai/packages) — packages tagged with `pi-package` on npm
- **Community list:** [awesome-pi-agent](https://github.com/qualisero/awesome-pi-agent) — curated extensions and resources
- **npm search:** Search for `keywords:pi-package` on [npmjs.com](https://www.npmjs.com)

Most community extensions work in Forge out of the box. Extensions that use TUI features (interactive prompts, widgets, keyboard shortcuts) will gracefully degrade — `ctx.hasUI` returns `false` in Forge's headless environment, and UI methods return safe defaults.
