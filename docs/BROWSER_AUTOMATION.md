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

An External Chrome snapshot preserves its PNG screenshot unchanged. If the successful JSON-RPC response would exceed the negotiated bounded response envelope, the extension measures the complete UTF-8 response and deterministically compacts only optional snapshot data: it drops console, network, and action-timeline diagnostics; bounds accessibility nodes; keeps a bounded prefix of visible text; and retains the largest fitting prefix of interactive elements. If that still does not fit, accessibility data, interactive elements, and visible text may be omitted as a final fallback. The screenshot is never dropped, recompressed, or replaced.

A compacted successful snapshot includes `compaction.omitted` with positive counts for each omitted source category (`accessibilityNodes`, `consoleEntries`, `networkEntries`, `actionTimelineEntries`, `interactiveElements`, and/or `visibleTextCharacters`). `compaction` is absent when nothing was omitted. If the screenshot alone cannot fit the response envelope, the operation returns the typed, non-retryable `response-too-large` failure rather than overflowing the relay or silently dropping the image. Callers should branch on that stable error code and retryability; any diagnostic `details` are bounded runtime metadata and are not required for this outcome.

Physical viewport resize and recording start/stop are embedded-only. Chrome also has no managed download workflow, saved download artifacts, opening of downloaded files, standalone screenshot export controls, or dock/pop-out view. A Chrome snapshot can still return bounded transient page and PNG data to the active operation.

The Desktop activity rail has one **Browser** workspace:

- an embedded tab renders in Forge with navigation, viewport, transient screenshot, recording, and dock/pop-out controls;
- a Chrome-backed tab stays in Chrome and appears as a compact card with **Show in Chrome**; and
- controls that the current target cannot support are hidden rather than presented as a second-host choice.

**Show in Chrome** does not depend on a long-lived attachment. Forge first settles any active operation burst, reacquires the exact sticky Chrome tab with transient authority, reveals it, and releases that exact authority again. If the exact target cannot be reacquired, reveal fails rather than opening or migrating another tab.

The workspace renderer registers one Desktop host with the local Builder backend and forwards bounded calls through trusted IPC. It transiently relays complete `browser_status` inventory responses between the trusted bridge and backend, but does not project that inventory into Browser workspace UI or canonical renderer state. The renderer exposes no tab-attachment, group, lease, or authority controls.

## Safety, fallback, and authority

### Safe fallback and no replay

Automatic fallback is limited to requests whose failure metadata proves that mutation did not start. Forge makes one Chrome acquisition/execution attempt for the request; if that attempt fails before mutation, it falls back directly to the embedded browser. Forge does not make a dedicated-Chrome retry or promise focused-tab reuse.

Forge does not replay an operation after it may have clicked, typed, navigated, evaluated code, or otherwise mutated the page. That failure returns typed `mutationState` and `noReplay` details to the caller. Explicit logical targets also never fall back to another affinity.

### Operation-scoped Chrome authority

Chrome control is private, per-tab, compare-and-set authority. Logical lease authority and physical debugger attachment have separate lifecycles. Consecutive operations in one exact lease may reuse a bounded physical attachment; between operations the Browser workspace reports **Agent attached · idle**, not human control. Attachments have bounded idle and maximum-lifetime timers and a profile-wide simultaneous-attachment cap. Operations remain serialized. Trusted human input advances the operation epoch before detach, so it interrupts agent control instead of racing it while leaving the exact logical lease available for an explicit later operation.

A timeout, cancelled/stale navigation, or ambiguous execution failure revokes its operation epoch and waits for tracked CDP commands to settle through debugger detach before the tab queue can continue. Root navigation outside an admitted operation also advances the idle epoch and detaches before later work. DevTools preemption, debugger identity loss, restricted navigation, transport uncertainty, lease expiry, runtime update/shutdown, and explicit lifecycle release use terminal cleanup. Supported in-operation navigation may retain the physical attachment only when Chrome positively re-proves the same tab-scoped root identity; a renderer target-ID change is adopted from that proof rather than guessed. Arbitrary `browser_evaluate` runs with CDP `userGesture: false` and therefore does not manufacture transient user activation.

