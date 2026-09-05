General Settings covers editor integration, sidebar preferences, repository clone defaults, compaction, telemetry, the Cortex consolidation schedule, and the Knowledge v2 preview. Appearance has its own **Settings > Appearance** pane, and diagnostic export controls live in **Settings > Observability**.

## Appearance

Open **Settings > Appearance** to choose Light, Dark, System, or a custom local appearance. Choose which code editor opens artifact file links from General. Supported editors are VS Code Insiders, VS Code, and Cursor.

## Repositories

Use **Settings > General > Repositories** to set a configured repository home for **Clone repository** during project creation. Precedence is: configured home → last successfully used clone base → your home directory. Clearing the configured home falls back to last-used or home. This section is local Builder only; collaboration-server Builder shells hide it and do not call the repositories settings API. Private clones require ambient noninteractive Git/SSH credentials on the Builder host.

## Sidebar

Toggle **Show provider usage** to control whether the provider subscription usage widget appears in the sidebar toolbar. When enabled, you'll see compact usage gauges for OpenAI Codex and Anthropic Claude with 5-hour and weekly windows, plus a weekly-only `xAI` SuperGrok credits gauge when xAI OAuth is stored. Click the widget to expand it for detailed metrics including reset remaining time and, where available, deficit/reserve pace and estimated runout times, and use the refresh button in the detail panel to re-poll immediately. Usage state is restored after backend restarts. OpenAI and Anthropic weekly estimates follow historical usage curves rather than simple linear interpolation; the xAI weekly gauge has no historical pace curve. Cursor SDK usage is not part of this widget — it appears in Stats token analytics and telemetry provider inference. xAI API-key-only or env-only `XAI_API_KEY` setups, and missing or unauthorized xAI OAuth, leave the xAI gauge absent without extra noise, and transient fetch failures keep the last good reading. Pooled OAuth usage polling refreshes tokens first, and pooled auth errors can suppress usage display. When OpenAI/Codex uses Forge Auth broker mode, broker-backed status and usage appear when the broker provides them. The setting is stored in your browser and applies immediately.

**Use new project view** is on by default. Leave it on for Inbox and Projects; turn it off to roll back to Classic. Inbox opens first and lists **Needs you**, **Active**, and **Recent**, then an inline Projects tree. **Needs you** is server-issued work-lifecycle attention, not unread, pending-choice, or error badges. **Done** and **Clear** dismiss those exact items; mute only hides **Needs you** and the Inbox badge. Origins that do not support session attention omit **Needs you**. Projects keeps the project/session tree, search prefixes, pins, and drag reorder. On desktop, Cortex lives in the activity-rail popover; mobile and Classic keep the pinned sidebar row.

## Working plans

Working plans and explicit session goals are always available to Builder managers and do not require a General Settings toggle.

## Compaction

Use **Settings > General > Compaction** to choose the model, reasoning level, and timeout Forge uses for automatic compaction and manual Smart compact runs. These controls apply only to supported Pi-backed manager compaction runtimes: OpenAI/Codex and Anthropic. Cursor SDK, xAI/Grok, and user-added OpenRouter manager models are not eligible here; OpenRouter manager eligibility is a separate policy. The default is **GPT-5.5**, **Low** reasoning, and a **5 minute** timeout. If the configured provider or model is unavailable, Forge shows a warning here so you can fix auth or pick a different model before automatic compaction needs it.

This pane does not choose Summary vs Fresh. That project default lives in **Project Settings → Context management**, with an optional session inherit/override beside Send. Compact and Smart compact still follow the effective policy: Summary keeps the current handoff/resume path, while Fresh uses a deterministic checkpoint and skips the Smart LLM handoff.

## Conversation Response Throughput

**Show response throughput in conversations** is off by default. Turn it on to show final Pi response throughput in manager headers, worker pills, and Worker Quick Look in Builder and Collaboration conversations. The rate uses provider-final output across the complete request duration. This browser setting applies immediately. Turning it off hides only those conversation controls: **Stats → Response throughput** continues collecting and showing historical response throughput.

## Prompt Cache Visualization

