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

## Commands

Run the scheduler CLI from this skill directory:

```bash
node ./schedule.js add \
  --manager "manager" \
  --name "Daily standup reminder" \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --timezone "America/Los_Angeles"
```

One-shot schedule (fires once at the next matching cron time):

```bash
node ./schedule.js add \
  --manager "manager" \
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

`--manager` is optional. If omitted, the CLI will auto-select a manager when there is only one manager
or when a known default manager is detected.

## Output

All commands return JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
