# Upstream Fixes/Features Analysis (non-runtime/model focus)

Prepared for upstream commit review against local `main` (`f8a13ee`) from merge-base `e3c29a9b0fc7ec525b2b71dcaacf9143b190301f`.

> Note: commit `cef0ce7` from the task list does not exist locally; matching commit by subject is `c0fefe7` ("Fix sidebar icon spacing: use consistent gap-0.5 for all icon pairs").

---

## 1) `3b16c4a` — Redirect deleted active agents to root

### Upstream diff summary
**Files changed (6):**
- `apps/ui/src/hooks/index-page/use-manager-actions.ts`
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/routes/-index.test.ts`
- `apps/ui/src/routes/index.tsx`

**What changed:**
- Removed immediate fallback-navigation logic from manager-delete action; relies on route/subscription reconciliation instead.
- Route parsing now tracks whether the user explicitly selected an agent (`hasExplicitAgentSelection`).
- WS client/state now tracks whether an `agents_snapshot` has been received (`hasReceivedAgentsSnapshot`).
- `IndexPage` route-sync effect was rewritten so that:
  - explicit, valid agent selections are honored,
  - explicit selections that disappear are redirected to default route only after an agents snapshot exists,
  - implicit root route remains clean (`/` without query params).
- Added tests verifying root URL cleanliness and query-param clearing when selected agent disappears.
- Improved `useOptionalNavigate()` fallback behavior in non-router contexts.

### Comparison with our fork
- We **still** have pre-fix behavior:
  - `use-manager-actions.ts`: active-manager delete path still manually picks fallback and navigates.
  - `use-route-state.ts`: no explicit-selection flag.
  - `ws-state.ts`: no `hasReceivedAgentsSnapshot`.
  - `index.tsx`: route reconciliation can leave stale `?agent=` when explicitly-selected agent disappears.
- This bug remains reproducible in our route-sync logic.

### Applicability
**Rating: APPLY**

Reasoning:
- Patch applies cleanly against current tree.
- Behavior is still missing in our fork.
- Low architectural risk (does not conflict with profiles/sessions model).

---

## 2) `cf74286` — Restyle worker execution detail rows

### Upstream diff summary
**Files changed (6):**
- `apps/ui/src/components/chat/MessageList.tsx`
- `apps/ui/src/components/chat/message-list/AgentMessageRow.tsx`
- `apps/ui/src/components/chat/message-list/ToolLogRow.tsx`
- `apps/ui/src/components/chat/message-list/types.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/styles.css`

**What changed:**
- Major visual/interaction redesign for tool execution rows:
  - parses serialized tool payloads,
  - tracks start/update/end times and durations,
  - supports richer summaries, shell-command previews, structured JSON fields,
  - adds copy buttons, raw payload modal, shimmer/pending styles.
- `MessageList` row spacing logic now adapts for worker-detail contexts.
- `AgentMessageRow` moved to lighter execution-scaffold styling.
- Added many new CSS variables/utilities (`--chat-exec-*`, code/text sizing, fade masks, motion rules).

### Comparison with our fork
- Our `MessageList`/`ToolLogRow`/`AgentMessageRow` are still the older UI.
- We have additional fork-specific behavior (message feedback plumbing) in `MessageList` that upstream patch does not account for.
- Our `styles.css` does not include any execution-row token additions.

### Applicability
**Rating: ADAPT**

Reasoning:
- Valuable UI polish, but large surface-area overlap with fork-specific UI features.
- Not a clean cherry-pick; requires manual merge to preserve feedback hooks and current behavior.

---

## 3) `80ee877` — Integrate react-grab in UI

### Upstream diff summary
**Files changed (5):**
- `apps/ui/package.json`
- `apps/ui/src/components/chat/MessageInput.tsx`
- `apps/ui/src/components/dev/ReactGrabBootstrap.tsx` (new)
- `apps/ui/src/routes/__root.tsx`
- `pnpm-lock.yaml`

**What changed:**
- Adds `react-grab` dependency.
- Adds DEV-only bootstrap component that dynamically imports react-grab and sets options.
- Mounts bootstrap in root route.
- Adds `data-react-grab-ignore` on message input form.

### Comparison with our fork
- No `react-grab` dependency or bootstrap component exists.
- Message input form has no ignore attribute.

### Applicability
**Rating: SKIP**

Reasoning:
- Dev tooling only; no user-facing bug fix.
- Adds dependency/lockfile churn with limited product value.

---

## 4) `9cdd416` — Fix manager bootstrap history to send transcript-only payloads

### Upstream diff summary
**Files changed (4):**
- `apps/backend/src/swarm/conversation-projector.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/test/ws-server.test.ts`

**What changed:**
- Added `ConversationProjector.getVisibleTranscript(agentId, limit)` (user-visible transcript only: `user_input` + `speak_to_user`).
- Added `SwarmManager.getVisibleTranscript(...)` passthrough.
- `WsHandler` bootstrap now uses transcript-only payload via `sendBootstrapConversationHistory(...)`.
- Added progressive payload-size fallback:
  - repeatedly halves history until event fits max WS payload,
  - emits `error` event `HISTORY_TRUNCATED` when truncation occurs.

### Comparison with our fork
- We currently bootstrap with full `getConversationHistory()` (no transcript filtering).
- No bootstrap payload byte guard/fallback exists.
- No `HISTORY_TRUNCATED` signaling.

### Applicability
**Rating: ADAPT**

Reasoning:
- **Safety logic is valuable** (payload truncation + signaling).
- **Transcript-only semantic change conflicts** with our existing All/Web and activity visibility behavior.
- Best path is selective port of safety mechanics, not direct semantics.

---

## 5) `c065381` — Add on-demand worker detail websocket subscription flow

### Upstream diff summary
**Files changed (8):**
- `apps/backend/src/ws/ws-command-parser.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/test/ws-server.test.ts`
- `packages/protocol/src/client-commands.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/lib/ws-client.test.ts`
- `apps/ui/src/hooks/index-page/use-visible-messages.ts`
- `apps/ui/src/routes/index.tsx`

**What changed:**
- New client commands: `subscribe_agent_detail` / `unsubscribe_agent_detail`.
- WS handler tracks secondary per-socket detail subscriptions.
- Secondary history bootstrap for detail stream with progressive truncation + `AGENT_DETAIL_HISTORY_TRUNCATED`.
- Broadcast paths now deliver conversation events to either primary or detail subscription target.
- UI client tracks desired detail agent and re-subscribes on reconnect.
- UI worker view effect subscribes/unsubscribes detail stream as active view changes.

### Comparison with our fork
- No protocol/parser/handler/client support for detail subscriptions.
- Our model still uses primary agent subscription switching for worker views.
- `use-visible-messages` still channel-toggle based; worker detail handling differs.

### Applicability
**Rating: REVIEW**

Reasoning:
- This is a real feature addition, but intent overlaps with our existing direct worker subscription behavior.
- Needs product/UX decision before porting to avoid redundant complexity.
- Some internals (progressive history fallback helper) are useful regardless.

---

## 6) `a1bc17c` — fix(ui): restore chat image previews from attachment file paths

### Upstream diff summary
**Files changed (6):**
- `apps/ui/src/components/chat/MessageList.tsx`
- `apps/ui/src/components/chat/message-list/ConversationMessageRow.tsx`
- `apps/ui/src/components/chat/message-list/MessageAttachments.tsx`
- `apps/ui/src/routes/index.tsx`
- plus 2 new tests:
  - `ConversationMessageRow.test.tsx`
  - `MessageAttachments.test.tsx`

**What changed:**
- Added `wsUrl` prop plumbing down to attachment renderer.
- `MessageAttachments` now resolves image source from either:
  - embedded base64 data, or
  - `GET /api/read-file?path=...` when only file path metadata exists.
- Better fallback to file-card rendering when no image source is available.

### Comparison with our fork
- Our attachments renderer still assumes inlined base64 (`data:` URI only).
- No `wsUrl` plumbed into message list/row attachment components.
- Metadata-only image previews still fail.

### Applicability
**Rating: ADAPT**

Reasoning:
- Good UX fix and likely needed if/when attachment metadata-only events are used.
- Requires manual merge with our feedback-enabled message list path.

---

## 7) `7d41d4f` — Fix bootstrap history limit to count visible messages

### Upstream diff summary
**Files changed (3):**
- `apps/backend/src/swarm/conversation-projector.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/test/ws-server.test.ts`

**What changed:**
- `getConversationHistory(limit)` changed from naive tail slicing to visible-message-aware cutoff:
  - counts only transcript entries (`conversation_message` from `user_input`/`speak_to_user`) toward limit,
  - preserves interleaved raw/tool events from that cutoff forward.
- Bootstrap history limit reset to 200 in ws handler.

### Comparison with our fork
- `ConversationProjector.getConversationHistory()` has no limit arg.
- WS bootstrap currently has no history limit constant at all.

### Applicability
**Rating: ADAPT**

Reasoning:
- Logic is useful if we enforce limits while retaining mixed event streams.
- Needs integration with our current bootstrap and UX model.

---

## 8) `36674ed` — Raise history bootstrap limit from 200 to 5000 entries

### Upstream diff summary
**Files changed (1):**
- `apps/backend/src/ws/ws-handler.ts`

**What changed:**
- Constant-only change: `BOOTSTRAP_HISTORY_LIMIT` 200 → 5000.

### Comparison with our fork
- We currently have no bootstrap limit constant in ws handler.
- This commit was later functionally superseded by `7d41d4f` + `9cdd416` changes.

### Applicability
**Rating: SKIP**

Reasoning:
- Standalone constant bump is obsolete in the final upstream sequence.

---

## 9) `e9966da` — Remove All toggle and unify manager chat transcript

### Upstream diff summary
**Files changed (4):**
- `apps/ui/src/components/chat/ChatHeader.tsx`
- `apps/ui/src/hooks/index-page/use-visible-messages.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/routes/-index.test.ts`

**What changed:**
- Removed Web/All channel toggle from header and route state.
- Manager view now intentionally shows transcript-only entries for manager-owned scope.
- Updated tests to assert transcript-focused behavior.

### Comparison with our fork
- We still expose Web/All toggle and related filtering logic.
- This is tied to our integrations/activity visibility behavior.

### Applicability
**Rating: REVIEW**

Reasoning:
- Large product decision, not just a bugfix.
- Could regress integration/operator workflows that depend on current All view.

---

## 10) `af758c2` — Fix UI typecheck for conversation attachment metadata

### Upstream diff summary
**Files changed (5):**
- `apps/ui/src/components/chat/message-list/MessageAttachments.tsx`
- `apps/ui/src/hooks/index-page/use-context-window.ts`
- tests in `AgentSidebar.test.ts`, `MarkdownMessage.test.ts`, `routes/-index.test.ts`

**What changed:**
- UI types moved from `ConversationAttachment` to metadata-capable `ConversationMessageAttachment` usage.
- Added defensive type narrowing for text attachments in token estimation.
- Test expectations adjusted for updated sidebar and markdown output.

### Comparison with our fork
- Our protocol still uses `ConversationAttachment` only; metadata union not present.
- Sidebar tests are already heavily diverged for multi-session UI.

### Applicability
**Rating: SKIP** (standalone)

Reasoning:
- Not needed unless we first port metadata attachment model from `ba646e5`.
- Treat as dependent follow-up, not independent backport.

---

## 11) `ba646e5` — Implement Phase 0 backend memory safety fixes

### Upstream diff summary
**Files changed (10):**
- Backend/runtime/core:
  - `apps/backend/src/swarm/codex-agent-runtime.ts`
  - `apps/backend/src/swarm/conversation-projector.ts`
  - `apps/backend/src/swarm/conversation-validators.ts`
  - `apps/backend/src/swarm/swarm-manager.ts`
  - `apps/backend/src/swarm/types.ts`
  - `apps/backend/src/ws/ws-handler.ts`
- Protocol:
  - `packages/protocol/src/attachments.ts`
  - `packages/protocol/src/server-events.ts`
- Tests:
  - `apps/backend/src/test/swarm-manager.test.ts`
  - `apps/backend/src/test/ws-server.test.ts`

**What changed (major buckets):**
1. **Tool event payload safety**
   - Codex runtime now emits compact/truncated tool summaries for start/end events.
2. **JSON serialization safety**
   - `safeJson` output truncation in projector (caps giant serialized payloads).
3. **Attachment memory reduction**
   - New attachment metadata type (`mimeType`, `filePath`, `sizeBytes`, etc.).
   - User conversation events store metadata instead of full payload blobs.
   - Attachments are persisted to disk as needed before runtime dispatch.
4. **WS transport safety**
   - Add WS event max-size and backpressure drop guards.
   - Add bootstrap history limit handling.

### Comparison with our fork
- We still emit/store full attachment data in conversation events.
- `safeJson` remains unbounded in projector and manager logs.
- WS send path has no max-event/backpressure checks.
- Protocol does not include attachment metadata union.
- Some lazy-loading/history handling pieces in our projector are already more advanced than old upstream baseline, but key safety pieces above are still missing.

### Applicability
**Rating: ADAPT**

Reasoning:
- High-value safety improvements.
- Very broad, cross-layer patch; direct cherry-pick is risky in our heavily diverged multi-session/profile codebase.
- Should be split and ported intentionally (especially WS guardrails + attachment metadata pipeline).

---

## 12) `56e6984` — Clean up manager schedule file on deleteManager

### Upstream diff summary
**Files changed (3):**
- `apps/backend/src/swarm/persistence-service.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/test/swarm-manager.test.ts`

**What changed:**
- Added persistence helper to delete manager schedule file (`ENOENT`-safe).
- Wired delete into manager deletion flow.
- Added regression test.

### Comparison with our fork
- Our `deleteManager(...)` removes descriptors/profile but does **not** remove profile schedule file.
- Persistence service has no schedule cleanup method.

### Applicability
**Rating: ADAPT**

Reasoning:
- Still relevant bug in our fork.
- Must adapt to profile/session semantics (delete by `profileId`, not blindly by a session agent id).

---

## 13) `c0fefe7` (task listed `cef0ce7`) — Fix sidebar icon spacing

### Upstream diff summary
**Files changed (1):**
- `apps/ui/src/components/chat/AgentSidebar.tsx`

**What changed:**
- Claude icon pair switched from overlap spacing to consistent `gap-0.5`.

### Comparison with our fork
- Our `RuntimeIcon` icon-pair renderers already use `gap-0.5` consistently.

### Applicability
**Rating: SKIP**

Reasoning:
- Already effectively present.

---

## 14) `699a514` — Fix agent sidebar runtime badge width alignment

### Upstream diff summary
**Files changed (1):**
- `apps/ui/src/components/chat/AgentSidebar.tsx`

**What changed:**
- Runtime badge width changed from flexible `min-w-7` to fixed `w-8` for alignment consistency.

### Comparison with our fork
- Our `RuntimeBadge` still uses `min-w-7`.

### Applicability
**Rating: ADAPT**

Reasoning:
- Minor but valid polish.
- One-line manual port in diverged sidebar.

---

## 15) `e467abb` — Landing page design/UX polish pass

### Upstream diff summary
**Files changed (3):**
- `apps/site/src/routes/__root.tsx`
- `apps/site/src/routes/index.tsx`
- `apps/site/src/styles.css`

**What changed:**
- Accessibility/semantics sweep:
  - skip link,
  - `<main>` landmark,
  - section labeling/heading hierarchy,
  - semantic lists/articles/dl usage,
  - aria labels and reduced-motion support.
- Visual/content polish:
  - contrast tweaks,
  - focus-visible ring styles,
  - typography and CTA polish,
  - mobile/tap/anchor behavior improvements.

### Comparison with our fork
- Our site is still pre-polish version.
- No skip link, reduced-motion override, or focus token system in site CSS.

### Applicability
**Rating: APPLY**

Reasoning:
- Patch applies cleanly.
- Isolated to `apps/site` and low risk to core app/runtime behavior.

---

# Cross-commit risk assessment (multi-session / profiles / integrations)

## Highest conflict risk
1. **`e9966da` (remove All toggle/transcript unification)**
   - Directly changes chat information model; likely impacts integrations and operator workflows.
2. **`9cdd416` + `7d41d4f` semantics if applied literally**
   - Transcript-only bootstrap can drop historical activity visibility unless UI model is also changed.
3. **`ba646e5` full port**
   - Cross-layer protocol/type/storage changes; must be staged carefully in our diverged architecture.

## Moderate conflict risk
4. **`c065381` detail subscriptions**
   - Adds additional WS subscription model; needs validation against current direct worker-subscription flow.
5. **`56e6984` schedule cleanup**
   - Important, but must be profile-aware in session-based manager model.
6. **`cf74286` tool-row redesign**
   - Heavy UI merge surface with existing feedback/message rendering customizations.

## Low conflict risk
7. **`3b16c4a` route cleanup**
8. **`699a514` badge width**
9. **`e467abb` site polish**
10. **`c0fefe7` (already present), `36674ed` (obsolete), `80ee877` (optional dev tool)**

---

# Recommended priority order

## P0 / immediate value
1. **`3b16c4a` (APPLY)** — fixes stale/invalid agent-route behavior after deletions.
2. **Adapt `56e6984`** — ensure profile schedule file cleanup on manager/profile delete.
3. **Selective safety backport from `ba646e5` + `9cdd416`/`7d41d4f`**:
   - WS event size/backpressure guards,
   - bootstrap payload truncation with explicit error signaling,
   - bounded JSON serialization for tool payload text.

## P1 / next
4. **Adapt `a1bc17c`** (and metadata-compatible UI pieces as needed) — restore previews when only `filePath` is available.
5. **`699a514` polish** — quick sidebar alignment fix.

## P2 / optional / product-decision
6. **`e467abb` (APPLY)** — isolated site UX improvements.
7. **`cf74286` (ADAPT)** — execution row visual redesign.
8. **`c065381` + `e9966da`** — only after explicit product decision on transcript model and worker-detail UX.
9. **Skip**: `36674ed` (superseded), `c0fefe7` (already present), `80ee877` (optional dev tooling), `af758c2` standalone (dependency-only with metadata model).
