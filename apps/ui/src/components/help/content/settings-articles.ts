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

## Sidebar

Toggle "Show provider usage" to control whether the provider subscription usage widget appears in the sidebar toolbar. When enabled, you'll see compact usage gauges for OpenAI Codex, Anthropic Claude, and Cursor SDK when used, with 5-hour and weekly windows. Click the widget to expand it for detailed metrics including deficit/reserve pace and estimated runout times, and use the refresh button in the detail panel to re-poll immediately. Usage state is restored after backend restarts, and weekly estimates follow historical usage curves rather than simple linear interpolation. Pooled OAuth usage polling refreshes tokens first, and pooled auth errors can suppress usage display. The same usage data also feeds Dashboard stats and token analytics. The setting is stored in your browser and applies immediately.

## Telemetry

Anonymous telemetry is enabled by default and sends only aggregate counts such as sessions, models, and feature adoption. It does not send prompts, code, file paths, repo names, or personal data.

To opt out, set \`FORGE_TELEMETRY=false\` in your environment. There is no telemetry setting in the UI.

## Cortex Auto-Review

Cortex is Forge's self-improvement system. When automatic reviews are enabled, Cortex periodically checks your sessions and updates knowledge, memory, and reference docs. You can set the review interval from every 15 minutes up to every 24 hours. Disable it entirely if you want to run reviews manually.

Only reviewable transcript drift drives reviews; raw JSONL growth alone and internal/system entries do not.

## Welcome Preferences

Edit the default preferences Forge shares with new manager sessions. These are the onboarding choices you made on first launch (name, technical level, workflow style). Changes here apply to future sessions.

## Collaboration

Open **Settings > Collaboration** to manage one or more collaboration backend connections. Add a connection, enter its backend URL, and click **Save** and **Test** for that connection to confirm it is reachable. Use the Builder/Collab toggle to open the collaboration sign-in surface. For configured remote backends, the toggle can take you to sign-in before you are authenticated. After sign-in succeeds, that backend's channels become available.

Settings are contextual: Builder mode Settings continue to configure the local backend, while Collab mode Settings configure the selected collaboration backend. Collab Settings are admin-only, and provider auth entered there writes directly to the selected collaboration backend instead of copying or sharing the local Builder auth file.

Collab Settings also include members and invites, plus password management, all scoped to the selected backend connection. Admins can manage members and invites, issue temporary-password resets that require a password change, and users can change their own password. If a collaboration session or socket gets invalidated by a lifecycle change, the public UI shows sign-in recovery instead of looping on reconnect or staying stuck on loading.

Collaboration channels are session-backed and can carry per-channel instructions and reference docs. Channel guidance is labeled **Additional instructions**.

The Collaboration status panel reflects the configured collaboration connection/backend, not the local Builder backend. Terminal settings stay hidden in remote Collab Settings v1 and remain local-only.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.`,
    keywords: [
      'theme',
      'dark mode',
      'light mode',
      'editor',
      'vscode',
      'cursor',
      'cortex',
      'auto-review',
      'reboot',
      'appearance',
      'onboarding',
      'preferences',
      'sidebar',
      'provider usage',
      'subscription',
      'usage monitoring',
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
    summary: 'Configure provider credentials and auth modes.',
    content: `The Authentication pane lists each provider on its own row. Every row shows the provider label and an auth-mode badge so you can see at a glance whether Forge is using OAuth or an API key.

## Supported providers

- **Anthropic** — Claude-based workers and managers. Supports either OAuth or API key auth.
- **OpenAI** — Codex runtime sessions and voice transcription. Supports either OAuth or API key auth.
- **Claude SDK** — Native Claude Code CLI OAuth path for Claude models. OAuth only.
- **Cursor SDK** — Native Cursor SDK runtime for Composer 2.5. API key only via \`CURSOR_API_KEY\` for both manager and specialist sessions. Background auth/transport failures stay inside the worker runtime and surface as worker failures, not app crashes.
- **xAI** — Grok-based workers.

## Configuring a provider

1. Open **Settings > Authentication**.
2. Find the provider row you want.
3. Use the auth control shown on that row to connect with OAuth or enter an API key, depending on the provider and your setup.
4. Click **Save** if prompted.

Each row also shows whether that provider is configured. Saved credentials are masked and stored on disk at \`~/.forge/shared/config/auth/auth.json\`. Pooled OAuth credentials refresh through the shared auth path before runtime selection and save refreshed tokens back under the pooled key; missing or clearly expired pooled creds surface as \`auth_error\`. Use the eye icon to toggle visibility of any entered secret. Click **Remove** to delete saved credentials.


Each provider row includes a **Get key** link when API key auth is supported, which opens the provider's key management page in your browser.

## OAuth login

Anthropic and OpenAI support OAuth as an alternative to API keys. Click **Login with OAuth**, follow the browser authorization flow, then paste the authorization code back into Forge. OAuth tokens are stored and refreshed automatically.

Claude SDK uses Claude Code CLI OAuth instead of an API key. Run \`claude login\` first so Forge can read the local Claude credentials. If the SDK is unavailable, Forge falls back to the Pi-proxied Anthropic path automatically.

If the OAuth flow gets stuck, click **Clear** to reset it and try again.

## Which credential do I need?

You need at least one provider credential to run agents. Most setups use Anthropic for Claude-based workers. Add OpenAI if you want Codex runtime sessions or voice transcription. Add xAI if you want to use Grok models. Use Claude SDK if you want the native Claude Code CLI OAuth path instead of an API key. Use Cursor SDK if you want Composer 2.5 access through \`CURSOR_API_KEY\` in manager and specialist selectors.`,
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

Each manager has three sound triggers:

- **Unread message sound** — plays when a manager sends a message you haven't read yet.
- **Question sound** — plays when an agent presents a structured choice or question (via the choice picker tool). When enabled, this takes priority over the unread message sound for choice request events. When disabled, choice requests fall back to the regular unread sound.
- **All done sound** — plays when a manager finishes with no workers still running.

## Cortex

Cortex always has its own standalone settings and never inherits from the defaults. This prevents automated review sessions from triggering sounds meant for interactive managers.

## Custom sounds

Upload your own notification sounds in MP3, WAV, or OGG format (max 2 MB per file). Custom sounds appear alongside the built-in options in every sound picker. Click the play button to preview a sound before selecting it.

To remove a custom sound, click the trash icon next to it. Any manager or the defaults using that sound falls back to the built-in default.

## CLI notifications

The **Mute CLI-originated notifications** toggle suppresses notification sounds for sessions that were created by the Forge CLI, as well as replies to messages sent via the CLI. Unread badges still update normally — only sounds are silenced.

This is useful when you have automated CLI workflows (scripts, CI pipelines, scheduled tasks) that generate activity you don't need audible alerts for.

## Tips

- The question sound is enabled by default and uses a dedicated audio file. It helps you notice when agents need your input for a decision.
- Set a distinct "all done" sound in the defaults so you hear when any long task finishes.
- Use per-manager overrides only when you need to tell managers apart by ear.
- Cortex settings are separate — configure them if you want sounds for automated reviews.
- If you prefer not to hear question alerts, disable the question sound in defaults — choice requests will fall back to the regular unread sound instead.
- Enable "Mute CLI-originated notifications" if you use the Forge CLI for background automation and don't want sound alerts for that activity.`,
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
      'cli',
      'mute',
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
    summary: 'Configure skills, share user-created bundles, and import skills from links.',
    content: `Skills give agents extra capabilities like web search, image generation, and browser automation. The Skills page lets you browse installed skills, inspect their files, configure API keys and settings, and share or import user-created skills from links.

## Scope and skill browser

Use the **Configuration scope** dropdown to switch between Global and per-profile skill views. The Skills tab fills the settings content area with a searchable skill list rail on the left, a file tree in the middle, and a file viewer on the right. Each area scrolls independently, so long skill lists and file trees stay usable. Select a skill to browse its definition (\`SKILL.md\`), helper scripts, and other files.

## Environment variables

When a skill declares required environment variables, they appear in the right detail pane alongside the selected skill. The pane shows:

- **Variable name** — the env var key (e.g. \`BRAVE_API_KEY\`)
- **Status** — whether a value is currently saved
- **Optional** — marked if the skill works without it but gains features with it

To configure a variable, paste the value into the input field and click **Save**. Use the eye icon to toggle visibility, or click **Remove** to delete a saved value.

## Dedicated skill panels

Skills like Chrome CDP have dedicated configuration UI in the right detail pane when selected. These panels expose settings specific to that skill, like connection targets or scope controls.

## How skills load

Skills are discovered at agent startup from builtin, user, and repository directories. You don't need to restart Forge after saving an API key — the key is available to the next agent session that needs it.

## Repository skills

If the current repository has a root \`.forge/skills/\` directory, Forge shows those skills in the browser alongside your global and per-profile skills. The built-in \`create-skill\` helper can scaffold directly into repository \`.forge/skills/\` when you want a project-scoped skill. Repository-root \`.forge/\` resources can also include \`.forge/specialists/\`, \`.forge/reference/\`, \`.forge/extensions/\`, \`.forge/pi/extensions/\`, and \`.forge/pi/settings.json\`.

Repository skills stay visible as text resources even when executable trust is denied. Only executable repo resources stay blocked until you trust the repository's \`.forge\` directory.

## Skill sharing

Use the Share button on a user-created global or project skill to generate a temporary bearer link from the skill share service. The default service origin is \`https://forgeskills.radops.ai\`; you can override it with \`FORGE_SKILL_SHARE_BASE_URL\` or disable sharing with \`FORGE_SKILL_SHARE_DISABLED\`. Legacy \`MIDDLEMAN_SKILL_SHARE_BASE_URL\` and \`MIDDLEMAN_SKILL_SHARE_DISABLED\` are still accepted.

Use **Import from URL** to paste a Forge skill-share link or a \`forge://skill-import\` deep link. Forge always opens a preview first so you can review files, warnings, and conflicts before anything is installed.

Conflicts default to reject. If the target directory already exists or the import would install an override, you must explicitly confirm the replacement before install.

## Collaboration skill selection

In Collaboration mode, the Skills page adds category and channel scopes to the scope dropdown. This lets you control which skills are loaded for each collaboration context:

- **Global** — browse all collaboration skills shared across channels.
- **Category** — set the default skill selection for new channels in that category (all or custom).
- **Channel** — choose which skills are loaded for a specific channel session.

Skill selection supports two modes: **All skills** (loads every available skill) or **Custom selection** (a curated list you choose). Always-on skills like \`memory\` are always included and cannot be turned off. There is no channel-local skill authoring in V1 — collaboration only stores the selection state.`,
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
      'share',
      'import',
      'url',
      'deep link',
      'preview',
      'conflict',
      'collaboration',
      'channel',
      'category',
      'selection',
    ],
    relatedIds: ['settings-auth', 'settings-extensions', 'settings-specialists'],
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
    content: `Specialists are named worker templates that tell the manager which model, reasoning level, and system prompt to use for different kinds of tasks. Instead of a single generic worker, you can have a backend specialist running Codex and a frontend specialist running GPT-5.5 at medium reasoning, each with tailored instructions.

Forge also ships collaboration-focused builtins such as \`collab-planner\`, \`collab-reviewer\`, \`collab-doc-writer\`, \`collab-scout\`, and \`collab-researcher\` for channel work that needs project-context aware roles.

## Global vs. profile scope

Use the scope dropdown to switch between:

- **Global** — specialists shared across all profiles. Builtin specialists live here.
- **Per-profile** — overrides that apply to one profile only, taking priority over global definitions.

## Builder vs. Collaboration visibility

Specialists are TargetSpace-aware. The Builder roster shows the local Builder set, while Collaboration mode shows the collaboration set for the active channel or server context. That keeps channel-only helpers out of the Builder roster and keeps Builder-only definitions out of Collab views.

## Collaboration scopes

Collab Settings supports three scopes:

- **Global** — shared collaboration specialists available to all channels.
- **Category** — the default specialists selected for new channels in that category.
- **Channel** — the active selected specialists for one channel session, plus channel-local specialist CRUD.

Channel-local specialists live at \`profiles/_collaboration/sessions/<channelSessionId>/specialists/<handle>.md\` and shadow any global specialist with the same handle inside that channel.

Skill selection (all/custom mode per category or channel) is managed on the **Skills** settings page, not here.

## Filtering the roster

When you have disabled specialists, a **Hide disabled** checkbox appears next to the toolbar buttons. Check it to filter disabled specialists from all sections. The preference persists across sessions.

## Enabling specialists

The global toggle at the top turns the specialist system on or off. When disabled, the manager uses legacy model routing guidance instead. Leave it enabled unless you have a specific reason to turn it off.

## Creating a specialist

1. Click **New Specialist**.
2. Enter a handle (kebab-case identifier) and display name.
3. Click **Create**. The specialist opens in edit mode with a default prompt.
4. Set the model, reasoning level, color, and "when to use" description.
5. Edit the prompt body to describe this specialist's focus.
6. Click **Save**.

## Project agent session creation

If a project agent has the **Can create sessions** toggle enabled in its settings, it can create new manager sessions in the same profile. Those created sessions can show creator attribution in the sidebar, and the creator keeps using the normal messaging path.

## Model and fallback

Each specialist has a primary model and reasoning level. You can also set a fallback model that takes over if the primary is unavailable or rate-limited. Recoverable failures are retried silently inside worker/runtime fallback replay or handoff before the manager sees an error, and successful fallback is invisible to the manager and user. Only exhausted fallback failures bubble up. Built-in specialists generally use cross-vendor fallbacks when practical. The built-in \`web-researcher\` follows normal fallback/model config semantics and uses Brave-backed research guidance on OpenAI Codex \`gpt-5.4-mini\`. Expand the fallback section to configure it.

## Specialist web research

Forge's current production web research path is the built-in \`web-researcher\`, which uses Brave-backed research guidance. xAI native web/X search is not a current production path unless a future adapter enables it.

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
- **Project** — applies to agents working in a specific repo (\`.forge/pi/extensions/\` for direct Pi extensions, with packages configured in \`.forge/pi/settings.json\`)

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

  // ── CLI Access ────────────────────────────────────────────────────
  {
    id: 'settings-cli-access',
    title: 'CLI Access',
    category: 'settings',
    summary: 'Generate CLI keys, install the desktop shim, and configure headless automation.',
    content: `CLI Access controls the first-party \`forge\` command-line interface. Use it when you want scripts or terminal workflows to inspect sessions, send messages, run automation, wait for completion, or answer pending choices.

## Access keys

CLI keys are separate from model-provider credentials. Generate a key, copy it immediately, and store it securely; Forge shows the plaintext key only once. The backend stores generated keys hash-only, so lost keys must be rotated or regenerated.

The key list shows metadata such as name, creation time, and last-used information. Revoke keys that are no longer needed. Rotate a key when you want to replace it without keeping the old credential active.

## LAN safety

Desktop Forge may be reachable over your local network or Tailscale. Anyone with network access to the backend and a valid CLI key can use the CLI API, so treat keys like bearer tokens and revoke them if they are shared accidentally.

## Install CLI

In the desktop app, click **Install CLI** to create a user-local shim:

- macOS/Linux: \`~/.forge/bin/forge\`
- Windows: \`%LOCALAPPDATA%\\forge\\bin\\forge.cmd\`

The shim uses the packaged Forge app runtime and bundled CLI resource, so it does not require a separate Node.js install and does not contain API keys. If the bin directory is not on \`PATH\`, Forge shows the exact shell instructions to add it.

Browser/source installs can use npm instead:

\`\`\`bash
npm install -g @forge/cli
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge doctor
\`\`\`

Prefer environment variables or flags for automation. Saved CLI config can store API keys as plaintext local data and should be used only when that tradeoff is acceptable.`,
    keywords: [
      'cli',
      'command line',
      'headless',
      'automation',
      'api key',
      'bearer',
      'install',
      'path',
      'rotate',
      'revoke',
    ],
    relatedIds: ['settings-auth', 'settings-general'],
    contextKeys: ['settings.cli-access'],
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
