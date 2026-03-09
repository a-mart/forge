# V2 Live Preview — UI/UX Research Report

**Date:** 2026-03-09  
**Researcher:** pw-v2-ui-embedding-research  
**Status:** Research complete — ready for design review

---

## Executive Summary

The user wants the Playwright Dashboard to evolve from a read-only discovery/status surface into a **live browser preview experience** — essentially embedding what the Playwright remote control window provides (a real-time viewport into agent-controlled browsers) directly into the Middleman dashboard.

This report evaluates UX models for that embedding, proposes a recommended V2 architecture, and includes a lightweight v1.1 tweak for immediate improvement to the current dashboard.

**Recommended V2 direction:** A **split-view layout** (session list + selected-session live canvas) as the default, with a **focus mode** toggle to expand the live canvas full-width, and a **tile mosaic** option for power users monitoring multiple active sessions. The live preview should be driven by CDP `Page.startScreencast` streamed through a thin Middleman backend proxy, rendered as an `<img>` frame stream in the browser — no VNC, no iframe, no external dependencies.

---

## 1. Current State Analysis

### 1.1 What exists today (v1 dashboard)

The Playwright Dashboard currently occupies the **center pane** of the Middleman shell (alongside chat and settings views). It renders:

- **Summary bar** — stat cards: total sessions, active, stale, correlated, worktrees, last scan time
- **Filter bar** — search, status dropdown, worktree dropdown, correlated-only toggle, preferred-only toggle, rescan button
- **Session card grid** — responsive 1/2/3 column grid of `PlaywrightSessionCard` components showing:
  - Session name + schema version badge
  - Liveness badge (Active/Inactive/Stale/Error) with green pulse dot for active
  - Location path with worktree badge
  - Agent correlation with confidence badge
  - Port chips (FE, API, CDP, Sandbox, LiteLLM)
  - Artifact counts (page snapshots, screenshots, console logs, network logs)
  - Last updated timestamp
  - Warnings banner

The dashboard is **read-only and discovery-focused**. It shows metadata about discovered sessions but provides no live visual feedback about what the browser is actually displaying.

### 1.2 What the "Playwright remote control window" provides

The existing Playwright CLI experience gives users a **live headed browser window** — a real Chrome window on their desktop that they can watch in real-time as agents navigate pages, fill forms, click buttons, and take screenshots. The key qualities:

1. **Immediacy** — you see exactly what the browser sees, frame-by-frame
2. **Real-time** — actions appear as they happen, no polling delay
3. **Full fidelity** — it's the actual browser viewport, not a summary or screenshot
4. **Context** — you can see the URL bar, page content, loading states, errors
5. **Trust** — watching the browser builds confidence the agent is doing the right thing

### 1.3 Gap analysis

The current dashboard tells you *that* a browser session exists and *whether* it's alive. It doesn't show *what* the browser is doing. Bridging this gap means adding a live visual stream from the browser into the dashboard UI.

### 1.4 Technical enablers already in place

- **CDP port** is already discovered and stored per session (`ports.cdp`)
- **CDP responsiveness** is already probed during liveness checks
- **Session correlation** already links browsers to agents
- **WebSocket infrastructure** already supports streaming data to the UI
- **The dashboard center pane** already has full width available

---

## 2. Technical Approach for Live Preview

### 2.1 CDP Screencast (Recommended)

Chrome DevTools Protocol provides `Page.startScreencast` which streams JPEG/PNG frames at configurable quality and framerate. This is the same mechanism Chrome DevTools uses for its "Remote Devices" screen mirror.

**How it works:**
1. Backend connects to the browser's CDP port (`http://127.0.0.1:{cdpPort}/json/version` → `webSocketDebuggerUrl`)
2. Backend sends `Page.startScreencast` with format/quality/maxWidth/maxHeight params
3. Chrome streams `Page.screencastFrame` events with base64-encoded JPEG data
4. Backend proxies frames to the Middleman UI over WebSocket
5. UI renders frames into an `<img>` tag or `<canvas>` element

**Advantages:**
- No external dependencies (no VNC server, no noVNC client library, no separate viewer)
- Works with headless Chrome (the sessions are `headless: true`)
- Configurable quality/resolution tradeoff
- Low latency (~100-200ms per frame)
- Frames only sent when content changes (Chrome is smart about this)
- Already proven technology (Chrome DevTools, Playwright Trace Viewer, etc.)

