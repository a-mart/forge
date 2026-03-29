import type { HelpArticle } from '../help-types'

export const settingsArticles: HelpArticle[] = [
  // ── General Settings ──────────────────────────────────────────────
  {
    id: 'settings-general',
    title: 'General Settings',
    category: 'settings',
    summary:
      'Appearance, editor choice, Cortex auto-review, and experimental feature toggles.',
    content: `General Settings is the main preferences pane. It covers appearance, editor integration, experimental features, and the Cortex auto-review schedule.

## Appearance

Pick a theme (Light, Dark, or System) and choose which code editor opens when you click artifact file links. Supported editors are VS Code Insiders, VS Code, and Cursor. The theme preference is stored in your browser and applies immediately.

## Cortex Auto-Review

Cortex is Forge's self-improvement system. When automatic reviews are enabled, Cortex periodically checks your sessions and updates knowledge, memory, and reference docs. You can set the review interval from every 15 minutes up to every 24 hours. Disable it entirely if you want to run reviews manually.

Cortex only reviews sessions that have changed since the last check, so frequent intervals do not waste resources.

## Experimental Features

The Playwright Dashboard toggle controls whether Forge discovers and displays Playwright CLI sessions across your repo roots and worktrees. This feature is macOS and Linux only. If the \`FORGE_PLAYWRIGHT_DASHBOARD_ENABLED\` environment variable is set, the toggle is locked to that value and cannot be changed here.

## Welcome Preferences

Edit the default preferences Forge shares with new manager sessions. These are the onboarding choices you made on first launch (name, technical level, workflow style). Changes here apply to future sessions.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.`,
    keywords: [
      'theme',
      'dark mode',
      'light mode',
      'editor',
      'vscode',
      'cursor',
      'playwright',
      'cortex',
      'auto-review',
      'reboot',
      'appearance',
      'onboarding',
      'preferences',
    ],
    relatedIds: ['settings-theme', 'settings-editor', 'settings-about'],
    contextKeys: ['settings.general'],
  },

  // ── Theme ─────────────────────────────────────────────────────────
  {
    id: 'settings-theme',
    title: 'Theme and Appearance',
    category: 'settings',
    summary: 'Switch between light, dark, and system-matched themes.',
    content: `Forge supports three theme modes: Light, Dark, and System. The System option follows your operating system preference and updates automatically if you change it.

## How to change

Open **Settings > General**. Under Appearance, select your theme from the dropdown. The change takes effect immediately across all views.

## Where it's stored

Your theme preference is saved in browser local storage. It persists across page reloads and browser restarts, but it is specific to the browser profile you're using. If you access Forge from a different browser, you'll need to set it again.

## Desktop app

In the Electron desktop app, the theme applies to the full window including the title bar chrome. Dark mode is the default for new installs.

If you use the System setting, the app follows your OS dark/light mode toggle in real time.`,
    keywords: ['theme', 'dark mode', 'light mode', 'system', 'appearance', 'color scheme'],
    relatedIds: ['settings-general'],
    contextKeys: ['settings.general'],
  },

  // ── Editor Preference ─────────────────────────────────────────────
  {
    id: 'settings-editor',
    title: 'Editor Preference',
    category: 'settings',
    summary: 'Choose which code editor opens artifact files.',
    content: `When agents produce code artifacts, Forge can open files directly in your preferred editor. This setting controls which editor is launched when you click a file link in the artifact panel or chat.

## Supported editors

- **VS Code Insiders** — uses the \`vscode-insiders://\` URL scheme
- **VS Code** — uses the \`vscode://\` URL scheme
- **Cursor** — uses the \`cursor://\` URL scheme

## How to change

Open **Settings > General**. Under Appearance, pick your editor from the Preferred Editor dropdown. The setting is stored in your browser and takes effect on the next file-open action.

## How it works

File links in the artifact sidebar and chat transcript use the selected editor's URL scheme to open files at the correct path. Your editor needs to be installed and registered as a handler for its URL scheme. Most editors do this automatically during installation.

If clicking a file link does nothing, check that the editor is installed and that your OS recognizes the URL scheme. On macOS, you may need to open the editor once after installation so it registers itself.`,
    keywords: ['editor', 'vscode', 'cursor', 'artifact', 'file', 'open', 'code'],
    relatedIds: ['settings-general'],
    contextKeys: ['settings.general'],
  },

  // ── Authentication ────────────────────────────────────────────────
  {
    id: 'settings-auth',
    title: 'Authentication',
    category: 'settings',
    summary: 'Add API keys and set up OAuth for AI providers.',
    content: `The Authentication pane stores credentials for the AI providers Forge uses. Without at least one provider configured, agents cannot make model calls.

## Supported providers

- **Anthropic** — powers Claude-based workers and managers
- **OpenAI** — powers Codex runtime sessions and voice transcription
- **xAI** — powers Grok-based workers

## Adding an API key

1. Open **Settings > Authentication**.
2. Find the provider you want.
3. Paste your API key into the input field.
4. Click **Save**.

Each provider row shows a "Configured" or "Not configured" badge. Once saved, the key is masked but stored on disk at \`~/.forge/shared/auth/auth.json\`. Use the eye icon to toggle visibility of the input. Click **Remove** to delete a saved key.

Each provider also has a "Get key" link that opens the provider's key management page in your browser.

## OAuth login

Anthropic and OpenAI support OAuth as an alternative to API keys. Click **Login with OAuth**, follow the browser authorization flow, then paste the authorization code back into Forge. OAuth tokens are stored and refreshed automatically.

If the OAuth flow gets stuck, click **Clear** to reset it and try again.

## Which key do I need?

You need at least one provider key to run agents. Most setups use Anthropic for Claude-based workers. Add OpenAI if you want Codex runtime sessions or voice transcription. Add xAI if you want to use Grok models.`,
    keywords: [
      'api key',
      'authentication',
      'anthropic',
      'openai',
      'xai',
      'grok',
      'oauth',
      'credentials',
      'login',
    ],
    relatedIds: ['settings-oauth'],
    contextKeys: ['settings.auth'],
  },

  // ── OAuth ─────────────────────────────────────────────────────────
  {
    id: 'settings-oauth',
    title: 'OAuth Login',
    category: 'settings',
    summary: 'Authorize Forge with your provider account through OAuth.',
    content: `OAuth lets you connect Forge to a provider account without manually copying API keys. It is supported for Anthropic and OpenAI.

## How the flow works

1. Open **Settings > Authentication**.
2. Find the provider and click **Login with OAuth**.
3. Forge opens an authorization URL in your browser.
4. Log in and authorize Forge on the provider's site.
5. Copy the authorization code from the browser.
6. Paste it into the code input in Forge and click **Submit**.
7. Forge exchanges the code for tokens and stores them.

Once connected, the provider row shows a "Connected" badge. Forge handles token refresh automatically in the background.

## When to use OAuth vs. API keys

Either approach works. OAuth is useful if you prefer not to generate long-lived API keys, or if your organization manages access through OAuth rather than API keys. API keys are simpler for personal use.

## Troubleshooting

- **Authorization URL doesn't open** — copy the URL manually and paste it into your browser.
- **Code submission fails** — make sure you copied the full code or URL from the provider page. Some providers include a URL with the code embedded; paste the whole thing.
- **Flow gets stuck** — click **Clear** to reset, then start again.
- **Token expired** — Forge refreshes tokens automatically. If auth stops working, remove the credential and re-authorize.`,
    keywords: [
      'oauth',
      'login',
      'authorize',
      'token',
      'anthropic',
      'openai',
      'browser',
      'authentication',
    ],
    relatedIds: ['settings-auth'],
    contextKeys: ['settings.auth'],
  },

  // ── Notifications ─────────────────────────────────────────────────
  {
    id: 'settings-notifications',
    title: 'Notification Sounds',
    category: 'settings',
    summary: 'Set up sound alerts per manager and upload custom sounds.',
    content: `Forge can play sounds when agents send messages or finish their work. You set baseline defaults once, and individual managers inherit them automatically. Any manager can override the defaults with its own settings.

## Global toggle

The main toggle at the top enables or disables all notification sounds. When it's off, no sounds play regardless of other settings.

## Notification defaults

The Defaults section sets baseline preferences that apply to all managers except Cortex. It has the same controls as per-manager settings: unread message sound, all-done sound, and volume.

When you change the defaults, every manager that hasn't been explicitly customized picks up the new settings automatically.

## Per-manager overrides

Below the defaults, each manager profile is listed. Managers using the defaults show a compact row with "Using defaults" and a **Customize** button. Click Customize to create a per-manager override that starts as a copy of the current defaults, then adjust whatever you need.

Managers with overrides show the full controls plus a **Reset to defaults** button. Resetting removes the override and the manager goes back to inheriting defaults.

Each manager has two sound triggers:

- **Unread message sound** — plays when a manager sends a message you haven't read yet.
- **All done sound** — plays when a manager finishes with no workers still running.

## Cortex

Cortex always has its own standalone settings and never inherits from the defaults. This prevents automated review sessions from triggering sounds meant for interactive managers.

## Custom sounds

Upload your own notification sounds in MP3, WAV, or OGG format (max 2 MB per file). Custom sounds appear alongside the built-in options in every sound picker. Click the play button to preview a sound before selecting it.

To remove a custom sound, click the trash icon next to it. Any manager or the defaults using that sound falls back to the built-in default.

## Tips

- Set a distinct "all done" sound in the defaults so you hear when any long task finishes.
- Use per-manager overrides only when you need to tell managers apart by ear.
- Cortex settings are separate — configure them if you want sounds for automated reviews.`,
    keywords: [
      'notifications',
      'sound',
      'alert',
      'audio',
      'unread',
      'done',
      'custom sound',
      'volume',
      'manager',
    ],
    relatedIds: ['settings-general'],
    contextKeys: ['settings.notifications'],
  },

  // ── Integrations ──────────────────────────────────────────────────
  {
    id: 'settings-integrations',
    title: 'Integrations',
    category: 'settings',
    summary: 'Connect external services like Telegram to Forge.',
    content: `The Integrations pane connects Forge to external messaging services. Currently, Telegram is the main supported integration.

## Configuration scope

Integration settings can be shared or per-profile:

- **Shared (all managers)** — the default. Settings apply to every manager that doesn't have a custom override.
- **Per-profile** — select a specific manager to create an override that takes priority over shared settings.

Pick the scope from the dropdown at the top of the pane. When you select a specific profile, any changes you make apply only to that profile's integration config.

## Adding an integration

1. Select the configuration scope (shared or a specific manager).
2. Configure the integration settings (see the Telegram article for details).
3. Click **Save**.
4. Use **Test connection** to verify the setup works.

## Disabling

Click **Disable** to turn off an integration without deleting its config. You can re-enable it later by toggling it back on and saving.

## Troubleshooting

- **Test connection fails** — check the bot token, make sure the bot is not being used by another service, and verify your network allows outbound HTTPS to the provider's API.
- **Messages aren't delivered** — confirm the integration is enabled and the allowed user list includes your user ID (or is empty, which allows all users).`,
    keywords: [
      'integrations',
      'telegram',
      'external',
      'messaging',
      'bot',
      'scope',
      'shared',
      'profile',
    ],
    relatedIds: ['settings-telegram'],
    contextKeys: ['settings.integrations'],
  },

  // ── Telegram ──────────────────────────────────────────────────────
  {
    id: 'settings-telegram',
    title: 'Telegram Bot Setup',
    category: 'settings',
    summary: 'Connect a Telegram bot to send and receive messages through Forge.',
    content: `Forge can connect to a Telegram bot so you can chat with your agents from Telegram. Messages from allowed users are forwarded to the manager, and agent replies are sent back to Telegram.

## Setup steps

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the bot token.
2. Open **Settings > Integrations**.
3. Select your configuration scope (shared or per-profile).
4. Toggle **Enable Telegram integration** on.
5. Paste the bot token.
6. Add allowed Telegram user IDs (comma-separated). Leave empty to allow all users.
7. Click **Save**, then **Test connection** to verify.

## Key settings

- **Bot token** — the token from BotFather. Once saved, enter a new value to rotate it.
- **Allowed users** — restrict which Telegram user IDs can interact with the bot. Empty means anyone can use it.
- **Drop pending updates on start** — skip any backlogged messages and start fresh.
- **Disable link previews** — send outbound messages without link preview cards.
- **Reply to inbound message** — reply directly to the triggering Telegram message.

## Attachments

Control which file types Telegram passes to Forge:

- **Image attachments** — photos sent to the bot
- **Text attachments** — text-like documents (e.g. .txt, .csv)
- **Binary attachments** — other document types, encoded as base64

Set the **max attachment size** in bytes (default 10 MB).

## Polling settings

Forge uses long polling to receive messages. The **poll timeout** (default 25 seconds) and **poll limit** (default 100) control how the bot checks for new messages. The defaults work well for most setups.`,
    keywords: [
      'telegram',
      'bot',
      'botfather',
      'token',
      'polling',
      'attachments',
      'messaging',
      'integration',
      'allowed users',
    ],
    relatedIds: ['settings-integrations'],
    contextKeys: ['settings.integrations'],
  },

  // ── Skills ────────────────────────────────────────────────────────
  {
    id: 'settings-skills',
    title: 'Skills Management',
    category: 'settings',
    summary: 'Configure API keys and settings for installed agent skills.',
    content: `Skills give agents extra capabilities like web search, image generation, and browser automation. The Skills pane shows installed skills and lets you configure their required API keys and settings.

## Skill selector

Use the dropdown at the top to filter by skill. Select "All Skills" to see every environment variable across all skills, or pick a specific skill to see only its requirements.

Some skills have a gear icon in the dropdown, which means they have a dedicated configuration panel beyond basic API keys. Select that skill to see its full settings.

## Environment variables

Each skill declares the environment variables it needs. The pane shows:

- **Variable name** — the env var key (e.g. \`BRAVE_API_KEY\`)
- **Status** — "Set" (green) if a value is saved, "Missing" (amber) if not
- **Required by** — which skill uses this variable
- **Optional** — marked if the skill works without it but gains features with it

To configure a variable:

1. Find the variable row.
2. Paste the value into the input field.
3. Click **Save**.

Use the eye icon to toggle visibility. Click **Remove** to delete a saved value.

Most variables have a "Get key" link that opens the provider's signup or key management page.

## Dedicated skill panels

Skills like Chrome CDP have dedicated configuration UI that appears when you select them. These panels expose settings specific to that skill, like connection targets or scope controls.

## How skills load

Skills are discovered at agent startup from builtin and user directories. You don't need to restart Forge after saving an API key — the key is available to the next agent session that needs it.`,
    keywords: [
      'skills',
      'api key',
      'environment variable',
      'brave',
      'chrome',
      'cdp',
      'image generation',
      'configuration',
      'secrets',
    ],
    relatedIds: ['settings-auth', 'settings-extensions'],
    contextKeys: ['settings.skills'],
  },

  // ── Prompts ───────────────────────────────────────────────────────
  {
    id: 'settings-prompts',
    title: 'Prompt System',
    category: 'settings',
    summary:
      'Edit system prompts, preview runtime context, and manage Cortex surfaces.',
    content: `The Prompts pane lets you browse and edit the system prompts that shape how agents behave. Prompts are scoped to a profile, so different managers can have different prompts.

## How prompt resolution works

Forge resolves prompts in three layers:

1. **Profile override** — a prompt you edited for a specific profile (highest priority)
2. **Repo prompt** — a project-level prompt from the repo
3. **Builtin default** — the prompt that ships with Forge (lowest priority)

When you edit a prompt here, you're creating a profile override. If you delete the override, Forge falls back to the next layer.

## Browsing prompts

1. Select a **profile** from the dropdown (if you have more than one).
2. Pick a **category**: Archetypes (persona-level prompts) or Operational (task-specific prompts).
3. Select a **prompt** from the list.

The editor shows the current prompt text with a source indicator showing where it came from.

## Cortex surfaces

If Cortex is enabled, a third category appears: **Cortex Surfaces**. These are grouped into system templates, seed templates, live files, and scratch surfaces. Cortex surfaces are managed separately because Cortex may update them during auto-reviews.

When viewing the Cortex profile, the category picker is hidden and all items are shown in a single grouped dropdown.

## Preview

Click the **Preview** button (eye icon) to see the complete runtime context a new session would receive. The preview shows every section: system prompt, memory, AGENTS.md content, loaded skills, and more. This is useful for understanding exactly what an agent sees when it starts.`,
    keywords: [
      'prompts',
      'system prompt',
      'archetype',
      'operational',
      'cortex',
      'override',
      'preview',
      'runtime context',
      'profile',
    ],
    relatedIds: ['settings-specialists'],
    contextKeys: ['settings.prompts'],
  },

  // ── Specialists ───────────────────────────────────────────────────
  {
    id: 'settings-specialists',
    title: 'Specialist Workers',
    category: 'settings',
    summary:
      'Create named worker personas with specific models, prompts, and fallback routing.',
    content: `Specialists are named worker templates that tell the manager which model, reasoning level, and system prompt to use for different kinds of tasks. Instead of a single generic worker, you can have a backend specialist running Codex and a frontend specialist running Opus, each with tailored instructions.

## Global vs. profile scope

Use the scope dropdown to switch between:

- **Global** — specialists shared across all profiles. Builtin specialists live here.
- **Per-profile** — overrides that apply to one profile only, taking priority over global definitions.

## Enabling specialists

The global toggle at the top turns the specialist system on or off. When disabled, the manager uses legacy model routing guidance instead. Leave it enabled unless you have a specific reason to turn it off.

## Creating a specialist

1. Click **New Specialist**.
2. Enter a handle (kebab-case identifier) and display name.
3. Click **Create**. The specialist opens in edit mode with a default prompt.
4. Set the model, reasoning level, color, and "when to use" description.
5. Edit the prompt body to describe this specialist's focus.
6. Click **Save**.

## Model and fallback

Each specialist has a primary model and reasoning level. You can also set a fallback model that takes over if the primary is unavailable or rate-limited. Expand the fallback section to configure it.

## Native search (web + X) (Grok models only)

Specialists using xAI Grok models can enable native search. When enabled, Forge gives the model access to xAI's built-in web and X search tools for current information, public social discussion, and inline citations.

The native search toggle appears in the specialist editor only when a Grok model is selected. For other models, the setting is hidden and ignored.

To enable native search:
1. Select a Grok model (e.g., grok-4, grok-4.20).
2. Find the Native Search toggle below the fallback settings.
3. Toggle it on and save.

Native search can also be enabled for one-off workers using the \`spawn_agent\` tool with the \`webSearch: true\` parameter.

## Pinning

Builtin specialists are updated when Forge updates. If you customize a builtin, enable **Pin customizations** to prevent your changes from being overwritten. Without pinning, Forge warns you before saving.

## Profile overrides

When viewing a profile scope, inherited specialists appear below your overrides. Click an inherited specialist to create a profile-specific copy you can customize. Use **Revert** to delete the override and return to the inherited version.

## Roster prompt

In profile scope, click **Roster Prompt** to see the specialist roster block that gets injected into the manager's system prompt. This shows exactly what the manager knows about its available specialists.`,
    keywords: [
      'specialists',
      'workers',
      'model',
      'reasoning',
      'fallback',
      'prompt',
      'roster',
      'pinned',
      'override',
      'template',
    ],
    relatedIds: ['settings-prompts'],
    contextKeys: ['settings.specialists'],
  },

  // ── Slash Commands ────────────────────────────────────────────────
  {
    id: 'settings-slash-commands',
    title: 'Slash Commands',
    category: 'settings',
    summary: 'Create saved prompt shortcuts accessible with / in chat.',
    content: `Slash commands are saved prompts you can insert into chat by typing \`/\` followed by the command name. They are a quick way to reuse common instructions without retyping them.

## Creating a command

1. Open **Settings > Slash Commands**.
2. Click **Add Command**.
3. Enter a command name (lowercase, hyphens allowed). The \`/\` prefix is added automatically.
4. Write the prompt text that will be inserted when you select this command.
5. Click **Create**.

## Using commands in chat

Type \`/\` in the chat input to see your available commands. Select one and its prompt text is inserted into the message. You can edit the inserted text before sending.

## Editing and deleting

Each command row has edit and delete buttons. Click the pencil icon to modify a command's name or prompt text. Click the trash icon to remove it.

## How they're stored

Slash commands are saved per profile. They persist across sessions and browser reloads. The command name is normalized to lowercase with hyphens when you save it.

## Tips

- Use slash commands for recurring instructions like "review this PR", "write tests for this file", or "summarize the last 10 messages".
- Keep command names short and descriptive so they're easy to find in the autocomplete list.
- The prompt text can be as long as you want. Multi-line prompts work fine.`,
    keywords: [
      'slash commands',
      'shortcuts',
      'prompt',
      'autocomplete',
      'chat',
      'command',
      'saved prompt',
    ],
    relatedIds: ['settings-general'],
    contextKeys: ['settings.slash-commands'],
  },

  // ── Extensions ────────────────────────────────────────────────────
  {
    id: 'settings-extensions',
    title: 'Extensions',
    category: 'settings',
    summary:
      'View and manage Pi extensions that add custom tools and event hooks.',
    content: `Extensions are custom code modules that add tools, intercept events, or modify context for agents. The Extensions pane shows every extension Forge has discovered on disk, grouped by source, along with runtime status for active agents.

## Discovery sources

Forge looks for extensions in four directories, checked in order:

- **Global Worker** — applies to all worker agents (\`~/.forge/agent/extensions/\`)
- **Global Manager** — applies to all manager agents (\`~/.forge/agent/manager/extensions/\`)
- **Profile** — applies to agents in a specific profile (\`~/.forge/profiles/<profileId>/pi/extensions/\`)
- **Project** — applies to agents working in a specific repo (\`.pi/extensions/\` in the project root)

Each discovered extension shows its source badge, file path, and a copy button for the path.

## Runtime bindings

When an extension is loaded by an active agent, the card shows which agents have it, what tools it provides, and what events it hooks. If no agents are running, it shows "Not loaded in active runtimes."

## Load errors

If an extension fails to load, the card shows the error with the agent that tried to load it. Common causes: syntax errors, missing dependencies, or invalid export signatures.

## Adding extensions

Drop a \`.ts\` or \`.js\` file (or a folder with \`index.ts\`/\`index.js\`) into one of the discovery directories. Extensions are discovered when an agent session starts — no backend restart needed.

Click **Refresh** to re-scan the directories and update the display.

For the extension API and examples, see the [extension documentation](https://github.com/a-mart/forge/blob/main/docs/PI_EXTENSIONS.md).`,
    keywords: [
      'extensions',
      'plugins',
      'tools',
      'events',
      'custom',
      'discovery',
      'runtime',
      'pi',
    ],
    relatedIds: ['settings-skills'],
    contextKeys: ['settings.extensions'],
  },

  // ── About ─────────────────────────────────────────────────────────
  {
    id: 'settings-about',
    title: 'About Forge',
    category: 'settings',
    summary: 'Version info, update checks, and release channel settings.',
    content: `The About pane shows Forge's current version and provides access to updates and release information.

## Version

The version badge shows the running version number. Click the GitHub releases link to see the full changelog and download history.

## Updates (desktop app)

In the Electron desktop app, this pane manages automatic updates:

- **Check for Updates** — manually check if a newer version is available.
- **Download Update** — download a discovered update. A progress bar shows download status.
- **Restart to Install** — once downloaded, restart the app to apply the update.

Update status messages show the current state: checking, up to date, available, downloading, or ready to install.

## Beta channel

Enable **Include beta updates** to get early access to pre-release versions. Beta releases ship new features sooner but may be less stable. Toggle it off to return to the stable release channel.

## Browser mode

When running Forge in a browser (not the desktop app), the update controls are hidden. Updates are managed through your deployment process instead.

## Troubleshooting

If an update check fails, verify your network connection and try again. The error message from the update service is shown in the status line.`,
    keywords: [
      'about',
      'version',
      'update',
      'release',
      'beta',
      'electron',
      'desktop',
      'changelog',
    ],
    relatedIds: ['settings-general'],
    contextKeys: ['settings.about'],
  },
]
