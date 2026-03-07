# Web Push / PWA Analysis (Middleman)

> Date: 2026-03-06  
> Focus: practical complexity and fit with Middleman’s "elegantly simple, local-first" ethos

## 1) Current state audit

### What exists today
- **Manifest file exists** at `apps/ui/public/manifest.json`.
- Manifest currently still scaffold/default-style values:
  - `"name": "Create TanStack App Sample"`
  - `"short_name": "TanStack App"`
  - `start_url: "."`
  - `display: "standalone"`
- Required icon sizes are present:
  - `apps/ui/public/logo192.png`
  - `apps/ui/public/logo512.png`

### What is missing
- **No service worker file** in `apps/ui/public/`.
- **No service worker registration** in UI source (`navigator.serviceWorker` not referenced anywhere).
- **No manifest `<link rel="manifest">`** in app head (`apps/ui/src/routes/__root.tsx` currently only adds favicon + stylesheet).
- **No notification permission UX** (`Notification.requestPermission` / push subscribe flow absent).
- **No Push API backend support** (`web-push` not installed, no subscription routes, no subscription storage).

### Backend event posture (good foundation)
- `apps/backend/src/ws/server.ts` already centralizes `conversation_message` handling and emits `unread_notification` events for `source === "speak_to_user"`.
- This is a clean hook point for future push dispatch.

---

## 2) HTTPS reality check

## Current reality
- Backend explicitly uses **HTTP** (`createServer` from `node:http`) in `apps/backend/src/ws/server.ts`.
- Backend defaults to loopback host/port in `apps/backend/src/config.ts` (`127.0.0.1:47187`).
- UI dev/preview scripts are also HTTP by default (`vite dev`, `vite preview`) with no TLS cert wiring in `apps/ui/package.json`.

## What HTTPS for Web Push really implies
For push on real devices (not localhost), you need secure context + valid cert chain.

### Option A: Add HTTPS directly in app processes
- Backend: switch to `node:https`, load cert/key (Tailscale cert files), run WSS.
- UI: run Vite preview/dev with `--https --cert --key` (or config equivalent).
- **Downside:** two separate TLS endpoints/ports to maintain, more moving parts.

### Option B (simpler operationally): reverse proxy TLS termination
- Keep backend and UI as-is on local HTTP ports.
- Put **Caddy/Nginx/Traefik** in front with Tailscale certs on `:443`.
- Proxy:
  - UI requests to Vite preview/static frontend
  - API + WS upgrade traffic to backend
- **Benefit:** avoids invasive backend protocol changes and keeps local dev unchanged.

### Tailscale cert practicality
- `tailscale cert <host>.tailnet.ts.net` gives publicly trusted certs.
- Renewal/placement operationally matters, but this is a solved path.
- If you already expose Middleman over Tailscale DNS name, TLS termination at proxy is usually the least disruptive route.

### Dev workflow impact
- **Local desktop dev:** unchanged (localhost is secure context for service workers).
- **Phone-on-tailnet testing:** needs HTTPS endpoint.
- So you can keep day-to-day dev HTTP and introduce HTTPS only for integrated/device testing + production.

---

## 3) Minimal PWA setup (installable, nothing fancy)

Bare minimum to make Middleman installable:

1. **Fix manifest metadata**
   - Update `apps/ui/public/manifest.json` (name, short_name, start_url, theme/background).
2. **Expose manifest in head**
   - Add `<link rel="manifest" href="/manifest.json">` in `apps/ui/src/routes/__root.tsx` head links.
3. **Add minimal service worker**
   - Create `apps/ui/public/sw.js` with basic install/activate handlers (no aggressive caching required).
4. **Register SW on client boot**
   - Add client-side registration (e.g., in root route `useEffect` or a small `src/lib/pwa.ts` helper).

That is enough for installability baseline. No offline cache strategy required for v1.

---

## 4) Web Push complexity audit (real cost)

Web Push is not huge, but it is **not** trivial. It adds multiple new concerns:

### New concepts introduced
- VAPID public/private keypair lifecycle
- Push subscription objects + cryptographic keys per device/browser
- Push service failure semantics (404/410 invalid subscription cleanup)
- Service worker event model (`push`, `notificationclick`)
- Permission UX and denied/default handling

