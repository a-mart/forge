General Settings covers editor integration, sidebar preferences, Active Work Plans, telemetry, and the Cortex auto-review schedule. Appearance now has its own **Settings > Appearance** pane, and diagnostic export controls live in **Settings > Observability**.

## Appearance

Open **Settings > Appearance** to choose Light, Dark, System, or a custom local appearance. Choose which code editor opens artifact file links from General. Supported editors are VS Code Insiders, VS Code, and Cursor.

## Sidebar

Toggle "Show provider usage" to control whether the provider subscription usage widget appears in the sidebar toolbar. When enabled, you'll see compact usage gauges for OpenAI Codex, Anthropic Claude, and Cursor SDK when used, with 5-hour and weekly windows. Click the widget to expand it for detailed metrics including deficit/reserve pace and estimated runout times, and use the refresh button in the detail panel to re-poll immediately. Usage state is restored after backend restarts, and weekly estimates follow historical usage curves rather than simple linear interpolation. Pooled OAuth usage polling refreshes tokens first, and pooled auth errors can suppress usage display. When OpenAI/Codex uses Forge Auth broker mode, broker-backed status and usage appear when the broker provides them. The same usage data also feeds Dashboard stats and token analytics. The setting is stored in your browser and applies immediately.

## Active Work Plans

Use **Enable Active Work Plans** to turn the session coordination UI on or off. It is Builder-only and on by default. When enabled, managers get the `task` tool, Active Work guidance, and the live Active Work card in chat. When disabled, the live card hides and manager runtimes recycle or defer recycle so the change takes effect cleanly. Historical Work Plan receipts stay visible either way.

## Compaction

Use **Settings > General > Compaction** to choose the model, reasoning level, and timeout Forge uses for automatic compaction and manual Smart compact runs. These controls apply only to supported Pi-backed manager compaction runtimes: OpenAI/Codex and Anthropic. Claude SDK/native runtimes and xAI/Grok are not eligible here; those runtimes may handle compaction through their own behavior where applicable. The default is **GPT-5.5**, **Low** reasoning, and a **5 minute** timeout. If the configured provider or model is unavailable, Forge shows a warning here so you can fix auth or pick a different model before automatic compaction needs it.

## Prompt Cache Visualization

Use **Enable prompt cache visualization** to show a compact prompt-cache chip in manager chat headers for OpenAI/Codex Pi sessions. It is Builder-only and **off by default**.

When enabled, Forge captures provider-reported cached input token counts on eligible manager turns and summarizes hit, partial, and miss states in the header popover. While disabled, Forge does not collect new cache observations and hides the indicator. Observations from earlier enabled periods may appear after you turn this on and load session history.

Cached token counts come from the provider. OpenAI does not report specific miss or drop causes, and Forge does not infer them.

## Telemetry

Anonymous telemetry is enabled by default and sends only aggregate counts such as sessions, models, and feature adoption. It does not send prompts, code, file paths, repo names, or personal data.

To opt out, set `FORGE_TELEMETRY=false` in your environment. There is no telemetry setting in the UI.

## Cortex Auto-Review

Cortex is Forge's self-improvement system. When automatic reviews are enabled, Cortex periodically checks your sessions and updates knowledge, memory, and reference docs. You can set the review interval from every 15 minutes up to every 24 hours. Disable it entirely if you want to run reviews manually.

Only reviewable transcript drift drives reviews; raw JSONL growth alone and internal/system entries do not.

## Welcome Preferences

Edit the default preferences Forge shares with new manager sessions. These are the onboarding choices you made on first launch (name, technical level, workflow style). Changes here apply to future sessions.

## Collaboration

Open **Settings > Collaboration** to manage one or more collaboration backend connections. Add a connection, enter its backend URL, and click **Save** and **Test** for that connection to confirm it is reachable. Use the Builder/Collab toggle to open the collaboration sign-in surface. For configured remote backends, the toggle can take you to sign-in before you are authenticated. Configured backends wait for sign-in before opening metadata or live subscriptions; unknown, network, and server errors remain retryable. After sign-in succeeds, that backend's channels become available.

Settings are contextual: Builder mode Settings continue to configure the local backend, while Collab mode Settings configure the selected collaboration backend. Collab Settings are admin-only, and provider auth entered there writes directly to the selected collaboration backend instead of copying or sharing the local Builder auth file.

Collab Settings also include members and invites, plus password management, all scoped to the selected backend connection. Admins can manage members and invites, issue temporary-password resets that require a password change, and users can change their own password. If a collaboration session or socket gets invalidated by a lifecycle change, the public UI shows sign-in recovery instead of looping on reconnect or staying stuck on loading.

Collaboration channels are session-backed and can carry per-channel instructions and reference docs. Channel guidance is labeled **Additional instructions**.

The Collaboration status panel reflects the configured collaboration connection/backend, not the local Builder backend. Terminal settings stay hidden in remote Collab Settings v1 and remain local-only.

## Observability

Open **Settings > Observability** to export Builder-only Forge traces to a local Arize Phoenix OTLP endpoint. That pane includes status, test export, capture toggles, and privacy controls.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.
