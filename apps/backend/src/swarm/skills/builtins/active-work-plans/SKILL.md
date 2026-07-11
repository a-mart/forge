---
name: active-work-plans
description: Use when substantial manager-led work needs durable visible progress, worker evidence links, review gates, blocker tracking, or handoff across pauses, stops, compaction, restart, or model changes. Do not use for quick answers or routine one-step work.
---

# Active Work Plans

Use this skill when a visible Work Plan would make substantial manager-led work easier to follow or recover. A Work Plan is descriptive coordination state, not a workflow runner. Execution stays manager-led through normal Forge tools: spawn workers, ask choices, inspect evidence, validate, and synthesize the final answer.

Do not create a Work Plan as a ritual first step. Unless the user explicitly asks for one or the task is clearly substantial/recoverability-sensitive, investigate the request first and decide from evidence whether durable tracking is useful. Be especially conservative when the reported bug involves Work Plan UI itself; avoid adding noisy plan state that could obscure the user's actual repro.

Creating or updating a Work Plan is not meaningful execution progress by itself. When the next step is clear, pair plan creation with immediate real work in the same turn: spawn or steer the worker, inspect evidence through the appropriate route, ask a required choice, or otherwise continue execution. Never let a plan card be the only visible action after telling the user you will investigate, patch, validate, or otherwise begin work.

Quick, standard, and deep are sizing guides for how compact the plan should be, not required process stages. Use the smallest mode that preserves visibility and handoff.

## Trigger check

Use an Active Work Plan when one or more of these are true:

- the user explicitly asks you to create, show, finish, or use an Active Work Plan, Work Plan, task plan, or `task` tool;
- the request has several meaningful phases;
- multiple workers, review passes, or remediation rounds are likely;
- the user benefits from seeing what is active, blocked, done, failed, or waiting;
- worker reports or validation evidence need durable links or summaries;
- the work may pause, stop, fork, compact, restart, switch models, or resume later;
- a final answer needs to account for partial failures, skipped validation, review gates, or blockers.

## Do not create or update a plan when

- the user needs a quick answer;
- the task is a simple one-step edit, check, or explanation;
- one obvious worker can handle it without durable progress tracking;
- the update would only record routine motion, such as reading a file or running one command;
- the plan would be more verbose than the work;
- the user explicitly asks not to use structured tracking.

If you are unsure, prefer no plan for small work and a compact plan for substantial work.

## Core rules

- Keep the plan concise. Use short phases and item labels.
- Treat the plan as coordination state only; it does not satisfy any investigation, implementation, validation, or handoff item until real evidence or worker output exists.
- Track user-relevant outcomes, not every action.
- Link relevant workers as evidence. In v1, `task.link` supports worker links only.
- In provider-facing v1, treat item labels and item statuses as create-time structure plus worker links. Reflect later evidence through worker links and an honest final summary, status, and warnings.
- If new evidence makes the original plan wrong, do not pretend it was perfect. Explain material changes in normal chat or in the final summary.
- Use existing choice requests for approvals. Do not invent a second approval flow in plan text.
- Do not infer success from a worker becoming idle. Use explicit worker reports, evidence, tests, or manager judgment.
- Use honest final states: completed, completed with warnings, failed, stopped, blocked, or interrupted.
- A completed plan does not replace the final response. Always synthesize the outcome in normal chat.

## Plan size

A useful plan usually has 2 to 5 phases or items. Prefer this level of detail:

```text
Inspect backend mutation flow
Implement persisted coordination store
Run fork/leakage tests
Review failure and stop states
```

Avoid this level of detail:

```text
Read file A
Read file B
Run grep
Ask worker for status
Parse worker message
Update plan note
```

Do not put raw worker prompts, full worker transcripts, raw JSON, long logs, filesystem paths, secrets, or unbounded results into the plan. Summarize the evidence instead.

## Manager tool usage

Use the manager-only `task` tool when available. It records descriptive coordination state; it does not execute work. If the user explicitly asks for an Active Work Plan, Work Plan, task plan, or `task` tool action, call `task` before claiming the plan exists.