**Parameters:**
```
Page.startScreencast({
  format: 'jpeg',      // jpeg is much smaller than png
  quality: 60,         // 0-100, 60 is good balance of quality/bandwidth  
  maxWidth: 1280,      // match the browser viewport
  maxHeight: 720,      // match the browser viewport
  everyNthFrame: 1     // every frame, or 2 for half-rate
})
```

### 2.2 Alternatives Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **CDP Screencast** | No deps, works headless, low latency, configurable | Requires backend CDP proxy | ✅ **Recommended** |
| **VNC + noVNC** | Full interactivity, industry standard | Requires VNC server on Chrome (not standard), heavy client lib, doesn't work headless | ❌ Overkill, wrong fit |
| **iframe to CDP inspector** | Zero backend work | CORS issues, security nightmare, doesn't work headless, Chrome DevTools UI not embeddable | ❌ Not viable |
| **Periodic screenshots via CDP** | Simple implementation | High latency, polling waste, choppy experience | ❌ Inferior UX |
| **Playwright trace replay** | Rich timeline | Post-hoc only, not live | ❌ Wrong use case |

### 2.3 Backend Proxy Architecture

```
Browser (headless Chrome)
  │ CDP WebSocket (ws://127.0.0.1:{cdpPort})
  │
  ▼
PlaywrightScreencastService (new backend service)
  │ - connects to CDP on demand when UI requests preview
  │ - manages screencast lifecycle (start/stop/ack)
  │ - transcodes frames if needed
  │ - multiplexes: one CDP connection, N UI consumers
  │
  ├── WebSocket frame events ──► Middleman WS Server ──► UI clients
  │
  └── REST endpoints for connect/disconnect/status
```

**Key design decisions for the proxy:**
- **On-demand** — only connect to CDP and start screencast when a UI client requests preview
- **Reference-counted** — stop screencast when last UI viewer disconnects
- **Frame acknowledgment** — use `Page.screencastFrameAck` to maintain backpressure
- **Thumbnail mode** — for tile view, send lower quality/resolution frames
- **Full mode** — for focused view, send higher quality frames

---

## 3. Proposed UX Models

### 3.1 Model A: Split View (List + Live Canvas)

```
┌─────────────────────────────────────────────────────────┐
│ Playwright Dashboard                        [⊞] [⟳] [⚙]│
├──────────────┬──────────────────────────────────────────┤
│ Sessions     │                                          │
│ ┌──────────┐ │  ┌──────────────────────────────────┐    │
│ │● active  │ │  │                                  │    │
│ │ default  │◄├──│   Live Browser Preview            │    │
│ │ main     │ │  │   (CDP screencast stream)        │    │
│ └──────────┘ │  │                                  │    │
│ ┌──────────┐ │  │  [Current URL: https://...]      │    │
│ │● active  │ │  │                                  │    │
│ │ default  │ │  └──────────────────────────────────┘    │
│ │ fix-feat │ │                                          │
│ └──────────┘ │  Agent: pw-worker-1 (fix-feature)       │
│ ┌──────────┐ │  Status: Active │ CDP: 62123            │
│ │○ stale   │ │  Artifacts: 12 snapshots, 3 screenshots │
│ │ default  │ │  Last activity: 2m ago                  │
│ │ fix-stop │ │                                          │
│ └──────────┘ │                                          │
├──────────────┴──────────────────────────────────────────┤
│ Summary: 3 sessions │ 2 active │ 1 stale │ Last: 30s  │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- Left panel shows compact session list (always visible)
- Clicking a session selects it and shows its live preview in the right canvas
- Selected active session auto-starts screencast; inactive/stale shows last screenshot or placeholder
- Session list shows liveness indicators (green dot pulsing for active, gray for stale)
- Metadata panel below the preview canvas shows correlation, ports, artifacts
- Resizable divider between list and canvas

**Pros:**
- Natural discovery-to-detail flow
- Always see all sessions while previewing one
- Clean mental model: pick a session, see what it's doing
- Responsive: on mobile, list becomes a drawer/sheet that overlays the canvas

**Cons:**
- Only one live preview visible at a time
- Left panel takes space from the preview
- Less useful if you want to watch multiple sessions simultaneously

### 3.2 Model B: Tile Mosaic

```
┌─────────────────────────────────────────────────────────┐
│ Playwright Dashboard                   [≡ List] [⊞] [⚙]│
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────┐ ┌─────────────────────┐        │
│ │ ● default (main)    │ │ ● default (fix-feat) │        │
│ │ ┌─────────────────┐ │ │ ┌─────────────────┐ │        │
│ │ │                 │ │ │ │                 │ │        │
│ │ │ Live Preview    │ │ │ │ Live Preview    │ │        │
│ │ │ (thumbnail)     │ │ │ │ (thumbnail)     │ │        │
│ │ │                 │ │ │ │                 │ │        │
│ │ └─────────────────┘ │ │ └─────────────────┘ │        │
│ │ CDP:62123  2m ago   │ │ CDP:64592  Just now  │        │
│ └─────────────────────┘ └─────────────────────┘        │
│ ┌─────────────────────┐                                │
│ │ ○ default (fix-stop)│                                │
│ │ ┌─────────────────┐ │                                │
│ │ │   No Preview    │ │                                │
│ │ │   (stale)       │ │                                │
│ │ └─────────────────┘ │                                │
│ │ Stale · 3h ago      │                                │
│ └─────────────────────┘                                │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 3 sessions │ 2 active │ 1 stale │ Last scan: 30s ago  │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- Each session rendered as a tile card with embedded thumbnail preview
- Active sessions show live low-res screencast thumbnails
- Stale/inactive sessions show a placeholder or last-known screenshot
- Clicking a tile opens focus mode (full-size live preview)
- Double-click or expand button enters full-canvas mode for that session
- Grid auto-fits: 1 col mobile, 2 cols tablet, 3+ cols desktop

