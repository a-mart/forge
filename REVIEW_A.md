# Review A — Feedback Signals Feature (`feat/feedback-system`)

**Reviewer:** Review Agent A  
**Date:** 2026-03-04  
**Branch:** `feat/feedback-system` (diff against `main`)  
**Scope:** Full-stack review — protocol types, backend service + routes, UI components + hooks

---

## 1. Critical Issues (must fix before merge)

### 1.1 Client does not unwrap POST response envelope — feedback submission silently broken

**Files:** `apps/ui/src/lib/feedback-client.ts:61`, `apps/backend/src/ws/routes/feedback-routes.ts:67`

The backend wraps the submitted event in a `{ feedback: submitted }` envelope:
```ts
sendJson(response, 201, { feedback: submitted });
```

But the client treats the raw response as a bare `FeedbackEvent`:
```ts
return (await response.json()) as FeedbackEvent
```

This means the returned object has shape `{ feedback: { id, createdAt, ... } }` instead of `{ id, createdAt, ... }`. The caller in `use-feedback.ts` then reads `event.id` and `event.createdAt` — both will be `undefined`.

**Impact:** Optimistic state update after submission writes `latestEventId: undefined` and `latestAt: undefined` into the feedback state map. The feature appears to work visually (the optimistic state is set _before_ the fetch), but the server-confirmed state is corrupt.

**Fix:** Unwrap the response in `feedback-client.ts`:
```ts
const payload = (await response.json()) as { feedback: FeedbackEvent }
return payload.feedback
```

### 1.2 Toggle-off (un-vote) is fundamentally broken — no server-side support

**Files:** `apps/ui/src/lib/use-feedback.ts:60-90`, `apps/backend/src/swarm/feedback-service.ts`

The UI implements a toggle-off semantic: clicking the same vote a second time is supposed to clear it:
```ts
const isToggleOff = currentVote === value
// Optimistic update sets value: null
```

However, `submitVote` still calls `submitFeedback` with the original `value` (e.g., `'up'`). The backend always appends a new event with the given value — it has no concept of clearing/toggling. So:

1. User clicks thumbs-up → backend records `value: 'up'` ✓
2. User clicks thumbs-up again → UI optimistically shows `null`, backend records **another** `value: 'up'`
3. On page reload, `getLatestStates` returns `value: 'up'` — the "clear" never happened

**Impact:** Vote toggling appears to work in the session, but persisted state always reflects the last submitted value. Reloads restore the un-toggled state.

**Fix options:**
- **(A) Add a `'clear'` value** to the protocol (`value: 'up' | 'down' | 'clear'`) and handle it in `getLatestStates` — when the latest event is `'clear'`, the resolved state is `null`.
- **(B) Don't send on toggle-off** — if `isToggleOff`, only update local state optimistically and skip the API call. This means clears are ephemeral (lost on reload), which may be acceptable as a v1 trade-off if documented.

---

## 2. Important Issues (should fix, could merge with follow-up)

### 2.1 No size limit on `comment` field — unbounded payload

**Files:** `apps/backend/src/ws/routes/feedback-routes.ts`, `apps/backend/src/swarm/feedback-service.ts`

Neither the route handler nor the service validates comment length. A malicious or buggy client could submit a multi-megabyte comment string, which would be persisted verbatim in the JSONL file and inflated session meta sizes.

**Fix:** Add a reasonable limit (e.g., 2000 characters) in `parseSubmitFeedbackBody`:
```ts
if (typeof maybe.comment === 'string' && maybe.comment.length > 2000) {
  throw new Error('comment must not exceed 2000 characters.')
}
```

### 2.2 `any` type in cortex-scan.ts

**File:** `apps/backend/src/swarm/scripts/cortex-scan.ts:77`

```ts
let parsed: any;
```

This allows unchecked property access throughout the meta parsing block. While this is pre-existing code, the diff extends this block to read new feedback-related fields (`feedbackFileSize`, `cortexReviewedFeedbackBytes`, etc.), making the `any` more impactful.

