# Upstream Review — Consolidated Summary & Proposed Next Steps

**Date:** 2026-03-06  
**Merge base:** `e3c29a9` | **Upstream commits not in fork:** 43 (24 non-merge)  
**Upstream:** `SawyerHood/middleman` → **Fork:** `radopsai/middleman`

---

## TL;DR

43 upstream commits spanning model upgrades, bug fixes, safety hardening, and new features. After detailed analysis against our diverged codebase, here's the breakdown:

| Category | Commits | Verdict |
|---|---|---|
| **GPT-5.4 model migration** | 3 | ✅ Port (adapt for our presets/tests) |
| **SDK/dependency bumps** | 2 | ✅ Port (prerequisite for 5.4) |
| **Safety & stability fixes** | 5 | ✅ Port selectively (high value) |
| **UI polish & bug fixes** | 5 | ✅ Port (mix of clean apply + adapt) |
| **Claude Code runtime** | 5 | ⏳ Defer (major integration project) |
| **Product decisions needed** | 2 | 🔍 Review before deciding |
| **Skip** | 4 | ⏭️ Already have, superseded, or low value |

---

## Phase 1: GPT-5.4 Migration (HIGH PRIORITY)

The #1 ask. Three commits form the upgrade chain:

### Step 1 — SDK bump (`f237a7a`)
- `@mariozechner/pi-ai`: `0.55.0` → `0.56.0`
- `@mariozechner/pi-coding-agent`: `0.55.0` → `0.56.0`
- **Critical:** OAuth imports migrate from deep `dist/utils/oauth/...` paths to `@mariozechner/pi-ai/oauth`
- Our settings routes + tests still use the old deep imports — must update
- Lockfile transitive: `openai` bumps from `6.10.0` → `6.26.0`

### Step 2 — Codex-app preset to 5.4 (`f0c0cd7`)
- `codex-app` canonical model ID: `default` → `gpt-5.4`
- Adds legacy compatibility: infer still accepts `default` for existing persisted descriptors
- Test expectations update across multiple suites

### Step 3 — Pi-codex preset to 5.4 (`5b79730`)
- `pi-codex` canonical model ID: `gpt-5.3-codex` → `gpt-5.4`
- SDKs bump again to `0.56.2`
- Legacy compat: infer still accepts `gpt-5.3-codex`
- Constants introduced: `PI_CODEX_MODEL_ID`, `LEGACY_PI_CODEX_MODEL_ID`, etc.

**Adaptation needed:** Our model-presets.ts has fork-specific extensions (`parseSwarmReasoningLevel`, etc.) and our test suite is diverged. Not a clean cherry-pick, but the logic is straightforward to port.

---

## Phase 2: Safety & Stability Fixes (HIGH VALUE)

### `ba646e5` — Backend memory safety (Phase 0) → **ADAPT**
Broad, high-value safety patch:
- **WS transport guards:** Max event size + backpressure drop (we have neither)
- **JSON serialization bounds:** `safeJson` truncation for giant tool payloads
- **Attachment metadata:** Store metadata instead of full blobs in conversation events
- **Tool event compaction:** Compact/truncated summaries for start/end events

⚠️ Very broad cross-layer change. Recommend splitting into sub-pieces:
1. WS size/backpressure guards (independent, high value)
2. `safeJson` bounded serialization (independent, high value)  
3. Attachment metadata pipeline (larger, ties into protocol types)

### `9cdd416` — Bootstrap history transcript-only + payload fallback → **ADAPT**
- Progressive payload-size fallback (halves history until it fits)
- `HISTORY_TRUNCATED` error signaling
- **Port the safety mechanics, not the transcript-only semantic** (conflicts with our All/Web visibility model)

### `7d41d4f` — Visible-message-aware history limits → **ADAPT**
- History limit counts only visible messages, preserves interleaved tool events
- Useful if we enforce bootstrap limits

### `56e6984` — Schedule file cleanup on manager delete → **ADAPT**
- Our deleteManager doesn't clean up schedule files (confirmed bug)
- Must adapt to profile-scoped paths

### `b5f2099` — list_agents compact output + includeTerminated → **ADAPT**
- Returns compact entries: `{agentId, role, managerId, status, model}` instead of full descriptors
- Adds `includeTerminated` opt-in (default: active only)
- **Known issue in our fork** — verbose list_agents is documented as a context-blowup risk
- Must preserve our session-scoping filter while adding compact output

