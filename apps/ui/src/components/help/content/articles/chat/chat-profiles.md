A profile is the set of settings, memory, and resources that a manager uses. When you create a new project in Forge, you're creating a profile.

## What a profile controls

- **Model and reasoning level** for the manager agent.
- **System prompt** (archetype and custom prompts).
- **Core memory** shared across all sessions in the profile.
- **Specialists** and their configuration.
- **Skills** and environment variables.
- **Reference documents** attached to the profile.
- **Integrations** like Telegram.

## Sessions and profiles

Each profile can have multiple sessions. Sessions inherit all config from the profile but maintain their own conversation history and session memory. Think of it as: the profile is the "who," and sessions are individual conversations.

By default, sessions use the profile's default model. You can override the model for any individual session — including the root session — without affecting other sessions. Sessions that still inherit the profile default pick up future default changes automatically. Use "Use Project Default" on a session to revert it to inherited state, and the override action is available from the session context menu alongside the other session-management actions.

## Rename a profile

Right-click the profile header in the sidebar and choose **Rename**. This only changes the display name. The profile ID and data directory stay the same.

## Change default model

Right-click the profile and choose **Change Default Model** to update the default model preset and reasoning level. Sessions still using the project default are updated automatically. Sessions with a model override are not affected. Changes take effect on the next message or session resume.

## Reorder profiles

Drag profile headers in the sidebar to rearrange them. The order is saved automatically.

## Deleting a profile

Right-click the profile header and choose **Delete Manager**. This removes the profile and all its sessions, history, and memory permanently. The Cortex profile cannot be deleted.
