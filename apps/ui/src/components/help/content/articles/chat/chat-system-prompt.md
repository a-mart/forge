The **Initial Model Input** viewer shows the exact provider-independent context captured for a session's first Pi model-request attempt. It is a read-only first-request record, not a live preview of the agent's current prompt.

## How to open it

Switch to the **All** channel view using the toggle in the chat header. In the wide chat header, a scroll icon immediately to the left of that toggle opens the viewer. It is deliberately an **All**-only diagnostic entry point; it is not part of the normal transcript.

## What's included

After the first request, the viewer shows:

- The final **system prompt** as it existed for that request. Depending on the session, it can include the base prompt, memory, `AGENTS.md` guidance, knowledge, loaded skills, date, working directory, and a `before_agent_start` override.
- The provider-independent request messages and the tool definitions supplied for that request, including their schemas.
- The selected provider and model, capture timestamp, fidelity notes, and a safe projection of request metadata.
- A raw JSON copy of the captured record.

Image payloads are summarized by byte count instead of retaining base64 data, and executable functions are not retained. Request metadata omits recognized sensitive fields, but the prompt, messages, and tool definitions are shown as captured rather than being a general-purpose redaction view. Treat the viewer and its copied JSON as sensitive session content.

## Persistence, copies, and forks

Forge stores one first-request record with the session history. Reopening the dialog, reconnecting, restarting, compacting, or recycling the runtime reads that same record; later requests do not replace it. The copy button copies the complete displayed record to your system clipboard.

Forks deliberately omit the source record. A Pi-backed fork records its own initial input when it makes its first model request.

## When it's not available

Until a Pi session has a saved first-request record—including sessions created before capture was available—the dialog says **Available after the first model request.** The capture is Pi-only; Cursor SDK sessions are currently unsupported, and other non-Pi runtime paths do not create this record.
