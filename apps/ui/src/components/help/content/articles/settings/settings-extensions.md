Extensions are custom code modules that add tools, intercept events, or modify context for agents. The Extensions pane shows every extension Forge has discovered on disk, grouped by source, along with runtime status for active agents.

## Discovery sources

Forge looks for extensions in four directories, checked in order:

- **Global Worker** — applies to all worker agents (`~/.forge/agent/extensions/`)
- **Global Manager** — applies to all manager agents (`~/.forge/agent/manager/extensions/`)
- **Profile** — applies to agents in a specific profile (`~/.forge/profiles/<profileId>/pi/extensions/`)
- **Project** — applies to agents working in a specific repo (`.forge/pi/extensions/` for direct Pi extensions, with packages configured in `.forge/pi/settings.json`)

Each discovered extension shows its source badge, file path, and a copy button for the path.

## Runtime bindings

When an extension is loaded by an active agent, the card shows which agents have it, what tools it provides, and what events it hooks. If no agents are running, it shows "Not loaded in active runtimes."

## Load errors

If an extension fails to load, the card shows the error with the agent that tried to load it. Common causes: syntax errors, missing dependencies, or invalid export signatures.

## Adding extensions

Drop a `.ts` or `.js` file (or a folder with `index.ts`/`index.js`) into one of the discovery directories. Extensions are discovered when an agent session starts — no backend restart needed.

Click **Refresh** to re-scan the directories and update the display.

For the extension API and examples, see the [extension documentation](https://github.com/a-mart/forge/blob/main/docs/PI_EXTENSIONS.md).
