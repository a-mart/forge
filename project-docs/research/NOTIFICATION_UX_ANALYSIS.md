# Notification UX Analysis

> **Date:** 2026-03-06
> **Scope:** UX and design simplicity review of the push notification feature proposal
> **Input:** `PUSH_NOTIFICATIONS_RESEARCH.md`, existing chat/settings UI patterns

---

## 1. Pushing Back on Over-Engineering

The research doc is thorough — too thorough for what this actually needs to be. Let's sort the proposals into "real" and "premature."

### What v1 actually needs

| Feature | Verdict |
|---|---|
| A way to get notified when a session responds | ✅ The whole point |
| A master on/off toggle | ✅ Obvious |
| Deep-link to the session that spoke | ✅ Essential for the notification to be useful |
| VAPID key auto-generation | ✅ Zero-config infrastructure |

### What's premature (cut all of this)

| Proposed Feature | Why It's Premature |
|---|---|
| **Trigger-level checkboxes** (speakToUser, sessionIdle, workerComplete, sessionLifecycle) | You have one user. The only notification that matters is "a manager spoke to you." Everything else is noise. If someone wants worker-complete notifications, they tell the manager to notify them — that's what `send_notification` is for. |
| **Quiet hours** | You're one person. You'll put your phone on Do Not Disturb. The OS already solved this. |
| **Debounce / batching** | Premature optimization for a problem that doesn't exist yet. Managers don't typically fire 50 speak_to_user messages in 10 seconds. If they do, that's a bug, not a notification settings problem. |
| **Channel toggles** (webPush: on, telegram: on) | At v1, pick one channel and make it work well. If Telegram is the quick win, it's just "notifications: on/off." If Web Push comes later, the toggle becomes relevant — add it then. |
| **Device management UI** (list subscriptions, remove old ones, label devices) | You have one phone. Maybe two devices. The `web-push` library already handles expired subscription cleanup via 410 responses. A device management screen is enterprise UX for an enterprise problem you don't have. |
| **Per-profile notification preferences** with global defaults | One person, maybe 2-3 profiles. A single global toggle is fine. Profile-level overrides can come if the need arises organically. |
| **Notification chat ID config** | For Telegram: just send to the same chat/DM the integration already uses. Don't make the user configure a separate "notification destination." |

### The principle

A self-hosted tool for a small team should feel like a well-configured personal tool, not like an admin panel at a SaaS company. Every toggle you add is a decision you're forcing the user to make. For notifications, the only decision should be: "Do I want to know when my agents talk to me?" Yes or no.

---

## 2. What "Elegantly Simple" Looks Like

### What notifications exist at launch

**Exactly one type:** A manager session has something to say to you (`speak_to_user`).

That's it. Not "session went idle." Not "worker completed." Not "session was created." The user cares about one thing: **"My agent responded and I'm not looking at the screen."**

The `speak_to_user` event is already the canonical "this message is for the human" signal. Everything else is internal machinery.

### What configuration is needed

**One toggle.** "Notifications: On / Off."

That's the entire settings surface for v1. The toggle enables push delivery for `speak_to_user` events across all sessions. No per-session filtering, no per-profile overrides, no trigger matrix.

If Web Push and Telegram are both available later, you add a second choice: "Notify via: Web Push / Telegram." But at v1, there's only one channel, so there's only one switch.

### What the notification looks like

**Title:** Session name (or manager name if no session name).
**Body:** First ~120 characters of the message. Enough to know what it's about, short enough to scan.
**No icon gymnastics.** Use the app icon. Don't try to show agent avatars or status badges in notification icons — that's a rabbit hole.

Examples:
```
┌─────────────────────────────────────┐
│ 📋 mobile-enhancements              │
│ Done — pushed the notification UX   │
│ analysis to project-docs/research.  │
│ Three files changed...              │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 📋 Cortex                           │
│ Review complete. Found 3 sessions   │
│ with unmerged memory. See notes...  │
└─────────────────────────────────────┘
```

### What happens when you tap it

**Direct navigation to that session's chat view.** The notification carries `agentId` in its data payload. Tapping opens/focuses the Middleman UI at `/?agent=<agentId>`.

