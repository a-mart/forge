Type in the text area at the bottom and press **Enter** to send. That's the default quick-send mode.

## Two input modes

Forge has two input modes, toggled with the **Aa** button (or `Shift+Cmd+X` / `Shift+Ctrl+X`):

- **Quick-send mode** (default): Enter sends the message. Shift+Enter adds a new line.
- **Format mode**: Enter adds a new line. Cmd+Enter (Ctrl+Enter on Windows/Linux) sends. A formatting toolbar appears with bullet and numbered list buttons.

Your mode preference is saved across sessions.

## Changing the session model

Eligible Builder manager sessions show a compact model pill beside **Send**. The pill shows the effective model and reasoning level; hover it to see whether the session is using the project default or a session override. Click it to open **Session Model**, where you can choose a model and reasoning level for this session. If the session already has an override, **Use Project Default** applies the current project default to that session. Later default changes affect only new conversations.

For Remote Projects, the pill loads model availability from and applies the change to the active project's server. It is hidden when you are viewing a worker, a Collaboration channel, or a system profile such as Cortex.

## Changing context management

Eligible local Builder managers also show a compact **Context management** control beside Send. It reports the effective policy (Summary or Fresh windows) and whether that comes from the project default or a session override. Open it to inherit the project default, force Summary, or opt into experimental Fresh windows. Saving a choice does not clear the current conversation; it applies at the next Compact, Smart compact, or automatic context transition.

Fresh is executable only by supported ordinary Pi Builder managers (OpenAI/Codex or Anthropic). The control is hidden for workers, Collaboration channels, Remote Projects, and system profiles such as Cortex. If the current runtime cannot execute Fresh, that option is disabled with the server's reason; Compact and Smart compact still follow the effective supported policy.

### Model-change notices

When a model or reasoning change is accepted for a session, Forge adds a neutral **Model change** notice to that session's conversation. It appears live and remains visible after reload or replay. The notice records the effective before-and-after values, for example: `Model changed from GPT-5.5 (reasoning: xhigh) to GPT-5.6 Luna (reasoning: high).` It is informational conversation history, not an assistant or user message.

The Send-adjacent work-mode control chooses Delegate first, Adaptive, or Hands-on for subsequent turns.

A notice is added only when the effective model or reasoning changes. Choosing the same effective settings again does not add one. Changing a project default affects sessions that still inherit it, so each inherited session that actually changes can receive a notice; sessions with an override are unaffected. **Use Project Default** can add a notice when it changes the session's effective model or reasoning, but not when the session already matches the project default.

## Replying to a message

Hover a visible normal user or assistant message and click **Reply** to attach it as the target for your next send. The composer preview means your message will include that quoted context. Use the clear control to remove the target, or click Reply on a different message to change it before sending.

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

In Builder web, a plain leading @Codex or [@Codex] routes the message text to a direct Codex app-server sidecar thread. Use it for text-only handoff to an external Codex app-server thread. Attachments are not sent, Collaboration channels do not support it, and Forge allows only one active direct Codex turn at a time. If you use @Codex -<plugin>, @Codex:<plugin>, or [@Codex:<plugin>] mention, Forge scopes the turn to a plugin, shows a plugin picker with enabled/available plugins from Codex plugin/list, lets you navigate the picker with ArrowUp/ArrowDown, and inserts a structured chip like `[@Codex:fireflies]`. The selector turn reaches the manager, which delegates to the visible Codex Plugin specialist worker with read-only scoped tools and bounded redacted previews/metadata. Full connector exports, such as Fireflies transcripts or summaries, are written to session artifacts rather than relayed in chat chunks; the returned chat result is only path/metadata plus a bounded preview. If a scoped Codex Plugin worker is stopped or fails, an explicit retry or clear continuation turn can reuse the server-stored scope without re-tagging, but unrelated turns clear that retry context. If you select the Codex sidecar, a direct follow-up continues that selected sidecar thread.