**Pros:**
- See all sessions at a glance with visual context
- Immediately obvious which sessions are alive/active
- Natural "security camera grid" mental model
- Great for the common case of 2-5 active sessions

**Cons:**
- Thumbnails are small — hard to read page content
- More bandwidth: streaming N thumbnails simultaneously
- More complex backend: N simultaneous CDP screencast connections
- Cards are heavier to render
- Doesn't scale well past ~6 active sessions on normal screens

### 3.3 Model C: Focus Mode (Single Session Full Canvas)

```
┌─────────────────────────────────────────────────────────┐
│ ← Back  │ default (main) │ ● Active │ CDP:62123  [⟳][⚙]│
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │                                                     │ │
│ │                                                     │ │
│ │              Full-Size Live Preview                  │ │
│ │              (CDP screencast stream)                │ │
│ │                                                     │ │
│ │                                                     │ │
│ │                                                     │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│ URL: https://app.example.com/dashboard                  │
│ Agent: pw-worker-1 (fix-feature) │ 12 snapshots         │
│ Viewport: 1280×720 │ Quality: High │ FPS: ~5            │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- Entered by clicking a session from the list or tile view
- Full available width/height used for the live preview
- Back button returns to list/tile view
- Compact header with session info + controls
- URL bar showing current page
- Optional metadata footer

**Pros:**
- Maximum preview fidelity — closest to the actual Playwright window experience
- Simple, focused interaction
- Low bandwidth — only one screencast stream
- Easy to implement well

**Cons:**
- Loses sight of other sessions
- Requires navigation (click in → view → back out)
- Not great for monitoring multiple sessions

### 3.4 Model D: Hybrid (Recommended)

**Combine A + C with B as an opt-in power mode:**

1. **Default: Split View (Model A)** — session list on left, selected session preview on right
2. **Focus Mode toggle** — expand the preview to full width, hiding the list
3. **Tile Mode toggle** — switch to mosaic view for multi-session monitoring
4. **Persist preference** — remember last mode in localStorage

This gives users all three experiences behind simple view toggles in the dashboard header.

---

## 4. Recommended V2 UI Architecture

### 4.1 View Mode Switcher

```
┌──────────────────────────────────────────────────────────┐
│ ← Back  Playwright Dashboard   [☰ Split] [⊞ Tiles] [⚙] │
└──────────────────────────────────────────────────────────┘
```

Three modes accessible from the header:
- **Split** (default) — list + canvas
- **Tiles** — mosaic grid with thumbnails
- **Focus** — entered contextually by expanding a preview (not a top-level toggle)

### 4.2 Component Tree

```
PlaywrightDashboardView (center pane)
├── DashboardHeader
│   ├── BackButton
│   ├── Title + status indicator
│   ├── ViewModeSwitcher (split/tiles)
│   ├── RescanButton
│   └── SettingsButton
│
├── SplitView (when mode = 'split')
│   ├── SessionListPanel (left, resizable)
│   │   ├── SearchInput
│   │   ├── QuickFilters (active/all/stale toggle)
│   │   ├── SessionListItem[] (compact rows)
│   │   │   ├── LivenessDot
│   │   │   ├── SessionName
│   │   │   ├── WorktreeBadge
│   │   │   └── TimeAgo
│   │   └── SummaryFooter
│   │
│   └── PreviewPanel (right, flex-1)
│       ├── LivePreviewCanvas (screencast frames)
│       │   ├── <img> or <canvas> for frame rendering
│       │   ├── ConnectionOverlay (connecting/disconnected states)
│       │   ├── StaleOverlay (for inactive sessions)
│       │   └── ExpandButton (→ focus mode)
│       ├── URLBar (current page URL)
│       └── SessionDetailBar
│           ├── CorrelationInfo
│           ├── PortChips
│           ├── ArtifactCounts
│           └── Timestamps
│
├── TileView (when mode = 'tiles')
│   ├── FilterBar
│   └── TileGrid
│       └── SessionTile[] (card with embedded thumbnail)
│           ├── ThumbnailPreview (low-res screencast)
│           ├── SessionHeader (name + liveness)
│           ├── CompactMeta (worktree, last updated)
│           └── ExpandButton (→ focus mode)
│
└── FocusView (when mode = 'focus', overlays split/tile)
    ├── FocusHeader (back to previous mode, session name, controls)
    ├── FullSizePreviewCanvas
    ├── URLBar
    └── DetailFooter
