The system prompt viewer shows the exact provider-independent input captured for the session's first Pi model request. It is a read-only record of the context Pi handed to the model before provider-specific conversion.

## How to open it

Switch to the **All** channel view using the toggle in the chat header. A scroll icon button appears to the left of the channel toggle. Click it to open the system prompt dialog.

The viewer is only available in "All" mode because it shows runtime internals.

## What's included

After the first request, the viewer shows:

- The final **system prompt**, including the base prompt, memory, `AGENTS.md` guidance, knowledge, loaded skills, date, working directory, and any `before_agent_start` override.
- The **converted messages** and active tool definitions with their schemas.
- The selected provider and model, safe request metadata, capture timestamp, and fidelity notes.
- A raw JSON copy of the captured record.

Image bytes are summarized instead of copying base64 payloads. Functions, credentials, headers, environment values, and other authentication fields are omitted.

## Copy and refresh

Click the **copy** button in the header to copy the raw captured input. The dialog is fetched fresh each time you open it, but this first-request record does not change later in the session.

## When it's not available

Before a Pi session sends its first model request, the dialog says **Available after the first model request.** Cursor SDK sessions are currently unsupported by this viewer.
