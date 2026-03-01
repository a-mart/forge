# Intelligent Session Memory Merge — Implementation Plan

> **Status:** Draft
> **Date:** 2026-03-01
> **Scope:** Replace raw-append memory merge with LLM-powered consolidation
> **Principle:** Simplest thing that works well. No new workers, archetypes, or infrastructure.

---

## 1. Current State

When a user right-clicks a session and selects "Merge Memory," the backend:

1. Acquires a per-profile merge mutex (`acquireProfileMergeLock`)
2. Reads the session memory file and profile base memory file
3. Checks if session memory is empty/default (no-op guard)
4. Calls `appendSessionMemoryToProfileMemory()` — a pure function that **concatenates** session memory below a merge header into the profile memory
5. Writes the result, sets `mergedAt`, emits events

**Problem:** Raw append causes profile memory to grow unboundedly. Duplicate facts, overlapping sections, no deduplication. After several session merges, the profile memory becomes noisy and redundant.

**The design doc spec'd** spawning a short-lived "merger worker" for intelligent consolidation. After exploration, that's over-engineered — we have a much simpler path.

---

## 2. Key Insight: `pi-ai` Has a One-Shot Completion API

`@mariozechner/pi-ai` (already a backend dependency) exports:

```ts
import { complete, getModel } from "@mariozechner/pi-ai";

const response = await complete(model, {
  systemPrompt: "...",
  messages: [{ role: "user", content: [{ type: "text", text: "..." }] }]
});
// response.content[0].text → the merged memory
```

This is a single LLM call. No runtime, no session file, no worker, no descriptor, no cleanup. The backend already has model resolution (`RuntimeFactory.resolveModel`) and auth (`AuthStorage`). We reuse all of it.

---

## 3. Proposed Flow

When the user clicks "Merge Memory" for session `manager--s2`:

```
1. acquireProfileMergeLock(profileId)
2. Read session memory file  →  sessionContent
3. Read profile memory file  →  profileContent
4. Guard: if sessionContent is empty/default → no-op (unchanged)
5. Guard: if profileContent is empty → just copy sessionContent as new profile memory (no LLM needed)
6. Call LLM:
     complete(model, {
       systemPrompt: MERGE_SYSTEM_PROMPT,
       messages: [{ role: "user", content: mergeUserPrompt(profileContent, sessionContent) }]
     })
7. Extract text from response
8. Guard: if response is empty/error → fall back to raw append (never lose data)
9. Write merged content to profile memory file
10. Set mergedAt on descriptor, save store, emit events
11. releaseMergeLock()
```

**Total new code: ~60-80 lines** (merge prompt + `executeLLMMerge` helper + fallback logic).

---

## 4. The Merge Prompt

A focused system prompt that produces clean output:

```
You are a memory file editor. You receive two memory files and produce one consolidated result.

Rules:
- Preserve the structure and section headers from the base memory
- Integrate new facts, decisions, preferences, and learnings from the session memory
- Deduplicate: if session memory repeats something already in base memory, keep only one copy
- If session memory contradicts base memory, prefer the session memory (it's newer)
- Remove stale/completed items that the session memory marks as done
- Output ONLY the final merged memory content — no explanations, no code fences
- Preserve markdown formatting exactly
```

The user message provides both files clearly labeled.

---

## 5. Model Selection

Use the **session's own model** (from `descriptor.model`). Rationale:
- It's already configured and authenticated
- Memory files are small (a few KB) — no need for a cheaper/faster model
- No new configuration surface

Resolve the model the same way `RuntimeFactory.resolveModel` does: try `ModelRegistry.find()`, fall back to `getModel()` from the catalog.

---

## 6. Fallback Strategy

If the LLM call fails (network error, rate limit, garbled output), **fall back to the existing raw append**. The user gets their merge — just not the smart one. Log a warning.

```ts
try {
  mergedContent = await executeLLMMerge(model, profileContent, sessionContent);
} catch (error) {
  log.warn("LLM merge failed, falling back to raw append", { error });
  mergedContent = appendSessionMemoryToProfileMemory(profileContent, sessionContent, opts);
}
```

