# V2 Live Preview Research: Embedded Playwright Remote Control

Date: 2026-03-09
Research scope: Agent Stack existing Playwright remote-control experience, embeddable live-preview options for Middleman, and recommended V2 path.

## Executive summary

The existing “Playwright remote control window” is **already a real live remote browser viewer**, but it is **not** a native DOM embed of the target page.

It works by:

1. Running Playwright browser sessions under a local daemon (`playwright-cli` session socket + persistent profile/session files).
2. Starting a **DevTools controller WebSocket** for a chosen Playwright browser context.
3. Streaming **live screencast frames** from the browser page to a UI.
4. Sending mouse/keyboard/navigation commands back over that same controller.
5. Optionally embedding Chromium DevTools in a side iframe for the selected tab.

So the current experience is best described as:

- **live and interactive**
- **frame-streamed / remote-controlled**
- **not screenshot polling**
- **not direct iframe embedding of the target app DOM**

### Best V2 recommendation

**Primary recommendation:** reuse the existing Playwright DevTools web UI and controller protocol inside Middleman, but host/embed it **inside Middleman** rather than launching the separate standalone app window.

Concretely:

- serve the Playwright DevTools frontend (or a thin adapted copy of it) from the Middleman backend
- keep using Playwright’s existing per-session `devtools-start` controller WebSocket
- embed the resulting UI in the Middleman web app via a same-origin iframe or mounted sub-app pane

This gives the closest match to the existing remote-control window with the least behavioral risk.

---

## 1. How the current remote control window works today

## 1.1 Agent Stack’s own repo mostly wires up Playwright CLI; the live remote-control UI is in Playwright internals

In Agent Stack, the relevant project-level entrypoints are:

- `scripts/pwcli.sh`
- `.playwright-cli/sessions/*.session`
- docs in `docs/guides/playwright-cli.md`

The actual live remote-control window implementation is **not custom Agent Stack UI code**. It comes from the Playwright CLI package and Playwright internals.

### Evidence

- `scripts/pwcli.sh` sets stable daemon/session directories:
  - `PLAYWRIGHT_DAEMON_SOCKETS_DIR=/tmp/playwright-cli-sockets`
  - `PLAYWRIGHT_DAEMON_SESSION_DIR=$(pwd)/.playwright-cli/sessions`
- It then runs:
  - `npx --yes --package @playwright/cli playwright-cli "$@"`

Source:
- `/Users/adam/repos/newco/agent_stack/scripts/pwcli.sh`

A current session file in Agent Stack shows the session is configured with:

- `assistantMode: true`
- `cdpPort: 53030`
- a daemon socket path
- persistent user-data dir

Source:
- `/Users/adam/repos/newco/agent_stack/.playwright-cli/sessions/3f15aae11982f048/default.session`

That tells us Agent Stack is already running the newer Playwright assistant/devtools flow, not some custom screenshot panel.

---

## 1.2 `playwright-cli show` launches a separate DevTools app window

The command path is:

1. `playwright-cli show`
2. `playwright/lib/cli/client/program.js`
3. spawn `devtoolsApp.js`
4. `devtoolsApp.js` starts a local HTTP server and opens a Chromium app window

### Key codepaths

#### CLI command dispatch
Source:
- `/tmp/pwcli-inspect/pw/package/lib/cli/client/program.js`

Relevant behavior:

- `case "show"` resolves `devtoolsApp.js`
- spawns a detached node process
- that process hosts the app and opens the window

#### Standalone DevTools app
Source:
- `/tmp/pwcli-inspect/pw/package/lib/cli/client/devtoolsApp.js`

Important details:

- starts an HTTP server
- serves static assets from:
  - `playwright-core/lib/vite/devtools`
- exposes session APIs under `/api/...`
- launches a Chromium app window with `--app=data:text/html,`
- loads the local HTTP server URL in that window

This means the current remote-control UI is already a **web app**. It is not inherently tied to a native desktop container beyond the fact that Playwright’s `show` command currently opens it in a separate Chromium app window.

That is a very important finding for Middleman: **there is embeddable web content here already.**