### New backend responsibilities
- Add `web-push` dependency and configure VAPID details.
- Build subscription APIs (subscribe/unsubscribe/list).
- Persist subscriptions (file/JSON store under `~/.middleman/shared/` or profile scope).
- Dispatch notifications from event hooks (e.g., existing `speak_to_user` path).
- Handle stale endpoints and cleanup on send failures.

### New frontend/SW responsibilities
- Register SW reliably.
- Ask permission intentionally (not on first load spam).
- Call `PushManager.subscribe()` with app server key.
- POST subscription to backend.
- Handle `push` payload in SW and show notification.
- Handle `notificationclick` to focus/open app and route user.

### Subscription lifecycle overhead
- Re-subscribe when browser rotates subscriptions.
- Distinguish multiple devices/browsers per user.
- Let user revoke device subscriptions.
- Keep data clean when endpoints expire.

### Practical complexity estimate
- **PWA installability only:** low (~0.5–1 day)
- **Production-ready Web Push:** medium/high (~3–6 days) plus ongoing maintenance/testing across browsers

---

## 5) The iOS question

Short answer: **iOS Web Push is not strong enough to be your only alert path.**

Reasons:
- Requires Safari home-screen install before push is even possible.
- EU policy/behavior constraints make portability uncertain.
- Cold-start deep-link behavior remains fragile in practice.
- WebKit/PWA edge cases are still more brittle than Android desktop flows.

So this is best treated as:
- **Reliable:** Android + desktop browsers
- **Best-effort:** iOS Safari-installed PWA

If iOS reliability matters, keep a secondary channel (Telegram/ntfy/native app).

---

## 6) Simplicity verdict (opinionated)

For Middleman’s ethos, the clean call is:

- **Yes to minimal PWA setup** (cheap, good UX win, little architectural burden).
- **Cautious/no to full Web Push as primary notification system** unless there is a strong product need.

Why:
- It introduces non-trivial cross-cutting complexity (crypto keys, subscription store, SW runtime, browser matrix, cleanup logic).
- It depends on external browser push relays anyway (not purely local-first in spirit, even if encrypted).
- iOS remains the weak link for dependable alerts.

For a self-hosted tool, this can feel like a lot of machinery for moderate gain—especially when simpler channels already exist.

---

## 7) If we do it: minimal clean implementation plan

## Phase A — Installable PWA only (recommended immediate scope)

### Files to change
- `apps/ui/public/manifest.json` (real metadata)
- `apps/ui/public/sw.js` (minimal lifecycle handlers)
- `apps/ui/src/routes/__root.tsx` (add manifest link + optional theme-color meta)
- `apps/ui/src/lib/pwa.ts` (new: register helper)
- `apps/ui/src/routes/__root.tsx` or top-level client hook to call register helper

### Scope
- No offline caching strategy beyond safe defaults.
- No push subscription logic.
- No backend changes required.

---

## Phase B — Minimal Web Push (only if explicitly chosen)

### Backend files (expected)
- `apps/backend/package.json` (add `web-push`)
- `apps/backend/src/ws/routes/` add push routes (subscribe/unsubscribe/list)
- `apps/backend/src/notifications/push-dispatcher.ts` (new)
- `apps/backend/src/notifications/push-store.ts` (new)
- `apps/backend/src/ws/server.ts` (wire dispatch from existing event hooks)

### Frontend/SW files (expected)
- `apps/ui/public/sw.js` (add `push` + `notificationclick` handlers)
- `apps/ui/src/lib/push.ts` (permission + subscribe API glue)
- Settings UI surface (likely in `apps/ui/src/components/chat/SettingsDialog.tsx` and related hooks)

### Data/config
- VAPID key storage in shared data dir (e.g., `~/.middleman/shared/vapid-keys.json`)
- Subscription storage file (shared or profile-scoped; define intentionally)

### Rough scope
- ~8–12 touched files.
- ~3–6 implementation days including cross-browser/device validation.

---

## Bottom line
If the goal is **elegant simplicity**, do this in two steps:
1. **Ship installable PWA baseline first** (cheap, clean, immediate win).
2. Treat Web Push as optional enhancement, not core dependency—especially because iOS reliability is conditional and operational complexity is real.
