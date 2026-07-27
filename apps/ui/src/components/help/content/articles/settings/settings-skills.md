Skills give agents reusable instructions and optional capabilities such as web search, image generation, and the separate `agent-browser` CLI workflow. The Skills page lets you browse installed skills, inspect their files, configure API keys and settings, and share or import user-created skills from links.

Browser is a local Forge Desktop capability for normal local Builder managers, not a Skill. Forge automatically uses either an embedded surface or a Chrome-backed tab. Optional Chrome setup and repair live in **Settings → Use Chrome with Forge**. Browser is not forwarded to Remote Projects or Collaboration.

## Scope and skill browser

Use the **Configuration scope** dropdown to switch between Global and per-profile skill views. The Skills tab fills the settings content area with a searchable skill list rail on the left, a file tree in the middle, and a file viewer on the right. Each area scrolls independently, so long skill lists and file trees stay usable. Select a skill to browse its definition (`SKILL.md`), helper scripts, and other files.

## Environment variables

When a skill declares required environment variables, they appear in the right detail pane alongside the selected skill. The pane shows:

- **Variable name** — the env var key (e.g. `BRAVE_API_KEY`)
- **Status** — whether a value is currently saved
- **Optional** — marked if the skill works without it but gains features with it

To configure a variable, paste the value into the input field and click **Save**. Use the eye icon to toggle visibility, or click **Remove** to delete a saved value.

## Dedicated skill panels

Some skills may expose dedicated configuration UI in the right detail pane when selected. These panels expose settings specific to that skill, like connection targets or scope controls. The `agent-browser` Skill instead documents its external CLI prerequisites and browser lifecycle. It is not an alias or configuration surface for either Desktop browser host.

## How skills load

Skills are discovered at agent startup from builtin, user, and repository directories. You don't need to restart Forge after saving an API key — the key is available to the next agent session that needs it.

## Repository skills

If the current repository has a root `.forge/skills/` directory, Forge shows those skills in the browser alongside your global and per-profile skills. The built-in `create-skill` helper can scaffold directly into repository `.forge/skills/` when you want a project-scoped skill. Repository-root `.forge/` resources can also include `.forge/specialists/`, `.forge/reference/`, `.forge/extensions/`, `.forge/pi/extensions/`, and `.forge/pi/settings.json`.

Repository skills stay visible as text resources even when executable trust is denied. Only executable repo resources stay blocked until you trust the repository's `.forge` directory.

## Skill sharing

Use the Share button on a user-created global or project skill to generate a temporary bearer link from the skill share service. The default service origin is `https://forgeskills.radops.ai`; you can override it with `FORGE_SKILL_SHARE_BASE_URL` or disable sharing with `FORGE_SKILL_SHARE_DISABLED`. Legacy `MIDDLEMAN_SKILL_SHARE_BASE_URL` and `MIDDLEMAN_SKILL_SHARE_DISABLED` are still accepted.

Use **Import from URL** to paste a Forge skill-share link or a `forge://skill-import` deep link. Forge always opens a preview first so you can review files, warnings, and conflicts before anything is installed.

Conflicts default to reject. If the target directory already exists or the import would install an override, you must explicitly confirm the replacement before install.

## Collaboration skill selection

In Collaboration mode, the Skills page adds category and channel scopes to the scope dropdown. This lets you control which skills are loaded for each collaboration context:

- **Global** — browse all collaboration skills shared across channels.
- **Category** — set the default skill selection for new channels in that category (all or custom).
- **Channel** — choose which skills are loaded for a specific channel session.

Skill selection supports two modes: **All skills** (loads every available skill) or **Custom selection** (a curated list you choose). Always-on skills like `memory` are always included and cannot be turned off. There is no channel-local skill authoring in V1 — collaboration only stores the selection state.
