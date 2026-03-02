# Telegram Multi-Session Setup Guide

After the latest update, Middleman supports **per-session Telegram topics** — each session gets its own thread in your Telegram chat with the bot. Here's what you need to do on the Telegram side.

---

## Quick Setup (Private DM with Bot)

### 1. Enable Topics in Bot DM
- Open your DM with the bot in Telegram (use a recent Telegram client — 10.x+)
- Tap the bot's name at the top to open the chat info
- Look for **"Topics"** toggle → enable it

### 2. (Optional) Lock Topic Management to Bot Only
- In BotFather: `/mybots` → select your bot → **Bot Settings** → **Manage Topics in Private Chats** → enable **"Only bot can manage topics"**
- This prevents you from accidentally creating/deleting topics — Middleman handles that automatically

### 3. Configure Shared Integration
- In Middleman settings → Integrations → select **"Shared (all managers)"**
- Enter your bot token and save
- Make sure `allowedUserIds` includes your Telegram user ID (your chat ID in DMs equals your user ID)

---

## What Happens Automatically

| Event | Telegram Action |
|-------|----------------|
| First outbound message from a new session | Bot creates a new topic named after the session label |
| Session renamed | Topic gets renamed to match |
| Session deleted | Topic gets closed |
| Session forked | New topic created with 🔀 prefix |
| Root/default session messages | Delivered to the General topic (flat chat) |

---

## Group/Supergroup Setup (Alternative)

If you prefer using a group instead of a DM:

1. Create a supergroup (or convert existing group)
2. Enable **Topics/Forum** mode in group settings
3. Add the bot as admin with these permissions:
   - `can_manage_topics` — required for creating/renaming/closing topics
   - `can_delete_messages` — optional, for topic deletion
4. Configure the integration with the group's chat ID

---

## Fallback Behavior

If topics aren't enabled or the bot lacks permissions, everything works exactly like before — single flat chat, all sessions share it. No errors, no setup required for the basic experience.

---

## Integration Awareness

Agents now know about configured Telegram integrations even when you're chatting via the web UI. They can proactively send you Telegram messages without you needing to provide chat IDs — the system injects integration context into the agent's prompt automatically.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot can't create topics | Enable topics in your DM (step 1) or give bot admin rights in group |
| Messages go to wrong session | Check that the topic mapping file exists: `~/.middleman/integrations/managers/{profileId}/telegram-topics.json` |
| Agent asks for chat ID from web | Make sure `allowedUserIds` is set in the integration config — the agent uses this to know your chat ID |
| Multiple managers, same bot token | Only one manager can poll per bot token. Use different bots for different managers, or configure only one manager's integration as active |
