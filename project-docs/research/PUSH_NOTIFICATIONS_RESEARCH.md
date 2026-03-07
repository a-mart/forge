# Push Notifications Research

> **Date:** 2026-03-06  
> **Context:** Middleman is a local-first, self-hosted multi-agent orchestration platform. The user accesses the UI from mobile devices via Tailscale (private mesh VPN, no public domain). This document explores how to add mobile push notifications.

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Web Push API / PWA Approach](#2-web-push-api--pwa-approach)
3. [Self-Hosted / Tailscale Constraints](#3-self-hosted--tailscale-constraints)
4. [Alternative Approaches](#4-alternative-approaches)
5. [Backend Integration Design](#5-backend-integration-design)
6. [Deep-Linking](#6-deep-linking)
7. [Configurability](#7-configurability)
8. [Recommendation](#8-recommendation)

---

## 1. Current Architecture Summary

Before diving into push options, here's what we're working with today:

### Frontend (apps/ui)
- **TanStack Start + Vite SPA** served as static files
- Already has a `public/manifest.json` (placeholder from TanStack scaffold — `"name": "Create TanStack App Sample"`)
- **No service worker** registered today
- **No PWA install** prompting or setup
- Realtime updates arrive via WebSocket client (`apps/ui/src/lib/ws-client.ts`)
- SPA routing uses query params: `/?agent=<agentId>` for session navigation, `/?view=settings` for settings

### Backend (apps/backend)
- Node.js HTTP + WebSocket server (`apps/backend/src/ws/server.ts`)
- Events emitted on `SwarmManager` EventEmitter: `conversation_message`, `agent_status`, `session_lifecycle`, etc.
- Already broadcasts `unread_notification` events when a manager's `speak_to_user` fires
- **Telegram integration** already exists with a full delivery bridge (`telegram-delivery.ts`) that forwards `conversation_message` events to Telegram chats — this is a proven pattern for outbound notifications
- Data stored under `~/.middleman/profiles/<profileId>/`

### Key Event Hook Points
| Event | Source | When |
|---|---|---|
| `conversation_message` (role=assistant, source=speak_to_user) | `SwarmManager` | Manager speaks to user |
| `agent_status` (status=idle) | `SwarmManager` | Agent finishes work |
| `session_lifecycle` (action=created/deleted/renamed/forked) | `SwarmManager` | Session lifecycle changes |
| `unread_notification` | `ws/server.ts` | Emitted alongside speak_to_user messages |

---

## 2. Web Push API / PWA Approach

### 2.1 How Web Push Works

The Web Push architecture has three actors:

```
┌──────────┐     subscribe      ┌──────────────┐
│  Browser  │ ───────────────►  │  Push Service │  (FCM for Chrome, APNs for Safari,
│  (PWA)    │ ◄─────────────    │  (cloud)      │   Mozilla Autopush for Firefox)
└──────────┘   push messages    └──────────────┘
      │                                ▲
      │ subscription                   │ POST to endpoint
      │ endpoint                       │ (VAPID-signed)
      ▼                                │
┌──────────────┐                       │
│  App Server  │ ──────────────────────┘
│  (Middleman) │
└──────────────┘
```

**Critical insight:** The app server (Middleman backend) does NOT push directly to the device. It sends an HTTP POST to a **cloud-hosted push service** (FCM, APNs, Mozilla Autopush), which then wakes the device and delivers the payload to the service worker. **This requires the Middleman server to have outbound internet access to reach these push relay services.**

### 2.2 What's Required

| Component | Status in Middleman | Work Needed |
|---|---|---|
| **Service Worker** (`sw.js`) | ❌ None exists | Create and register from `public/` |
| **Web App Manifest** (`manifest.json`) | ⚠️ Placeholder exists | Update with proper name, icons, `start_url`, `display: standalone` |
| **HTTPS** | ⚠️ Depends on Tailscale setup | Tailscale HTTPS certs or reverse proxy |
| **VAPID Key Pair** | ❌ None | Generate once, store in `~/.middleman/shared/` |
| **Push Subscription Storage** | ❌ None | Store per-device subscriptions server-side |
| **`web-push` npm library** | ❌ Not installed | Add to backend workspace |
| **Notification Permission UI** | ❌ None | Add prompt in UI settings or on first visit |

### 2.3 VAPID Keys

VAPID (Voluntary Application Server Identification) is the self-hosted authentication mechanism for Web Push. No Firebase project or Google account needed.

```bash
# One-time generation using web-push CLI
npx web-push generate-vapid-keys
```

Produces a public/private key pair. The public key is sent to the browser during `PushManager.subscribe()`, and the private key signs outbound push messages. Fully self-contained — no third-party service accounts required.

### 2.4 Push Subscription Flow

```
1. UI loads → registers service worker
2. User clicks "Enable Notifications" → browser shows permission prompt
3. On grant → PushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })
4. Browser contacts its push service (FCM/APNs/Autopush) → returns PushSubscription object
5. UI sends PushSubscription (endpoint + keys) to Middleman backend via HTTP POST
6. Backend stores subscription keyed to profile/device
```

The `PushSubscription` object looks like:
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/abc123...",
  "keys": {
    "p256dh": "base64-encoded-key",
    "auth": "base64-encoded-auth"
  }
}
```

### 2.5 Notification Payload Structure

```json
{
  "title": "Task Complete",
  "body": "Worker finished: research push notifications",
  "icon": "/logo192.png",
  "badge": "/logo192.png",
  "tag": "session-abc123",
  "data": {
    "url": "/?agent=session-abc123",
    "agentId": "session-abc123",
    "type": "task_complete"
  }
}
```

The `data.url` field is used by the service worker's `notificationclick` handler to deep-link into the correct session.

### 2.6 Browser Support Matrix

| Browser | Push Support | Notes |
|---|---|---|
| **Chrome Android** | ✅ Full | Uses FCM relay. Works in background. Best support. |
| **Firefox Android** | ✅ Full | Uses Mozilla Autopush relay. |
| **Safari iOS (16.4+)** | ⚠️ Conditional | **Must be installed to home screen as PWA first.** Push permission prompt only appears after home-screen installation. Not available in EU (iOS 17.4+). |
| **Safari macOS (Sonoma+)** | ✅ | Works when added to Dock as PWA. |
| **Chrome iOS** | ❌ | All iOS browsers use WebKit. Push only works through Safari PWA. |
| **Edge** | ✅ Full | Uses Windows Push Notification Services. |

### 2.7 iOS-Specific Limitations

This is the biggest friction point:

1. **Home screen installation required** — Push notifications only work for PWAs installed via Safari's "Add to Home Screen." There is no programmatic install prompt on iOS (unlike Android's `beforeinstallprompt`).
2. **No EU support** — As of iOS 17.4, Apple removed standalone PWA support in EU countries. PWAs open in Safari tabs and push doesn't work.
3. **Cold-start deep-link issue** — When the PWA is killed and a notification is tapped, iOS opens the PWA at `start_url`, not the notification's `click_action` URL. The service worker `notificationclick` event fires correctly only when the PWA is backgrounded (not killed). Workaround: store the target URL in `sessionStorage`/`localStorage` and check on app boot.
4. **No notification grouping control** — iOS groups all notifications from a PWA together automatically.
5. **Storage eviction** — iOS may evict service worker registrations and caches after ~7 days of inactivity.

### 2.8 PWA Installability Requirements

For the "Add to Home Screen" flow to produce a standalone PWA (required for iOS push):

| Requirement | Current State | Action |
|---|---|---|
| Valid `manifest.json` with `name`, `icons`, `start_url`, `display: standalone` | ⚠️ Placeholder | Update |
| At least one 192×192 and one 512×512 icon | ✅ Icons exist (`logo192.png`, `logo512.png`) | Possibly rebrand |
| Served over HTTPS (or localhost) | ⚠️ Depends on setup | Tailscale HTTPS |
| Service worker registered | ❌ | Create |

---

## 3. Self-Hosted / Tailscale Constraints

### 3.1 The HTTPS Requirement

Web Push API requires a **secure context** (HTTPS or `localhost`). Options:

| Method | Works? | Notes |
|---|---|---|
| **`tailscale cert`** | ✅ Yes | Generates valid Let's Encrypt certs for `machine.tailnet.ts.net`. Trusted by all browsers. Requires Tailscale HTTPS enabled in admin console. Certs valid 90 days, auto-renewable. |
| **Self-signed certificates** | ⚠️ Partial | Browsers will show warnings. Service worker registration may be blocked. Not recommended. |
| **`localhost`** | ✅ For dev | Secure context by spec, but only for local access, not from phone to server. |
| **Tailscale Funnel** | ✅ But public | Exposes service to public internet via Tailscale's infra. Overkill for this use case. |

**Verdict:** `tailscale cert` is the right approach. Generate certs for `middleman.tailnet-name.ts.net` and configure the Node.js backend + Vite preview to serve HTTPS. The Middleman backend currently uses plain HTTP (`createServer`); would need to switch to `createServer` from `node:https` with the Tailscale cert/key, or put a reverse proxy (Caddy) in front.

### 3.2 The Push Relay Problem (Critical)

**This is the single most important constraint for Middleman's self-hosted architecture.**

Web Push does NOT send notifications directly from server to device. The flow is:

```
Middleman Server ──POST──► FCM/APNs/Autopush (cloud) ──push──► Device
```

**The Middleman backend must have outbound HTTPS access to the public internet** to reach:
- `fcm.googleapis.com` (Chrome on Android)
- `updates.push.services.mozilla.com` (Firefox)
- Apple's push gateway (Safari on iOS/macOS)

This is a **hard requirement of the Web Push protocol**. You cannot self-host the push relay — each browser has its own push service baked in, and there is no way to change it.

**For a Tailscale setup:**
- ✅ The server machine typically has internet access (it runs Tailscale which itself needs internet)
- ✅ The phone has internet access (it runs Tailscale + has cellular/WiFi)
- ✅ The push subscription is registered over the Tailscale network (HTTPS to local server)
- ✅ The push delivery goes through the public internet (server → FCM → phone)
- ✅ The notification payload is end-to-end encrypted (using the subscription's p256dh/auth keys)

**The phone does NOT need to be able to reach the Middleman server to receive the push notification.** The notification arrives via FCM/APNs over the phone's regular internet connection. Tapping the notification then opens the PWA, which does need Tailscale connectivity to load the UI and establish the WebSocket.

**Bottom line:** Web Push works fine with Tailscale as long as both the server and the phone have general internet access. The push payload goes through public cloud relays, but the content is encrypted.

### 3.3 Network Partition Scenarios

| Scenario | Push Delivery | Deep-Link |
|---|---|---|
| Phone on WiFi + Tailscale up, server online | ✅ | ✅ |
| Phone on cellular, Tailscale up, server online | ✅ | ✅ |
| Phone on cellular, Tailscale down | ✅ (push arrives) | ❌ (can't load UI until Tailscale reconnects) |
| Server offline, phone online | ❌ (no one to send push) | ❌ |
| Server online, phone offline | ⏳ (FCM queues for ~4 weeks) | N/A |

---

## 4. Alternative Approaches

### 4.1 Telegram Bot Notifications (Quick Win)

Middleman already has a mature Telegram integration with `TelegramDeliveryBridge` that forwards `speak_to_user` messages to Telegram chats. This is a **proven, working notification path**.

**How it works today:**
- `TelegramDeliveryBridge` listens for `conversation_message` events where `sourceContext.channel === "telegram"`
- It routes messages to the correct Telegram chat/topic via the bot API

**What we'd add for push notifications:**
- A **new notification mode** in the delivery bridge (or a parallel service) that sends brief notification messages to a dedicated Telegram chat/DM regardless of source channel
- Include a deep-link URL back to the Middleman UI: `https://middleman.tailnet.ts.net/?agent=session-id`
- Telegram already handles push delivery to the phone via its own native app

**Pros:**
| Advantage | Details |
|---|---|
| Already built | Telegram integration is production-ready |
| Cross-platform | Works on iOS, Android, desktop — no PWA install required |
| No HTTPS requirement | Telegram handles the push relay |
| Deep-link support | Telegram renders URLs as tappable links |
| Rich formatting | Can include session name, agent status, message preview |
| Reliable | Telegram's push infrastructure is battle-tested |
| EU compatible | No iOS PWA restrictions apply |

**Cons:**
| Limitation | Details |
|---|---|
| Requires Telegram account | User must have Telegram installed |
| Two-app experience | Notification in Telegram → tap link → opens browser → Middleman UI |
| Latency | Extra hop through Telegram servers |
| Not "native" feeling | Notifications come from Telegram, not from Middleman directly |
| Bot token management | Already handled, but adds dependency on Telegram API availability |

**Implementation effort:** Low. Extend existing `TelegramDeliveryBridge` or create a parallel `TelegramNotificationBridge` that listens for configurable events and sends concise notifications with deep-link URLs.

### 4.2 ntfy.sh

[ntfy](https://ntfy.sh/) is a self-hostable HTTP-based pub-sub notification service. It has native Android/iOS apps and a PWA.

**How it would work:**
1. Self-host ntfy server (or use the free hosted tier)
2. Middleman backend POSTs to `https://ntfy.example.com/middleman-notifications`
3. ntfy delivers via its own push infrastructure (uses FCM for Android, APNs for iOS via its own app, Web Push for PWA)
4. User installs ntfy app and subscribes to the topic

**Pros:**
- Self-hostable, open source (Apache 2.0)
- Native apps for Android and iOS with reliable push
- Simple HTTP API: `curl -d "Task complete" ntfy.sh/my-topic`
- Supports click URLs, actions, priorities, tags, attachments
- Can include deep-link URLs in notifications

**Cons:**
- Another service to self-host and maintain
- Another app for the user to install (ntfy)
- Still needs internet access for push relay (ntfy uses FCM/APNs internally)
- Adds external dependency to a local-first tool
- No tight integration with Middleman's UI

**Implementation effort:** Low-medium. Simple HTTP POST from backend. Needs ntfy server deployment.

### 4.3 Native Wrapper (Capacitor / TWA)

Wrapping the Middleman SPA in a native shell would unlock native push APIs directly.

**Capacitor:**
- Wraps the SPA in a WebView with native bridge
- `@capacitor/push-notifications` plugin provides direct FCM/APNs access
- Full control over notification behavior, deep-linking, badges

**TWA (Trusted Web Activity):**
- Android-only
- Wraps a PWA in a native Chrome shell
- Inherits Web Push behavior from Chrome

**Pros:**
- Native push without PWA install dance (especially helpful on iOS)
- Better notification UX (grouping, actions, sounds)
- App store distribution possible

**Cons:**
- Significant development/maintenance overhead
- Separate build pipeline for iOS and Android
- Capacitor requires native project setup (Xcode, Android Studio)
- Apple developer account needed ($99/year)
- Overkill for a self-hosted tool used by one person/small team
- TWA is Android-only

**Verdict:** Not recommended for Middleman's use case. The overhead doesn't justify the benefit.

### 4.4 Polling / SSE Fallback

If Web Push isn't available (e.g., no HTTPS, iOS not installed as PWA):

- **In-app notification badge:** Already partially implemented via `unread_notification` events over WebSocket. Works when the tab is open.
- **Audio alert:** Play a sound when a notification arrives and the tab is in background.
- **Server-Sent Events (SSE):** Similar to WebSocket but one-directional. No benefit over existing WebSocket.
- **Polling:** Periodic fetch. Wastes battery and bandwidth.

These are degraded fallbacks, not true push. The tab/app must be open. Useful only as a complement to real push.

### 4.5 Comparison Matrix

| Approach | iOS Support | Android Support | Requires Internet | Install Required | Effort | UX Quality |
|---|---|---|---|---|---|---|
| **Web Push (PWA)** | ⚠️ Home screen install | ✅ | ✅ (push relay) | PWA install | Medium | ★★★★ |
| **Telegram** | ✅ | ✅ | ✅ (Telegram API) | Telegram app | Low | ★★★ |
| **ntfy.sh** | ✅ (via app) | ✅ (via app) | ✅ (push relay) | ntfy app | Low-Med | ★★★ |
| **Native Wrapper** | ✅ | ✅ | ✅ (FCM/APNs) | App install | High | ★★★★★ |
| **In-app (WebSocket)** | ✅ (tab open) | ✅ (tab open) | ❌ (Tailscale only) | None | None (exists) | ★★ |

---

## 5. Backend Integration Design

### 5.1 Notification Event Sources

The backend already has clear event hooks. Here's what would trigger notifications:

| Trigger | Event Source | Priority | Description |
|---|---|---|---|
| Manager speaks to user | `conversation_message` where `source === "speak_to_user"` | High | The primary use case — task results, questions, updates |
| Manager/session goes idle | `agent_status` where `status === "idle"` and agent was previously `busy`/`thinking` | Medium | Session completed its current task |
| Worker completes | `agent_status` for worker going idle, combined with parent callback detection | Low | Useful for long-running worker tasks |
| Custom agent tool | New `send_notification` tool | High | Agent explicitly wants to alert the user |
| Session lifecycle | `session_lifecycle` events | Low | New session created, session deleted, etc. |

### 5.2 Push Subscription Storage

Subscriptions should be stored per-device, associated with the user/profile:

```
~/.middleman/shared/push-subscriptions.json
```

Schema:
```typescript
interface PushSubscriptionRecord {
  id: string                    // UUID, generated on registration
  endpoint: string              // Push service endpoint URL
  keys: {
    p256dh: string              // Client public key
    auth: string                // Client auth secret
  }
  userAgent: string             // For identifying device
  createdAt: string             // ISO timestamp
  lastUsedAt: string            // Updated on each push sent
  profileId?: string            // Optional: scope to specific profile
  label?: string                // User-assigned device name
}
```

Why `shared/` not per-profile: Push subscriptions represent physical devices. A user may want notifications from multiple profiles. The notification dispatch can filter by preference, but the subscriptions themselves are device-level.

### 5.3 Notification Dispatch Service

```typescript
// apps/backend/src/notifications/push-dispatch.ts

class PushNotificationDispatcher {
  private readonly vapidKeys: VapidKeys         // Loaded from shared config
  private readonly subscriptionStore: SubscriptionStore
  
  // Called by event listeners in ws/server.ts or a dedicated notification service
  async sendNotification(payload: NotificationPayload): Promise<void> {
    const subscriptions = await this.subscriptionStore.getAll()
    
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
          { vapidDetails: this.vapidKeys, TTL: 3600 }
        )
        sub.lastUsedAt = new Date().toISOString()
      } catch (err) {
        if (isExpiredSubscription(err)) {
          await this.subscriptionStore.remove(sub.id)
        }
      }
    }
  }
}
```

### 5.4 Integration Points in Existing Code

The most natural integration point is `apps/backend/src/ws/server.ts`, right alongside the existing `unread_notification` broadcast:

```typescript
// In server.ts, the onConversationMessage handler already does:
if (event.role === "assistant" && event.source === "speak_to_user") {
  this.wsHandler.broadcastToSubscribed({
    type: "unread_notification",
    agentId: event.agentId,
  });
  
  // NEW: Push notification dispatch
  this.pushDispatcher?.sendNotification({
    title: "Middleman",
    body: truncate(event.text, 200),
    tag: `speak-${event.agentId}`,
    data: {
      url: `/?agent=${event.agentId}`,
      agentId: event.agentId,
      type: "speak_to_user"
    }
  });
}
```

For the Telegram path, a similar listener in the notification service would forward to Telegram.

### 5.5 Future `send_notification` Agent Tool

An agent tool that lets managers/workers explicitly send notifications:

```typescript
// Tool definition (in swarm/tools/)
{
  name: "send_notification",
  description: "Send a push notification to the user's devices",
  parameters: {
    title: { type: "string", description: "Notification title" },
    body: { type: "string", description: "Notification body text" },
    priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
    url: { type: "string", description: "Deep-link URL (optional)" }
  }
}
```

The tool handler would call `PushNotificationDispatcher.sendNotification()` with the payload. The URL could default to the current session's deep-link if not specified.

This is an easy extension once the dispatch infrastructure exists.

---

## 6. Deep-Linking

### 6.1 URL Structure

Middleman's SPA already supports session routing via query parameters:

```
/?agent=<agentId>           → Opens chat view for that session/agent
/?view=settings             → Opens settings
/                           → Default manager
```

With Tailscale HTTPS, full deep-link URLs would be:
```
https://middleman.tailnet.ts.net:47289/?agent=session-abc123
```

### 6.2 Service Worker Notification Click Handler

```javascript
// sw.js
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  
  const targetUrl = event.notification.data?.url || '/'
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Try to focus an existing Middleman tab
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            // Post message to navigate to the target session
            client.postMessage({
              type: 'NOTIFICATION_CLICK',
              url: targetUrl,
              agentId: event.notification.data?.agentId
            })
            return client.focus()
          }
        }
        // No existing tab — open a new one
        return clients.openWindow(targetUrl)
      })
  )
})
```

### 6.3 Client-Side Navigation Handler

In the React app, listen for service worker messages to trigger in-app navigation:

```typescript
// In the main app component or a useEffect
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'NOTIFICATION_CLICK') {
    // Use TanStack Router to navigate
    navigate({
      to: '/',
      search: { agent: event.data.agentId },
      resetScroll: true
    })
  }
})
```

### 6.4 iOS Cold-Start Workaround

When iOS kills the PWA and a notification is tapped, it opens at `start_url` ignoring the notification's URL. Workaround:

```javascript
// In sw.js notificationclick handler, if no existing window:
// Store target in a shared location before opening
self.targetUrl = targetUrl

// In the main app, on boot:
if (navigator.serviceWorker?.controller) {
  navigator.serviceWorker.controller.postMessage({ type: 'GET_TARGET_URL' })
}

// Or simpler: use URL fragment/hash that persists
// clients.openWindow('/?agent=session-abc123') 
// This sometimes works, but iOS behavior is inconsistent
```

A more reliable approach: store the target URL in `IndexedDB` from the service worker, and check it on app startup.

---

## 7. Configurability

### 7.1 Notification Preference Model

```typescript
interface NotificationPreferences {
  enabled: boolean                    // Master switch
  
  channels: {
    webPush: boolean                  // Web Push API
    telegram: boolean                 // Telegram bot DM
  }
  
  triggers: {
    speakToUser: boolean              // Manager speaks to user (default: true)
    sessionIdle: boolean              // Session finishes a task (default: false)
    workerComplete: boolean           // Worker completes (default: false)
    customNotification: boolean       // Agent tool notifications (default: true)
    sessionLifecycle: boolean         // Session created/deleted (default: false)
  }
  
  quietHours?: {
    enabled: boolean
    start: string                     // "22:00"
    end: string                       // "08:00"
    timezone: string                  // "America/Chicago"
  }
  
  debounce?: {
    enabled: boolean
    windowMs: number                  // Batch notifications within this window
    maxPerWindow: number              // Max notifications per window (then summarize)
  }
}
```

### 7.2 Storage Location

Preferences should be stored per-profile since different manager profiles may have different notification needs:

```
~/.middleman/profiles/<profileId>/notification-preferences.json
```

With a global default at:
```
~/.middleman/shared/notification-defaults.json
```

### 7.3 UI for Notification Preferences

Add a "Notifications" section in the existing Settings panel (`apps/ui/src/components/chat/SettingsDialog.tsx`):

- **Master toggle:** Enable/disable all notifications
- **Channel toggles:** Web Push, Telegram
- **Trigger checkboxes:** Which events generate notifications
- **Quiet hours:** Time range picker
- **Device management:** List registered push subscriptions, remove old ones
- **Test button:** Send a test notification to verify setup

For iOS users, show a prominent callout:
> "To receive push notifications on iOS, you must first install Middleman as an app: tap the Share button in Safari, then 'Add to Home Screen.'"

---

## 8. Recommendation

### 8.1 Phased Implementation Path

#### Phase 0: Telegram Quick Win (1-2 days)
**Do this first.** It requires minimal new infrastructure and provides immediate value.

- Extend `TelegramDeliveryBridge` (or create a sibling `TelegramNotificationService`) to send notification-style messages for configurable events
- Include deep-link URLs to the Middleman UI: `https://middleman.tailnet.ts.net:47289/?agent=<agentId>`
- Add basic notification preference toggles in Settings (which events to notify on)
- Telegram handles all push delivery — works on iOS and Android immediately with no PWA setup

**Why:** Middleman already has a fully functional Telegram integration. The marginal effort to add notification messages is tiny. The user already has Telegram on their phone. This gives 80% of the value with 10% of the Web Push effort.

#### Phase 1: PWA Foundation (2-3 days)
Make the app installable as a PWA, which is a prerequisite for Web Push and also improves the mobile experience independently.

- Update `manifest.json` with proper Middleman branding, icons, `display: standalone`, `start_url: /`
- Create a minimal service worker (`public/sw.js`) with app shell caching
- Add install prompt/instructions in the UI (especially for iOS)
- Set up Tailscale HTTPS cert for the backend/UI servers
- Switch backend to HTTPS or add a reverse proxy

**Why:** PWA installability improves the mobile experience regardless of push notifications. The app gets its own icon, runs without browser chrome, and feels more native.

#### Phase 2: Web Push (3-5 days)
Build the full Web Push pipeline once the PWA foundation is in place.

- Generate VAPID keys (store in `~/.middleman/shared/vapid-keys.json`)
- Install `web-push` npm package in backend
- Implement `PushNotificationDispatcher` service
- Add push subscription REST endpoints (`POST /api/push/subscribe`, `DELETE /api/push/subscribe/:id`, `GET /api/push/subscriptions`)
- Add service worker push event handler and notification click deep-linking
- Wire into existing event hooks in `ws/server.ts`
- Add push subscription management UI in Settings

#### Phase 3: Agent Tool + Polish (1-2 days)
- Implement `send_notification` agent tool
- Add debounce/batching for rapid-fire notifications
- Add quiet hours support
- iOS cold-start deep-link workaround
- Notification preference sync across sessions

### 8.2 Ranking

| Approach | Feasibility | Effort | UX Quality | Recommended |
|---|---|---|---|---|
| **Telegram (Phase 0)** | ★★★★★ | ★★★★★ (lowest) | ★★★ | ✅ **Do first** |
| **Web Push PWA (Phase 1-2)** | ★★★★ | ★★★ | ★★★★ | ✅ **Do second** |
| **ntfy.sh** | ★★★★ | ★★★★ | ★★★ | ⚠️ Consider if Telegram isn't available |
| **Native Wrapper** | ★★ | ★ (most effort) | ★★★★★ | ❌ Not worth it |

### 8.3 Blockers and Unknowns

| Item | Risk | Mitigation |
|---|---|---|
| **Tailscale HTTPS for service worker** | Medium — needs testing | `tailscale cert` should work. Test that the cert is accepted for SW registration. |
| **iOS PWA cold-start deep-link** | Medium — known iOS bug | IndexedDB workaround. Test on actual device. |
| **FCM/APNs reachability from server** | Low — server likely has internet | Verify outbound HTTPS to `fcm.googleapis.com`. Could be blocked by strict firewall. |
| **iOS EU restriction** | Low — depends on user location | Telegram fallback covers this. |
| **Push subscription expiry** | Low | Handle 410 responses from push services, clean up expired subscriptions. |
| **Multiple profiles, one device** | Medium — design question | Subscriptions are device-level. Preferences are per-profile. Dispatch filters by preference. |
| **Tailscale not connected when tapping notification** | Medium | Push arrives fine, but UI won't load. Show offline message with retry. |

### 8.4 Quick Start Checklist

For the immediate Telegram quick-win:

- [ ] Create `TelegramNotificationService` that listens for `speak_to_user` events across all sessions (not just Telegram-sourced messages)
- [ ] Format notification: `"📋 [Session Name] — Task complete\n\n{first 200 chars of message}\n\n🔗 Open: https://middleman.ts.net:47289/?agent={agentId}"`
- [ ] Add Settings toggle: "Send Telegram notifications for manager responses"
- [ ] Add Settings option: "Notification chat ID" (Telegram DM or group to receive notifications)
- [ ] Test end-to-end: manager completes task → Telegram notification → tap link → Middleman opens to correct session

---

## Appendix A: Web Push Library Options

| Library | Language | Notes |
|---|---|---|
| [`web-push`](https://www.npmjs.com/package/web-push) | Node.js | Most popular. 2.5M weekly downloads. Handles VAPID, encryption, FCM/Mozilla endpoints. |
| [`@nicolo-ribaudo/web-push`](https://www.npmjs.com/package/@nicolo-ribaudo/web-push) | Node.js | Fork with ESM support and modern APIs. |

## Appendix B: Key References

- [W3C Push API Spec](https://www.w3.org/TR/push-api/)
- [Web Push Protocol (RFC 8030)](https://datatracker.ietf.org/doc/html/rfc8030)
- [VAPID Spec (RFC 8292)](https://datatracker.ietf.org/doc/html/rfc8292)
- [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Tailscale HTTPS Certificates](https://tailscale.com/kb/1153/enabling-https/)
- [ntfy.sh Documentation](https://docs.ntfy.sh/)
- [web-push npm package](https://www.npmjs.com/package/web-push)
- [iOS PWA Limitations Guide](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