---

## 1.3 Session discovery model used by the current window

The DevTools app backend exposes:

- `GET /api/sessions/list`
- `POST /api/sessions/close`
- `POST /api/sessions/delete-data`
- `POST /api/sessions/run`
- `POST /api/sessions/devtools-start`

Source:
- `/tmp/pwcli-inspect/pw/package/lib/cli/client/devtoolsApp.js`

The frontend polls `/api/sessions/list` every 3 seconds.

In the minified frontend bundle, the model object (`V0`) does this:

- fetches `/api/sessions/list`
- stores sessions + client info
- for connectable sessions, calls `/api/sessions/devtools-start`
- caches returned WebSocket URLs per session socket path

This means:

- **session discovery/grid membership is polling-based**
- **the actual session viewport is not polling-based**

That distinction matters.

---

## 1.4 The live session viewport is a WebSocket-driven screencast + input tunnel

### How a session gets its live feed

When the app wants live control for a session, it calls:

- `POST /api/sessions/devtools-start`

That causes the session to run:

- `devtools-start`

Which maps to Playwright tool:

- `browser_devtools_start`

Which calls:

- `browserContext._devtoolsStart()`
- `BrowserContext.devtoolsStart()`
- `DevToolsController.start()`

### Key codepaths

Sources:
- `/tmp/pwcli-inspect/pw/package/lib/mcp/browser/tools/devtools.js`
- `/tmp/pwcli-inspect/pw-core/package/lib/server/browserContext.js`
- `/tmp/pwcli-inspect/pw-core/package/lib/server/devtoolsController.js`

### What `DevToolsController` does

`DevToolsController.start()`:

- starts an HTTP server with WebSocket handling
- creates a controller URL
- serves a connection that can either:
  - speak the custom devtools/session protocol, or
  - proxy CDP for Chromium pages

Inside `DevToolsConnection`:

- it tracks selected page/tab
- subscribes to page screencast frames
- emits tab list updates
- accepts commands:
  - `selectTab`
  - `closeTab`
  - `newTab`
  - `navigate`
  - `back`
  - `forward`
  - `reload`
  - `mousemove`
  - `mousedown`
  - `mouseup`
  - `wheel`
  - `keydown`
  - `keyup`
  - `pickLocator`
  - `cancelPickLocator`

This is exactly the interaction model the user described as the current “mini-browser window”.

---

## 1.5 Rendering model: live screencast frames, not DOM embedding

The selected page is rendered by:

- starting a Playwright screencast on the page
- receiving `Page.Events.ScreencastFrame`
- base64-encoding each frame
- emitting `frame` events to the UI

### Key codepaths

Sources:
- `/tmp/pwcli-inspect/pw-core/package/lib/server/devtoolsController.js`
- `/tmp/pwcli-inspect/pw-core/package/lib/server/screencast.js`

Important details:

- `DevToolsConnection._selectPage()` calls:
  - `page.screencast.startScreencast(this, { width: 1280, height: 800, quality: 90 })`
- frame handler sends:
  - `{ data, viewportWidth, viewportHeight }`
- UI converts the base64 payload into:
  - `data:image/jpeg;base64,...`
- and displays it in an `<img>`

The frame throttler in `screencast.js` aims for roughly:

- ~25 fps normally
- slower when throttling is enabled for tracing modes

So the current experience is:

- **live raster streaming**
- **JPEG frame push over WebSocket**
- **remote input backchannel**

It is **not**:

- static screenshots written to disk and refreshed on a timer
- a DOM iframe of the actual page
- a video tag or WebRTC stream

---

## 1.6 Chromium-only DevTools side panel

The live viewer also computes `inspectorUrl` for Chromium pages only.

Source:
- `/tmp/pwcli-inspect/pw-core/package/lib/server/devtoolsController.js`

It checks whether the page delegate is `CRPage` and then builds a Chrome DevTools frontend URL backed by a CDP-over-WebSocket bridge.

Implication:

- the **main live viewport** is broader Playwright screencast infrastructure
- the **DevTools iframe/panel** is specifically Chromium/CDP flavored