**Fix:** Type as `unknown` and add narrowing guards or use the same `isRecord` + optional-access pattern used elsewhere in the codebase.

### 2.3 No HTTP-level route tests for feedback endpoints

**Files:** `apps/backend/src/test/ws-server.test.ts`, `apps/backend/src/swarm/__tests__/feedback-service.test.ts`

The service-level tests are solid, but there are zero tests for the HTTP routes themselves. This means the following are untested:
- Route matching (the regex patterns)
- CORS handling
- Session existence validation (`isExistingSession`)
- JSON body parsing and error responses
- The response envelope shape (`{ feedback: ... }`, `{ states: ... }`)

The response envelope mismatch (issue 1.1) would have been caught by route-level tests.

**Fix:** Add integration tests that exercise `POST /api/v1/profiles/:p/sessions/:s/feedback`, `GET .../feedback`, `GET .../feedback/state`, and `GET /api/v1/feedback` with actual HTTP requests against the test server.

### 2.4 `message.timestamp` as feedback `targetId` is fragile

**Files:** `apps/ui/src/components/chat/message-list/ConversationMessageRow.tsx:102`, `apps/ui/src/components/chat/MessageList.tsx:200`

Message feedback uses `message.timestamp` as the `targetId`:
```tsx
<MessageFeedback targetId={message.timestamp} ... />
```

Timestamps may not be unique across messages (two messages arriving in the same millisecond) and could change if the conversation is replayed/reconstructed. A stable message ID would be more robust.

**Impact:** Low for typical usage, but could cause vote collision on rapid-fire messages or re-projected conversations.

**Fix (follow-up):** Consider using a message-specific ID (e.g., an index, hash, or the `parentId` from the JSONL entry) rather than `timestamp` as the target identifier.

### 2.5 `feedbackStates` in `submitVote` dependency array causes excessive recreation

**File:** `apps/ui/src/lib/use-feedback.ts:47`

```ts
const submitVote = useCallback(
  async (...) => {
    const currentVote = feedbackStates.get(targetId)?.value ?? null
    ...
  },
  [profileId, sessionId, feedbackStates], // ← feedbackStates changes on every vote
)
```

Every time `feedbackStates` changes, `submitVote` gets a new reference, causing all consumers (`MessageFeedback`, `ChatHeader`) to re-render. With many messages visible, this could cause noticeable jank after each vote.

**Fix:** Use a ref to track feedbackStates for the current-vote read, and remove it from the dependency array:
```ts
const feedbackStatesRef = useRef(feedbackStates)
feedbackStatesRef.current = feedbackStates

const submitVote = useCallback(async (...) => {
  const currentVote = feedbackStatesRef.current.get(targetId)?.value ?? null
  ...
}, [profileId, sessionId])
```

---

## 3. Minor Issues (nice to have, optional)

### 3.1 Textarea in reason picker has no `maxLength`

**File:** `apps/ui/src/components/chat/message-list/MessageFeedback.tsx:131`

The `<Textarea>` for the optional comment has no `maxLength` attribute. Even if a backend limit is added (2.1), an HTML-level guard improves UX.

```tsx
<Textarea maxLength={2000} ... />
```

### 3.2 Reason picker popover `onOpenAutoFocus` prevents focus management

**File:** `apps/ui/src/components/chat/message-list/MessageFeedback.tsx:121`

```tsx
onOpenAutoFocus={(e) => e.preventDefault()}
```

This prevents the popover from moving focus into itself when opened, which may confuse keyboard-only users. Consider focusing the first checkbox or submit button instead.

### 3.3 Keyboard accessibility for thumbs up/down buttons

**File:** `apps/ui/src/components/chat/message-list/MessageFeedback.tsx:83-119`

The buttons correctly use `aria-label` and `aria-pressed`. However, `role` is implicit from `<button>`, which is correct. The `disabled` state is only set when `isSubmitting` is true, but there's no `aria-busy` on the containing element during submission.

### 3.4 Duplicate `resolveWsUrl` logic

