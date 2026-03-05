# Feedback System — Cortex Processing Handoff

> **Audience:** Cortex agent (automated reviewer/knowledge extractor)
> **Last updated:** 2026-03-05

---

## 1. System Overview

The feedback system captures structured user sentiment on individual assistant messages and entire sessions. It operates end-to-end across three layers:

### User-Facing UX Flow

1. **Message-level feedback:** The user clicks a thumbs-up or thumbs-down button on any assistant message in the chat UI. After voting, a reason picker appears with direction-specific reason codes (e.g., "accuracy", "great_outcome" for upvotes; "poor_outcome", "over_engineered" for downvotes; some reasons like "needs_clarification" apply to both). The user can optionally add a free-text comment (max 2000 chars). Users can also submit standalone comments without a vote direction.

2. **Session-level feedback:** The user can rate an entire session with the same thumbs up/down + reason + comment flow. The `targetId` for session-scoped feedback equals the `sessionId`.

3. **Toggle/clear behavior:** Re-clicking the same vote direction clears it (`"clear"` value). Switching directions replaces the existing vote. Votes and comments are independent — a user can have both a vote AND a comment on the same target simultaneously.

### Data Flow

```
UI (click) → POST /api/v1/profiles/:profileId/sessions/:sessionId/feedback
           → FeedbackService.submitFeedback()
           → Upsert into feedback.jsonl (atomic write via tmp+rename)
           → Update session meta.json (feedbackFileSize, lastFeedbackAt)
           → Cortex scan picks up delta via watermark comparison
```

### Key Design Principles

- **Upsert/delete, NOT append-only.** The JSONL file represents current state, not a log. When a user changes their vote or clears it, the file is rewritten.
- **One file per session.** All feedback for a session lives in a single `feedback.jsonl` file.
- **Uniqueness key:** `(actor, scope, targetId)` per value category. Votes and comments use independent keys — `user:message:<msgId>` for a vote and `user:comment:message:<msgId>` for a comment can coexist.

---

## 2. Storage Model

### File Location

```
~/.middleman/profiles/<profileId>/sessions/<sessionId>/feedback.jsonl
```

Resolved by `getSessionFeedbackPath(dataDir, profileId, sessionId)` in `apps/backend/src/swarm/data-paths.ts`.

### File Format

- **JSONL** — one JSON object per line, newline-terminated.
- Each line represents one **currently active** feedback entry (vote or comment).
- The file is rewritten atomically on every mutation (write to `.tmp-<uuid>`, then `rename`).
- An empty or missing file means zero active feedback for that session.
- Malformed lines are silently skipped during reads (lenient parsing).

### Mutation Semantics

| Operation | Behavior |
|-----------|----------|
| **New vote** | Appended as a new line |
| **Change vote** (e.g., up→down) | Existing line with same key replaced in-place |
| **Clear vote** (`value: "clear"`) | Existing line with same key removed; file shrinks |
| **New comment** | Appended as new line (independent from any vote on same target) |

The uniqueness key is computed as: `${actor}:${scope}:${targetId}`

This means for a given actor+scope+targetId combination, there is at most **one** entry in the file. With the addition of the `"comment"` value type, votes (`"up"` / `"down"`) and comments (`"comment"`) occupy separate key spaces since comment entries use the `"comment"` value.

### Session Meta Watermarks

When feedback is submitted, the session's `meta.json` is updated with:

| Field | Type | Description |
|-------|------|-------------|
| `feedbackFileSize` | `string \| null` | Current byte size of `feedback.jsonl` (as string) |
| `lastFeedbackAt` | `string \| null` | ISO-8601 timestamp of the most recent feedback submission |
| `cortexReviewedFeedbackBytes` | `number \| undefined` | Byte offset Cortex has reviewed up to |
| `cortexReviewedFeedbackAt` | `string \| null \| undefined` | When Cortex last reviewed feedback |

---

## 3. JSON Schema — FeedbackEvent (JSONL Line)

