A profile is the set of settings, memory, and resources that a manager uses. When you create a new project in Forge, you're creating a profile.

## What a profile controls

- **Model and reasoning level** for the manager agent.
- **System prompt** (archetype and custom prompts).
- **Core memory** shared across all sessions in the profile.
- **Specialists** and their configuration.
- **Skills** and environment variables.
- **Reference documents** attached to the profile.

## Sessions and profiles

Each profile can have multiple sessions. Sessions start from the profile's config but keep their own conversation history, session memory, and stored model. Think of it as: the profile is the "who," and sessions are individual conversations.

New conversations copy the profile's default model. You can override the model for any individual session — including the root session — without affecting other sessions. Changing **Project Settings → Default model** or **Change Default Model** updates the project default for new conversations only; existing sessions retain their stored model. **Use Project Default** copies the current default onto that one session; later project-default changes do not cascade. The override action is available from the session context menu alongside the other session-management actions.

Remote profiles remain authoritative on their Forge server. Their project headers appear with blue styling and a globe marker when the connection's Remote Projects preference and server policy are enabled; nested session rows use status dots. Header actions are limited to **Change Working Directory**, which opens the server directory browser. Local rename, archive, delete, fork, and model actions remain absent. A remote connection may instead show connecting, sign-in-required, unreachable, server-disabled, update-required, or empty status until its projects can be selected.

## Project Settings

For a local Builder project, right-click its header and choose **Project Settings**, or use the header's hover/focus **…** menu. The page stays scoped to that project even if another conversation is selected. It groups project name, working directory, default model and reasoning, Context management, Project secrets, and Repository resources `.forge` controls. Context management is the project default for Summary vs experimental Context v2; it is not a Settings → General control. It is unavailable for Cortex and Remote Projects.

## Rename a profile

Use **Project Settings → Project name → Rename**, or the existing **Rename** header shortcut. This only changes the display name. The profile ID and data directory stay the same.

## Change default model

Use **Project Settings → Default model → Change**, or the existing **Change Default Model** header shortcut, to update the default model and supported reasoning level. That change applies to new conversations only. Existing sessions retain their stored model. **Use Project Default** copies the current default onto one session; later project-default changes do not cascade.

## Reorder profiles

Drag local and connected remote project headers in Inbox or Projects to intermix them. The order is saved automatically by your local Builder instance and shared by browsers or the desktop app connected to that instance. It is a display preference, not an access list: Forge does not write it to remote collaboration servers, and reordering a remote profile does not grant access or alter server policy. Projects that are offline, disabled, archived, or simply unseen by one client retain their positions. Forge never treats one browser's connection list or project snapshot as permission to remove another client's saved positions, so deleted projects or removed connections can remain as harmless hidden anchors until explicit local-instance cleanup is available. Local Cortex remains pinned above the reordered projects.

## Deleting a profile

Right-click the profile header and choose **Delete Manager**. This removes the profile and all its sessions, history, and memory permanently. The Cortex profile cannot be deleted.
