The system prompt viewer shows you the complete prompt that the agent is actually using at runtime. This is the full context the model sees before your messages.

## How to open it

Switch to the **All** channel view using the toggle in the chat header. A scroll icon button appears to the left of the channel toggle. Click it to open the system prompt dialog.

The viewer is only available in "All" mode because it shows runtime internals.

## What's included

The system prompt includes more than what you see in the prompt editor in Settings. The full runtime prompt typically contains:

- The **base system prompt** (from the archetype or custom prompt template).
- **Memory context** (profile core memory and session memory).
- **AGENTS.md** guidance loaded from the working directory.
- **Loaded skills** and their instructions.
- Any **custom instructions** like pinned message content.

## Copy and refresh

Click the **copy** button in the header to copy the full prompt to your clipboard. The prompt is fetched fresh each time you open the dialog, so it reflects the current state.

## When it's not available

Agents created before system prompt persistence was added won't have a stored prompt. The dialog will show a message explaining this.
