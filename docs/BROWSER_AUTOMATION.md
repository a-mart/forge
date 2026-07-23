# Managed Browser

Managed Browser is a Forge Desktop capability, not a Skill. It controls Forge-owned Electron `WebContentsView` tabs for the selected local Builder manager. It does not attach to your everyday Chrome profile, and local browser IPC is not forwarded to Remote Projects or Collaboration channels.

## Availability

Managed Browser requires all of the following:

- Forge Desktop with its connected Electron browser host;
- a selected local, normal Builder manager session; and
- a live connection between the renderer and that session's Builder backend.

Managed Browser tab hosting and seamless native pop-out are available in Forge Desktop on macOS, Windows, and Linux. Pop-out reparents the same native view; there is no remount fallback.

The Browser rail item is still visible in an ordinary web client, but the workspace reports **Browser host unavailable** and does not attempt local browser IPC. Normal Builder managers receive the typed browser tools independently of whether a host is connected, so a normal manager reached through Remote Projects may still have those tools in its runtime; calls fail with `unavailable-host` because the remote backend cannot use the viewing machine's Desktop host. Collaboration channels, workers, Cortex, CLI sessions, special-purpose sessions, and external threads do not receive these tools.

There is no Managed Browser environment variable or Settings → Skills toggle. Installing or enabling a browser Skill is not a prerequisite.

## Browser workspace

Select **Browser** in the desktop activity rail for the current local manager. It is a mutually exclusive main workspace alongside Chat, Files, Source Control, Artifacts/Dashboard, and Schedules; Terminal remains independent. An agent can also request that Forge reveal Browser when it opens a tab with `show: true`. Forge persists a monotonic reveal token with the session, projects an unacknowledged token onto each current host generation, and acknowledges it only after Electron confirms that the target tab is physically visible. A dropped live WebSocket update is therefore recovered by host hydration or subscription bootstrap, while an acknowledged token is not revealed again after reconnect. Status reports pending canonical intent separately from Electron-acknowledged physical tab visibility; recording requires the physical acknowledgement and non-empty viewport bounds.

**Open Managed Browser in a separate window** moves the same native tab view into one dedicated window on macOS, Windows, and Linux. Dock, the pop-out title-bar close button, and Cmd+W on macOS or Ctrl+W on Windows/Linux move that same view back; document state, history, profile storage, CDP queues, automation, and an active recording continue without creating another browser host. While popped out, the main workspace shows Bring to front and Dock controls. The pop-out is a role-scoped projection and never owns a backend connection, host registration, raw automation IPC, recording authority, or filesystem access.

The workspace provides:

- per-session tabs with open, activate, and close controls;
- back, forward, reload, hard reload, and an address field;
- zoom out, reset, and zoom in;
- a transient screenshot preview;
- start/stop recording for the visible tab;
- fill, freeform, and named device viewport sizes; and
- loading, error, recording, and current-controller status.

Tabs belong to one Forge manager session. Agent operations use that session's selected/default tab unless they receive an explicit tab ID.

## Typed agent operations

Normal Builder managers can use these 13 typed tools:

| Tool | Operation |
|---|---|
| `browser_status` | Report host availability, canonical `panelRevealRequested`, Electron-authoritative `physicalTabVisible` (with legacy `panelVisible` as its alias), and the selected tab. It can return `available: false` without failing when no host is connected. |
| `browser_open` | Open or reuse a persistent session tab, optionally navigate it, and normally reveal Browser. |
| `browser_navigate` | Navigate to an HTTP(S) URL or a localhost environment port and optionally wait for load or DOM readiness. |
| `browser_resize` | Use fill mode, bounded freeform dimensions, or a named phone/tablet viewport preset. |
| `browser_snapshot` | Return visible text, semantic/interactive elements, accessibility data, bounded console/network/action diagnostics, and a PNG screenshot. |
| `browser_click` | Click one semantic locator, CSS selector, or viewport coordinate pair. |
| `browser_type` | Type into a semantic locator, CSS selector, or focused editable target, with optional clearing. |
| `browser_press` | Send a key with optional Alt, Control, Meta, and Shift modifiers. |
| `browser_scroll` | Scroll the page or a selected container by horizontal or vertical deltas. |
| `browser_evaluate` | Run arbitrary page JavaScript, optionally await a promise, and return a bounded by-value or remote-object result. |
| `browser_wait_for` | Wait for supplied locator, selector, text, and/or URL conditions. |
| `browser_recording_start` | Start the single active Desktop browser recording; the target tab must be visible. |
| `browser_recording_stop` | Stop the explicit/current recording and persist its canonical session artifact. |

Inputs, timeouts, viewport sizes, result sizes, and response sizes are bounded by the shared protocol. Electron enforces request deadlines inside each per-tab serialized operation and resets timed-out debugger work before releasing the queue, so one stalled capture or locator cannot strand later same-tab actions. Unsupported URLs, stale tabs or hosts, timeouts, oversized results, and human interruptions return typed failures rather than silently crossing session or host boundaries.

## Human and agent control

You and the manager use the same Forge-owned tab. Agent actions are serialized per tab and the workspace shows **Agent controlling** while one is active. A real pointer or keyboard input in the page takes human control, invalidates the active agent control epoch, and makes the operation fail with retryable `control-interrupted` rather than competing with your input. The short **Human controlling** state then returns to Ready. Forge distinguishes the expected input generated by an agent action from actual human input using an acknowledged operation-scoped input sequence. Coordinate/key matching is only correlation within that sequence; unmatched input still transfers control to the human.