Each line in `feedback.jsonl` conforms to the following schema:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "FeedbackEvent",
  "description": "A single feedback entry representing the current state of a user's vote or comment on a message or session.",
  "type": "object",
  "required": [
    "id",
    "createdAt",
    "profileId",
    "sessionId",
    "scope",
    "targetId",
    "value",
    "reasonCodes",
    "comment",
    "channel",
    "actor"
  ],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique identifier for this feedback entry. Regenerated on every upsert (not stable across edits)."
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "description": "ISO-8601 timestamp of when this feedback was last submitted or updated."
    },
    "profileId": {
      "type": "string",
      "minLength": 1,
      "description": "The profile that owns the session. Matches the profile directory name."
    },
    "sessionId": {
      "type": "string",
      "minLength": 1,
      "description": "The session agent ID this feedback belongs to."
    },
    "scope": {
      "type": "string",
      "enum": ["message", "session"],
      "description": "Whether the feedback targets a specific message or the entire session."
    },
    "targetId": {
      "type": "string",
      "minLength": 1,
      "description": "The ID of the target. For scope=message, this is the message ID from the session JSONL. For scope=session, this MUST equal the sessionId."
    },
    "value": {
      "type": "string",
      "enum": ["up", "down", "comment"],
      "description": "The feedback direction. 'up' = positive, 'down' = negative, 'comment' = neutral comment without a vote direction."
    },
    "reasonCodes": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "accuracy",
          "instruction_following",
          "autonomy",
          "speed",
          "verbosity",
          "formatting",
          "product_ux_direction",
          "over_engineered",
          "great_outcome",
          "poor_outcome",
          "needs_clarification"
        ]
      },
      "uniqueItems": true,
      "description": "Zero or more reason codes qualifying the feedback. Deduplicated. See Reason Codes Reference for valid combinations per direction."
    },
    "comment": {
      "type": "string",
      "maxLength": 2000,
      "description": "Free-text comment. Empty string if no comment provided."
    },
    "channel": {
      "type": "string",
      "enum": ["web", "telegram", "slack"],
      "description": "The channel through which the feedback was submitted."
    },
    "actor": {
      "type": "string",
      "enum": ["user"],
      "description": "Who submitted the feedback. Currently always 'user'."
    }
  }
}
```

### Constraints

- When `scope` is `"session"`, `targetId` **must** equal `sessionId`. The service enforces this on both write and read (invalid entries are rejected/skipped).
- `reasonCodes` must only contain values from the `FEEDBACK_REASON_CODES` constant. Unknown codes cause submission rejection.
- `id` is a UUIDv4 regenerated on every upsert — it is **not** a stable identifier across vote changes.
- `comment` defaults to `""` (empty string), never `null` or `undefined`.

### Example JSONL File

```jsonl
{"id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","createdAt":"2026-03-05T14:30:00.000Z","profileId":"middleman-project","sessionId":"feeback-system","scope":"message","targetId":"msg-001","value":"down","reasonCodes":["accuracy","instruction_following"],"comment":"The response contradicted earlier context.","channel":"web","actor":"user"}
{"id":"b2c3d4e5-f6a7-8901-bcde-f12345678901","createdAt":"2026-03-05T14:32:00.000Z","profileId":"middleman-project","sessionId":"feeback-system","scope":"message","targetId":"msg-005","value":"up","reasonCodes":["great_outcome"],"comment":"","channel":"web","actor":"user"}
{"id":"c3d4e5f6-a7b8-9012-cdef-123456789012","createdAt":"2026-03-05T15:00:00.000Z","profileId":"middleman-project","sessionId":"feeback-system","scope":"session","targetId":"feeback-system","value":"up","reasonCodes":["autonomy","great_outcome"],"comment":"Great session overall.","channel":"web","actor":"user"}
{"id":"d4e5f6a7-b8c9-0123-defa-234567890123","createdAt":"2026-03-05T15:05:00.000Z","profileId":"middleman-project","sessionId":"feeback-system","scope":"message","targetId":"msg-001","value":"comment","reasonCodes":["needs_clarification"],"comment":"Can you elaborate on the data model here?","channel":"web","actor":"user"}
```

---

## 4. Reason Codes Reference

| Code | Human Label | Applies To | Diagnostic Signal |
|------|-------------|------------|-------------------|
| `accuracy` | Accuracy | up, down | **Up:** Response was factually correct and precise. **Down:** Response contained errors, hallucinations, or incorrect information. |
| `instruction_following` | Instruction Following | up, down | **Up:** Followed instructions exactly as given. **Down:** Ignored, misinterpreted, or deviated from explicit instructions. |
| `autonomy` | Autonomy | up, down | **Up:** Took appropriate initiative, made good independent decisions. **Down:** Was too passive (asked unnecessary questions) or too aggressive (acted without checking). |
| `speed` | Speed | up, down | **Up:** Completed task efficiently and quickly. **Down:** Took too long, too many round-trips, or wasted effort on unnecessary work. |
| `verbosity` | Verbosity | up, down | **Up:** Output length was appropriate. **Down:** Response was too long/wordy or too terse/incomplete. |
| `formatting` | Formatting | up, down | **Up:** Well-structured, clean formatting. **Down:** Poor formatting, hard to read, inconsistent style. |
| `product_ux_direction` | Product/UX Direction | up, down | **Up:** Made good product/UX decisions aligned with user intent. **Down:** Made poor product/UX choices that don't match what the user wanted. *(Renamed from `ux_decision`.)* |
| `over_engineered` | Over-Engineered | down | Response was unnecessarily complex, added unneeded abstractions, or gold-plated beyond what was asked. |
| `great_outcome` | Great Outcome | up | The end result was excellent — a strong positive holistic signal. |
| `poor_outcome` | Poor Outcome | down | The end result was poor — a strong negative holistic signal. |
| `needs_clarification` | Needs Clarification | up, down | **Up:** Good that it asked for clarification (appropriate uncertainty). **Down:** Should have asked for clarification instead of guessing. Signals ambiguity in the interaction. |

### Direction Validity Matrix

| Reason Code | ↑ Up | ↓ Down |
|-------------|------|--------|
| `accuracy` | ✓ | ✓ |
| `instruction_following` | ✓ | ✓ |
| `autonomy` | ✓ | ✓ |
| `speed` | ✓ | ✓ |
| `verbosity` | ✓ | ✓ |
| `formatting` | ✓ | ✓ |
| `product_ux_direction` | ✓ | ✓ |
| `over_engineered` | — | ✓ |
| `great_outcome` | ✓ | — |
| `poor_outcome` | — | ✓ |
| `needs_clarification` | ✓ | ✓ |

> **Note:** Direction validity is enforced in the UI reason picker, not at the storage layer. The backend accepts any valid reason code with any direction. When processing, be aware that unusual combinations (e.g., `great_outcome` + `down`) may exist from API usage but should be treated as noise.

---

## 5. API Endpoints

All endpoints are under the base URL `http://127.0.0.1:<BACKEND_PORT>`.

