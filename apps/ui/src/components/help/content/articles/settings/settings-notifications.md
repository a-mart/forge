Forge can play sounds when agents send messages or finish their work. You set baseline defaults once, and individual managers inherit them automatically. Any manager can override the defaults with its own settings.

## Global toggle

The main toggle at the top enables or disables all notification sounds. When it's off, no sounds play regardless of other settings.

## Notification defaults

The Defaults section sets baseline preferences that apply to all managers except Cortex. It has the same controls as per-manager settings: unread message sound, all-done sound, and volume.

When you change the defaults, every manager that hasn't been explicitly customized picks up the new settings automatically.

## Per-manager overrides

Below the defaults, each manager profile is listed. Managers using the defaults show a compact row with "Using defaults" and a **Customize** button. Click Customize to create a per-manager override that starts as a copy of the current defaults, then adjust whatever you need.

Managers with overrides show the full controls plus a **Reset to defaults** button. Resetting removes the override and the manager goes back to inheriting defaults.

Each manager has three sound triggers:

- **Unread message sound** — plays when a manager sends a message you haven't read yet.
- **Question sound** — plays when an agent presents a structured choice or question (via the choice picker tool). When enabled, this takes priority over the unread message sound for choice request events. When disabled, choice requests fall back to the regular unread sound.
- **All done sound** — plays when a manager finishes with no workers still running.

## Cortex

Cortex always has its own standalone settings and never inherits from the defaults. This prevents automated review sessions from triggering sounds meant for interactive managers.

## Custom sounds

Upload your own notification sounds in MP3, WAV, or OGG format (max 2 MB per file). Custom sounds appear alongside the built-in options in every sound picker. Click the play button to preview a sound before selecting it.

To remove a custom sound, click the trash icon next to it. Any manager or the defaults using that sound falls back to the built-in default.

## CLI notifications

The **Mute CLI-originated notifications** toggle suppresses notification sounds for sessions that were created by the Forge CLI, as well as replies to messages sent via the CLI. Unread badges still update normally — only sounds are silenced.

This is useful when you have automated CLI workflows (scripts, CI pipelines, scheduled tasks) that generate activity you don't need audible alerts for.

## Tips

- The question sound is enabled by default and uses a dedicated audio file. It helps you notice when agents need your input for a decision.
- Set a distinct "all done" sound in the defaults so you hear when any long task finishes.
- Use per-manager overrides only when you need to tell managers apart by ear.
- Cortex settings are separate — configure them if you want sounds for automated reviews.
- If you prefer not to hear question alerts, disable the question sound in defaults — choice requests will fall back to the regular unread sound instead.
- Enable "Mute CLI-originated notifications" if you use the Forge CLI for background automation and don't want sound alerts for that activity.
