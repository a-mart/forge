Forge can play sounds for unread manager messages, questions that need a choice, and a completed session. Set baseline defaults once; individual managers inherit those defaults until you customize them.

## Global toggle and defaults

The main toggle enables or disables every notification sound. When it is off, no notification sound plays regardless of a manager's individual settings.

The **Defaults** section applies to all managers except Cortex. It includes unread-message, question, and all-done sounds plus volume. Changing a default immediately affects every manager that has not been customized.

## Per-manager overrides

A manager using the defaults shows **Using defaults** and **Customize**. Customize creates a per-manager copy of the current defaults. A customized manager shows its controls and **Reset to defaults**, which removes the override.

Each manager has three sound triggers:

- **Unread message** plays for an unread ordinary notification from the manager.
- **Question** plays for a structured choice request. It takes priority over the unread sound; if disabled, the regular unread sound is used instead.
- **All done** is a completion signal, not a sound for every lifecycle change. When a manager's unread notification arrives while work is still streaming, Forge can play unread then recheck at idle. It plays all done only after the manager is idle and no workers are still streaming. A choice request never starts an all-done signal.

## Cortex and custom sounds

Cortex always has standalone settings and never inherits the defaults, so scheduled or direct Cortex activity can be configured separately.

You can upload MP3, WAV, or OGG sounds up to 2 MB. Preview a sound before choosing it. Removing a custom sound makes any setting that used it fall back to the built-in default.

## CLI notifications

**Mute CLI-originated notifications** suppresses sounds for Forge CLI-created sessions and replies to CLI-originated messages. Unread badges still update; only audio is muted.

## Tips

- Keep the question sound enabled if you need to notice decisions promptly.
- Give all-done a distinct sound for long-running work.
- Use per-manager overrides only when you need different audible identities.
- Mute CLI-originated notifications for unattended automation.