### 5.1 Submit Feedback

```
POST /api/v1/profiles/:profileId/sessions/:sessionId/feedback
```

**Request Body:**

```json
{
  "scope": "message",
  "targetId": "msg-001",
  "value": "down",
  "reasonCodes": ["accuracy", "instruction_following"],
  "comment": "Optional free-text comment",
  "channel": "web"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scope` | `"message" \| "session"` | Yes | |
| `targetId` | `string` | Yes (auto-filled for session scope) | Must equal sessionId when scope=session |
| `value` | `"up" \| "down" \| "comment" \| "clear"` | Yes | `"clear"` removes the existing entry |
| `reasonCodes` | `string[]` | Yes (can be `[]`) | Must be valid codes from `FEEDBACK_REASON_CODES` |
| `comment` | `string` | No (defaults to `""`) | Max 2000 characters |
| `channel` | `"web" \| "telegram" \| "slack"` | No (defaults to `"web"`) | |

**Response (201):**

```json
{
  "feedback": {
    "id": "a1b2c3d4-...",
    "createdAt": "2026-03-05T14:30:00.000Z",
    "profileId": "middleman-project",
    "sessionId": "feeback-system",
    "scope": "message",
    "targetId": "msg-001",
    "value": "down",
    "reasonCodes": ["accuracy", "instruction_following"],
    "comment": "Optional free-text comment",
    "channel": "web",
    "actor": "user"
  }
}
```

**Error (400/500):** `{ "error": "..." }`

### 5.2 List Session Feedback

```
GET /api/v1/profiles/:profileId/sessions/:sessionId/feedback
```

**Query Parameters (all optional):**

| Param | Type | Description |
|-------|------|-------------|
| `since` | ISO-8601 string | Only return events with `createdAt >= since` |
| `scope` | `"message" \| "session"` | Filter by scope |
| `value` | `"up" \| "down" \| "comment"` | Filter by value |

**Response (200):**

```json
{
  "feedback": [
    { /* FeedbackEvent */ },
    { /* FeedbackEvent */ }
  ]
}
```

### 5.3 Get Feedback State (Computed)

```
GET /api/v1/profiles/:profileId/sessions/:sessionId/feedback/state
```

Returns a summary of the latest feedback state per target. Useful for UI to restore vote indicators without parsing all events.