Use **Enable prompt cache visualization** to show a compact prompt-cache chip in manager chat headers for OpenAI/Codex Pi sessions. It is Builder-only and **off by default**.

When enabled, Forge captures provider-reported cached input token counts on eligible manager turns and summarizes hit, partial, and miss states in the header popover. While disabled, Forge does not collect new cache observations and hides the indicator. Observations from earlier enabled periods may appear after you turn this on and load session history.

Cached token counts come from the provider. OpenAI does not report specific miss or drop causes, and Forge does not infer them.

## Telemetry

Anonymous telemetry is enabled by default. It sends a random install identifier and report identifier; coarse environment metadata such as app and runtime versions, platform, architecture, Desktop status, and language; aggregate usage and feature-adoption counts; configured and used provider names; and the most-used catalog model ID. It does not send prompts or messages, code, file contents or paths, repository names, credentials, or secrets.

To opt out, set `FORGE_TELEMETRY=false` in your environment. There is no telemetry setting in the UI.

## Cortex consolidation

While Knowledge v2 is ON, the enabled daily Cortex schedule runs the consolidator over existing entries. It can merge duplicates, supersede conflicts, archive stale entries, and regenerate indexes, but it does not mine transcripts or create entries. Disable the schedule if you want to trigger consolidation manually from Cortex **Run**.

## New Cortex (Knowledge v2)

Knowledge v2 is a default-off preview. When ON, prompts receive compact global and active-profile `INDEX.md` files plus current session `memory.md`. Canonical profile `memory.md` continues to be maintained; legacy shared `common.md` is preserved during normal switching, but neither is prompt-injected. OFF restores legacy context while the originals remain. Explicit confirmed cleanup archives and removes those originals, so OFF alone cannot restore their prior content.

The switch does not migrate data. A successful guarded migration commits a valid manifest and immediately activates v2. If activation persistence fails, the manifest remains an authorized recovery point with v2 OFF; it also permits ordinary re-enable after a later disable. Without a valid manifest, Settings shows migration-required guidance and does not issue an enable request.

This mode switch is different from `FORGE_CORTEX_ENABLED=false`, which disables the entire Cortex subsystem.

## Welcome Preferences

Edit the default preferences Forge shares with new manager sessions. These are the onboarding choices you made on first launch (name, technical level, workflow style). Forge always updates the structured onboarding state. Changes apply to future manager sessions through the active mode's store: the managed legacy `common.md` block with v2 OFF, or global v2 preference entries with v2 ON.

## Collaboration

Open **Settings > Collaboration** to manage one or more server connections. Choose **Add connection**, enter the server URL, select **Test**, then select **Add**. Sign in to the saved connection with your collaboration account. The Builder/Collab switch opens that server's Collaboration channels; the separate per-connection **Remote projects** switch can show its normal Builder projects in the unified Builder sidebar.

Settings are contextual: Builder mode Settings continue to configure the local backend, while Collab mode Settings configure the selected collaboration backend. Collab Settings are admin-only, and provider auth entered there writes directly to the selected collaboration backend instead of copying or sharing the local Builder auth file.

Collab Settings also include members and invites, plus password management, all scoped to the selected backend connection. Admins can manage members and invites, issue temporary-password resets that require a password change, and users can change their own password. Creating an invite for an existing member or an email with an active pending invite is rejected and shows the server's error. Revoke the pending invite before creating a new one. If a collaboration session or socket gets invalidated by a lifecycle change, the public UI shows sign-in recovery instead of looping on reconnect or staying stuck on loading.

Collaboration channels are session-backed and can carry per-channel instructions and reference docs. Channel guidance is labeled **Additional instructions**.

The Collaboration status panel reflects the selected connection, not the local Builder backend. Terminal settings remain hidden for Collaboration channels. That is separate from Remote Projects: when the server operator allows remote Builder terminals, those PTYs run on the remote server host and follow its terminal policy.

See **Collaboration and Remote Projects** for connection states, automatic opt-in rules, data locality, and security boundaries.

## Observability

Open **Settings > Observability** to export Builder-only Forge traces to a local Arize Phoenix OTLP endpoint. That pane includes status, test export, capture toggles, and privacy controls.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.
