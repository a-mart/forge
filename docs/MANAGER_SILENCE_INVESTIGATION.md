# Manager Silence Investigation — Worker Callbacks Without User Updates

**Date:** 2026-06-10
**Status:** Root cause identified; recommendations pending decision
**Primary evidence:** `~/.forge/profiles/rapa-teams-gateway/sessions/mammo-sch` (gpt-5.5 manager), cross-session scan of all profiles, git history

---

## 1. Summary

The "manager goes silent after a worker reports back" behavior is **a model-behavior failure that the product currently has zero defense against**, made worse by a recent regression:

1. **Trigger (model behavior):** When a worker's final report is injected into the manager as a `SYSTEM: status: ...` message, gpt-5.5 ends its turn with a literally empty response — a whitespace-only `commentary` block, an empty `final_answer`, no tool calls, `stopReason: "stop"`, ~12 output tokens — instead of calling `speak_to_user`. Measured across all sessions on this machine: **gpt-5.5 does this after ~18% of worker callbacks; gpt-5.4 ~10%; claude-opus-4-6 ~2%; gpt-5.3-codex 0%**. This has been happening since at least early April; it is not new.
2. **Onset (model migration):** The behavior arrived with gpt-5.5 manager adoption. Weekly time series across all sessions: Claude-managed sessions (through early May) sat at 0–3%; gpt-5.5 shows 10% in its first week of use (W17, week of Apr 20) climbing to 15–22% by early May as it displaced Claude as the manager model. This matches the perception that it was "very rare" before roughly the v0.19.0-beta.1 era (May 18) — the ramp (late April → early May) slightly precedes the beta and tracks the model switch, not the release itself.
3. **Failed countermeasure (June 3–8):** The `manager-noop-guard` was a short-lived fix attempt for this exact issue — added June 3 (`418760d6`), parked June 8 (`df48b165`, "Park Active Work and callback recovery fixes for testing"). It fired 16 times in real sessions during those 5 days; **7 of 16 recovery nudges were ignored — the manager emitted another empty turn even after being explicitly told to respond** (including 5 consecutive failures in `middleman-project/work-stop-patch-review` on June 8). The guard's mechanism — sending the silent model another `SYSTEM:`-prefixed plea — was unreliable by design, and parking it was a defensible call. Since June 8 there is no countermeasure at all.
4. **Invisibility (design gap):** A silent manager turn leaves no trace anywhere a human or the product looks: plain/empty assistant output is not rendered to the user (by design), is not projected into `session.conversation.jsonl`, produces no log line, no UI state, no metric. The only artifact is an empty `message` record in raw `session.jsonl`. The product cannot distinguish "manager correctly chose silence" from "manager dropped a terminal result on the floor."
5. **Prompt contradiction (contributing):** The manager prompt simultaneously mandates updates on completion ("You MUST send a user-facing update if the running workers have completed...") and legitimizes silence ("When no response is appropriate, make no user-facing tool call", a worked example whose expected behavior is "No user-facing tool call", "Messages prefixed `SYSTEM:` are internal context, not direct user requests"). Prompt-only fixes (June 9, `4667f1e9`) measurably did not solve it: three more incidents occurred June 10 *after* that wording was live, including two after the user escalated and after thinking level was raised to high.

**Answer to "technical issue or model behavior?": both, in layers.** The proximate cause of each silence is the model emitting an empty turn, and the regression timeline tracks the gpt-5.5 manager migration (late April), not a code change. But it persists as a user-facing outage because nothing structural guarantees terminal worker results reach the user — the one countermeasure tried (June 3–8 no-op guard) relied on re-prompting the same model and failed ~44% of the time it fired.

---

## 2. Evidence Base

- Session logs: `~/.forge/profiles/rapa-teams-gateway/sessions/mammo-sch/` (`session.jsonl` 18.5 MB, `session.conversation.jsonl` 12.4 MB, `meta.json` incl. fully resolved system prompt, `workers/`)
- Cross-session scan: every `~/.forge/profiles/*/sessions/*/session.jsonl` (all profiles, March–June 2026)
- Code: this repo at `main` (`5cd7901e`), which is also what the daemon runs (`tsx apps/backend/src/index.ts` from the working tree)
- Git history: `418760d6`, `d23a62fd`, `8dac1c50`, `2d8301ec`, `df48b165`, `4667f1e9`

