# Review B — Feedback Signals (`feat/feedback-system`)

## Scope reviewed
Diff reviewed between `main..feat/feedback-system`, including backend service/routes, protocol/types, UI hook/components, and tests.

`pnpm test` was executed from repo root: **all tests passed** (backend + UI).

---

## 1) Critical issues (must fix before merge)

### C1. API response contract mismatch between backend and UI client
- **Files**:
  - `apps/backend/src/ws/routes/feedback-routes.ts:66`
  - `apps/ui/src/lib/feedback-client.ts:61`
- **Line context**:
  - Backend returns `sendJson(response, 201, { feedback: submitted })`
  - UI client does `return (await response.json()) as FeedbackEvent`
- **Why this is critical**:
  - The UI is casting a wrapped payload (`{ feedback: ... }`) to `FeedbackEvent` directly.
  - `event.id` / `event.createdAt` become `undefined` at runtime in `use-feedback.ts`, which silently corrupts local feedback metadata updates.
  - Violates protocol/type alignment criteria.
- **Fix suggestion**:
  - Either:
    1. Change backend POST response shape to raw event (`sendJson(..., submitted)`), **or**
    2. Keep backend as-is and update client parsing to:
       - `const payload = (await response.json()) as { feedback: FeedbackEvent }`
       - `return payload.feedback`
  - Add route-level test for POST response shape to prevent regression.

### C2. Toggle-off behavior is implemented in UI but not persisted by backend
- **Files**:
  - `apps/ui/src/lib/use-feedback.ts:63-75, 101-112`
  - `apps/backend/src/swarm/feedback-service.ts:95-106`
- **Line context**:
  - UI assumes clicking same vote toggles to `null` and comments “backend handles the toggle”.
  - Backend latest-state resolution is “last event wins” with only `up|down` values.
- **Why this is critical**:
  - User can clear a vote optimistically in UI, but server state still persists `up`/`down`.
  - On refetch/reload, cleared feedback reappears.
  - `FeedbackState.value: 'up' | 'down' | null` is not meaningfully honored server-side.
- **Fix suggestion**:
  - Implement server-side toggle resolution per target (same vote repeated => clear/null state), or remove toggle-off UX entirely.
  - Add tests for `up -> up => null` and `down -> down => null` behavior.

---

## 2) Important issues (should fix, could merge with follow-up)

### I1. Feedback session scope breaks when active agent is a worker
- **Files**:
  - `apps/ui/src/routes/index.tsx:184-188, 587-611`
  - `apps/backend/src/ws/routes/feedback-routes.ts:169-175`
- **Line context**:
  - UI sets `feedbackSessionId = activeAgentId` and enables feedback if `activeAgent.profileId` exists.
  - Backend route only accepts manager session IDs (`descriptor.role === 'manager'`).
- **Impact**:
  - In worker subscriptions, feedback requests target worker IDs and return 404.
  - Controls can appear but fail silently.
- **Fix suggestion**:
  - Derive session id as manager session id:
    - manager view: `activeAgent.agentId`
    - worker view: `activeAgent.managerId`
  - Optionally hide session feedback controls unless active agent is manager session.

### I2. `meta.json` feedback watermark updates are atomic-per-write but not concurrency-safe across writers
- **Files**:
  - `apps/backend/src/swarm/feedback-service.ts:140-153`
- **Line context**:
  - `readSessionMeta(...)` -> mutate fields -> `writeSessionMeta(...)` (full-file rewrite).
- **Impact**:
  - Concurrent feedback submissions and other meta writers can clobber fields.
  - `lastFeedbackAt` can move backwards depending on write order.
- **Fix suggestion**:
  - Add per-session meta lock/mutex or centralized patch/update helper.
  - Enforce monotonic update: `lastFeedbackAt = max(existing, incoming)`.

### I3. Invalid query input can return 500 instead of 400
- **Files**:
  - `apps/backend/src/ws/routes/feedback-routes.ts:146-151, 358-364`
- **Line context**:
  - Route maps errors to 400 only via `isInvalidRequestError(...)` string matching.
  - Path sanitizer errors (`Invalid path segment`) are not classified as client errors.
- **Impact**:
  - Bad `profileId` query values can produce 500 (server error) instead of 400.
- **Fix suggestion**:
  - Expand error classifier (or better: use typed HttpError with status codes).
  - Add route tests for invalid `profileId` query cases.

### I4. Cross-session query does full sequential scan and full in-memory sort
- **Files**:
  - `apps/backend/src/swarm/feedback-service.ts:67-80`
- **Line context**:
  - Iterates every profile/session and calls `listFeedback` sequentially, then sorts all events.
- **Impact**:
  - Latency scales poorly as sessions/feedback volume grows.
- **Fix suggestion**:
  - Add pagination and/or require scoped filters for heavy queries.
  - Use bounded parallelism for directory/file reads.
  - Consider returning aggregate/latest-only for dashboard use-cases.

### I5. Route-level feedback endpoint tests are missing
- **Files**:
  - `apps/backend/src/test/ws-server.test.ts` (no feedback endpoint coverage)
- **Impact**:
  - Contract and status-code bugs slipped through (e.g., C1).
- **Fix suggestion**:
  - Add tests for:
    - POST `/api/v1/profiles/:profileId/sessions/:sessionId/feedback` (201 + response shape)
    - GET feedback/state happy paths
    - 400 invalid body/query
    - 404 unknown/non-manager session

---

## 3) Minor issues (nice to have)

### M1. UI feedback types are duplicated instead of imported from protocol
- **File**: `apps/ui/src/lib/feedback-types.ts:1`
- **Line context**: file comment says this is temporary local copy.
- **Risk**: drift from `packages/protocol/src/feedback.ts` over time.
- **Fix suggestion**: import shared types/constants from `@middleman/protocol` (or generate shared client-safe types).

### M2. `channel` param type is too loose in UI client
- **File**: `apps/ui/src/lib/feedback-client.ts:37`
- **Line context**: `channel?: string`
- **Risk**: invalid values compile; error deferred to runtime 400.
- **Fix suggestion**: type as `FeedbackEvent['channel']`.

---

## 4) Positive observations

- Good use of centralized path helpers and sanitization (`data-paths.ts` + `getSessionFeedbackPath`) in feedback persistence path derivation.
- JSONL reader behavior is resilient:
  - missing file => empty list
  - malformed/interrupted lines => skipped safely (`apps/backend/src/swarm/feedback-service.ts`).
- CORS + OPTIONS handling in new routes follows existing backend patterns.
- `SessionMeta` additions are optional in protocol (`packages/protocol/src/shared-types.ts:83-86`), helping backward compatibility.
- Helpful unit coverage exists for service behavior:
  - cross-session query
  - malformed JSONL handling
  - latest-state resolution by last-event wins
  (`apps/backend/src/swarm/__tests__/feedback-service.test.ts`).
