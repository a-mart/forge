Cortex manages knowledge files that your manager sessions read for context. There are two levels: common knowledge shared across all profiles, and per-profile memory scoped to individual managers.

## Common knowledge

The common knowledge file stores facts and preferences that apply everywhere. This includes things like your workflow style, technical standards, communication preferences, and known gotchas that Cortex has learned from reviewing your sessions.

All managers can read common knowledge. Cortex updates it when reviews surface patterns that are broadly useful — not tied to one specific project or profile.

## Per-profile memory

Each profile has its own memory file. This contains project-specific context, decisions, and working notes relevant to that profile's sessions. Profile memory is injected into sessions alongside common knowledge, so managers get both general and project-specific context.

## Viewing and editing

Open the Cortex dashboard and go to the **Knowledge** tab. Use the dropdown at the top to switch between Common Knowledge and individual profile memory files. The file size is shown next to each profile name.

You can edit any knowledge file directly:

1. Select the file from the dropdown.
2. Click the edit button (pencil icon) in the toolbar.
3. Make your changes in the editor.
4. Click save, or cancel to discard.

The content is markdown. Cortex uses structured sections with headers like "Workflow Preferences", "Technical Standards", and "Known Gotchas" to organize what it learns. You can restructure these however you want — Cortex will respect your edits in future reviews.

## When knowledge updates

Knowledge changes when Cortex completes a review run. It reads session transcripts and feedback, extracts durable facts, and merges them into the relevant knowledge file. You can also edit files manually at any time — your changes take effect immediately for new sessions.