All timestamps below are UTC; the session UI displays local time (UTC-5).

---

## 3. Product Orientation (what matters for this bug)

Forge is a pnpm monorepo: `apps/backend` (Node daemon: HTTP + WebSocket), `apps/ui` (React SPA), `apps/electron` (desktop shell), `packages/protocol` (shared event/command types), `packages/cli`. The orchestration core is `apps/backend/src/swarm/`, with `SwarmManager` (`swarm-manager.ts`, ~8.5k lines) as facade over extracted services (lifecycle, runtime controller, prompt, session, worker health, etc. — see `apps/backend/src/swarm/AGENTS.md`).

Three runtime families exist (`runtime/runtime-factory.ts`): Claude SDK, Cursor SDK, and Pi (default; hosts OpenAI Codex models via the Responses API, `runtimeKind: "pi"`). The affected session runs `openai-codex/gpt-5.5` on the Pi runtime.

### 3.1 The only path to the user

The manager is the only user-facing agent, and the **only** mechanisms that render in the user's chat are:

- `speak_to_user` tool → `host.publishToUser()` (`swarm-manager.ts:5096–5145`) → `ConversationMessageEvent` with `source: "speak_to_user"` → appended to `session.jsonl`/`session.conversation.jsonl` and broadcast over WebSocket.
- `present_choices` (structured choice UI).

Plain assistant text is intentionally **not** rendered (manager prompt: "Plain assistant text … not directly visible to end users"). Consequence: a manager turn that ends with only text — or with *nothing* — is invisible. There is no fallback rendering, no log, no event.

### 3.2 Worker → manager callback path

1. Worker finishes and calls `send_message_to_agent` targeting the manager (tool result: "Queued message for mammo-sch…").
2. `SwarmManager.sendMessage()` (~`swarm-manager.ts:4761`) → `prepareModelInboundMessage()` (~`:4965`) prefixes non-user-origin text with `INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: "` (`swarm-manager.ts:516`, applied at `:4974`).
3. The message is delivered to the manager runtime as a **user-role message** (`runtime.sendMessage(...)`, ~`:4926`), which triggers a normal manager turn.
4. Whatever the manager does with it is entirely up to the model. On turn end (`runtime-event-projector.ts:267–269` logs `turn_end`), **no code checks whether the turn produced any user-visible action.**

So the full contract "terminal worker result → user finds out" hangs on one LLM choosing to call one tool.

---

## 4. Incident Forensics (Mammo Sch session)

### Incident A — June 9, overnight silence

| UTC | Event |
|---|---|
| 21:01:05 | Manager `speak_to_user`: "Proceeding with the single guarded live pilot now. I'll stop on any blocker … and report the exact outcome." |
| 21:01:25 | `spawn_agent` → `mammo-live-graph-execute` |
| 21:06:06 | Worker final callback injected: `SYSTEM: status: done summary: Executed the approved guarded live Graph pilot …` (containing the 403 Forbidden outcome) |
| **21:06:12** | **Manager turn: empty text, no tool calls. Turn ends.** |
| — | ~16 hours of silence |
| 12:59 (next day) | User: "update?" → manager immediately produces a perfect summary of the 403 |

### Incident B — June 10, the 8:08 AM case (screenshots)

| UTC | Event |
|---|---|
| 13:02:44 | Manager `speak_to_user`: "Great. I'll verify the permission … I'll report immediately …" |
| 13:03:03 | `spawn_agent` → `mammo-permission-rerun` |
| 13:08:39 | Worker final callback injected: `SYSTEM: status: blocked summary: … ClientConnectorCertificateError …` |
| **13:08:48** | **Manager turn: empty. Raw record below.** |
| 13:54:39 | User: "you still aren't giving updates!" → manager immediately summarizes correctly |