In Agent Stack, the session file shows Chromium + Chrome channel, so this fits the current usage.

---

## 2. What is truly live vs what is not

## 2.1 Truly live in the existing remote-control window

### Truly live

1. **Viewport updates**
   - pushed frame-by-frame over an active WebSocket
   - not timer-polled files
   - not user-triggered snapshots

2. **Remote input**
   - mouse, wheel, keyboard, tab/navigation commands go back immediately over the controller socket

3. **Tab/title/URL changes**
   - delivered as session events from the controller

4. **Inspector/CDP panel for Chromium**
   - backed by a live bridge, not static artifacts

### Not truly live

1. **Session discovery list itself**
   - the app polls `/api/sessions/list` every 3 seconds
   - new session appearance / removal is polling-based

2. **Artifact discovery in Middleman’s current dashboard**
   - entirely filesystem/discovery-based
   - no live viewport today

---

## 2.2 “Not screenshots” — precise interpretation

If by “not screenshots” the user means:

- not static PNG files
- not periodic `captureScreenshot` snapshots every few seconds
- not manual refresh

then the existing system qualifies as **truly live**.

If by “not screenshots” the user means:

- must be direct DOM embedding of the target page
- must not be pixel-streamed at all

then the current remote-control window does **not** qualify, because it is still a raster/frame stream.

The important product truth is:

> The current experience is a live remote browser stream, not a DOM embed.

That is also the experience the user explicitly wants replicated.

---

## 3. Technical strategies for embedding this into Middleman

## 3.1 Option A — Reuse the existing Playwright DevTools web app inside Middleman via iframe/sub-app

## Architecture

Use the existing Playwright DevTools frontend as an embeddable web app.

### Backend

Middleman backend would:

1. Serve the Playwright DevTools static assets from:
   - `playwright-core/lib/vite/devtools`
2. Provide the expected API routes under a Middleman path, e.g.:
   - `/api/playwright-live/sessions/list`
   - `/api/playwright-live/sessions/close`
   - `/api/playwright-live/sessions/delete-data`
   - `/api/playwright-live/sessions/devtools-start`
3. Either:
   - adapt Middleman’s discovery data to the Playwright app contract, or
   - reimplement the same session-listing logic directly from Playwright session files
4. Keep using Playwright’s existing `devtools-start` controller WebSocket per session

### Frontend

Middleman UI would embed:

- `<iframe src="/playwright-live/">`

or a session-specific hash:

- `/playwright-live/#session=<encoded socketPath>`

### Why this is attractive

- closest possible behavior match to today’s working remote-control window
- minimal behavioral re-implementation
- already has grid view + session detail + navigation + input capture
- already has Chromium DevTools side panel behavior

### Why this is truly live

Because the embedded app still talks to the same Playwright controller WebSocket and receives real-time screencast frames + input round-trips.

### Strengths

- fastest path to “it feels like the existing window”
- maximum reuse
- least protocol guessing

### Risks

- the app assets live under Playwright internal package paths, not a public stable UI API
- frontend bundle is effectively internal/private and version-sensitive
- you may need to pin Playwright CLI/Playwright versions tightly or vendor a snapshot
- iframe integration can feel slightly less native unless styled carefully

### Feasibility

**High** for a practical V2, provided Middleman accepts version-pinned reuse of internal Playwright assets.

---

## 3.2 Option B — Native Middleman React component that reuses the same controller WebSocket protocol

## Architecture

Instead of embedding the whole Playwright DevTools app, Middleman would build its own React component using the same `devtools-start` WebSocket URL.

### Backend

- Middleman keeps discovery of sessions
- Middleman exposes an endpoint that returns a `devtools-start` controller URL for a session

### Frontend

Build a native component that:

- opens the controller WebSocket
- receives `frame` and `tabs` events
- displays the frame stream in an `<img>` or `<canvas>`
- sends input/navigation commands back

This is basically reimplementing the key parts visible in the Playwright bundle:

- session detail pane
- tab strip
- navigation controls
- screencast viewport
- optional locator picker