If the app is already open in a tab: focus that tab, navigate to the session.
If the app is closed: open a new tab/PWA instance at the session URL.
If Tailscale is down when tapped: the browser shows a connection error. That's fine — the user understands network requirements of their own self-hosted tool.

No intermediate screens. No notification center. No inbox. Tap → you're in the conversation.

---

## 3. The Two-App vs. One-App Question

**Telegram path:** Notification in Telegram → tap link → browser/PWA opens → Middleman loads at session.
**Web Push path:** Notification from Middleman → tap → PWA opens directly at session.

### How much does this UX gap matter?

**Less than you'd think, more than zero.**

For a power user who lives in both apps:
- The Telegram path adds ~1 second of friction (app switch + page load).
- The mental model is slightly fractured: "Middleman talks to me through Telegram" vs. "Middleman talks to me directly."
- But the user already has Telegram open for the integration's conversational features. It's not a foreign context.

The real difference is **perceived quality.** Web Push notifications feel like the app is a first-class citizen on your device. Telegram notifications feel like a workaround — even if functionally they're equivalent. For a craftsperson who values tools that feel right, this gap matters emotionally even if it doesn't matter functionally.

### The pragmatic take

**Telegram first, Web Push soon after.** The Telegram path works today with minimal new code and zero new infrastructure (no HTTPS, no service worker, no VAPID keys, no PWA install dance). It gets the user notified immediately. Then Web Push replaces it as the primary channel once the PWA foundation is laid — and the Telegram path becomes a fallback for when PWA isn't installed or for iOS EU users.

The key insight: these aren't competing approaches. Telegram is the scaffold; Web Push is the building. Build the scaffold first so you can work from it.

---

## 4. Progressive Disclosure

### Where notification settings live

**In the existing Settings UI, as a new "Notifications" tab.** The settings layout already has a clean tab system (General, Authentication, Integrations, Skills). Add a fifth tab: Notifications, with a `Bell` icon.

```
General | Auth | Integrations | Skills | Notifications
                                         ^^^^^^^^^^^
```

This follows the existing pattern exactly. No new UI paradigms, no floating panels, no onboarding modals.

### What the Notifications tab contains at v1

```
Notifications
─────────────────────────────────────

Push Notifications
Send a notification when a session responds.

  [  Notifications ·············· On  ]   ← single Switch toggle

  Status: ✅ Connected (1 device)      ← or "Not set up" with
                                           brief setup hint

  [ Send Test Notification ]            ← small outline button
```

That's the entire screen. One toggle, a status line, a test button. The existing `SettingsSection` + `SettingsWithCTA` + `Switch` components handle this perfectly — no new UI primitives needed.

### How the user discovers and enables notifications

**No onboarding flow.** No permission banners. No first-visit modals.

The user goes to Settings → Notifications → flips the toggle. If it's Web Push, the browser's native permission prompt fires on toggle-on. If it's Telegram, it just starts working (the integration is already configured).

For Web Push specifically, if the PWA isn't installed yet, show a single line of helper text below the toggle:

> "For push notifications, install Middleman to your home screen first. In Safari, tap Share → Add to Home Screen."

That's the extent of "onboarding." The user is technical. They don't need a guided tour.

### What NOT to build

- ❌ A notification bell icon in the chat header with a dropdown
- ❌ An in-app notification center / inbox
- ❌ Toast popups for in-app notifications (WebSocket already handles real-time updates)
- ❌ A setup wizard for push configuration
- ❌ Badge counts on the app icon (nice-to-have for much later, not v1)

The existing unread indicators in the sidebar already handle the "which sessions have new messages" problem when the app is open. Push notifications solve the "the app isn't open" problem. Don't conflate them.

---

## 5. The Future `send_notification` Tool

### What agent-initiated notifications should feel like

They should feel like a **tap on the shoulder** — intentional, from a specific agent, with a clear reason. Not like system noise.

The notification format should be slightly different from system notifications to signal provenance:

**System notification (speak_to_user):**
```
mobile-enhancements
Done — pushed changes to three files...
```

**Agent-initiated notification (send_notification):**
```
🔔 Cortex
Scheduled review found 3 sessions needing attention
```

The `🔔` prefix (or equivalent visual treatment) signals "an agent deliberately pinged you" vs. "a session responded to your message." Subtle but useful for triage.

### How it differs from system notifications

