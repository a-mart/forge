# Worker Pills Web UI — Code Review

**Reviewer:** Independent code review agent  
**Date:** 2026-03-22  
**Files reviewed:**
- `apps/ui/src/components/chat/WorkerPillBar.tsx` (new)
- `apps/ui/src/components/chat/WorkerQuickLook.tsx` (new)
- `apps/ui/src/routes/index.tsx` (modified)

**Reference:** `.internal/worker-pills-web-plan.md`

---

## Issues Found

### 1. Popover is far too small for useful quick-look content
**Category:** UX  
**Severity:** Important

The PopoverContent is `w-96` (384px) with a `max-h-[300px]` activity feed. At this size, tool call rows with expand/collapse are cramped and barely readable. Agent messages with multi-line text are truncated. The popover doesn't feel like a useful preview — it feels like a constrained mobile widget on a desktop screen.

**Fix:** Significantly increase both dimensions:
```tsx
// WorkerPillBar.tsx, PopoverContent
- className="w-96 max-w-[calc(100vw-2rem)] p-0"
+ className="w-[32rem] max-w-[calc(100vw-2rem)] p-0"

// WorkerQuickLook.tsx, activity feed container
- <div className="max-h-[300px] overflow-y-auto px-2 py-1.5">
+ <div className="max-h-[28rem] overflow-y-auto px-2 py-1.5">
```

Consider going even wider (`w-[36rem]`) since this is a desktop-only surface. The popover opens `side="top"` near the bottom of the viewport, so vertical space is abundant.

---

### 2. No way to navigate back to the parent manager after viewing a worker conversation
**Category:** UX / Missing feature  
**Severity:** Important

The plan mentions this as a possible follow-up ("Could optionally show a '← Back to {session}' pill"), but without it the UX is broken: clicking "View full conversation →" navigates to a worker view where the pill bar disappears (`isActiveManager` guard), and the only way back is digging through the sidebar tree. This makes the entire pill → quick-look → drill-in flow feel like a dead end.

**Fix:** Add a "back to parent" bar when viewing a worker conversation. This should render in the same slot where `WorkerPillBar` goes (between MessageList and MessageInput) when `activeAgent?.role === 'worker'`:

```tsx
// New component — WorkerBackBar.tsx (or inline in WorkerPillBar.tsx)
// Renders: ← Back to {parentSessionLabel}
// Shows when activeAgent.role === 'worker' and activeAgent.managerId exists

// In index.tsx, change the conditional:
- {isActiveManager ? (
-   <WorkerPillBar ... />
- ) : null}
+ {isActiveManager ? (
+   <WorkerPillBar ... />
+ ) : activeAgent?.role === 'worker' && activeAgent?.managerId ? (
+   <WorkerBackBar
+     managerId={activeAgent.managerId}
+     managerLabel={/* resolve from state.agents */}
+     onNavigateBack={() => handleSelectAgent(activeAgent.managerId)}
+   />
+ ) : null}
```

Style it as a subtle, single-line bar with a left arrow and the parent session name, matching the pill bar's border/bg treatment.

---

### 3. Tooltip + Popover on same trigger — Radix interaction conflict
**Category:** Bug  
**Severity:** Important

The `WorkerPill` nests `TooltipTrigger asChild` > `PopoverTrigger asChild` > `<button>`. When the popover opens (click), the tooltip doesn't automatically dismiss and can remain visible behind/alongside the popover. Radix Tooltip and Popover don't coordinate dismissal when sharing a trigger element. Additionally, hovering while the popover is open can re-trigger the tooltip overlay.

**Fix:** Dismiss the tooltip when the popover opens:
```tsx
<Tooltip open={popoverOpen ? false : undefined}>
```
This forces the tooltip closed whenever the popover is open, while letting it work normally (hover-controlled) otherwise.

---

### 4. `animate-ping` on the pulsing dot is too aggressive for a persistent ambient indicator
**Category:** UX  
**Severity:** Minor