---

## Phase 3: UI & Bug Fixes (MEDIUM PRIORITY)

### `3b16c4a` — Redirect deleted agents to root → **APPLY** ✅
- Fixes stale `?agent=` URLs after deletion
- Adds `hasExplicitAgentSelection` + `hasReceivedAgentsSnapshot` tracking
- Clean apply likely possible — low architectural risk

### `a1bc17c` — Restore chat image previews from file paths → **ADAPT**
- Resolves images via `GET /api/read-file?path=...` when only metadata exists
- Our attachment renderer still assumes base64 only
- Requires `wsUrl` prop plumbing through message list

### `699a514` — Sidebar badge width alignment → **ADAPT**
- One-line fix: `min-w-7` → `w-8`
- Trivial manual port

### `cf74286` — Worker execution detail row restyle → **ADAPT**
- Major visual redesign for tool rows (durations, previews, copy buttons, shimmer)
- Large merge surface with our feedback-enabled message list
- Nice-to-have, not urgent

### `e467abb` — Landing page polish → **APPLY** ✅
- Accessibility sweep (skip links, landmarks, aria, reduced-motion)
- Isolated to `apps/site` — zero risk to core app

---

## Phase 4: Claude Code Runtime (DEFERRED — Major Project)

Five commits introduce a complete Claude Code runtime:
1. `3f34b1a` — Base runtime (~1088 LOC) + MCP tool bridge + preset/protocol/UI wiring
2. `66af36e` — Stream/stop/replay lifecycle hardening
3. `c3e9603` — Tool completion signal fix + sidebar icon
4. `9c07f85` — Full tool lifecycle completeness + dedupe
5. `5b209f9` — Custom entry persistence fix (also has codex-side value)

**Why defer:** Our runtime factory, manager, and tool infrastructure are heavily diverged (session-file guards, Cortex tool filtering, profile/session architecture). This is a standalone integration workstream, not a cherry-pick.

**Exception:** The codex portion of `5b209f9` (custom entry persistence) is independently valuable and can be ported with Phase 2 work.

---

## Phase 5: Product Decisions Needed (REVIEW)

### `c065381` — Worker detail WebSocket subscription flow
- New `subscribe_agent_detail` / `unsubscribe_agent_detail` commands
- Overlaps with our existing direct worker subscription behavior
- **Decision needed:** Is the dual-subscription model better than our current approach?

### `e9966da` — Remove All toggle, unify transcript view
- Removes Web/All channel toggle entirely
- Could regress integration/operator workflows that use All view
- **Decision needed:** Do we want to keep the All toggle?

---

## Skip List

| Commit | Why |
|---|---|
| `80ee877` react-grab | Dev tooling only, no product value |
| `36674ed` raise limit to 5000 | Superseded by later visible-count logic |
| `af758c2` attachment typecheck | Dependent on metadata model, not standalone |
| `c0fefe7` sidebar icon spacing | Already effectively present in our fork |

---

## Proposed Execution Plan

### Wave 1 — GPT-5.4 + Quick Wins (1 worktree branch)
1. SDK bump (`f237a7a` adapted)
2. Codex-app 5.4 preset (`f0c0cd7` adapted)
3. Pi-codex 5.4 preset (`5b79730` adapted)
4. Agent route redirect fix (`3b16c4a` — likely clean apply)
5. Landing page polish (`e467abb` — clean apply)
6. Sidebar badge width (`699a514`)

### Wave 2 — Safety Hardening (1 worktree branch)
1. WS event size guards + backpressure (from `ba646e5`)
2. `safeJson` bounded serialization (from `ba646e5`)
3. Bootstrap payload fallback + truncation signaling (from `9cdd416`)
4. `list_agents` compact output + `includeTerminated` (from `b5f2099`)
5. Schedule file cleanup on delete (`56e6984`)

### Wave 3 — UI Improvements (1 worktree branch)
1. Image preview from file paths (`a1bc17c`)
2. Visible-message-aware history limits (`7d41d4f`)
3. Worker execution row restyle (`cf74286`) — if desired
4. Codex custom entry persistence (`5b209f9` codex portion)

### Wave 4 — Future / Separate Tracks
- Claude Code runtime integration (own project, own timeline)
- Product decisions on All toggle removal + worker detail subscriptions
