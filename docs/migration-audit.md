# Migration and Backwards Compatibility Audit

Date: 2026-02-25

> **Note (2026-03-03):** The data directory restructure has been merged. A one-time boot migration (`apps/backend/src/swarm/data-migration.ts`) now transforms the old flat layout to a hierarchical profile-scoped layout, gated by a `.migration-v1-done` sentinel. This supersedes the individual file-presence migrations described in items 3, 4, and 7 below — those migration paths still exist in the codebase as fallbacks but the v1 migration handles the bulk transformation.

## Scope and method
- Searched `apps/backend/src/` and `apps/ui/src/` for migration/compatibility patterns (`migrate`, `legacy`, `compat`, `deprecated`, `alias`, `fallback`, `old`).
- Reviewed all high-signal hits in scheduler, integrations, swarm manager/store/session handling, and WS HTTP routes.
- Used `git blame` on each confirmed item to capture when it was added.

## Findings

### 1) Legacy Pi auth file migration
- Location: `apps/backend/src/config.ts:38-40`, `apps/backend/src/config.ts:126-142`
- From -> To: copies legacy Pi auth file `~/.pi/agent/auth.json` into Middleman auth file `<dataDir>/auth/auth.json` when default auth path is used.
- Added: `2847382` (2026-02-20)
- Lifecycle: one-time opportunistic migration (runs on boot, no marker file; guarded by file existence).
- Risk of removal: existing local users who only have legacy Pi auth would stop auto-migrating and would need to re-authenticate or manually copy credentials.

### 2) Legacy default manager ID path fallback in config (removed)
- Location: removed from `apps/backend/src/config.ts` in `remove-env-knobs`.
- From -> To: config no longer accepts an env-driven default manager ID and no longer pre-resolves manager-scoped memory/schedules paths in base config.
- Added: `2f01b96` (2026-02-24), removed in `remove-env-knobs` (2026-02-26)
- Lifecycle: retired compatibility shim.
- Risk of removal: installs relying on a forced single-manager ID now rely on discovered manager IDs.

### 3) Schedule storage migration (global -> manager-scoped)
- Location: `apps/backend/src/scheduler/schedule-storage.ts:7-9`, `apps/backend/src/scheduler/schedule-storage.ts:28-33`, `apps/backend/src/scheduler/schedule-storage.ts:72-105`, `apps/backend/src/index.ts:23-26`
- From -> To: migrates `<dataDir>/schedules.json` to `<dataDir>/schedules/<managerId>.json`; writes marker `<dataDir>/schedules/.migrated`.
- Added: `659e8ef` (2026-02-20), fallback manager handling updated in `2f01b96` (2026-02-24)
- Lifecycle: one-time file migration gated by marker and destination existence checks.
- Risk of removal: legacy schedule files would not be picked up; scheduled jobs silently disappear until manually moved.

### 4) Integration config migration (global -> manager-scoped)
- Location: `apps/backend/src/integrations/registry.ts:68`, `apps/backend/src/integrations/registry.ts:337-381`, `apps/backend/src/integrations/slack/slack-config.ts:12-24`, `apps/backend/src/integrations/telegram/telegram-config.ts:20-31`
- From -> To: migrates legacy global config files `<dataDir>/integrations/slack.json` and `<dataDir>/integrations/telegram.json` into manager profiles at `<dataDir>/integrations/managers/<managerId>/...`; writes `<dataDir>/integrations/.migrated`.
- Added: `11013a9` (2026-02-20), default manager fallback updated in `2f01b96` (2026-02-24)
- Lifecycle: one-time migration gated by marker and existing manager-scoped profiles.
- Risk of removal: old integration configs are ignored; Slack/Telegram appear unconfigured until manual migration.

### 5) Integration config manager ID fallback to legacy `"manager"`
- Location: `apps/backend/src/integrations/slack/slack-config.ts:275-278`, `apps/backend/src/integrations/telegram/telegram-config.ts:284-287`
- From -> To: blank manager IDs normalize to `"manager"` when building integration profile IDs/paths.
- Added: `11013a9` (2026-02-20)
- Lifecycle: ongoing compatibility shim.
- Risk of removal: bad/blank manager IDs may throw or resolve to missing paths instead of legacy default behavior.