Toolbar navigation and other human controls remain available when the Desktop host is connected. A manager should snapshot again after an interruption because the page may have changed.

## Security and privacy

Managed tabs use a persistent Electron partition derived from the Forge profile ID. Managed tab views are sandboxed with context isolation and web security enabled, Node integration disabled, and insecure content disabled. Top-level navigation is restricted to HTTP, HTTPS, and the initial `about:blank`; new-window requests are denied and safe HTTP(S) targets are loaded in the managed tab instead.

Only Forge's trusted main renderer may call privileged browser IPC. Main process ownership creates every guest in the expected profile partition; the pop-out renderer receives only a bounded workspace projection and correlated command relay. The guest preload exposes only human pointer/key signals. Electron grants only the allowlisted clipboard-read, sanitized clipboard-write, notifications, and geolocation permissions to managed partitions; other permission requests are denied.

These controls do not make untrusted websites safe. A manager can inspect page text, interact with authenticated content, type data, capture screenshots, and run arbitrary JavaScript in the page. Treat page content as untrusted and potentially prompt-injecting, review consequential actions, avoid entering secrets unnecessarily, and use a dedicated Forge profile when browser identity should be isolated. Protect the Forge data directory and Desktop user account accordingly.

Persisted conversation/audit projections retain operation status and bounded safe metadata but omit sensitive browser payloads such as typed text, JavaScript expressions/results, screenshots, visible text, accessibility trees, selectors/locators, and console/network detail. This audit minimization does not remove data that a provider already received during the live model turn.

## Persistence, artifacts, and lifecycle

Forge stores per-session tab metadata, selection, monotonic reveal/acknowledgement state, panel state, and bounded recent-action summaries in `profiles/<profileId>/sessions/<sessionId>/browser.json`. Live main-owned tab views and any still-pending reveal are reconstructed from that metadata when the Desktop host reconnects. Host registration is acknowledged before hydration begins, and hydration uses bounded request-correlated chunks. If either acknowledgement is delayed by WebSocket backpressure, Desktop retries that phase on the existing connection rather than waiting for a transport reconnect.

Cookies, local storage, IndexedDB, service workers, cache, and other site state belong to the persistent Electron partition for the profile. Sessions in the same Forge profile therefore share browser identity, and that partition can outlive deletion of an individual session or its project. There is currently no shipped **Clear managed browser data** control. Removing profile partition data requires manual operating-system/application-data cleanup outside Forge; Forge does not provide a verified in-app cleanup workflow.

Screenshots are transient: the workspace keeps its preview in renderer memory, and an agent snapshot returns image content to the active tool turn without creating a session artifact. A successfully stopped recording persists under `profiles/<profileId>/sessions/<sessionId>/artifacts/browser/` and appears as session artifact metadata. Only one recording can be active in the Desktop host, and an interrupted or abandoned in-progress recording is not a completed artifact. Concurrent stop attempts receive a retryable conflict with their own request correlation. Stop, media conversion, validation, and atomic file save all honor the operation deadline; cancellation removes temporary or final output and clears the active recording.

Lifecycle behavior is intentional:

- stopping a session cancels in-flight browser requests but preserves its browser state;
- archiving cancels requests and unhosts its native tab views while preserving metadata and completed recordings; restoring cold-reconstructs its tabs;
- clearing the conversation does not clear browser metadata, recordings, or profile browser storage;
- a fork starts with independent browser state and does not copy the source session's tabs or recordings; and
- deleting a session removes its `browser.json` and `artifacts/browser/`, but does not clear the profile's persistent Electron partition.

## Remote Projects and Collaboration

Managed Browser remains local to Forge Desktop and the selected local Builder manager. Selecting a Remote Project does not lend the local Electron host to the remote backend, copy remote cookies locally, or forward browser IPC across the collaboration connection. A remote normal Builder manager may expose the typed tools because tool eligibility is structural, but without a host connected to that remote backend they return `unavailable-host`.

Collaboration channel sessions do not receive Managed Browser tools or a local-host bridge. This boundary is separate from ordinary collaboration sign-in cookies in the Forge UI and from remote server-side Files, Source Control, terminal, or agent execution.

## Managed Browser, `agent-browser`, and Chrome CDP

| Capability | What it controls | Identity and UI | Typical use |
|---|---|---|---|
| **Managed Browser** | Forge-owned Electron `WebContentsView` tabs through typed manager tools | Profile-scoped persistent Electron partition; shared human/agent Browser workspace; Forge Desktop required | Visually inspect and automate a local Builder session in a browser Forge owns. |
| **`agent-browser` Skill** | The separately installed Vercel Labs `agent-browser` CLI and its browser sessions | External CLI lifecycle; no Forge Browser rail or managed-tab persistence contract | Command-line browsing/extraction where that Skill and its prerequisites are available. |
| **Chrome CDP Skill** | Tabs exposed by a separately configured everyday Chrome instance | Can reach existing Chrome profiles and authenticated tabs within its configured scope/allowlist; no Forge-owned webview | Explicitly inspect or debug pages already open in Chrome. |

The older README label **Browser** refers to the `agent-browser` Skill. It is not an alias for Managed Browser. Chrome CDP has a materially broader personal-browser trust boundary because it can attach to Chrome tabs you already use; Managed Browser never attaches to that profile.