The raw assistant message for the 13:08:48 turn (`session.jsonl` record id `3f3e32be`):

```json
"content": [
  {"type":"text","text":" ","textSignature":"{...\"phase\":\"commentary\"}"},
  {"type":"text","text":"","textSignature":"{...\"phase\":\"final_answer\"}"}
],
"stopReason": "stop",
"usage": {"input":1720,"output":12,"cacheRead":161280}
```

The model received the callback, spent 12 output tokens, deliberately produced an empty final answer, and stopped. In `session.conversation.jsonl` (what the UI renders) this turn **does not exist at all** — the projection ends with "Queued message for mammo-sch" and resumes 46 minutes later with the user's complaint.

### It kept happening after the complaints

Same morning, after the user escalated *and* after thinking level was raised medium→high at 13:55 (`swarm_model_change_continuity_request`, same model):

- 14:17:35 callback (`status: done` — the guarded rerun result) → **empty turn at 14:17:44**
- 14:25:39 callback (`status: done` — "Added Jeff as optional…") → **empty turn at 14:25:44**

Neither was ever relayed.

### Census of all 61 injected `SYSTEM:` messages in this session

Of the *final* worker reports (`SYSTEM: status: ...`) on June 9–10 (~33), **7 ended in a fully empty manager turn** — every silence the user experienced, plus ones not yet noticed (June 9 15:26, 16:52, 19:39). When the manager *did* respond, it responded well (speak_to_user, spawn chains, present_choices). The failure is all-or-nothing per turn, ~20% of the time, and is *not* correlated with callback content quality (both `done` and `blocked` reports were dropped).

---

## 5. Quantitative Analysis (all profiles, March–June)

Heuristic: user-role message starting with `SYSTEM: status:` / `SYSTEM: [workerCallback]` / `SYSTEM: Worker`, where the immediately following assistant message has no tool calls and no non-whitespace text.