```

### 4.3 State Management

```typescript
// Dashboard-level state (component-local, persisted to localStorage)
interface PlaywrightDashboardState {
  viewMode: 'split' | 'tiles'               // persisted
  selectedSessionId: string | null           // transient
  focusSessionId: string | null              // transient (when in focus mode)
  listPanelWidth: number                     // persisted (split mode divider)
  showInactive: boolean                      // persisted (default: false)
  searchQuery: string                        // transient
  tileQuality: 'low' | 'medium'             // persisted
}

// Screencast connection state (per-session, managed by hook)
interface ScreencastState {
  sessionId: string
  status: 'connecting' | 'streaming' | 'paused' | 'disconnected' | 'error'
  currentFrame: string | null                // base64 JPEG data URL
  currentUrl: string | null
  frameRate: number                          // observed FPS
  lastFrameAt: number | null
  error: string | null
}
```

### 4.4 Screencast Hook

```typescript
// apps/ui/src/hooks/use-playwright-screencast.ts
function usePlaywrightScreencast(options: {
  wsUrl: string
  sessionId: string | null
  quality: 'thumbnail' | 'preview' | 'full'
  enabled: boolean
}): {
  frame: string | null           // current frame as data URL
  url: string | null             // current page URL
  status: ScreencastState['status']
  fps: number
  error: string | null
  reconnect: () => void
}
```

### 4.5 New Protocol Events

```typescript
// Client → Server: request screencast start/stop
interface PlaywrightScreencastStartCommand {
  type: 'playwright_screencast_start'
  sessionId: string
  quality: 'thumbnail' | 'preview' | 'full'
}

interface PlaywrightScreencastStopCommand {
  type: 'playwright_screencast_stop'
  sessionId: string
}

// Server → Client: screencast frames
interface PlaywrightScreencastFrameEvent {
  type: 'playwright_screencast_frame'
  sessionId: string
  frame: string                  // base64 JPEG
  url: string                   // current page URL
  timestamp: number
  metadata?: {
    width: number
    height: number
    deviceScaleFactor: number
  }
}

