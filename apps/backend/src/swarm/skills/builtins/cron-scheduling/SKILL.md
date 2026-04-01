---
name: cron-scheduling
description: Create, list, and remove persistent scheduled tasks using cron expressions.
---

# Cron Scheduling

Use this skill when the user asks to schedule, reschedule, or cancel reminders/tasks for later.

Before creating a schedule, confirm:
- exact schedule timing (cron expression),
- timezone (IANA, for example `America/Los_Angeles`),
- task message content.

If the request is ambiguous, ask a follow-up question before adding a schedule.

## Storage

- Schedule data is stored under `${SWARM_DATA_DIR}`.
- Do not hardcode schedule file paths; the scheduler CLI resolves the correct storage location for the selected manager.
- `--session` is required when adding a schedule. Every schedule must target a specific session.

## Session ID guidance

Every new schedule must include `--session`.

- Workers should usually schedule against their owning manager session ID. This is available from the `SWARM_SESSION_ID` env var when present, or from the agent identity / session context already provided to the runtime.
- Managers should use their own session / agent ID.

## Commands

Run the scheduler CLI from this skill directory:

```bash
node ./schedule.js add \
  --manager "manager" \
  --session "manager--s2" \
  --name "Daily standup reminder" \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --timezone "America/Los_Angeles"
```

One-shot schedule (fires once at the next matching cron time):

```bash
node ./schedule.js add \
  --manager "manager" \
  --session "manager--s2" \
  --name "One-time deployment check" \
  --cron "30 14 * * *" \
  --message "Check deployment status" \
  --timezone "America/Los_Angeles" \
  --one-shot
```

Remove a schedule:

```bash
node ./schedule.js remove \
  --manager "manager" \
  --id "<schedule-id>"
```

List schedules:

```bash
node ./schedule.js list --manager "manager"
```

`--session` is required for `add`.

`--manager` is optional. If omitted, the CLI will auto-select a manager when there is only one manager
or when a known default manager is detected.

## Output

All commands return JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