| Manager model | empty / callbacks | rate | period observed |
|---|---|---|---|
| openai-codex/**gpt-5.5** | 1,172 / 6,464 | **18%** | Apr–Jun |
| openai-codex/gpt-5.4 | 106 / 1,101 | 10% | Mar–Jun |
| anthropic/claude-opus-4-6 | 55 / 3,032 | **2%** | Mar–Apr |
| openai-codex/gpt-5.3-codex | 0 / 102 | 0% | — |

### 5.1 Weekly time series (onset analysis)

Empty / total callbacks per ISO week, by manager model family:

| Week (2026) | gpt-5.5 | gpt-5.4 | claude |
|---|---|---|---|
| W10–W13 (Mar) | — | 1–12% (low volume) | 0–2% |
| W14 (Apr 1–5) | — | 88/813 (11%) | 36/1149 (3%) |
| W15–W16 (Apr 6–19) | — | 5% / 0% | 1–2% |
| **W17 (Apr 20–26)** | **73/725 (10%)** — first gpt-5.5 use | — | 6/213 (3%) |
| W18 (Apr 27–May 3) | 153/994 (15%) | 1/75 | 6/278 (2%) |
| **W19 (May 4–10)** | **299/1334 (22%)** | 1/455 | 0/21 — last claude-manager week |
| W20 (May 11–17) | 154/958 (16%) | 1/360 | — |
| W21 (May 18–24, v0.19.0-beta.1 ships) | 246/1242 (20%) | 1/399 | — |
| W22 (May 25–31) | 289/1288 (22%) | 1/355 | — |
| W23 (Jun 1–7) | 120/746 (16%) | 2/235 | — |
| W24 (Jun 8–10) | 43/235 (18%) | 3/145 | — |

Conclusions:

- The behavior **arrives with gpt-5.5 in W17 (~10%) and saturates by W19 (~22%)** exactly as gpt-5.5 displaces Claude as the manager model. The subjective memory "very rare until around/before the beta release" matches: the ramp is late April → early May, just before v0.19.0-beta.1 (May 18).
- Commit anchors line up: gpt-5.5 entered the model catalog **Apr 23** (`de5ef963`) and manager sessions adopted it by hand that same week (W17); the `pi-codex` preset was sunset and `pi-5.5` promoted to the default on **May 27** (`a9c4155e`), universalizing exposure right before v0.20.0 (May 28). The betas (May 18, Jun 1) bracket this migration, which is why the onset is remembered relative to them.
- Sharpest framing: the **old default** manager model (`pi-codex` = gpt-5.3-codex) shows **0 empty turns in 102 observed callbacks**; the **new default** (gpt-5.5) shows 18%. "It never used to happen" was literally true on the old default.
- The injection **format is not the cause**: gpt-5.5 went empty at comparable rates across every callback format from its first week (`terminal` 7%, `worker-notice` 17%, `other-system` 16% in W17). The `[workerCallback]` JSON wrapper only existed June 3–8 (`8dac1c50` → deleted in `df48b165`) and changed nothing.
- The **prompt is not the trigger either**: the anti-chatter "Communication style" rules date to **Apr 2** (`e8849edd`) — Claude managers ran at 0–3% under them for weeks — and the W17→W19 climb completed *before* the May 24 V2 prompt refactor (`5bacfee8`). The prompt's silence-sanctioning language is an amplifier for a model already inclined to go quiet, not the cause.
- gpt-5.4 had shown the same tendency at lower volume/rate (11–12% in some March/April weeks); claude-opus-4-6 stayed at 0–3% throughout.

Notes:
- Not every "empty after callback" is harm: for *routine* mid-progress callbacks the prompt explicitly sanctions silence (and the model expresses "say nothing" as an empty turn). The harmful subset is empties after **terminal** reports with nothing else running. But as a like-for-like comparison across models the gap is decisive: this is a strongly model-correlated behavior, present at meaningful rates for every gpt-5.x manager, marginal for Claude.
- The behavior predates the work-task ("Active Work") system, survived its revert, and survived the June 9 prompt clarification. The work-task system was correctly ruled out — `workPlansEnabled` is now hardcoded false (`swarm-manager.ts:1296`, `:2093`) and the callback path never touched it.

### Why it felt new

- It effectively *is* new at scale: Claude-managed sessions (≤3%) dominated until late April; gpt-5.5 brought 10–22% rates the moment it became the manager model (see §5.1). Subjective onset "around or before the beta release" is accurate — the ramp completed just before v0.19.0-beta.1.
- June 3–8 the no-op guard partially absorbed it (9 of 16 fires recovered); since June 8 nothing absorbs it.
- During the Active Work era, terminal moments more often had a next tool call (`task` updates) keeping turns non-empty, which masked the terminal-silence case.

---

## 6. Code-Change Timeline

| Date (local) | Commit | Effect |
|---|---|---|
| Apr 2 | `e8849edd` | manager.md gains the "Communication style" anti-chatter rules ("Do not narrate worker spawning…", "Sound like a capable operator, not a status console") — present throughout the low-rate Claude era |
| Apr 23 14:51 | `de5ef963` | **gpt-5.5 added to the model catalog**; specialists switched same day (`5210bc57`). Manager sessions start using it by hand within days (W17) — and the empty-turn rate appears with it |
| May 18 | `4e99b64e` | v0.19.0-beta.1 (first beta) ships |
| May 24 | `5bacfee8` | Manager prompt V2 refactor (286 lines restructured, incl. "User updates" consolidation). Rate unchanged (already ~20%) |
| May 27 16:42 | `a9c4155e` | **`DEFAULT_SWARM_MODEL_PRESET`: `pi-codex` → `pi-5.5`** — gpt-5.5 becomes the default manager model for everything; v0.20.0 ships next day |
| Jun 3 17:30 | `418760d6` | **Adds `manager-noop-guard.ts`** (650 lines + ~1,550 lines of tests): on `agent_end`/`idle` with no pending work, if the manager turn completed no action tool (speak_to_user, send_message_to_agent, present_choices, task, spawn_agent, kill_agent, …) and produced no visible output, emit a diagnostic conversation entry and send an internal `SYSTEM:` recovery nudge instructing the manager to respond. Suppression paths for manual stop / runtime recovery. **Also adds a "Worker callback closure" section to manager.md** explicitly forbidding whitespace/empty answers to actionable callbacks |
| Jun 3 19:17 | `8dac1c50` | Clarifies worker callback manager contract (prompt + guard refinement) |
| Jun 8 12:14 | `2d8301ec` | Fixes guard races / Pi callback follow-up parity — still stabilizing |
| Jun 8 14:10 | `df48b165` | **"Park Active Work and callback recovery fixes for testing"** — deletes `manager-noop-guard.ts`, `worker-callback-message.ts`, both guard test suites, Pi runtime recovery hooks (−171 lines in `pi-agent-runtime.ts`), −257 lines in `swarm-manager.ts`, and the manager.md "Worker callback closure" section (the explicit no-empty-turns rule) |
| Jun 8 ~14:00 | — | Dev daemon (re)started; has been running parked code since |
| Jun 9 11:33 | `4667f1e9` | Prompt-only mitigation: adds the "You MUST send a user-facing update if the running workers have completed…" rule. Incidents continued (3× on Jun 10 with this prompt resolved into the session). |

### 6.1 Did the guard work? (measured)

Searching every session for the actual nudge prefix `SYSTEM: [Forge manager recovery]` delivered as a real inbound manager message:

- **16 fires** across 8 sessions, June 4–8 (it would also have fired on both Mammo incidents — no action tool, no pending work).
- **9 recoveries** — the manager responded to the nudge with `speak_to_user` / `task` / `spawn_agent` / `send_message_to_agent`.
- **7 failures ("EMPTY-AGAIN")** — the manager answered the recovery nudge itself with another empty turn. `middleman-project/work-stop-patch-review` logged 5 consecutive failures on June 8 (14:40–18:15 UTC), right before the park decision.

So the guard was a real fix attempt for this issue that was **~56% effective when it fired**, because its recovery mechanism was "send the silent model another `SYSTEM:`-prefixed plea" — the exact message class the model was already ignoring. Parking it (`df48b165`) was a defensible judgment call; the gap is that nothing replaced it, and the failure mode it targeted is constant (§5.1).

---

## 7. Root Cause Analysis (layered)

**L1 — Model behavior (proximate).** gpt-5.5 on the Codex Responses API treats a `SYSTEM:`-prefixed informational message as something it may acknowledge with an empty final answer. This is consistent with its Codex-CLI-shaped training (final answers are developer-console output, optional after tool work) and is *invited* by the prompt (see L3). It is stochastic (~18%), uncorrelated with thinking level, and immediately self-corrects when the user prods (the model has full context; it just didn't speak).

**L2 — Missing enforcement & observability (systemic).** The architecture routes 100% of user-visible output through one optional tool call, then trusts the model. There is no invariant "terminal worker report ⇒ user-visible consequence," no detection of silent turns, no logging, no metric, no UI hint. The one mechanism that tried to enforce this (`manager-noop-guard`, June 3–8) re-prompted the same model and failed 7 of 16 times it fired; it was parked without a replacement.

**L3 — Prompt contradictions (contributing).** The resolved prompt simultaneously contains:
- "You MUST send a user-facing update if the running workers have completed their work…" (the rule we want), and
- "When no response is appropriate, make no user-facing tool call." (`# User-facing output`)
- Example `no_progress_chatter` → expected behavior: "No user-facing tool call."
- "Prefer at most one kickoff update and one completion update." / "Do not narrate… routine internal progress." / "Sound like a capable operator, not a status console."
- "Messages prefixed `SYSTEM:` are internal context, not direct user requests." (`manager.md:39` — the callback arrives with exactly this prefix)

A model under heavy anti-chatter pressure, told SYSTEM messages aren't requests and that silence is a sanctioned terminal action, will sometimes classify a terminal report as "nothing to say." The MUST sentence competes with five quieter instructions pulling the other way.

---

## 8. Design Review & Recommendations

Ordered by leverage. 1–3 are the load-bearing changes; 4–6 harden the edges.

### R1. Make terminal worker results structurally reach the user (kill the failure class)

The server already knows, before the model ever sees it, that a worker sent a final report. Don't leave the user's only window on that fact to model discretion:

- Render final worker callbacks in the default (Web) chat view as a compact, collapsed "worker report" card (they already render in the All/Detailed view — this is a projection/filter change, not new plumbing).
- `speak_to_user` then becomes synthesis/commentary on top of an always-visible fact, instead of the sole carrier of it. Even a 100% mute manager can no longer hide an outcome.

This is the only recommendation that fully removes the failure mode rather than reducing its probability.

### R2. Restore the no-op guard as a permanent invariant — with a deterministic fallback

Un-park (or rebuild from `8dac1c50`/`2d8301ec`) with two changes to its philosophy:

- **It is not a feature, it is an invariant.** Couple its tests to the callback path so a future revert can't silently drop it.
- **Escalate beyond nudging.** Old design: one internal `SYSTEM:` recovery nudge — asking the same model that just went silent to please speak, in the message-class it ignores. Measured June 4–8: this failed 7 of 16 times (§6.1), which is why the guard felt like it "wasn't working." New ladder: (1) nudge once; (2) if the next turn is still actionless, **synthesize the user-visible message deterministically** from the worker's callback (e.g. "Worker `mammo-permission-rerun` finished: blocked — ClientConnectorCertificateError…" with the full report attached) and mark it as system-relayed. The deterministic step is the part the old guard lacked; it converts the guard from "best effort" to an invariant. Cap at one cycle to avoid loops.
- Guard trigger stays as designed: turn was prompted by an injected message, ended with no completed action tool, no pending workers/queued deliveries, no manual stop/recovery in flight.

### R3. Fix the prompt's mixed signals (cheap, do regardless)

- Scope the silence permissions: "make no user-facing tool call" and the `no_progress_chatter` example must be explicitly limited to **non-terminal** callbacks while other work is still running.
- Make the MUST rule mechanical, not normative: "If a worker callback has `status: done|partial|blocked` and you are not starting another worker in this same turn, you MUST call `speak_to_user` before ending the turn. Ending the turn with no tool call after such a callback is an error."
- Distinguish the injection prefix: terminal reports should not share the `SYSTEM:` prefix that `manager.md:39` declares "internal context, not direct user requests." Use e.g. `WORKER FINAL REPORT (response required):` for terminal callbacks; keep `SYSTEM:` for genuinely informational notices. (`worker-callback-message.ts`, deleted in the park commit, was the start of exactly this contract.)

### R4. Force a tool call on callback-triggered turns where the API supports it

The Responses API supports `tool_choice: "required"`. For manager turns whose inbound message is a terminal worker callback, request a forced tool call (the manager's toolset includes `speak_to_user`, `send_message_to_agent`, `spawn_agent` — all legitimate continuations; an explicit `acknowledge_silently` tool can be added if a true no-op must remain expressible and auditable). Per-runtime capability work, so this is a hardening layer rather than the first move.

### R5. Observability for silent turns

- Log a structured `manager:silent_turn` event (manager id, triggering message id/type, pending counts) whenever a turn triggered by an injected message ends with no action tool.
- Count it in session meta/stats; surface in the UI as a subtle marker in the All view ("manager processed this without responding").
- This also creates the dataset to evaluate models and prompt changes (the 18%/10%/2% table above should be a dashboard, not an archaeology project).

### R6. Treat manager-model choice as a reliability parameter

gpt-5.5 is ~9× worse than claude-opus-4-6 on this axis. Whatever else changes, the model catalog / specialist docs should record "callback responsiveness" as a known per-model behavior, and the Model-Specific Instructions section is the right place for gpt-5.x-targeted phrasing once R3 lands.

### Review-filter pass (question/delete/simplify)

- The *recovery nudge → hope* loop from the June 3 guard is the part not worth rebuilding as-is; R2's deterministic fallback subsumes it and is simpler to reason about.
- `README_NEW.md` and the parked-but-present work-plan code are unrelated clutter discovered in passing; the work-plan files are intentionally retained for un-parking, so leave them, but the guard should not return entangled with them.

---

## 9. Implemented Fix (2026-06-10)

Shipped on branch `cc/clever-tu-b007ea` — the minimal-complexity variant of R2 + the R3 prefix change:

**Empty-turn resample** (`apps/backend/src/swarm/runtime/pi-agent-runtime.ts`, `maybeResampleEmptyTerminalReportTurn`): when a **manager** turn on the Pi runtime ends and the last two context messages are a terminal worker report (`SYSTEM:`/`WORKER REPORT:` + `status: done|partial|blocked`) followed by a whitespace-only assistant message with no tool calls and `stopReason: "stop"`, the runtime drops both messages from the in-memory context (same helper compaction surgery uses), invalidates any codex websocket continuation state, and re-dispatches the identical report — a fresh sample with no nudge text and no record of the prior silence in model-visible context. Bounded by 2 resamples per report; skipped when deliveries are pending, recovery/compaction is active, or the agent is a worker. The failed turn is side-effect-free by definition (no tool calls), so the retry cannot duplicate any action.

**Observability**: each resample logs `manager:empty_turn_resample` (attempt, trigger preview); exhaustion logs `manager:silent_turn`. If `manager:silent_turn` appears in daemon logs at any meaningful rate, refusals are correlated rather than independent and the deterministic-relay backstop (R2 phase 2) earns its complexity.

**Terminal-report prefix** (`swarm-manager.ts` `prepareModelInboundMessage`): internal messages whose body starts with `status: done|partial|blocked` are now prefixed `WORKER REPORT: ` instead of `SYSTEM: ` — terminal reports no longer arrive under the banner the manager prompt explicitly devalues ("internal context, not direct user requests"). `manager.md` routing/update rules updated accordingly, including a mechanical closure rule ("an empty turn is never a valid response to a worker's final report"). The resample trigger accepts both prefixes, so pre-change history and any other `SYSTEM: status:` producers remain covered. The archive last-used hydrator filters the new prefix like it filters `SYSTEM:`.

**Verified**: TDD — 10 new runtime tests (resample, legacy prefix, codex invalidation, retry cap, budget reset, six non-trigger guards), updated prefix/hydrator assertions; full backend suite 2,925 passed / 0 failed; tsc and eslint clean.

**Rollout note**: the dev daemon runs from the *main* repo working tree via tsx. This change takes effect only after it is merged into that working tree and the backend is restarted. Claude SDK and Cursor runtimes are unchanged (measured rates there were marginal); the fix targets the Pi runtime where gpt-5.x managers live.

### 9.1 Field result, same day — resampling alone is insufficient; escalation added

First live test (daemon restarted 13:29 on the merged fix): at 18:49:31 UTC the `mammo-production-execution-readiness` worker delivered a decision-heavy 8.3k-char verdict (`WORKER REPORT: status: done … NEEDS_MINIMAL_PROD_EXECUTOR`). The manager went empty; the resample fired **exactly as designed** — identical report re-dispatched at 18:49:34 and 18:49:37 — and the model returned **three identical empty turns ~3 s apart**, then a clean capped give-up. (The 18:41 routine report minutes earlier got an immediate `speak_to_user`.)

Conclusion: **the empty response is deterministic per context**, not an 18%-per-draw coin flip. The historical 18% means "18% of contexts induce silence"; within such a context, re-rolling identical input re-rolls nothing. The corroborating contrast was in the logs all along: terse user-register prods ("update?", "you still aren't giving updates!") are 8-for-8 — *different input*, not another draw — while the June guard's SYSTEM-register tool-instructions failed 7/16. The recovery input's register is the operative variable.

Same-day change (this section's fix, v2):

- **Escalating redelivery**: resample #1 stays verbatim (free, covers stochastic cases). The final resample appends `EMPTY_TURN_REDELIVERY_DIRECTIVE` — "The user is waiting on this outcome and has not been updated. Send them the update with speak_to_user now." — new tokens (defeats determinism) in the register that has never failed. The manager still authors the user-facing message; raw worker output is never shown to the user.
- **Loop-safe budgeting**: the retry budget is keyed on the directive-stripped report text, so an empty answer to the escalated redelivery exhausts the budget rather than resetting it.
- **Visible exhaustion**: on give-up the runtime emits a `silent_turn` runtime-error event (new phase) with a `userFacingMessage`, which the error projector renders as a system notice in the conversation feed ("⚠️ The manager processed a worker's final report but did not produce a response after automatic retries. Send a message (e.g. \"update?\") to surface the outcome."). Previously this only went to a console nobody reads.

Next rungs if `silent_turn` still fires (evidence-gated, in order): patch pi-ai/pi-coding-agent to support `tool_choice: "required"` on the recovery turn (hard non-empty guarantee, manager remains the author; both vendored packages need the option threaded — verified not currently exposed), then one-turn model switch for the recovery turn. Raw-report relay to the user is rejected as a product violation (manager is the single user-facing voice).

### 9.2 Upstream research + replay-history contamination fix (same day)

Pi runtime status: Forge pins `@mariozechner/pi-ai`/`pi-coding-agent` **0.71.1** (May 1) with local patches; upstream renamed to `earendil-works/pi` with packages `@earendil-works/pi-*`, now **0.79.1** (Jun 9). Nothing in 0.71.1→0.79.1 targets empty final answers (codex commits are transport/retry; adjacent: non-empty system prompt fix 0.73.1, synthetic/duplicate Codex replay-ID hardening May 28 re #5148, developer-role compat Jun 7). Upgrading is hygiene, not a cure; it also requires migrating package scope and re-basing the local patch — parked until the experiments below have data.

**Contamination finding (fixed, `81efd9a5`)**: the Apr 18 local pi-ai patch (`bc462356`, "fix xAI empty content rejection on tool-call-only messages") inserted a synthetic `" "` assistant message into replayed Responses history for **every** tool-call-only assistant turn — the comment said xAI but the condition was unscoped, so it applied to openai-codex too. Most manager turns are tool-only, so every gpt-5.5 manager request showed the model a history in which "it" frequently responded with a lone space — and the observed failure emits exactly a lone-space commentary. The patch landed five days before gpt-5.5 adoption, so gpt-5.5 was never observed with clean history. Not the origin (gpt-5.4 empties predate Apr 18) but a prime amplifier suspect. Fix: gated on `isXaiResponsesModel`; functionally verified against the installed package (codex tool-only turns replay as bare `function_call` items; xAI keeps its placeholder).

External corroboration that this is request-shape-sensitive, not purely model-side: NousResearch/hermes-agent#5736 (openai-codex on gpt-5.x returns empty `response.output` in their agent loop while minimal direct calls work; unresolved) and OpenAI community reports of gpt-5.x Responses returning 200s with empty/reasoning-only output.

**Measurement**: the `manager:empty_turn_resample` / `manager:silent_turn` logs are the A/B counter. Compare resample frequency before/after the daemon restart that picks up `81efd9a5`. If empties effectively vanish, contamination was the dominant amplifier; if they persist at ~18%, escalate per the rungs above and consider a minimal repro for an upstream/OpenAI report.

## 10. Reproducing the Forensics

```bash
S=~/.forge/profiles/rapa-teams-gateway/sessions/mammo-sch
# Timeline around an incident (UTC window):
python3 - "$S/session.jsonl" <<'EOF'
import json,sys
for line in open(sys.argv[1]):
    r=json.loads(line)
    ts=r.get('timestamp','')
    if not ('2026-06-10T13:08'<=ts<='2026-06-10T13:10'): continue
    print(json.dumps(r)[:300])
EOF
```

- Empty-turn signature: assistant `message` whose `content` is only `text` blocks with no non-whitespace chars and no `toolCall` items, `stopReason: "stop"`.
- Callback signature: user-role `message` whose text starts `SYSTEM: status:` (current format) or `SYSTEM: [workerCallback]` (pre-June format).
- The cross-model census script lives in the session transcript for this investigation and is trivially re-derivable from the two signatures above.