### 6) Backward-tolerant integration config shape parsing
- Location: `apps/backend/src/integrations/slack/slack-config.ts:94-131`, `apps/backend/src/integrations/slack/slack-config.ts:232-251`, `apps/backend/src/integrations/telegram/telegram-config.ts:102-148`, `apps/backend/src/integrations/telegram/telegram-config.ts:206-217`, `apps/backend/src/integrations/telegram/telegram-config.ts:241-260`
- From -> To: older/partial config JSON is merged onto defaults; masked token placeholders are treated as "keep existing secret"; Telegram user IDs allow legacy numeric values and normalize to strings.
- Added: Slack `1586973` (2026-02-20), Telegram `6fd0227` (2026-02-20), Telegram numeric user ID normalization in `3bc55ca` (2026-02-20)
- Lifecycle: ongoing compatibility behavior.
- Risk of removal: older config files may lose settings, masked token updates may accidentally clear secrets, and some Telegram configs may fail normalization.

### 7) Memory file migration (global -> per-agent/per-manager)
- Location: `apps/backend/src/swarm/memory-paths.ts:3-20`, `apps/backend/src/swarm/swarm-manager.ts:2688-2749`
- From -> To: migrates legacy `<dataDir>/MEMORY.md` into manager memory files `<dataDir>/memory/<managerId>.md`; writes `<dataDir>/memory/.migrated`.
- Added: `3df8df5` (2026-02-23); manager-ID collection/fallback interaction updated in `2f01b96` (2026-02-24)
- Lifecycle: one-time migration gated by marker and existing `.md` files in memory dir.
- Risk of removal: legacy memory content will no longer be imported into manager-scoped memory.

### 8) Persisted descriptor normalization/backfill on boot
- Location: `apps/backend/src/swarm/swarm-manager.ts:1458-1567`
- From -> To: normalizes old/partial `agents.json` descriptors (session file path, missing cwd/model/context usage, manager self-ownership, worker `managerId` backfill, status normalization).
- Added: core behavior in `32dc88f` (2026-02-17), additional manager-ID strictness in `2f01b96` (2026-02-24), context usage normalization in `b86a9f0` (2026-02-25)
- Lifecycle: ongoing compatibility shim every boot.
- Risk of removal: previously persisted descriptors can become invalid (orphan workers, stale statuses, broken ownership/session paths).

### 9) Legacy conversation session entry type support
- Location: `apps/backend/src/swarm/swarm-manager.ts:124-125`, `apps/backend/src/swarm/swarm-manager.ts:2834-2837`
- From -> To: accepts both legacy custom type `"swarm_conversation_message"` and current `"swarm_conversation_entry"` when loading session history.
- Added: `26eba57` (2026-02-13)
- Lifecycle: ongoing compatibility shim.
- Risk of removal: older session files would stop hydrating conversation history.

### 10) Legacy schedules HTTP route alias
- Location: `apps/backend/src/ws/server.ts:32-33`, `apps/backend/src/ws/server.ts:299-314`, `apps/backend/src/ws/server.ts:2611-2630`, `apps/backend/src/ws/server.ts:1863-1871`
- From -> To: legacy route `/api/schedules` maps to manager route `/api/managers/:managerId/schedules` via resolved default manager.
- Added: manager-scoped schedule routing `659e8ef` (2026-02-20), stricter manager resolution in `2f01b96` (2026-02-24)
- Lifecycle: ongoing API compatibility shim.
- Risk of removal: older callers hitting `/api/schedules` break immediately.

### 11) Legacy Slack/Telegram HTTP route aliases (including old settings paths)
- Location: `apps/backend/src/ws/server.ts:38-55`, `apps/backend/src/ws/server.ts:1169-1175`, `apps/backend/src/ws/server.ts:1254-1260`, `apps/backend/src/ws/server.ts:2570-2744`
- From -> To: legacy routes (`/api/integrations/slack*`, `/api/integrations/telegram*`, `/api/settings/slack*`, `/api/settings/telegram*`) map to manager-scoped routes `/api/managers/:managerId/integrations/...`.
- Added: manager-scoped integration routing `11013a9` (2026-02-20), legacy-path/default-manager handling tightened in `2f01b96` (2026-02-24)
- Lifecycle: ongoing API compatibility shim.
- Risk of removal: pre-manager-scoped clients/scripts fail against integration APIs.