The isolated-world trusted-input bridge is a singleton for each exact `{tab, frame, document}`. Repeated recovery injection cannot multiply Ports or DOM listeners; document replacement disconnects the stale frame bridge, and both per-tab and profile-wide bridge cardinality are bounded.

Every release is tied to the exact Chrome instance, logical session, tab, lease identity, and owner epoch. Forge checkpoints that identity before control and removes the checkpoint only after Chrome acknowledges the exact release. If a normal release acknowledgement is lost:

- the checkpoint remains durable;
- Forge retries that same release after reconnection; and
- later Chrome acquisition for that session is blocked until the exact release is acknowledged.

Turn end, stop, archive, host replacement, Desktop update, and Desktop quit use this fail-closed cleanup path and do not complete when browser release cannot be acknowledged. Deletion may still complete its terminal logical-session cleanup, but Desktop does not forget the exact pending debugger-release checkpoint merely because the extension is disconnected. Pending terminal intent is durable and is proactively reconciled when that exact extension instance reconnects. Chrome tabs remain open when authority is released.

When a leased Chrome tab closes, physical target destruction is detach proof. The extension durably writes an opaque exact tab-close receipt before removing session authority, unions it with any remaining tabs in the same owner epoch, retries failed receipt writes, and can return the original released tab IDs after worker or browser restart. Extension startup also reconciles debugger state left by worker suspension: it detaches only positively identified Forge-owned attachment state, treats foreign ownership as preemption without detaching the foreign debugger, and reports active or receipted authority to Desktop on reconnect. The extension runtime maintains bounded attachment/reuse/duration/detach-reason, bridge-cardinality, preemption, and cleanup diagnostics for qualification and troubleshooting. Opening DevTools, another debugger taking control, Chrome or extension disconnect, expiry, or human input can interrupt an operation; inspect or snapshot again before continuing.

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
- **Pending exact release:** keep Chrome and Forge open for authenticated reconciliation. This applies to normal release, archive, and terminal deletion: Forge blocks new acquisition rather than abandoning a possibly attached debugger checkpoint or guessing another target; non-delete lifecycle cleanup also waits for the acknowledgement.
- **Chrome tab no longer exists:** the logical target remains Chrome-affine and fails. Open a new logical browser tab instead of expecting silent migration.
- **Different data directory:** load that data directory's stable extension folder in the intended Chrome profile and complete setup there.

For maintainers diagnosing a newly dedicated Chrome open, the target may first appear as an inactive `about:blank`. A URL-bearing open performs the one authorized initial navigation for that exact target; it must not be treated as a generic navigation replay.

Canonical data paths and OS registration targets are in [Configuration](CONFIGURATION.md#chrome-adapter-local-integration). Maintainer staging, signing, package-content, and qualification gates are in the [Electron release guide](../apps/electron/README.md#optional-chrome-adapter-packaging-and-validation).

## Local-only boundary

The Automatic Browser Host is attached only to the normal local Builder backend reached by Forge Desktop. An ordinary browser client has no local host. Forge does not forward its Electron views, Chrome relay, extension connection, private target affinity, authority, recovery checkpoints, or IPC through active-origin routing.

A normal manager running on a remote backend may still have structurally planned browser tools. Without a Desktop host connected directly to that backend, calls return `unavailable-host`; the viewing machine's Desktop does not satisfy them. Collaboration channel sessions receive neither the host nor browser tools.

## `agent-browser` Skill

The `agent-browser` Skill invokes the separately installed Vercel Labs CLI and owns a separate browser/session lifecycle. It does not register the Automatic Browser Host, use `browser.json`, appear in the Browser workspace, or configure Chrome integration. Use the Skill when you specifically want its command-line browsing and extraction workflow.