- `get`: recover the current plan state before continuing after a pause, compaction, restart, model switch, or uncertainty.
- `upsert_plan`: create a new active plan with `itemsText`, one short item per line, plus top-level title/goal/mode/status fields. Keep revision notes short.
- `update_item_status`: mark one item's status after worker evidence without rewriting the item list.
- `link`: attach a relevant worker to the plan or item as evidence.
- `finish_plan`: close the plan honestly as completed, completed with warnings, failed, stopped, or interrupted.

Use these actions at meaningful boundaries only: plan creation paired with immediate execution/delegation, worker launch/linking, recovery with `get`, stop/interruption, and final synthesis.

Tool-call reliability rules:

- The `task` tool input is a single object with top-level `action`.
- Use `action: "upsert_plan"` to create a plan. Do not use `create`, `set_status`, `update_plan`, or nested action objects.
- For model-generated plan creation, use `itemsText` with one item per line, preferably `[status] title`.
- `itemsText` is create-only. Do not use `itemsText` when revising an existing plan's item list.
- Do not send `items`, `planText`, JSON strings, markdown task syntax, or nested item arrays from normal provider-facing tool calls.
- Use `update_item_status` for meaningful item progress or completion after worker evidence. Do not rewrite the full item list through `upsert_plan`.
- Do not put JSON, links, URLs, file paths, or reference syntax in `itemsText`.
- If the plan already exists, use `get`, `update_item_status`, `link`, or `finish_plan`; do not attempt item-list rewrites from the manager prompt.
- Do not add fields that are not in the examples or schema.

`task.get` returns `stateRevision` plus the full bounded `snapshot`. Successful mutations return compact acknowledgements with `stateRevision`, `planId`, `planRevision`, current plan `status`, and sometimes `createdItemIds`, `updatedItemId`, or `linkedItemId`. Prefer passing the latest `stateRevision` as `expectedStateRevision` when linking, updating item status, or finishing an existing plan.

If a `task` result returns `ok: false` with `error.recoverable: true`, treat it as a recoverable result, not a reason to stop or go silent. Follow `error.suggestedAction`: call `task.get` when the state or ids may be stale, retry with fresh `planId`, `itemId`, or `expectedStateRevision` when the input shape was wrong, or continue without plan state if the plan sidecar cannot safely represent the work. Do not auto-retarget a mutation to a different plan. When closing or pausing a user turn, use the appropriate output path: normal final text only for the active direct-web user turn; routine direct-web worker callbacks are internal decision turns, and accepted outcomes or material blockers originating from them use explicit `speak_to_user` delivery; brief assistant progress text only for direct web/session progress followed by same-turn tool, delegation, or coordination work; `speak_to_user` for collaboration, Cortex/review, non-web, proactive external, or unknown/protected worker-report closeouts; peer reply/delegation when not user-facing. If no same-turn action follows a direct-web assistant message, that message ends the turn and must be final/standalone.

## Valid tool input shapes

These are tool input objects. Pass them to the `task` tool as structured arguments, not as quoted JSON strings.

Create a compact plan with `itemsText`:

```json
{
  "action": "upsert_plan",
  "title": "Fix chat header count regression",
  "goal": "Find the unread-count mismatch, patch the smallest shared bug, and validate the UI path.",
  "mode": "quick",
  "status": "active",
  "itemsText": "[active] Inspect count source and replay path\n[todo] Patch the shared state bug\n[todo] Run targeted validation",
  "revisionNote": "Started compact plan for visible progress."
}
```

Link a worker after spawning it:

```json
{
  "action": "link",
  "planId": "<planId>",
  "itemId": "<itemId>",
  "link": { "type": "worker", "agentId": "<workerAgentId>", "label": "Backend investigation" }
}
```

Mark one item done after reviewing worker evidence:

```json
{
  "action": "update_item_status",
  "planId": "<planId>",
  "itemId": "<itemId>",
  "expectedStateRevision": 4,
  "status": "done"
}
```

Finish honestly:

```json
{
  "action": "finish_plan",
  "planId": "<planId>",
  "expectedStateRevision": 7,
  "status": "completed_with_warnings",
  "finalSummary": "Patched the count source and ran targeted UI validation.",
  "warnings": ["Full test suite was not run."]
}
```

These examples are illustrative, not exhaustive schema documentation. The provider-facing shape is intentionally small: one top-level `action`, exact action names, `itemsText` only for create-time item lists, status-only `update_item_status`, worker-only `link`, and terminal `finish_plan`.