### Why this is truly live

Same reason as Option A: the rendering is driven by the Playwright controller’s live screencast stream, not filesystem screenshots.

### Strengths

- best long-term Middleman-native UX
- no iframe boundary in the final session-view component
- can blend into current dashboard layout and state model

### Risks

- more implementation work than Option A
- protocol is not a documented public Playwright web API; it is inferred from internal code
- Chromium inspector panel integration is extra work if desired
- you either mirror the private protocol or copy code from internal Playwright UI

### Feasibility

**Medium-high**. Very viable, but more custom work than the iframe/sub-app reuse path.

---

## 3.3 Option C — Direct CDP mirroring from `cdpPort`

## Architecture

Use the discovered `cdpPort` from session files and connect directly to Chromium DevTools Protocol.

Potential flow:

1. Read `resolvedConfig.browser.launchOptions.cdpPort` from the session file
2. Call `http://127.0.0.1:<cdpPort>/json/version`
3. Attach to the right target/page
4. Start screencast via CDP (`Page.startScreencast`-style path)
5. Send input events via CDP (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, etc.)

### Why this is truly live

It would still be a live pushed frame stream, likely via CDP screencast, not screenshot polling.

### Strengths

- no dependency on Playwright’s internal DevTools frontend bundle
- fully custom to Middleman
- can be very powerful if you want tighter control later

### Risks

- significantly more implementation complexity
- Chromium-only in practice
- target/page selection becomes your problem
- can interfere with existing Playwright control if handled incorrectly
- more fragile than piggybacking on Playwright’s own controller abstraction
- you would be rebuilding functionality Playwright already built

### Feasibility

**Medium**, but worse than reusing Playwright’s existing controller unless there is a strong reason to own the full stack.

---

## 3.4 Option D — Embed the target app URL directly in an iframe

## Architecture

Just iframe the page URL the agent is working on.

### Why this is weak / usually wrong

This would **not** be the actual Playwright session.

Problems:

- different browser context
- different cookies/auth/session state
- not the agent’s real tab history
- not the same active page/tab selection
- cannot show what the agent is truly doing inside its Playwright-managed profile

### Live or not?

It is live web content, but **not the agent’s live session**.

### Feasibility

Technically easy, product-wise wrong for the requirement.

**Reject as primary architecture.**

---

## 3.5 Option E — Screenshot/polling based preview

Examples:

- poll `Page.captureScreenshot`
- run repeated `playwright-cli screenshot`
- use saved PNG artifacts from `.playwright-cli`

### Why this is weak

- laggy
- expensive
- looks choppy
- loses input interactivity unless you build a separate control path
- clearly inferior to the current remote-control experience

### Live or not?

**Not truly live**. This is screenshot polling.

### Feasibility

Easy-ish, but does not meet the user’s stated bar.

---

## 3.6 Option F — OS/window capture or video streaming fallback

Examples:

- capture a real headed Chrome window via OS APIs / ffmpeg / WebRTC
- stream it into Middleman

### Why this is weak

- heavy and brittle
- platform-specific
- requires a visible browser window
- much farther from the existing clean Playwright control path

### Live or not?

Potentially live, but operationally much weaker and more invasive.

### Feasibility

Low relative value for V2.

---

## 4. Browser-native constraints and realities

## 4.1 There is no real “embed the agent’s exact browser tab DOM” path without becoming that browser tab

A normal web iframe cannot directly become or attach to:

- an already-running Playwright-controlled browser tab in another browser process/profile
- its exact DOM/runtime/cookies/session state

So any faithful embedded preview will almost certainly be one of:

1. a live pixel/frame stream plus remote input
2. a remote browser UI built specifically for that purpose
3. a separate browser instance connected over CDP/remote protocol

That is exactly why Playwright’s current solution is screencast + control, not DOM embedding.

---

## 4.2 The current Playwright solution is already optimized for the right constraint set

It already solves:

- live rendering of the real page state
- input remoting
- tab switching
- navigation commands
- optional locator picking
- Chromium DevTools integration

