Type in the text area at the bottom and press **Enter** to send. That's the default quick-send mode.

## Two input modes

Forge has two input modes, toggled with the **Aa** button (or `Shift+Cmd+X` / `Shift+Ctrl+X`):

- **Quick-send mode** (default): Enter sends the message. Shift+Enter adds a new line.
- **Format mode**: Enter adds a new line. Cmd+Enter (Ctrl+Enter on Windows/Linux) sends. A formatting toolbar appears with bullet and numbered list buttons.

Your mode preference is saved across sessions.

## Slash commands

Type `/` to open a command picker. Slash commands are shortcuts that expand into predefined prompts. You can create custom ones in Settings > Slash Commands.

Arrow keys navigate the list. Enter or Tab selects a command.

## Drafts

If you switch sessions with unsent text, Forge saves it as a draft. When you switch back, the draft is restored. Drafts also survive page refreshes.

## Voice input

Click the microphone button to record a voice message. Forge transcribes it and inserts the text into the input area. Recording stops automatically after the time limit. Requires an OpenAI API key configured in Settings > Authentication.

## Sending while streaming

You can send follow-up messages while the agent is still responding. The input field stays active during streaming so you can queue up additional instructions or corrections.

## Sending to Codex

In Builder web, a plain leading @Codex or [@Codex] routes the message text to a direct Codex app-server sidecar thread. Use it for text-only handoff to an external Codex app-server thread. Attachments are not sent, Collaboration channels do not support it, and Forge allows only one active direct Codex turn at a time. If you use @Codex -<plugin>, @Codex:<plugin>, or [@Codex:<plugin>] mention, Forge scopes the turn to a plugin, shows a plugin picker with enabled/available plugins from Codex plugin/list, lets you navigate the picker with ArrowUp/ArrowDown, and inserts a structured chip like `[@Codex:fireflies]`. The selector turn reaches the manager, which delegates to the visible Codex Plugin specialist worker with read-only scoped tools and bounded redacted results. If you select the Codex sidecar, a direct follow-up continues that selected sidecar thread.