interface PlaywrightScreencastStatusEvent {
  type: 'playwright_screencast_status'
  sessionId: string
  status: 'streaming' | 'paused' | 'disconnected' | 'error'
  error?: string
}
```

### 4.6 Quality Profiles

| Profile | Max Width | Max Height | JPEG Quality | Use Case |
|---------|-----------|------------|-------------|----------|
| `thumbnail` | 320 | 180 | 40 | Tile mosaic view |
| `preview` | 640 | 360 | 60 | Split view panel |
| `full` | 1280 | 720 | 80 | Focus mode |

Frame size estimates:
- Thumbnail: ~5-15 KB/frame
- Preview: ~15-40 KB/frame  
- Full: ~40-100 KB/frame

At ~3-5 FPS (typical for screencast with content changes):
- Thumbnail: ~15-75 KB/s per session
- Preview: ~45-200 KB/s per session
- Full: ~120-500 KB/s per session

These are very manageable for local network use.

---

## 5. Recommended v1.1 Quick Improvement (Current Dashboard)

Before V2, a small improvement to the current dashboard that addresses immediate usability:

### 5.1 Hide stale/inactive sessions by default

**Problem:** The current dashboard shows ALL discovered sessions with no status pre-filtering. Stale sessions from hours/days ago clutter the view and make it harder to find what's actually running.

**Change:** Default the status filter to `active` instead of `all`.

```diff
// PlaywrightDashboardView.tsx
const INITIAL_FILTERS: PlaywrightDashboardFiltersState = {
  search: '',
- status: 'all',
+ status: 'active',
  worktree: 'all',
  onlyCorrelated: false,
  onlyPreferred: false,
}
```

**Add a visible "Show all" toggle:**

```
┌─────────────────────────────────────────────────┐
│ [Search...] [Active ▾] [All worktrees ▾] [⟳]   │
│                                                  │
│ Showing 2 active sessions                        │
│ [Show all 5 sessions including stale/inactive →] │
└─────────────────────────────────────────────────┘
```

When the user has the `active` filter on and there are hidden sessions, show a subtle link/button below the filter bar: *"Also showing: 2 inactive, 1 stale — [Show all]"* that switches to `all`.

### 5.2 Persist filter preference

Store the last-used status filter in `localStorage` so returning to the dashboard remembers the user's preference.

### 5.3 Auto-focus active sessions

When the dashboard opens and there's exactly one active session, auto-select it (preparation for V2 where selection drives the preview).

---

## 6. Navigation: Summary/Discovery ↔ Live Preview

### 6.1 Entry Points

Users arrive at the Playwright Dashboard from:
1. **Sidebar nav button** — the MonitorPlay icon in the sidebar footer
2. **Direct URL** — `?view=playwright`
3. **Future: notification** — "Browser session started" click-through

### 6.2 Flow Within the Dashboard

```
[Dashboard opens]
    │
    ├── (Has active sessions?) 
    │   ├── Yes, 1 session → Split view, auto-select it, start preview
    │   ├── Yes, multiple → Split view, no auto-select (user picks)
    │   └── No active → Split view, list shows all, preview pane shows empty state
    │
    ├── [User clicks session in list]
    │   └── Preview pane updates, screencast starts if active
    │
    ├── [User clicks expand on preview]
    │   └── Focus mode: full-width preview, "← Back" returns to split
    │
    ├── [User switches to Tile mode]
    │   └── Grid of tiles with thumbnails, click any → Focus mode
    │
    └── [User clicks Rescan]
        └── Rescans, updates list, preserves selection if session still exists