That strongly argues for reuse over re-invention.

---

## 5. Recommended V2 architecture

## Primary recommendation

### **Embed a Middleman-hosted Playwright DevTools sub-app that reuses the existing Playwright controller protocol**

This is the best mix of:

- behavioral fidelity
- true liveness
- reuse
- delivery speed
- manageable implementation risk

## Recommended shape

### Phase 1: embedded sub-app reuse

1. **Backend route layer in Middleman**
   - add a new backend route namespace, e.g. `/playwright-live/*`
   - serve static assets from Playwright’s devtools bundle or a vendored copy
   - expose compatible session APIs under `/playwright-live/api/...`

2. **Session source**
   - use Middleman’s existing Playwright discovery service as the source of truth for visible sessions where possible
   - add a small adapter that maps Middleman session descriptors into the Playwright app’s expected session JSON shape
   - or directly mirror Playwright’s session list logic if that proves simpler

3. **Controller startup**
   - for a selected session, trigger the same `devtools-start` flow Playwright already uses
   - return the controller WebSocket URL

4. **UI embedding**
   - add a “Live view” affordance from the existing Playwright dashboard cards
   - open a full-pane or split-pane iframe pointing to the embedded sub-app
   - pass the target session via hash/query

5. **Same-origin hosting preferred**
   - do not iframe a random separate localhost server if avoidable
   - serve/proxy the assets through the Middleman backend so the browser sees one origin

## Why this is the best path

- It preserves the exact interaction style the user already likes.
- It avoids writing a bespoke CDP mirroring system.
- It avoids the major product mismatch of direct target-page iframes.
- It keeps “separate Chrome window” as fallback only, not primary.

---

## 6. Why the recommended path is truly live

The recommended path remains truly live because it keeps these existing mechanics:

1. **Live controller WebSocket per session**
2. **Playwright screencast frames pushed from the real page**
3. **Immediate mouse/keyboard/navigation commands back to the page**
4. **Live tab/title/URL updates from the actual session**

It is not based on:

- saved PNG artifacts
- periodic capture polling
- a replay log
- a synthetic second browser session

It is the same real-time remote-control model as today, just embedded.

---

## 7. Fallback architectures and why they are weaker

## Fallback 1 — Native Middleman React viewer using the same controller WS

Good fallback if iframe/sub-app reuse proves too awkward or version-fragile.

Weaker because:

- more code to build and maintain
- protocol reuse becomes more implicit/private
- extra work for parity with current session detail UX

Still a strong fallback.

## Fallback 2 — Direct CDP screencast/input implementation

Weaker because:

- more complexity
- Chromium-only bias
- more fragile ownership/target-selection behavior
- duplicates what Playwright already implemented

## Fallback 3 — Launch `playwright-cli show` in a separate window

This is the lowest-risk operational fallback because it already works today.

Weaker because:

- fails the embedded requirement
- breaks the integrated-dashboard feel
- feels bolted on

## Fallback 4 — screenshot polling

Weaker because:

- not truly live
- visually worse
- user explicitly does not want this outcome

---

## 8. Implementation implications for Middleman

## 8.1 Backend implications

Middleman currently has:

- discovery-only Playwright dashboard
- explicit note that live CDP/screenshot work was deferred
- no browser control path yet

Relevant sources:
- `/Users/adam/repos/middleman/docs/playwright-dashboard/DESIGN.md`
- `/Users/adam/repos/middleman/apps/backend/src/playwright/playwright-discovery-service.ts`

### New backend work likely needed

1. **Live route namespace**
   - add routes for a Playwright live-preview app/API

2. **Session adapter**
   - map discovered sessions to the Playwright app’s expected session payloads
   - include socket path, timestamps, session name, version, compatibility info

3. **Controller bootstrap**
   - endpoint that starts/returns a devtools controller URL for a session

4. **Potential static asset serving**
   - either serve Playwright devtools assets directly from installed package paths
   - or vendor/copy them into the repo for stability

5. **Security guardrails**
   - restrict to local authenticated Middleman users/sessions
   - avoid exposing arbitrary control URLs cross-origin