The plan specifically noted this concern: "`animate-pulse` or custom keyframes for a smoother effect." The implementation uses `animate-ping`, which produces a rapid expanding-ring effect. For a single status dot (like ChatHeader), ping is fine. But with 3-5 pills visible simultaneously, the multiple pinging dots create a distracting visual cacophony.

The ChatHeader uses `animate-ping` on a larger dot (size-4) with lower opacity (`bg-emerald-500/45`), where it acts as a single attention beacon. The pills' dots are smaller (size-2) and there are many of them — `animate-pulse` (gentle opacity fade) would be more appropriate.

**Fix:**
```tsx
// WorkerPillBar.tsx, pulsing dot
- <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
- <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
+ <span className="relative inline-flex size-2 animate-pulse rounded-full bg-emerald-500" />
```

This removes the expanding-ring overlay entirely and uses a simple opacity pulse on the dot itself. Single element, less DOM, less visual noise.

---

### 5. Duplicated `hydrateToolDisplayEntry` logic — drift risk
**Category:** Style / Maintainability  
**Severity:** Minor

`WorkerQuickLook.tsx` duplicates the `hydrateToolDisplayEntry` function from `MessageList.tsx`. The two implementations are nearly identical but already diverge slightly:
- MessageList uses `resolveToolExecutionEventActorAgentId(event)` which handles both `agent_tool_call` and `conversation_log` event types.
- QuickLook inlines the logic with a ternary check on `event.type`.

This is a maintenance landmine — any future fix to one copy will likely miss the other.

**Fix:** Extract the shared hydration logic into `message-list/types.ts` or a new `message-list/tool-hydration.ts` utility, and import it from both `MessageList` and `WorkerQuickLook`. The `buildQuickLookEntries` function in QuickLook can remain local since it has different entry-building semantics.

---

### 6. `ToolExecutionEvent` type alias in QuickLook is misleading
**Category:** Style / Type safety  
**Severity:** Nit

```typescript
type ToolExecutionEvent = ToolExecutionLogEntry | AgentToolCallEntry
```

`ToolExecutionLogEntry` (from `conversation_log`) will never appear in `activityMessages` — the `AgentActivityEntry` union is `agent_message | agent_tool_call` only. The `conversation_log` branch in the type and in the ternary fallback (`event.agentId`) is dead code.

**Fix:** Remove the unused union member:
```typescript
type ToolExecutionEvent = AgentToolCallEntry
```
Or better yet, just use `AgentToolCallEntry` directly and drop the alias.

---

### 7. Grid-rows animation on the pill bar container never actually animates
**Category:** Bug (cosmetic)  
**Severity:** Minor

```tsx
<div className={cn(
  'grid transition-[grid-template-rows] duration-200 ease-out',
  pillEntries.length > 0 ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
)}>
```

The container returns `null` when `pillEntries.length === 0`, so the `grid-rows-[0fr]` branch is never reached — the component unmounts before it can animate to zero height. The grid-rows transition is dead code.

**Fix:** Either:
- (a) Keep the component mounted with an empty state and let the grid-rows transition collapse it, OR
- (b) Remove the grid-rows wrapper since it's not doing anything. The current behavior is: pills exist → render, pills gone → unmount (instant).

Option (a) is cleaner for the exit animation:
```tsx
// Don't early-return null. Instead let the grid handle collapse.
// Move the `if (pillEntries.length === 0) return null` to only bail 
// when there were *never* any pills (e.g., the ref map has never been populated).
```

This requires the parent to always render `<WorkerPillBar>` (remove the `isActiveManager` guard or make it always-mount), and let the component internally handle its own visibility.

---

### 8. Pill exit fade is 200ms CSS transition but removal timer is 500ms — timing mismatch
**Category:** Edge case  
**Severity:** Nit