```

### 6.3 Summary Information Preservation

In all view modes, summary information remains accessible:

- **Split view:** Summary footer at bottom of session list panel
- **Tile view:** Summary bar above the tile grid
- **Focus view:** Compact detail footer below the preview

No mode completely loses the operational metadata that the v1 dashboard provides.

### 6.4 Back-to-Chat Integration

The dashboard always has a "← Back to chat" button in the header (same as current v1). The Playwright nav button in the sidebar shows active state highlighting when the dashboard is open.

---

## 7. Multi-Session vs Single-Session Scaling

### 7.1 Session Count Scenarios

| Scenario | Active | Inactive/Stale | Recommended Default View |
|----------|--------|---------------|-------------------------|
| Solo developer, one agent | 0-1 | 0-3 | Split view |
| Active development, 2-3 agents | 1-3 | 2-5 | Split view |
| Heavy parallel work, 5+ agents | 3-8 | 5-15 | Tile view |
| Stale environment, nothing running | 0 | 5-20 | Split view (empty preview) |

### 7.2 Scaling Strategy

- **1-3 active sessions:** Split view is ideal. User selects one at a time to preview.
- **4-8 active sessions:** Tile view becomes valuable. Users can see all active sessions as thumbnails and drill into any one.
- **8+ active sessions:** Tile view with pagination or virtual scrolling. Thumbnails become essential for quick identification.

### 7.3 Resource Management

- Maximum simultaneous screencast connections: **cap at 6** (configurable). Beyond that, only the most recently active sessions get live thumbnails; others show a "click to preview" placeholder.
- When user leaves the dashboard (navigates to chat/settings), **all screencast connections are closed** after a 5-second grace period.
- Tile thumbnails use the `thumbnail` quality profile. Split/focus use `preview`/`full`.

---

## 8. Responsive / Mobile Considerations

### 8.1 Desktop (≥1024px)

Full split view with resizable divider. Tile view shows 2-3 columns.

### 8.2 Tablet (768-1023px)

Split view with narrower list panel (200px min). Tile view shows 2 columns. Focus mode is the same.

### 8.3 Mobile (<768px)

**Split view transforms:**
- Session list is the default view (full width)
- Tapping a session opens focus mode (full-width preview)
- Back button returns to list
- No simultaneous list + preview (not enough space)

**Tile view transforms:**
- Single column of tiles with thumbnails
- Tap to focus

**Key mobile constraints:**
- Use `dvh` units (already in the codebase) to avoid viewport issues
- Touch targets minimum 44px (already followed by sidebar patterns)
- Swipe gestures: swipe left on preview to return to list (optional, not v2-critical)

### 8.4 Preview Sizing

The preview canvas should maintain the browser viewport aspect ratio (default 1280×720 = 16:9) and scale to fit the available container with letterboxing if needed. On mobile, the preview fills the width and the height adjusts proportionally.

---

## 9. Session Lifecycle in the Preview

### 9.1 Active Session Selected

- Screencast starts automatically
- Green connection indicator
- Frames update in real-time
- URL bar shows current page
- If the session becomes inactive while previewing, show a "Session ended" overlay with the last frame frozen

### 9.2 Inactive Session Selected

- Show a static placeholder: "Session inactive — browser not running"
- If last-known screenshot is available from artifacts, show it dimmed with an "Inactive" badge overlay
- If the session becomes active while selected (agent starts browser), auto-start screencast

### 9.3 Stale Session Selected

- Show "Session stale — last active {time}" with muted styling
- Option to dismiss/hide stale sessions

### 9.4 Connection Failures

- If CDP connection fails: show "Unable to connect to browser" with retry button
- If screencast frames stop (timeout >5s): show "Preview paused — waiting for activity"
- If browser crashes: show "Browser disconnected" with the last frame frozen

---

## 10. Success Criteria

**"Feels like the current Playwright remote control window, but built into Middleman"**

### 10.1 Must-have for V2 Launch

1. **Live frames** — see the browser updating in real-time when an agent is actively browsing
2. **Low latency** — less than 500ms from action in browser to visual update in dashboard
3. **Reliable connection** — auto-reconnects if CDP connection drops
4. **Session awareness** — immediately obvious which session is previewed, its status, and its agent correlation
5. **Zero external deps** — no VNC, no noVNC, no additional Chrome flags beyond what's already configured
6. **Non-intrusive** — starting a preview should not interfere with the agent's browser operations
7. **Clean lifecycle** — preview starts when you look, stops when you leave

### 10.2 Should-have

8. **URL visibility** — see the current page URL (like a browser address bar)
9. **Multi-session awareness** — easy to switch between sessions
10. **Tile overview** — at-a-glance view of all active browsers
11. **Quality adaptation** — lower quality for thumbnails, higher for focused view

### 10.3 Nice-to-have (V2.x)

12. **Click-to-interact** — click in the preview to send mouse events to the browser (remote control)
13. **Keyboard forwarding** — type in the preview to send keyboard events
14. **Console log panel** — see browser console output alongside the preview
15. **Network activity indicator** — visual indicator when the browser is loading
16. **Screenshot capture** — one-click screenshot from the preview
17. **Recording** — record a screencast session as video

### 10.4 Anti-goals

- NOT a replacement for Chrome DevTools — no DOM inspector, no network panel
- NOT a remote desktop — no full OS-level interaction
- NOT a test runner UI — no test results, no assertions view

---

## 11. Comparison of Models — Decision Matrix

| Criterion | Split View (A) | Tile Mosaic (B) | Focus Mode (C) | Hybrid (D) |
|-----------|:---:|:---:|:---:|:---:|
| Discovery + preview together | ✅ | ⚠️ | ❌ | ✅ |
| Multi-session monitoring | ⚠️ | ✅ | ❌ | ✅ |
| Preview fidelity | ⚠️ | ❌ | ✅ | ✅ |
| Implementation complexity | Low | High | Low | Medium |
| Bandwidth efficiency | ✅ | ❌ | ✅ | ✅ |
| Mobile-friendly | ✅ | ⚠️ | ✅ | ✅ |
| Feels like "the Playwright window" | ⚠️ | ❌ | ✅ | ✅ |
| Preserves operational metadata | ✅ | ⚠️ | ⚠️ | ✅ |
| Scales to many sessions | ⚠️ | ✅ | ❌ | ✅ |

**Winner: Model D (Hybrid)** — Split view as default, with tile and focus mode as toggleable options.

---

## 12. Explicit Recommendation

### V1.1 (immediate, ship this week)

1. Change default status filter from `all` to `active`
2. Add a "Show N hidden sessions" affordance when filtered
3. Persist filter preference in localStorage
4. Auto-select the single active session if there's exactly one

**Effort: ~2-4 hours. Zero backend changes.**

### V2 Architecture (next milestone)

1. **Backend: PlaywrightScreencastService**
   - New service in `apps/backend/src/playwright/`
   - Connects to CDP WebSocket on demand
   - Manages `Page.startScreencast` / `Page.screencastFrameAck` lifecycle
   - Proxies frames over existing Middleman WS as new event types
   - Reference-counted: starts on first UI consumer, stops on last disconnect
   - Quality profiles: thumbnail (320×180), preview (640×360), full (1280×720)

2. **Protocol: New events**
   - `playwright_screencast_start` (client command)
   - `playwright_screencast_stop` (client command)
   - `playwright_screencast_frame` (server event)
   - `playwright_screencast_status` (server event)

3. **Frontend: Hybrid dashboard**
   - Default: **Split view** (session list + preview canvas)
   - Toggle: **Tile view** (mosaic with live thumbnails)
   - Contextual: **Focus mode** (full-width preview from any entry point)
   - `usePlaywrightScreencast` hook manages frame state
   - Preview rendered as `<img src={dataUrl}>` for simplicity and performance
   - Preserve all existing metadata/filters/summary in the list panel
   - View mode + divider width persisted in localStorage

4. **Default behavior on dashboard open:**
   - If 1 active session → auto-select, start preview in split view
   - If 2+ active sessions → split view, no auto-select, user picks
   - If 0 active sessions → split view, list shows all, preview shows empty state
   - Stale/inactive sessions hidden by default, "Show all" toggle visible

5. **Lifecycle:**
   - Screencast starts when session is selected (or when tile view mounts for active sessions)
   - Screencast stops when user deselects, navigates away, or session goes inactive
   - All screencasts stop when user leaves the Playwright dashboard
   - Backend CDP connections close after 10s of no UI consumers

### Implementation Order

1. Backend screencast proxy service (can be developed independently)
2. Protocol event types
3. `usePlaywrightScreencast` hook
4. Split view with preview canvas
5. Focus mode
6. Tile view with thumbnails
7. v1.1 quick-wins (filter defaults, persistence)

Steps 1 and 7 can be done in parallel. Steps 2-6 are sequential.

---

## 13. Open Questions for Design Review

1. **Interaction in preview:** Should V2 include click/keyboard forwarding to the browser, or is view-only sufficient? (Recommendation: view-only for V2, interaction in V2.x)

2. **Tile view cap:** How many simultaneous thumbnail screencasts should we allow? (Recommendation: 6, configurable)

3. **Audio:** Should we consider forwarding browser audio? (Recommendation: No, out of scope)

4. **Session naming:** The current session names are all "default" which isn't helpful in a multi-session view. Should we surface the worktree name more prominently? (Recommendation: Yes — primary label should be `{worktreeName}/{sessionName}` or just worktree name when session is "default")

5. **Integration with chat:** When previewing a browser tied to an agent, should there be a "Jump to chat" button? (Recommendation: Yes — bidirectional navigation between agent chat and its browser preview)