## 8.2 Frontend implications

### Suggested UX shape

Use the existing Playwright dashboard as the entry point.

Example V2 interaction:

1. user opens Playwright dashboard
2. sees discovered sessions as today
3. clicks **Live view** on a session card
4. center pane switches to embedded live viewer
5. optional back button returns to session grid

### Best near-term UI choice

- use a dedicated center-pane live view
- iframe or mounted sub-app fills the pane
- optionally support split mode later (session list left, live viewer right)

## 8.3 Product implications

If the user expectation is “same as the existing remote-control window but inside Middleman”, this path satisfies it.

If the expectation is “actual DOM iframe of the target web app”, that expectation should be reset, because the existing experience is not that either.

---

## 9. Open questions / validation steps

## 9.1 Validate Playwright asset reuse stability

Questions:

- How stable is `playwright-core/lib/vite/devtools` across upgrades?
- Do we vendor the bundle for stability, or serve it from the installed package?

Recommended validation:

- inspect package diff across one or two nearby Playwright versions
- decide whether to pin or vendor

## 9.2 Validate standalone-app-free hosting

Question:

- Can we cleanly host the existing web app without triggering `launchApp()` and its separate Chromium window?

Likely answer:

- yes, by reusing the static assets + API contract without calling the standalone launcher

Recommended validation:

- prototype a backend route that serves the devtools assets only
- verify the app boots in a normal browser tab/iframe

## 9.3 Validate session contract compatibility

Question:

- Should Middleman adapt its discovery snapshot to the Playwright app contract, or just re-run Playwright’s own session registry logic for the live sub-app?

Recommended validation:

- compare Middleman-discovered sessions with `/api/sessions/list` output from Playwright’s app for the same workspace
- choose the simpler/safer source of truth

## 9.4 Validate iframe behavior

Questions:

- Does the embedded app capture keyboard/mouse correctly inside an iframe?
- Does focus handoff feel okay?
- Does the Chromium inspector iframe inside the embedded app still work when nested?

Recommended validation:

- prototype same-origin iframe embed
- test click-to-capture, Escape-to-release, typing, tab switch, navigation

## 9.5 Validate scaling/perf

Questions:

- How many simultaneous session previews can we show before CPU/network gets noisy?
- Should grid thumbnails be lazy, selected-session-only, or hover-activated?

Recommended validation:

- measure with multiple active sessions
- probably only live-connect visible cards and the selected detail pane

## 9.6 Validate browser-family assumptions

Question:

- Are Middleman/Agent Stack sessions always Chromium for this feature, or do we need graceful degradation?

Observation:

- current Agent Stack sessions appear Chromium/Chrome channel
- inspector side-panel is Chromium-specific

Recommended validation:

- confirm expected browser family for the supported product path

---

## 10. Final recommendation

### Recommended V2 path

**Build an embedded Middleman live-preview surface by reusing Playwright’s existing DevTools web app + controller WebSocket flow, hosted inside Middleman rather than opened as a separate standalone window.**

### Why this is the right answer

- It most closely matches the existing remote-control experience.
- It is truly live in the same sense the current window is truly live.
- It strongly prefers reuse over reinvention.
- It keeps separate-window fallback available but not primary.
- It avoids the major trap of pretending a simple iframe of the target URL is equivalent.

### Practical next implementation step

Prototype this exact vertical slice:

1. Middleman backend serves Playwright devtools assets under `/playwright-live/`
2. Middleman backend exposes compatible `/playwright-live/api/sessions/*` endpoints
3. Middleman UI adds a “Live view” action on a Playwright session card
4. Clicking it opens a center-pane iframe to `/playwright-live/#session=<socketPath>`
5. Validate:
   - live motion
   - live tab updates
   - click/keyboard control
   - no separate Chromium app window

If that works, it is the best V2 foundation.

If that proves too brittle due to private asset coupling, the next-best fallback is:

**native Middleman React viewer using the same Playwright controller WebSocket protocol**

—not CDP-from-scratch, and not screenshot polling.