When a worker stops streaming, the pill gets `exiting: true` → `opacity-0` via `transition-all duration-200`. The removal timer fires after `REMOVE_DELAY_MS = 500`. So the pill is invisible for 300ms before being removed from DOM. Not harmful, but the timer should match the CSS duration:

**Fix:**
```tsx
- const REMOVE_DELAY_MS = 500
+ const REMOVE_DELAY_MS = 200
```
Or keep 500ms if the intent is debounce-on-transient-status-flicker (plan mentions 500ms debounce), in which case the CSS opacity transition should also be 500ms for a smoother fade.

---

### 9. `pillEntriesRef` mutation inside `useEffect` — React concurrent mode concern
**Category:** Performance / Correctness  
**Severity:** Minor

The reconciliation `useEffect` mutates `pillEntriesRef.current` (a Map stored in a ref) and then calls `forceRender` to trigger re-renders. This works in React 18's default mode but is fragile under StrictMode or concurrent features:
- The effect runs twice in StrictMode (dev), which could create duplicate exit timers.
- The `setTimeout` callbacks capture stale ref state if React re-executes the effect.

In practice, since the Map is mutated in-place (not replaced), the double-execution in StrictMode won't create duplicates for the `current.set()` calls. But the `setTimeout` scheduling in the exit branch could fire cleanup callbacks for timers that were already cleared by the second execution.

**Fix:** This is acceptable for now, but a comment documenting the StrictMode behavior would help future maintainers. A more robust approach would use `useReducer` instead of ref mutation + forceRender, but that's a larger refactor and not blocking.

---

### 10. `createdAt` malformed handling is silent
**Category:** Edge case  
**Severity:** Nit

```tsx
const createdEpoch = Date.parse(worker.createdAt)
if (!Number.isFinite(createdEpoch)) return 0
```

This correctly handles malformed dates by returning `0`, which displays as `0:00`. The timer would show `0:00` and never increment (since `Date.now() - NaN` would also be caught). This is fine behavior — no crash, just a frozen `0:00`. No fix needed, just noting it's handled.

---

### 11. `activityMessages` is passed unfiltered to every `WorkerPill`
**Category:** Performance  
**Severity:** Minor

Each `WorkerPill` receives the full `activityMessages` array and filters it internally with `useMemo`. With N pills and M activity messages, this is O(N×M) filtering on every render. The plan notes `activityMessages` is capped at 2000 entries, so with 5 pills this is 10,000 filter operations per tick (every second).

**Fix:** Pre-filter at the `WorkerPillBar` level:
```tsx
// In WorkerPillBar, compute a Map<workerId, AgentActivityEntry[]> once
const activityByWorker = useMemo(() => {
  const map = new Map<string, AgentActivityEntry[]>()
  for (const entry of activityMessages) {
    const id = entry.type === 'agent_tool_call' ? entry.actorAgentId
      : entry.type === 'agent_message' ? (entry.fromAgentId || entry.toAgentId)
      : null
    if (id) {
      let arr = map.get(id)
      if (!arr) { arr = []; map.set(id, arr) }
      arr.push(entry)
    }
  }
  return map
}, [activityMessages])

// Pass pre-filtered array to each pill
<WorkerPill activityMessages={activityByWorker.get(entry.worker.agentId) ?? []} ... />
```

This makes filtering O(M) once instead of O(N×M) per tick. The individual pill's `useMemo` can then be simplified to just `.slice(-8)`.

Note: The `agent_message` filtering is slightly more complex because messages matching `toAgentId` (not just `fromAgentId`) should also be included. The pre-filter would need to index by both IDs for agent_message entries.

---

### 12. Missing `key` stability concern with ref-based entries
**Category:** Edge case  
**Severity:** Nit

Pills are keyed by `entry.worker.agentId`, which is stable. However, when a worker exits and a new worker reuses the same `agentId` (theoretically possible if the backend recycles IDs), the exiting pill's timeout could conflict with the new entry. The current code handles this in the reconciliation effect by clearing exit timers when a streaming worker re-appears with the same ID, so this is properly addressed.