## Reflecting worker results

When you spawn a worker for planned work, link the worker to the relevant item. After the worker reports:

1. Read the result and decide whether it actually satisfies the planned work.
2. Do not infer success from worker process state alone.
3. Update item status with `update_item_status` when an item materially progresses or completes.
4. Update top-level plan state only when the overall status, scope, or risk materially changes.
5. Keep detailed findings in the worker transcript or final synthesis, then use `finish_plan` with an honest terminal state when the plan is done, stopped, failed, or completed with warnings.

If a worker fails, stalls, is stopped, or ends without a usable report, do not greenwash it. Reflect the uncertainty in top-level status, the final summary, or warnings instead of pretending every item succeeded.

## User-facing status updates

Use plan updates to keep the UI current. Do not narrate every plan update in chat, and do not send chat updates merely to say that routine plan state changed. If the only thing you have done is create or update the plan, keep going rather than treating that as a status update.

Send a concise user-facing update only when it is useful:

- starting a substantial multi-phase effort;
- reaching a review or decision gate;
- hitting a blocker that needs user input;
- changing scope in a material way;
- stopping work;
- completing work.

For routine progress, update the plan state and keep working.

## Quick mode: 2 to 5 items

Use quick mode when the work is small but still benefits from a compact visible checklist.

```text
Title: Fix chat header count regression
Goal: Identify and patch the unread-count mismatch, then validate the affected UI path.
Items:
1. Inspect count source and replay path
2. Patch the smallest shared state bug
3. Run targeted validation
4. Summarize result and risk
```

Keep updates sparse. Do not spawn extra workers or add review gates unless the evidence calls for it.

## Standard implementation flow

Use standard mode for normal feature or bug work with investigation, implementation, validation, and review.

```text
Title: Add Active Work Plan sidecar support
Goal: Persist a session-scoped coordination file with safe writes and compact snapshots.
Items:
1. Confirm schema and lifecycle decisions
2. Implement store and mutation service
3. Add tests for defaults, corrupt files, and races
4. Review the diff for scope creep and simplification
5. Run targeted validation and handoff
```

Link implementation and review workers to their item. Record skipped checks, failed tests, or unresolved risk as warnings. Complete as `completed_with_warnings` when meaningful uncertainty remains.

## Deep multi-round effort

Use deep mode for broad work with discovery, planning, implementation, independent review, and remediation gates.

```text
Title: Ship Active Work Plans MVP
Goal: Deliver progress visibility without adding workflow execution semantics.
Items:
1. Gate A decisions
2. Backend coordination store and DTOs
3. Manager tool and lifecycle integration
4. UI card and header indicator
5. Security/product/backend review gate
6. Remediation and final validation
```

Keep the plan high-level. Link worker batches to review or implementation items instead of creating one item per worker. Use review gates explicitly. Revise between rounds rather than creating competing active plans.

## Stopping, blocking, and partial completion

When the user stops work, use neutral copy and preserve partial evidence. For example: "Work stopped. Partial results kept."

When work is blocked, record what is blocked and what would unblock it. Do not keep marking unrelated items as running.

When the result is useful but incomplete, say so. Use completed with warnings when there are skipped validations, partial worker failures, unresolved review comments, or assumptions the user should know about.

## Anti-patterns

Avoid these:

- creating a plan for every request;
- creating a plan just because the request has two small steps;
- making the plan more detailed than the work;
- treating the plan as a rigid workflow that overrides new evidence;
- serializing useful parallel work into artificial phases;
- creating one item per command, file, worker heartbeat, or status check;
- creating one item per worker unless each worker maps to a user-relevant outcome;
- marking success from worker idle state alone;
- hiding failed, skipped, stopped, or unverified work behind a green completed state;
- duplicating transcripts, logs, raw prompts, secrets, paths, or long outputs inside plan notes;
- using plan text instead of choice requests for approvals;
- adding hidden workers, automatic retries, executable templates, scheduler behavior, dependencies, or workflow-run semantics;
- using the plan card as a substitute for final manager synthesis.

## Completion expectations

When finishing planned work, provide the normal manager handoff:

- what was done;
- what changed or was produced;
- what was verified;
- warnings, risks, or skipped checks;
- any follow-up needed.

Keep the final response concise. The plan carries progress state; the chat response should carry the outcome.