**Response (200):**

```json
{
  "states": [
    {
      "targetId": "msg-001",
      "scope": "message",
      "value": "down",
      "latestEventId": "a1b2c3d4-...",
      "latestAt": "2026-03-05T14:30:00.000Z"
    },
    {
      "targetId": "feeback-system",
      "scope": "session",
      "value": "up",
      "latestEventId": "c3d4e5f6-...",
      "latestAt": "2026-03-05T15:00:00.000Z"
    }
  ]
}
```

### 5.4 Query Feedback Across Sessions

```
GET /api/v1/feedback
```

Global query across all profiles and sessions. Primarily for Cortex review workflows.

**Query Parameters (all optional):**

| Param | Type | Description |
|-------|------|-------------|
| `profileId` | `string` | Narrow to a specific profile |
| `since` | ISO-8601 string | Only events after this timestamp |
| `scope` | `"message" \| "session"` | Filter by scope |
| `value` | `"up" \| "down" \| "comment"` | Filter by value |

**Response (200):**

```json
{
  "feedback": [
    { /* FeedbackEvent with profileId, sessionId, etc. */ }
  ]
}
```

Results are sorted by `createdAt` ascending, then by `id` for determinism.

### 5.5 Cortex Scan Feedback Watermarks

The cortex scan tool (`/api/cortex/scan` or `scanCortexReviewStatus()`) returns per-session review status that includes feedback watermarks:

```typescript
interface ScanSession {
  profileId: string;
  sessionId: string;
  // ... session content watermarks ...
  feedbackDeltaBytes: number;     // feedbackTotalBytes - feedbackReviewedBytes
  feedbackTotalBytes: number;     // Current size of feedback.jsonl
  feedbackReviewedBytes: number;  // Last reviewed byte offset
  feedbackReviewedAt: string | null;  // When Cortex last reviewed feedback
  lastFeedbackAt: string | null;  // When user last submitted feedback
  status: "never-reviewed" | "needs-review" | "up-to-date";
}
```

The `status` field accounts for **both** session content deltas and feedback deltas:
- `"up-to-date"` only when BOTH `deltaBytes === 0` AND `feedbackDeltaBytes === 0`
- `"never-reviewed"` when no review has ever happened (both `reviewedAt` and `feedbackReviewedAt` are null)
- `"needs-review"` otherwise

Sessions are sorted with needs-review first, ordered by combined delta size descending.

---

## 6. Cortex Processing Guidance

### 6.1 Finding Sessions with Unreviewed Feedback

**Step 1: Run cortex scan**

Use the cortex scan endpoint or function to get all sessions with their watermarks:

```bash
curl http://127.0.0.1:47187/api/cortex/scan
```

**Step 2: Filter for feedback deltas**

Look for sessions where `feedbackDeltaBytes > 0`. This means the `feedback.jsonl` file has grown since the last Cortex review. Note that because the file is upsert/delete (not append-only), `feedbackDeltaBytes` can be **negative** if votes were cleared (file shrank). Treat negative deltas as "needs re-review" too.

```
feedbackDeltaBytes > 0  → new feedback to process
feedbackDeltaBytes < 0  → feedback was cleared/changed, re-review needed
feedbackDeltaBytes = 0  → no changes since last review
```

### 6.2 Reading and Parsing Feedback Files

Read the JSONL file directly from disk:

```
~/.middleman/profiles/<profileId>/sessions/<sessionId>/feedback.jsonl
```

Parse line-by-line. Each non-empty line is a JSON object conforming to the FeedbackEvent schema. Skip blank lines and lines that fail JSON parsing.

```typescript
const lines = rawContent.split(/\r?\n/).filter(line => line.trim());
const events = lines.map(line => JSON.parse(line));
```

**Important:** Since the file is upsert-based, every line represents a **currently active** vote or comment. There are no historical/superseded entries. If you see a `"down"` vote on `msg-001`, that is the user's current sentiment — not a vote that may have been changed.

### 6.3 Interpreting Feedback Data

#### Votes vs Comments

| `value` | Meaning |
|---------|---------|
| `"up"` | User explicitly approved this message/session |
| `"down"` | User explicitly disapproved this message/session |
| `"comment"` | User left a comment without expressing directional sentiment |

A single target can have both a vote AND a comment simultaneously (they are keyed independently). When analyzing, consider both together for full context.

#### Message-Level vs Session-Level