| Aspect | System (speak_to_user) | Agent Tool (send_notification) |
|---|---|---|
| Trigger | Automatic — fires on every speak_to_user when notifications are enabled | Explicit — agent decides to notify |
| Frequency | Matches conversation cadence | Controlled by agent logic |
| Content | First N chars of the message | Custom title + body from the agent |
| Deep-link | Always → that session | Optional URL, defaults to session |
| User expectation | "My session responded" | "An agent has something important to tell me" |

### Guard rails

Keep these minimal but real:

1. **Rate limiting:** Max 1 notification per agent per 60 seconds. Not configurable. Just a sane default to prevent runaway agents from spamming the phone. If an agent calls `send_notification` 10 times in a minute, only the first one delivers; the rest are silently dropped (with a log entry). The agent doesn't need to know — it's a platform-level safety net.

2. **No per-agent opt-in for v1.** If notifications are on, `send_notification` works for all agents. Per-agent control is the kind of granularity that sounds useful in theory but creates a settings surface nobody maintains. If a specific agent is too noisy, fix the agent's prompt — don't build a notification permission matrix.

3. **No priority levels for v1.** The research doc proposes `low/normal/high`. At v1, all notifications are equal. OS-level notification priority (like critical alerts that bypass DND) is a dangerous power to give to an AI agent. Keep it flat.

4. **Respect the master toggle.** If notifications are off, `send_notification` is a no-op. The tool still "succeeds" from the agent's perspective (so it doesn't retry or error), but nothing is delivered. The tool response should indicate `"delivered": false, "reason": "notifications_disabled"` so the agent can adjust if its prompt logic cares.

### Tool interface (simplified from research doc)

```typescript
{
  name: "send_notification",
  description: "Send a push notification to the user's device",
  parameters: {
    title: { type: "string", description: "Short notification title" },
    body: { type: "string", description: "Notification body (max ~200 chars)" }
  }
}
```

No `priority`, no `url`, no `tag`. Title and body. The URL defaults to the sending session. The tag defaults to `agent-<agentId>` for automatic notification replacement (so rapid-fire calls replace rather than stack). Add parameters later if a real need emerges.

---

## 6. Recommendation

### The simplest thing that would delight

**Phase 1: Telegram notification bridge (1-2 days)**

Add a lightweight notification listener that, when enabled, sends a concise Telegram DM for every `speak_to_user` event. Include a deep-link URL. One toggle in Settings → Notifications to enable/disable.

The user's experience:
1. They already have Telegram integration configured.
2. They go to Settings → Notifications → flip "On."
3. A manager responds to them → their phone buzzes with a Telegram message → they tap the link → Middleman opens to that session.

That's the whole feature. One toggle, one notification type, one delivery channel.

**Phase 2: PWA + Web Push (3-5 days, when ready)**

Build the PWA foundation (manifest, service worker, HTTPS via Tailscale certs). Add Web Push as a second delivery channel. The Notifications settings tab gains a "Notify via" selector: Telegram / Web Push. The notification experience upgrades from "Telegram message with a link" to "native push notification that opens the app directly."

**Phase 3: `send_notification` tool (1 day, whenever)**

Once either notification channel works, add the agent tool. It's a thin wrapper around the same dispatch path. Rate-limited, respects the master toggle. Agents gain the ability to proactively reach the user.

### What makes this "elegantly simple"

- **One decision at setup:** On or off.
- **One notification type that matters:** "Your agent has something to say."
- **One tap to get there:** Notification → session.
- **Zero new UI paradigms:** Everything lives in the existing settings tab system.
- **Zero configuration debt:** No trigger matrices, quiet hours, debounce windows, or device management screens to maintain.

The feature should feel like it was always there — quiet when you don't need it, reliable when you do. That's the bar.

---

## Appendix: Settings Tab Addition

For implementation reference, the new Notifications tab fits the existing pattern exactly:

```typescript
// SettingsLayout.tsx — add to NAV_ITEMS
{ id: 'notifications', label: 'Notifications', icon: <Bell className="size-4" /> }

// SettingsDialog.tsx — add tab content
{activeTab === 'notifications' && <SettingsNotifications wsUrl={wsUrl} />}
```

The `SettingsNotifications` component would use the existing `SettingsSection`, `SettingsWithCTA`, and `Switch` primitives. No new UI components needed.
