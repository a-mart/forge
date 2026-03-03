---
name: memory
description: Update persistent swarm memory in ${SWARM_MEMORY_FILE} when the user explicitly asks to remember, update, or forget durable information.
---

# Persistent Memory Workflow

Use this skill when the user explicitly asks to:
- remember something for later,
- update previously remembered facts/preferences, or
- forget/remove stored memory entries.

Do not write memory for normal one-off requests.

## File location
- Use `${SWARM_MEMORY_FILE}` as the source of truth for the memory file path in this runtime (also shown in your loaded context).
- Do not derive memory paths manually from `${SWARM_DATA_DIR}` or agent/session IDs; the runtime resolves the correct memory owner and path.

## Steps
1. Read the current memory file with `read` before changing it.
2. Apply minimal edits:
   - prefer `edit` for targeted changes,
   - use `write` only for full rewrites.
3. Keep entries concise, factual, and durable.
4. Never store secrets (passwords, API keys, tokens, private keys) or highly sensitive personal data.
5. If the request is ambiguous, ask a clarifying question before writing.
6. After updating memory:
   - manager: confirm the update to the user via `speak_to_user`,
   - worker: report the update back to the manager via `send_message_to_agent`.