- **Message-level** (`scope: "message"`): Feedback on a specific assistant response. The `targetId` is the message ID from the session JSONL.
- **Session-level** (`scope: "session"`): Holistic feedback on the entire session. `targetId === sessionId`.

Session-level feedback provides overall sentiment. Message-level feedback pinpoints specific moments.

#### Reason Code Patterns — Diagnostic Value

| Pattern | Signal | Recommended Action |
|---------|--------|--------------------|
| `down` + `accuracy` | Hallucination or factual errors | Flag for knowledge correction; check if knowledge base has stale info |
| `down` + `instruction_following` | Agent deviated from explicit instructions | Review system prompt adherence; check if instructions were ambiguous |
| `down` + `autonomy` | Agent was too passive or too aggressive | Tune archetype/system prompt for autonomy level |
| `down` + `over_engineered` | Excessive complexity | Note for future simplification guidance |
| `down` + `product_ux_direction` | Bad product/UX decisions | Update product knowledge/preferences |
| `down` + `poor_outcome` | General dissatisfaction with result | Broad quality signal; look for co-occurring specific reasons |
| `up` + `great_outcome` | Strong positive signal | Reinforce the patterns that led to this outcome |
| `up` + `autonomy` | Good independent decision-making | Note the decision pattern as a positive example |
| `*` + `needs_clarification` | Ambiguity in the interaction | **Up:** Agent appropriately asked for clarification. **Down:** Agent should have asked but didn't. Both indicate areas where instructions/context could be improved. |
| `comment` (no vote) + any reason | Neutral observation with context | User wants to annotate without judging; treat as informational signal |

### 6.4 Suggested Aggregation Approaches

#### Priority Queue: Messages Needing Attention

```
1. Filter: scope=message, value=down
2. Sort by: number of reason codes (more reasons = more specific signal)
3. Group by: reasonCode to find systemic issues
```

#### Session Quality Score

```
For each session:
  - Count up votes, down votes, and comments
  - Weight session-level feedback higher than message-level
  - down + poor_outcome or down + accuracy = high-priority session to review
```

#### Systemic Issue Detection

```
Across all sessions:
  - Aggregate reason codes across all down votes
  - If "accuracy" appears in >30% of downvotes → knowledge quality issue
  - If "instruction_following" is frequent → system prompt or archetype issue
  - If "over_engineered" is frequent → adjust complexity preferences
  - If "needs_clarification" is frequent → improve context/instruction clarity
```

#### Cross-Session Trend Analysis

Use the `GET /api/v1/feedback?since=<timestamp>` endpoint to pull feedback across all sessions since the last review. Group by `profileId` to identify profile-specific quality trends.

### 6.5 Updating Review Watermarks

After processing feedback for a session, update the session's `meta.json` to record the new watermark:

```json
{
  "cortexReviewedFeedbackBytes": <current feedbackFileSize as number>,
  "cortexReviewedFeedbackAt": "<current ISO-8601 timestamp>"
}
```

This ensures the next cortex scan correctly reports only new/changed feedback.

**Caveat:** Because the file uses upsert/delete semantics, the byte size can decrease. If `cortexReviewedFeedbackBytes > feedbackTotalBytes`, the file was compacted (votes cleared). Set the watermark to the current file size after re-reviewing.

### 6.6 Correlating Feedback with Session Content

To understand *what* a message-level vote refers to:

1. Read the session JSONL at `profiles/<profileId>/sessions/<sessionId>/session.jsonl`
2. Find the message entry whose `id` matches the feedback `targetId`
3. Read the message content and surrounding context to understand what was voted on

This correlation is essential for extracting actionable insights — a downvote on `msg-042` is meaningless without knowing what `msg-042` said.

---

## Appendix: File Paths Quick Reference

| File | Path | Purpose |
|------|------|---------|
| Feedback JSONL | `profiles/<profileId>/sessions/<sessionId>/feedback.jsonl` | Active feedback entries |
| Session meta | `profiles/<profileId>/sessions/<sessionId>/meta.json` | Watermarks, file sizes |
| Session JSONL | `profiles/<profileId>/sessions/<sessionId>/session.jsonl` | Conversation history (for correlating targetIds) |
| Session memory | `profiles/<profileId>/sessions/<sessionId>/memory.md` | Session working memory |
| Profile memory | `profiles/<profileId>/memory.md` | Shared profile memory |

All paths are relative to the data directory (default: `~/.middleman`).