**File:** `apps/ui/src/lib/feedback-client.ts:4-12`

The WS URL resolution logic is duplicated from `routes/index.tsx` (and possibly other places). Consider extracting to a shared utility.

### 3.5 Test coverage: missing edge cases

**File:** `apps/backend/src/swarm/__tests__/feedback-service.test.ts`

Covered well: basic CRUD, latest-state resolution, filtering, cross-session queries, JSONL resilience, meta updates.

Missing:
- Empty comment string (partially covered — always sends `""`, but no test for explicit empty string handling)
- All 10 reason codes in a single submission (only tests 1-2 at a time)
- Concurrent writes (two `submitFeedback` calls interleaved)
- Very long comment strings
- `actor` spoofing attempt (e.g., `actor: 'admin'`)
- Session-scope with mismatched `targetId` (the service throws, but no test verifies the error)

### 3.6 Cortex scan `status` classification edge case

**File:** `apps/backend/src/swarm/scripts/cortex-scan.ts:109-113`

```ts
const status: ScanSession["status"] =
  deltaBytes === 0 && feedbackDeltaBytes === 0
    ? "up-to-date"
    : reviewedAt === null && feedbackReviewedAt === null
      ? "never-reviewed"
      : "needs-review";
```

A session with `deltaBytes === 0`, `feedbackDeltaBytes > 0`, and `reviewedAt !== null` but `feedbackReviewedAt === null` would be classified as `"needs-review"` rather than `"never-reviewed"` for the feedback dimension. This is technically correct (the session itself _was_ reviewed), but the label may be misleading for Cortex — a display-only concern.

---

## 4. Positive Observations

### 4.1 Protocol type parity is exact
`packages/protocol/src/feedback.ts` and `apps/ui/src/lib/feedback-types.ts` are character-for-character identical in their type/const definitions. The UI file has a clear comment noting it will be replaced with protocol imports. Good discipline.

### 4.2 Append-only JSONL design is correct for this use case
Using `appendFile` for an append-only event log avoids read-modify-write races. The JSONL parser gracefully skips invalid lines (tested). The `coerceFeedbackEvent` validator is thorough — it rejects incomplete records, invalid enums, and structurally invalid events (e.g., session-scope with mismatched targetId).

### 4.3 Input validation is comprehensive
The backend validates all enum fields (`scope`, `value`, `channel`, `actor`), reason codes against the canonical list with deduplication, and required string fields. The `isInvalidRequestError` heuristic for 400 vs 500 status codes is reasonable.

### 4.4 SessionMeta feedback watermark integration is clean
The `feedbackFileSize`, `lastFeedbackAt`, `cortexReviewedFeedbackBytes`, and `cortexReviewedFeedbackAt` fields are consistently wired through `session-manifest.ts`, `cortex-scan.ts`, `shared-types.ts`, and the API. The coerce/normalize functions handle missing and null values correctly. The cortex scan test covers the new fields.

### 4.5 Optimistic UI pattern is well-structured
Despite the toggle-off bug, the optimistic update → server confirm → error revert pattern in `use-feedback.ts` is clean. The cancellation flag in the effect prevents stale fetches. The `fetchedKeyRef` avoids redundant fetches on re-render without profileId/sessionId change.

### 4.6 TypeScript builds are clean
Both `@middleman/backend` and `@middleman/ui` pass `tsc --noEmit` with zero errors. All 236 backend tests pass.

### 4.7 Minimal footprint in existing code
The wiring touches are surgical: one import + one spread in `server.ts`, prop-passing in `routes/index.tsx`, `ChatHeader.tsx`, and `MessageList.tsx`. No invasive changes to existing behavior.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 2 | Must fix |
| Important | 5 | Should fix / follow-up |
| Minor | 6 | Optional |
| Positive | 7 | — |

**The two critical issues (response envelope mismatch and broken toggle-off) should be resolved before merge.** The response mismatch is a straightforward one-line fix. The toggle-off requires a design decision on whether to add server-side support or accept ephemeral clears for v1.
