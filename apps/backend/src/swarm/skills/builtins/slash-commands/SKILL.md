---
name: slash-commands
description: Create, update, list, and delete global slash commands.
---

# Slash Commands

Use this skill when the user asks to manage reusable `/` commands.

Slash commands are global (shared across profiles/sessions) and stored under:
- `${SWARM_DATA_DIR}/shared/slash-commands.json`

Run the CLI from the repository root.

## Commands

List all slash commands:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js list
```

Create a command:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js create \
  --name "summarize" \
  --prompt "Summarize the latest changes and open risks."
```

Update by id:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js update \
  --id "<command-id>" \
  --new-name "summary" \
  --prompt "Summarize the latest changes."
```

Update by name:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js update \
  --name "summarize" \
  --new-name "summary" \
  --prompt "Summarize the latest changes."
```

Delete by id:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js delete \
  --id "<command-id>"
```

Delete by name:

```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js delete \
  --name "summary"
```

## Validation rules

- Name must be non-empty.
- Name must use only alphanumeric characters, hyphens, and underscores.
- Name must not start with `/`.
- Duplicate names are rejected (case-insensitive).
- Prompt must be a non-empty string.

## Output

All commands print JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
