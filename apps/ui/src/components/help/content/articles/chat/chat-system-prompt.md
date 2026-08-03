The **Initial Model Input** viewer shows the exact provider-independent context captured for a session's first Pi model-request attempt. It is a read-only first-request record, not a live preview of the agent's current prompt.

## How to open it

Switch to the **All** channel view using the toggle in the chat header. In the wide chat header, a scroll icon immediately to the left of that toggle opens the viewer. It is deliberately an **All**-only diagnostic entry point; it is not part of the normal transcript.

## What's included

The default **Prompt** view keeps the captured request readable:

- The final **system prompt** is one continuous page with colored source labels for resolved system instructions, project files such as `AGENTS.md`, memory, skills, reference material, recovery context, and runtime details.
- The available-skills catalog is formatted as cards with each skill's name, description, and source location instead of showing its XML markup.
- Tool definitions appear as cards with their descriptions, required inputs, and top-level parameter types. Each card can reveal its complete schema.
- The provider, model, and capture time appear as compact context above the prompt.
- A token summary shows the provider-reported input total from the actual first response when available. It also estimates the visible system prompt, messages, and tools; each prompt source, skill, and tool has its own estimate.

The provider-reported total includes normalized uncached, cache-read, and cache-write input reported for that first request. It requires a completed response with usage data, so failed, incomplete, older, or non-reporting requests fall back to a clearly labeled rough total.

Section counts and fallback totals use Forge's provider-independent approximation of about four characters per token. They cover the captured system prompt, converted messages, and tool definitions but exclude request metadata, provider-specific framing, and image tokenization. They are useful for relative size, not provider-exact accounting.

Use the **Raw JSON** toggle for the complete persisted record, including provider-independent messages and safe request metadata. Image payloads are summarized by byte count instead of retaining base64 data, and executable functions are not retained. Request metadata omits recognized sensitive fields, but the prompt, messages, and tool definitions are shown as captured rather than being a general-purpose redaction view. Treat the viewer and copied content as sensitive session content.

## Persistence, copies, and forks

Forge stores one first-request record with the session history. Reopening the dialog, reconnecting, restarting, compacting, or recycling the runtime reads that same record; later requests do not replace it. The copy button copies the system prompt in **Prompt** view or the complete record in **Raw JSON** view.

Forks deliberately omit the source record. A Pi-backed fork records its own initial input when it makes its first model request.

## When it's not available

Until a Pi session has a saved first-request record—including sessions created before capture was available—the dialog says **Available after the first model request.** The capture is Pi-only; Cursor SDK sessions are currently unsupported, and other non-Pi runtime paths do not create this record.
