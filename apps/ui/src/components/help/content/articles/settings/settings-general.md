General Settings covers editor integration, sidebar preferences, Active Work Plans, telemetry, and the Cortex auto-review schedule. Appearance now has its own **Settings > Appearance** pane, and diagnostic export controls live in **Settings > Observability**.

## Appearance

Open **Settings > Appearance** to choose Light, Dark, System, or a custom local appearance. Choose which code editor opens artifact file links from General. Supported editors are VS Code Insiders, VS Code, and Cursor.

## Sidebar

Toggle "Show provider usage" to control whether the provider subscription usage widget appears in the sidebar toolbar. When enabled, you'll see compact usage gauges for OpenAI Codex, Anthropic Claude, and Cursor SDK when used, with 5-hour and weekly windows. Click the widget to expand it for detailed metrics including deficit/reserve pace and estimated runout times, and use the refresh button in the detail panel to re-poll immediately. Usage state is restored after backend restarts, and weekly estimates follow historical usage curves rather than simple linear interpolation. Pooled OAuth usage polling refreshes tokens first, and pooled auth errors can suppress usage display. The same usage data also feeds Dashboard stats and token analytics. The setting is stored in your browser and applies immediately.

## Active Work Plans

Use **Enable Active Work Plans** to turn the session coordination UI on or off. It is Builder-only and on by default. When enabled, managers get the `task` tool, Active Work guidance, and the live Active Work card in chat. When disabled, the live card hides and manager runtimes recycle or defer recycle so the change takes effect cleanly. Historical Work Plan receipts stay visible either way.

## Telemetry

Anonymous telemetry is enabled by default and sends only aggregate counts such as sessions, models, and feature adoption. It does not send prompts, code, file paths, repo names, or personal data.

To opt out, set `FORGE_TELEMETRY=false` in your environment. There is no telemetry setting in the UI.

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

## Observability

Open **Settings > Observability** to export Builder-only Forge traces to a local Arize Phoenix OTLP endpoint. That pane includes status, test export, capture toggles, and privacy controls.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.