This means the merge action **never fails** from the user's perspective. Worst case it degrades to today's behavior.

---

## 7. What Changes

| File | Change | Lines |
|---|---|---|
| `apps/backend/src/swarm/swarm-manager.ts` | Replace body of `mergeSessionMemory` to call LLM merge with fallback | ~30 |
| `apps/backend/src/swarm/memory-merge.ts` | **New file.** Contains `executeLLMMerge()`, the merge prompt, and text extraction. Pure function + one async call. | ~50 |
| `apps/backend/src/test/memory-merge.test.ts` | **New file.** Unit tests for the merge module (prompt construction, text extraction, fallback behavior). | ~40 |

**What stays the same:**
- `appendSessionMemoryToProfileMemory` — kept as fallback (not deleted)
- `acquireProfileMergeLock` — unchanged (still needed for serialization)
- `isSessionMemoryMergeNoOp` — unchanged (still needed for early exit)
- WS route in `session-routes.ts` — unchanged (already emits merge events correctly)
- Protocol types — unchanged (merge events already defined)
- UI — unchanged (already handles merge_started / merged / merge_failed)

---

## 8. Edge Cases

| Case | Handling |
|---|---|
| Empty session memory | Already handled — `isSessionMemoryMergeNoOp` returns early |
| Empty profile memory | Skip LLM, just write session content as the new profile memory |
| LLM returns empty string | Fall back to raw append |
| LLM returns garbage/code fences | Strip code fences, validate non-empty, fall back if bad |
| Concurrent merges (same profile) | Already serialized by `acquireProfileMergeLock` mutex |
| Very large memory files | Token limit risk — mitigated by memory files being naturally small (< 10KB). If this becomes a problem later, truncate session memory with a warning. |
| Session already merged (`mergedAt` set) | Allow re-merge — user may have added more to session memory since last merge |
| API key missing/invalid | LLM call throws → caught → falls back to raw append |
| Model not found | Same — resolve failure → caught → fallback |

---

## 9. Memory Custodian — Not Needed for v1

The design doc spec'd a cron-scheduled "Memory Custodian" manager that auto-merges unmerged sessions. **Defer this entirely.**

Reasons:
- On-demand merge (user clicks button) is sufficient for current usage
- The Custodian is a convenience optimization — it reduces manual clicks but adds a whole new manager, cron config, and merge-scheduling logic
- With intelligent merge now working, the button-click experience is already good
- If we want it later, it's straightforward: a cron job that iterates unmerged sessions and calls the same `executeLLMMerge` function

**Revisit when:** users report friction from manually merging, or when session count per profile grows large enough that manual merge is impractical.

---

## 10. What We're NOT Doing

- ❌ **No merger worker/archetype** — The existing "merger" archetype is for git branch merges, not memory. And workers are interactive, tool-using agents — massive overkill for a single LLM call.
- ❌ **No new configuration surface** — No "merge model" setting. Uses the session's model.
- ❌ **No structural markdown parsing** — The LLM handles deduplication and structure. No fragile regex/AST approach.
- ❌ **No Memory Custodian** — Deferred. On-demand is fine for v1.
- ❌ **No backup/undo mechanism** — The merge mutex prevents concurrent corruption. If a user wants to undo, they can edit the memory file directly (it's just markdown). A future enhancement could keep one backup, but it's not worth the complexity now.

---

## 11. Testing Strategy

1. **Unit tests** (`memory-merge.test.ts`):
   - Prompt construction with various input shapes
   - Text extraction from `AssistantMessage` response
   - Fallback to raw append on LLM error
   - Code fence stripping
   - Empty/default memory guards

2. **Integration smoke test** (manual):
   - Create a session, add some memory, merge, verify profile memory is clean
   - Merge with empty session memory → no-op
   - Merge when profile memory is empty → session content becomes profile memory

3. **Existing tests** in `swarm-manager.test.ts` continue to pass — the merge mutex, no-op guard, and descriptor update logic are unchanged.
