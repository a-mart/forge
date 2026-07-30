# Browser automation

Forge Desktop exposes one protocol-v2 **Automatic Browser Host** to normal local Builder managers. The host privately runs each logical tab on either Forge's embedded Electron browser or the optional Chrome adapter. This is not a user- or caller-selected host preference, and neither target kind is a Skill.

The separate [`agent-browser` Skill](#agent-browser-skill) keeps its own CLI and browser lifecycle.

## Automatic target policy

Each logical browser tab has a sticky private target affinity:

- `managed-electron` — a main-process-owned Electron `WebContentsView` rendered inside Forge;
- `external-chrome` — one exact tab in a Chrome profile that loaded Forge's extension.

The affinity is assigned to each logical tab and is not a host-preference picker. An inventory `tabId` may explicitly select an eligible Chrome tab when opening; after selection, an operation with an explicit logical `tabId` always returns to that target. Forge never silently moves an explicit Chrome tab into Electron, or an embedded tab into Chrome, to make an operation succeed.

Once the Forge extension is enabled and authenticated in a Chrome profile, the Automatic Browser can access eligible ordinary web tabs across that profile. For a tabless request, the Automatic Browser Host:

1. keeps non-open operations on the session's selected or default logical tab when one exists;
2. treats `browser_open` as the explicit selection boundary described below;
3. routes physical resize and recording directly to an embedded tab; and
4. uses the embedded browser when Chrome acquisition is unavailable or an embedded-only capability is required.

### Eligible tab inventory and open selection

`browser_status` returns a bounded `eligibleTabs` inventory across all ready, authenticated Chrome profiles. Each entry has an opaque canonical `tabId` accepted by `browser_open`; inventory selection does not require OS focus. Ranking is deterministic: active tab first, then a tab in the focused window, then descending Chrome last-access time (exposed publicly as `lastAccessedAt`), descending profile connection time, ascending opaque extension-instance ID, ascending window ID, and ascending tab ID. The public inventory is capped at 32 entries. `eligibleTabsTruncated` is true when the aggregate exceeds that cap, any profile reports its own inventory truncated, or a ready profile's inventory request fails; candidates from failed profiles are omitted. There is no Chrome profile confirmation prompt or picker.

The `reuseExistingTab` input controls whether a tabless open selects an existing eligible Chrome tab or may create a new one:

- The model-facing `browser_open` tool defaults `reuseExistingTab` to `true`. Without `tabId`, it selects the active or most recently accessed eligible tab from the profile-wide inventory, without requiring Chrome or the operating system to be focused.
- Passing an inventory `tabId` explicitly selects that exact eligible Chrome tab. The tab ID comes from `browser_status`; it is not a profile picker or host preference.
- Tabs created from the Browser workspace use `reuseExistingTab: false`. When creation is needed, or when no eligible tab exists, Forge may create an inactive neutral `about:blank` tab. A URL-bearing open performs one authorized initial navigation on that created tab.
- After an open selects a logical tab, subsequent non-open operations remain sticky to it. Explicit Chrome tabs do not migrate, and child tabs are not automatically enrolled.

Chrome-internal pages, extension pages, and other platform-restricted pages remain excluded from eligibility. A normal web tab held by DevTools or another competing debugger may still appear in `eligibleTabs`, but acquisition or execution fails while that debugger controls the tab; inventory does not imply that Forge can take control.

## Operations and workspace

The common operation set is:

- status and open;
- navigate and snapshot;
- click, type, key press, and scroll;
- JavaScript evaluation; and
- bounded wait (`waitFor` in protocol v2).

### External Chrome snapshot response bounds

An External Chrome snapshot measures the complete JSON-RPC response in UTF-8 before sending it. Its PNG is captured adaptively from the page's CSS viewport and device pixel ratio: Forge starts at the largest qualified scale and retries smaller scales until the PNG meets the qualified pixel and byte limits, never upscaling a smaller source viewport. The useful floor is 320×180; if the image is still too large at that minimum qualified scale, Forge returns the typed, non-retryable `response-too-large` failure with the stable `minimum-qualified-screenshot-overflow` limitation. It never claims a snapshot succeeded by dropping or silently shrinking below that floor.

If the successful JSON-RPC response would exceed the negotiated bounded response envelope, the extension deterministically compacts only optional snapshot data: it drops console, network, and action-timeline diagnostics; bounds accessibility nodes; keeps a bounded prefix of visible text; and retains the largest fitting prefix of interactive elements. If that still does not fit, accessibility data, interactive elements, and visible text may be omitted as a final fallback. The screenshot is never dropped, recompressed, or replaced. A compacted response includes `compaction.omitted` with positive counts for each omitted source category; `compaction` is absent when nothing was omitted. If the screenshot itself cannot fit the envelope, Forge returns `response-too-large` with the stable screenshot-only limitation rather than overflowing the relay. Callers should branch on the stable error code and retryability; diagnostic `details` are bounded metadata, not required for this outcome.

Physical viewport resize and recording start/stop are embedded-only. Chrome also has no managed download workflow, saved download artifacts, opening of downloaded files, standalone screenshot export controls, or dock/pop-out view. A Chrome snapshot can still return bounded transient page and PNG data to the active operation.

The Desktop activity rail has one **Browser** workspace:

- an embedded tab renders in Forge with navigation, viewport, transient screenshot, recording, and dock/pop-out controls;
- a Chrome-backed tab stays in Chrome and appears as a compact card with **Show in Chrome**; and
- controls that the current target cannot support are hidden rather than presented as a second-host choice.

**Show in Chrome** does not depend on a long-lived attachment. Forge first settles any active operation burst, reacquires the exact sticky Chrome tab with transient authority, reveals it, and releases that exact authority again. If the exact target cannot be reacquired, reveal fails rather than opening or migrating another tab.

The workspace renderer registers one Desktop host with the local Builder backend and forwards bounded calls through trusted IPC. It transiently relays complete `browser_status` inventory responses between the trusted bridge and backend, but does not project that inventory into Browser workspace UI or canonical renderer state. The renderer exposes no tab-attachment, group, lease, or authority controls.

### Logical authority and physical debugger lifecycle

Logical Chrome authority (the exact session/lease/tab ownership) and the physical `chrome.debugger` attachment are separate lifecycles. A logical tab can remain Chrome-affine and idle while no debugger is attached. The Desktop authority burst releases after 30 seconds of logical inactivity; the extension's physical debugger session has a 35-second idle timeout and a five-minute maximum lifetime. Nearby operations may reuse one exact same-lease attachment, but `attached-idle`/`agent-idle` is truthful only while that exact attachment and its leased root identity remain positively proven.

Trusted clicks, key presses, wheel scrolls, and touch gestures are collaborative input. They advance the operation/control epoch, cancel the agent operation, and require a fresh snapshot before another potentially mutating operation. Forge waits for already-dispatched CDP commands to settle; when that proof succeeds it preserves the exact logical lease and exact attachment as `attached-idle` rather than detaching or replaying. A fresh snapshot re-observes the page and clears the gate. Ordinary trusted pointer movement while idle is ignored. During an active exact synthetic sequence, however, a mismatched or interleaved trusted `pointermove` (including a hover move at different coordinates) cancels that sequence; only the exact next expected event is treated as synthetic. Untrusted page events do not interrupt.

A renderer swap or eligible page navigation stays on the same logical target. Forge positively re-proves the replacement root and frame ancestry over the exact debugger channel, reinjects the singleton bridge, and remains `attached-idle` only after that proof; callers must re-observe with a fresh snapshot. While revalidation is pending, status does not claim `attached-idle`. Restricted or unproven targets, DevTools/competing-debugger preemption, a closed tab, transport uncertainty, expiry, operation cancellation/failure/timeout, update, and quit detach physical control and terminally reconcile the logical lease as appropriate. Stop/turn end release the exact authority; **Take Control** is an explicit terminal human takeover that releases the exact authority and does not leave it available for agent reattachment. This distinction never permits an explicit target to migrate.

## Safety, fallback, and authority

### Safe fallback and no replay

Automatic fallback is limited to requests whose failure metadata proves that mutation did not start. Forge makes one Chrome acquisition/execution attempt for the request; if that attempt fails before mutation, it falls back directly to the embedded browser. Forge does not make a dedicated-Chrome retry or promise focused-tab reuse.

Desktop writes a durable, exact pre-acquisition journal before sending an acquisition request. If that journal cannot be written, the request has not been sent and a non-explicit request may still be eligible for embedded fallback with `mutationState: not-started`. Once delivery may have begun, a Desktop crash, lost response, or uncertain journal finalization is treated as `mutationState: possible`: Forge performs no fallback and no replay, and reconciles the exact lease/tab on authenticated reconnect. A possible mutation returns no-replay evidence to the caller.

Forge does not replay an operation after it may have clicked, typed, navigated, evaluated code, or otherwise mutated the page. That failure returns typed `mutationState` and `noReplay` details to the caller. Explicit logical targets also never fall back to another affinity.

### Operation-scoped Chrome authority

Chrome control is private, per-tab, compare-and-set authority. Consecutive operations may share a short adaptive authority burst so Forge does not repeatedly attach and release the debugger between nearby actions. Operations remain serialized, and trusted human input interrupts agent control instead of racing it.

Every non-terminal release is tied to the exact Chrome instance, logical session, tab, lease identity, and owner epoch. Desktop checkpoints that identity before control. The extension durably retains an exact release receipt after releasing the tab; the receipt is not removed merely because the release response arrived. Desktop first durably records the pending acknowledgement, then sends the exact release acknowledgement; the extension removes its receipt only after that explicit acknowledgement succeeds. If either response or persistence is lost, both sides retain exact evidence and retry the same scope after reconnect. Later acquisition for that session is blocked until reconciliation.

Admission reserves bounded checkpoint and release-receipt capacity before a new acquisition or created tab can proceed. When that capacity or a transport/request queue is full, Forge rejects or backpressures new work rather than evicting receipts, guessing a scope, or abandoning cleanup.

Physical control detaches on trusted input after settlement, external navigation while its replacement root is being proved, DevTools/competing-debugger preemption, proven root-identity or restricted-target loss, target close, operation cancellation/failure/timeout, idle timeout, maximum lifetime, transport uncertainty, lease expiry, and runtime update/shutdown. Trusted collaborative input and eligible navigation normally preserve the exact logical lease and, once settlement/revalidation is proven, the exact attachment as `attached-idle`; timeout or physical expiry may leave the exact lease idle for a later reattach. Identity loss, restricted targets, DevTools preemption, target close, transport uncertainty, lease expiry, and terminal lifecycle cleanup release that lease with exact evidence. Chrome tabs remain open when authority is released. Inspect or snapshot again after a collaborative interruption or navigation; never replay a request whose mutation state is possible.

Turn end, stop, archive, host replacement, Desktop update, and Desktop quit use this fail-closed cleanup path. In particular, archive does not proceed when its browser release cannot be acknowledged. Deletion is different because it is terminal: Forge attempts exact browser revocation, but browser revocation is best-effort and a stale release cannot block deletion. After a delete request, Desktop clears the matching session's in-memory state, while External Chrome attempts to release and then forgets matching checkpoints and session affinity even if the extension is disconnected or the acknowledgement is lost.

### Maintainer correctness boundaries

- Re-injection is a recovery probe, not a second attachment mechanism. Each live document owns one singleton content bridge, keyed by exact tab, frame, and document identity; duplicate bridges are rejected, stale document bridges are replaced, and bridge cardinality is bounded. Eligible navigation re-proves root identity and frame ancestry before reinjection; it does not create a detach/reattach gap.
- Collaborative input is epoch-based. Trusted click, key, wheel, or touch starts revoke the current operation epoch before cleanup. The exact debugger/lease may remain `attached-idle` only after every already-dispatched CDP command settles by the caller deadline; otherwise cleanup detaches and terminally reconciles. A fresh successful snapshot is the only re-observation gate for mutation.
- Synthetic trusted-input suppression is exact-sequence based, not time-based. Every trusted pointer, key, wheel, or touch event must match and consume the next expected signature (including phase, modifiers, coordinates/buttons, key fields, wheel deltas, or touch points). Idle `pointermove` is ignored; a mismatched/interleaved event during a sequence immediately interrupts agent control. Untrusted page events are ignored.
- `browser_evaluate` always invokes CDP `Runtime.evaluate` with `userGesture: false`. Synthetic input uses its separate narrowly bracketed CDP input path and trusted-event acknowledgement; arbitrary evaluation never receives transient user activation.
- Navigation dispatch and cleanup share one deadline. Initial navigation checks authority immediately before the sole `tabs.update`; late readiness callbacks cannot inject, complete, or replay after expiry. Timed-out native request IDs remain accepted only as bounded tombstones (30 seconds, capped at 128); late responses are consumed without disconnecting, while unknown or malformed responses remain bounded protocol errors.
- Native transport errors are local to the request where possible. A bounded request/response or reconnect failure returns typed error metadata without tearing down a valid authenticated port; disconnect/reconnect renegotiates protocol, payload identity, bounds, heartbeat, and authority snapshots automatically. A replacement port never receives a late response from an older port epoch.

## Privacy and persistence

Browser automation can inspect authenticated pages, capture visible content and accessibility data, type data, click controls, and execute arbitrary page JavaScript. Treat website instructions as untrusted and review consequential actions. A model provider may receive page data required for the active turn.

Forge's Chrome extension declares exactly:

- host permission `<all_urls>`; and
- permissions `alarms`, `debugger`, `nativeMessaging`, `scripting`, `storage`, and `webNavigation`.

It declares no action or side-panel surface, optional permissions, `tabGroups`, `bookmarks`, `history`, `downloads`, `sessions`, `notifications`, or `topSites`. Forge does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. A dedicated Chrome profile containing only the accounts needed for Forge work is strongly recommended.

Each session's `browser.json` uses protocol schema v2. It stores logical session identity, hosting state, tabs with private `targetAffinity`, active/default tab identity, panel and reveal state, bounded recent action summaries, lifecycle-cleanup acknowledgement, revision, and timestamps. It does **not** store a selected browser host.

Before writing schema-v2 state, Forge redacts Chrome-backed page URLs and titles, tab error detail, and page-identifying URL/title fields from action summaries. The bounded `eligibleTabs` fields (`url`, `title`, opaque profile/window IDs, active state, window-focus state, and `lastAccessedAt`) may transiently reach the manager/model through `browser_status` so it can select a target, but are not projected into Browser workspace UI or canonical renderer/session state and are not persisted. Exact authority stays in Desktop memory or protected integration recovery state, not renderer state. Redaction limits durable exposure; it cannot retract page data already used by a live operation or model turn.

Schema-v1 state migrates conservatively. Proven embedded tabs become `managed-electron` tabs. Unproven Chrome hints, old lease-like records, and reveal intent that points only at a dropped target are discarded or satisfied rather than reinterpreted as authority.

Embedded cookies and site storage live in a persistent profile-scoped Electron partition and can outlive a session; Forge does not currently ship a clear-data control. Chrome site identity remains in Chrome's profile. Transient screenshots are not standalone artifacts. Successfully stopped recordings live under the session's `artifacts/browser/` directory and are embedded-only. Clearing conversation history does not clear browser state, a fork starts with independent browser state, archive/restore preserves metadata and completed recordings, and deleting a session removes its browser metadata and recordings but not the profile-scoped Electron partition.

## Optional Chrome setup

Forge's Chrome adapter is an intentionally unpacked local Desktop integration, not a Chrome Web Store extension. Chrome 125 or newer, Developer mode, and unpacked extensions must be allowed by browser and enterprise policy.

Forge Desktop deploys a deterministic extension shell/payload and an authenticated native-messaging host under the active data directory. Chrome always loads the stable folder:

```text
<data-dir>/integrations/external-chrome/extension/
```

Setup is per Chrome profile and per `FORGE_DATA_DIR`:

1. Open the intended dedicated Chrome profile.
2. In Forge Desktop, open **Settings → Use Chrome with Forge**.
3. Choose **Show Forge extension folder** when available.
4. Manually open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the exact revealed `extension/` folder—not its parent or a payload subdirectory.
5. Confirm extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`.
6. Return to Settings and choose **Use Chrome with Forge**.

Settings is deliberately limited to status, setup/enable, qualified repair, and revealing the validated folder, with advanced diagnostics for failures. There is no browser-host selector, persisted target preference, profile alias, candidate list, attachment flow, or authority UI.

Compatible connected extensions can reload an authenticated local payload after Desktop update or recovery. A manual reload in `chrome://extensions` is fallback-only when **Settings → Use Chrome with Forge → Advanced diagnostics → Recovery** reports `manual-extension-reload`. Development builds can also require one manual reload after Desktop replaces same-version development content while the old worker is broken or disconnected.

### Repair and troubleshooting

- **Chrome setup is unavailable:** use the main Forge Desktop window. Ordinary web clients cannot inspect local installation state or invoke Desktop browser IPC.
- **Chrome does not connect:** verify Chrome 125+, Developer mode, enterprise policy, the exact stable folder, and the pinned extension ID, then refresh Settings.
- **Native host missing or untrusted:** choose **Repair** only when Settings enables it. Do not substitute or hand-edit an executable, manifest, registry key, rendezvous, or authentication file.
- **Registration conflict:** Chrome has one current-user registration target for Forge's native host name. Stop the other Forge installation or data-directory owner before using qualified repair; do not overwrite the target manually.
- **Restricted target or debugger conflict:** close DevTools or the competing debugger and retry. Forge will not take over a restricted page.
- **Pending exact release:** for a normal lifecycle release or archive, keep Chrome and Forge open for authenticated reconciliation; Forge blocks new acquisition rather than abandoning the checkpoint or guessing another target. A terminal delete is the exception: Forge forgets matching Desktop/External Chrome session state and checkpoints after its best-effort revocation attempt, so a stale release does not block deletion.
- **Chrome tab no longer exists:** the logical target remains Chrome-affine and fails. Open a new logical browser tab instead of expecting silent migration.
- **Different data directory:** load that data directory's stable extension folder in the intended Chrome profile and complete setup there.

For maintainers diagnosing a newly dedicated Chrome open, the target may first appear as an inactive `about:blank`. A URL-bearing open performs the one authorized initial navigation for that exact target; it must not be treated as a generic navigation replay.

The focused unit/build and isolated-profile checks do not prove live MV3 service-worker suspension/restart behavior, headed Chrome, native-host/Desktop end-to-end registration, or current-platform Chrome debugger behavior. macOS, Windows, and Linux reparenting/packaging/signing and release-SEA gates remain separate qualification gates.

Canonical data paths and OS registration targets are in [Configuration](CONFIGURATION.md#chrome-adapter-local-integration). Maintainer staging, signing, package-content, and qualification gates are in the [Electron release guide](../apps/electron/README.md#optional-chrome-adapter-packaging-and-validation).

## Local-only boundary

The Automatic Browser Host is attached only to the normal local Builder backend reached by Forge Desktop. An ordinary browser client has no local host. Forge does not forward its Electron views, Chrome relay, extension connection, private target affinity, authority, recovery checkpoints, or IPC through active-origin routing.

A normal manager running on a remote backend may still have structurally planned browser tools. Without a Desktop host connected directly to that backend, calls return `unavailable-host`; the viewing machine's Desktop does not satisfy them. Collaboration channel sessions receive neither the host nor browser tools.

## `agent-browser` Skill

The `agent-browser` Skill invokes the separately installed Vercel Labs CLI and owns a separate browser/session lifecycle. It does not register the Automatic Browser Host, use `browser.json`, appear in the Browser workspace, or configure Chrome integration. Use the Skill when you specifically want its command-line browsing and extraction workflow.