### 12) Legacy Slack channels query parameter alias
- Location: `apps/backend/src/ws/server.ts:1217-1219`
- From -> To: accepts `includePrivate` as alias for newer `includePrivateChannels` query parameter.
- Added: `1586973` (2026-02-20)
- Lifecycle: ongoing compatibility shim.
- Risk of removal: old callers using `includePrivate` lose expected behavior for private channel inclusion.

### 13) Settings auth provider aliases (OpenAI naming compatibility)
- Location: `apps/backend/src/ws/server.ts:119-123`, `apps/backend/src/ws/server.ts:2759-2766`, `apps/backend/src/swarm/swarm-manager.ts:220-234`, `apps/backend/src/swarm/swarm-manager.ts:2914-2921`
- From -> To: maps provider aliases (`openai`, `openai-codex`) to canonical storage/provider IDs used by auth flows.
- Added: WS login alias mapping `0648b71` (2026-02-20); settings provider alias definitions `2847382` (2026-02-20)
- Lifecycle: ongoing alias compatibility.
- Risk of removal: existing settings/auth interactions using alternate provider names may fail lookup or break login flow.

### 14) Model preset alias mapping (backend)
- Location: `apps/backend/src/swarm/model-presets.ts:27-29`, `apps/backend/src/swarm/model-presets.ts:73-79`
- From -> To: maps older model IDs (`claude-opus-4.6`, `codex-app`, `codex-app-server`) to canonical presets (`pi-opus`, `codex-app`).
- Added: initial alias logic `8f14cd2` (2026-02-17), codex-app aliases in `9c0e2b6` (2026-02-20)
- Lifecycle: ongoing compatibility shim.
- Risk of removal: saved descriptors using older model IDs may no longer infer presets correctly.

### 15) Model preset alias mapping duplicated in UI
- Location: `apps/ui/src/routes/index.tsx:51-52`, `apps/ui/src/routes/index.tsx:178-183`, `apps/ui/src/components/chat/AgentSidebar.tsx:40-56`
- From -> To: mirrors backend alias logic so UI can infer/display current presets for legacy model ID strings.
- Added: sidebar mapping `8da8d4a` (2026-02-20), route mapping `075e234` (2026-02-21)
- Lifecycle: ongoing UI compatibility shim.
- Risk of removal: UI may display "unknown" model context for agents persisted with legacy model IDs.

### 16) UI fallback for legacy default manager ID
- Location: `apps/ui/src/lib/agent-hierarchy.ts:19-20`
- From -> To: fallback target selection prefers manager ID `"manager"` when present.
- Added: `d6b9d2c` (2026-02-17)
- Lifecycle: ongoing UI compatibility behavior.
- Risk of removal: fallback selection changes for installations still using legacy default manager naming.

### 17) Non-data compatibility shims

#### 17a) Browser API compatibility for theme auto mode
- Location: `apps/ui/src/lib/theme.ts:78-97`
- From -> To: uses modern `matchMedia.addEventListener` when available, otherwise deprecated `addListener/removeListener` fallback.
- Added: `7835905` (2026-02-20)
- Lifecycle: ongoing compatibility shim.
- Risk of removal: older browser/webview environments may stop reacting to system theme changes.

#### 17b) `cron-parser` API/return-shape compatibility
- Location: `apps/backend/src/scheduler/cron-scheduler-service.ts:487-507`, `apps/backend/src/scheduler/cron-scheduler-service.ts:512-535`
- From -> To: supports multiple `cron-parser` parse entry points and `next()` return formats (`Date`, `toDate()`, `toISOString()`).
- Added: `e831cf2` (2026-02-20)
- Lifecycle: ongoing dependency-compatibility shim.
- Risk of removal: scheduler can break depending on installed `cron-parser` version/API shape.

## Schema versioning check
- No explicit schema/version fields were found that drive migration branches in persisted Middleman data files (agents store, schedules, integration configs, memory, sessions).
- Migrations are currently file-presence and marker-based (`.migrated`) rather than version-number based.

## High-risk removals (if done before public release)
- Removing any one-time file migrations (items 1, 3, 4, 7) without a one-off cleanup script will strand legacy local data.
- Removing descriptor/session normalization (items 8, 9) can break existing local dev stores and chat history hydration.
- Removing legacy HTTP route aliases (items 10, 11, 12) can break older clients/tests/scripts immediately.