---

### 13. Popover stays open when pill is in exit phase
**Category:** Edge case  
**Severity:** Minor

If a user has the quick-look popover open and the worker stops streaming, the pill begins its exit fade (opacity-0) and then gets removed from DOM after `REMOVE_DELAY_MS`. The popover will be force-closed by the DOM removal, which may cause an abrupt visual jump rather than a graceful close.

**Fix:** Close the popover when the pill enters exit state:
```tsx
// In WorkerPill
useEffect(() => {
  if (exiting && popoverOpen) {
    setPopoverOpen(false)
  }
}, [exiting, popoverOpen])
```

---

### 14. Plan called for separate `WorkerPill.tsx` file — implementation consolidated
**Category:** Style  
**Severity:** Nit

The plan specified three files (`WorkerPillBar.tsx`, `WorkerPill.tsx`, `WorkerQuickLook.tsx`), but the implementation puts `WorkerPill` inside `WorkerPillBar.tsx`. This is a reasonable consolidation choice since `WorkerPill` is tightly coupled to the bar's tick/entry system. No change needed — just noting the deviation.

---

### 15. `TooltipProvider` is instantiated per-pill
**Category:** Performance  
**Severity:** Nit

Each `WorkerPill` wraps its content in a `<TooltipProvider delayDuration={400}>`. The codebase does this elsewhere (ChatHeader, AgentSidebar), so it's consistent, but it's slightly wasteful — a single `TooltipProvider` at the `WorkerPillBar` level would serve all pills.

**Fix (optional):**
```tsx
// Move TooltipProvider to WorkerPillBar, wrapping the flex container
<TooltipProvider delayDuration={400}>
  <div className="flex items-center gap-1.5 ...">
    {pillEntries.map(...)}
  </div>
</TooltipProvider>
```

---

## Summary Table

| # | Issue | Category | Severity |
|---|-------|----------|----------|
| 1 | Popover too small for useful content | UX | Important |
| 2 | No back-navigation from worker to parent manager | UX | Important |
| 3 | Tooltip + Popover interaction conflict | Bug | Important |
| 4 | `animate-ping` too aggressive for multiple pills | UX | Minor |
| 5 | Duplicated `hydrateToolDisplayEntry` — drift risk | Style | Minor |
| 6 | Misleading `ToolExecutionEvent` type alias | Style | Nit |
| 7 | Grid-rows exit animation never fires | Bug | Minor |
| 8 | CSS fade duration vs removal timer mismatch | Edge case | Nit |
| 9 | Ref mutation in useEffect — concurrent mode fragility | Performance | Minor |
| 10 | Malformed `createdAt` handled correctly | Edge case | — (no fix) |
| 11 | O(N×M) activity filtering per tick | Performance | Minor |
| 12 | Key stability with recycled agentIds | Edge case | — (handled) |
| 13 | Popover abrupt close during pill exit | Edge case | Minor |
| 14 | File consolidation vs plan | Style | Nit |
| 15 | TooltipProvider per-pill | Performance | Nit |

---

## Overall Assessment

**Verdict: Merge-ready after fixing the 3 Important issues (#1, #2, #3).**

The implementation is solid overall — correct data flow, good use of shared interval, proper ref-based reconciliation for enter/exit states, and correct reuse of `ToolLogRow`/`AgentMessageRow`. The code is well-structured and follows codebase conventions.

The three Important issues are:
1. **Popover sizing** (#1) — trivial CSS change, 2 lines
2. **Back-navigation** (#2) — new small component + index.tsx wiring, ~40 lines
3. **Tooltip/Popover conflict** (#3) — one-line prop addition

The Minor issues (animation, perf, hydration dedup) are all worth addressing but not blocking. The Nits are polish.

The plan's edge cases are well-handled: malformed dates, empty activity, rapid status changes (debounced exit), and WebSocket disconnection all degrade gracefully.
