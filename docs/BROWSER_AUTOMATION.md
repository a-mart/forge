# Browser automation

Forge has three separate browser automation paths. **Managed Browser** and **External Chrome (Local Beta)** are local Forge Desktop hosts for normal local Builder managers. Neither is a Skill, and neither host is forwarded to Remote Projects or Collaboration. The legacy **`agent-browser`** Skill keeps its separate CLI/browser lifecycle.

## Choose a browser path

| Path | What it controls | Identity and UI | Current limits | Use it when |
|---|---|---|---|---|
| **Managed Browser** | Forge-owned Electron `WebContentsView` tabs | Persistent profile-scoped Electron partition; tabs render in the Browser workspace and can dock or pop out | Requires Forge Desktop | You want a browser Forge owns, physical viewport controls, and session recordings. |
| **External Chrome (Local Beta)** | The session's bounded leased tab set in a Chrome profile that loaded Forge's unpacked extension | Tabs stay in Chrome; Forge Desktop shows profile aliases, candidates, attachment state, and agent operations | Chrome 125+; no physical resize, recordings, managed download workflow, standalone screenshot export controls, or dock/pop-out | You need Forge to work with an existing Chrome login or site state. |
| **`agent-browser` Skill** | The separately installed Vercel Labs `agent-browser` CLI and its browser sessions | External CLI lifecycle; no Forge Browser workspace or browser-state contract | Depends on the Skill and CLI prerequisites | You want the existing command-line browsing/extraction workflow. |

Selecting **Browser** in the Desktop activity rail opens the browser workspace for the selected local manager. Use **Browser host** to choose Managed Browser or a connected External Chrome host. Host selection is a per-session preference and changes which host subsequent browser operations target. **Switching the selected host does not detach External Chrome tabs.**

## Managed Browser

### Availability and workspace

Managed Browser requires Forge Desktop, a selected normal local Builder manager, and a live connection to that manager's local Builder backend. An ordinary web client shows **Browser host unavailable** and does not attempt local browser IPC.

The workspace provides:

- per-session tabs with open, activate, and close controls;
- back, forward, reload, hard reload, an address field, and zoom;
- fill, bounded freeform, and named device viewport sizes;
- transient screenshot preview and visible-tab recording; and
- loading, error, recording, and current-controller status.

**Open Managed Browser in a separate window** reparents the same native tab view rather than remounting it. Docking or closing the pop-out moves that view back while its page state, browser identity, automation queues, and active recording continue.

### Agent operations and control

Normal Builder managers can use typed operations for status, open, navigate, resize, snapshot, click, type, key presses, scroll, arbitrary JavaScript evaluation, waiting, and recording start/stop. Inputs, deadlines, viewport sizes, and results are bounded by the shared protocol.

You and the manager share the same tab. Agent operations serialize per tab and show **Agent controlling** while active. Real pointer or keyboard input transfers control to the human and interrupts the current action instead of racing it. Snapshot again after an interruption because the page may have changed.

### Security, persistence, and artifacts

Managed tabs use a persistent Electron partition derived from the Forge profile ID. The views are sandboxed with context isolation and web security enabled, Node integration and insecure content disabled, bounded permissions, and HTTP(S)-only top-level navigation after the initial blank page. Those controls do not make websites safe: a manager can inspect authenticated content, type data, capture screenshots, and execute arbitrary page JavaScript. Treat page instructions as untrusted and review consequential actions.

The session's shared `browser.json` stores browser host selection, tab metadata, reveal state, and bounded safe action summaries. Managed Browser cookies and site storage live in the profile-scoped Electron partition and may outlive a session. Forge does not currently provide a **Clear managed browser data** action.

Managed screenshots are transient. Successfully stopped recordings are Managed Browser-only session artifacts under `artifacts/browser/`. Only one Desktop browser recording can be active. Clearing a conversation does not clear browser state; a fork starts with independent browser state; archive/restore preserves metadata and completed recordings; deleting the session removes its browser metadata and recordings but not the profile's Electron partition.

## External Chrome (Local Beta)

External Chrome is an intentionally unpacked local integration. It is not distributed or updated through the Chrome Web Store. Forge Desktop deploys a pinned extension shell and payload plus an authenticated native-messaging host into the active Forge data directory. Chrome loads the stable extension folder from that data directory while compatible payload selectors can change underneath it.

### Requirements and warnings

- Use Chrome 125 or newer.
- Chrome must allow **Developer mode** and unpacked extensions. Chrome shows normal unpacked/developer warnings, and enterprise policy may block either capability.
- Use the main Forge Desktop window. The web app cannot inspect local Chrome profiles or tabs.
- A **dedicated Chrome profile is strongly recommended**. Put only the accounts needed for Forge work in that profile; do not start with an everyday profile.

### Set up each Chrome profile and Forge data directory

Set up External Chrome once for every Chrome profile and every Forge data directory you intend to pair. A Chrome profile that loaded the extension for one `FORGE_DATA_DIR` is not automatically configured for another.

1. Open the intended dedicated Chrome profile.
2. In Forge Desktop, open **Settings → External Chrome (Local Beta)**.
3. Confirm **Validated Load unpacked folder** is **ready**. Use the exact folder Forge shows; it is the stable Load unpacked path for this Forge data directory. Do not select its parent or a payload subfolder.
4. Manually enter `chrome://extensions` in Chrome and turn on **Developer mode**.
5. Click **Load unpacked** and select that exact folder.
6. Confirm Chrome reports extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`. If the ID differs, remove that extension and do not enable the integration.
7. Return to Settings, compare the packaged/deployed identity and native-host status, then confirm **Enable**.
8. Repeat the ceremony in each additional Chrome profile. Repeat it again when using a different Forge data directory.

Forge does not open Chrome settings pages, discover profiles, or install the extension for you.

### Permissions and privacy

The declared V1 permission set intentionally includes `<all_urls>` plus `alarms`, `bookmarks`, `debugger`, `downloads`, `favicon`, `history`, `nativeMessaging`, `notifications`, `scripting`, `sessions`, `sidePanel`, `storage`, `tabGroups`, `tabs`, `topSites`, and `webNavigation`, with optional `downloads.open`. This is declared Chrome authority, not a claim that every API is active. Current Local Beta code does not read bookmarks, history, or top sites and does not call `downloads.open`; those APIs remain dormant. The startup shell registers download-change notifications, but the payload currently ignores them: Forge provides no managed download workflow, artifact capture or persistence, or download-open behavior.

Forge does **not** copy Chrome credentials, Chrome profile databases, official Chrome profile names, bookmarks, history, or top sites. Loading the extension still grants the declared authority to that extension. Once you attach a page, browser snapshots can expose its visible content, accessibility data, bounded console/network/action diagnostics, URL/title, and a bounded PNG, and operations can click, type, navigate, wait, or execute arbitrary JavaScript. Authenticated page actions can therefore act with that Chrome profile's site identity. The model provider may receive attached-page data needed for the active turn.

Candidate tab titles and origins are listed locally before attachment. External Chrome URLs/titles are removed from persisted session browser state and bounded audit summaries, but that persistence minimization does not retract data already used in a live model turn. Protect the Forge data directory, Desktop account, Chrome profile, and any backups.

### Attach tabs

External Chrome operates only the session's bounded leased tab set: tabs you confirm, tabs Forge creates through `open` in the selected or sole connected profile, and qualifying grouped child tabs when you explicitly enable that policy.

1. Select the local manager and open **Browser**.
2. Choose **External Chrome** from **Browser host**. The option becomes available only after a compatible extension instance connects.
3. Choose a connected extension instance. The editable alias is Forge-local display state; it is not read from or written to Chrome's official profile name.
4. Select unrestricted candidate tabs. Chrome internal/extension pages, tabs owned by another debugger or DevTools, and tabs already leased elsewhere cannot be attached.
5. Optionally select a Chrome group. **Include child tabs opened by attached tabs** is off by default; when enabled, qualifying child tabs in the leased group join the lease.
6. Review the authority warning and confirm attachment.

The extension side panel can create a Forge-named grouped tab or a local pending lease. Its session label is only a local pending label; Forge Desktop maps the final attachment to the selected Builder session.

### Leases, human control, and detach

A Chrome extension instance grants one compare-and-set session lease over that bounded tab set. Another Forge attachment cannot silently reuse that instance or tab scope. Human input interrupts agent control, and opening DevTools or another debugger can make Forge lose debugger ownership.

External Chrome leases persist until the turn disposition, **Detach now**, a session lifecycle release, bounded expiry, or connection/debugger loss. A turn can retain a bounded handoff lease for a later follow-up; it is not indefinite. Stop, archive, delete, explicit detach, and host replacement run the guarded lifecycle release path. Forge keeps exact durable release authority so an interrupted release can be reconciled after restart.

Selecting Managed Browser in the host picker only changes the session preference. It does not release an External Chrome lease. Use **Detach now from Forge** in the Browser workspace (or **Detach now** in the extension side panel) when you want to release debugger authority immediately. **Detach leaves the Chrome tabs open.**

### Supported and unsupported operations

External Chrome supports status, grouped create/open, navigation, snapshot, click, type, press, scroll, evaluate, and wait operations on leased tabs. Snapshot includes bounded visible text, semantic elements, accessibility data, diagnostics, and a bounded PNG for the model turn.

External Chrome does not support:

- physical viewport resize or device presets;
- recordings;
- managed download handling, download artifact capture or persistence, or opening downloaded files;
- a standalone screenshot toolbar/export workflow (`snapshot` can still return bounded transient screenshot data); or
- the Managed Browser dock/pop-out workspace.

Recordings and completed browser recording artifacts are Managed Browser-only. External tabs remain rendered and controlled in Chrome, not in an Electron tab view.

### Updates and manual reload fallback

Forge Desktop stages and verifies compatible extension/native-host updates. Compatible connected Chrome profiles are asked to reload automatically after update or rollback. Do not make manual reload part of the normal update routine.

Only when Settings reports **Manual extension reload required** should you open `chrome://extensions`, compare the versions/hashes shown by Forge, and click **Reload** on Forge External Chrome in each affected profile. If Chrome was closed during an update, reopen it and check Settings before taking action.

### Repair, takeover, rollback, and removal

- **Repair native host** repairs Forge-owned native registration and may rotate local authentication. It does not inspect or modify Chrome profiles or tabs.
- **Roll back** selects the last verified compatible payload/native host when one exists. Compatible profiles use automatic reload; use manual reload only when Settings displays the fallback state.
- **Take over stale owner** transfers stale **Forge coordinator/native-host ownership**, not a Chrome profile, tab, or another live Desktop instance. Quiesce the old Forge instance first and use takeover only when Settings proves the prior Forge authority is stale and enables the action.
- **Remove integration** releases recoverable leases, disables the coordinator, unregisters the native host, and removes Forge's local authentication material. Remove the unpacked extension manually from every Chrome profile afterward. User tabs remain open.

All state-changing Settings actions require confirmation and stay disabled when local validation cannot prove them safe.

### Troubleshooting

- **External Chrome is unavailable in the host picker:** use the main Forge Desktop window; verify Settings is ready/online and at least one compatible Chrome profile is connected.
- **No extension connection:** confirm Chrome 125+, the exact Load unpacked folder, the pinned extension ID, Developer mode, and enterprise policy. Then refresh Settings.
- **Native host missing, untrusted, or needs repair:** use **Repair native host**. If Settings says reinstall is required, do not substitute another executable or manifest.
- **Foreign registration conflict:** another installation owns Chrome's single native-host registration target. Do not overwrite it manually. Quiesce the owning Forge instance and use the guarded takeover only when Forge enables it.
- **Debugger conflict / restricted tab:** close DevTools or the other debugger, or choose an ordinary HTTP(S) page. Chrome internal pages cannot be attached.
- **Recovering or lost lease:** keep Chrome and Forge Desktop open briefly for authenticated reconciliation. If recovery does not complete, detach and attach again. Tabs remain open.
- **Manual extension reload required:** this exact Settings status is the manual fallback trigger; reload each affected unpacked extension and refresh status.
- **Different Forge data directory:** load that data directory's exact extension folder in the intended Chrome profile and enable its coordinator separately.

Canonical integration files and OS registration targets are documented under [Configuration](CONFIGURATION.md#external-chrome-local-integration). Maintainer build, staging, signing, and package-content gates are documented in the [Electron release guide](../apps/electron/README.md#external-chrome-packaging-and-validation).

## Remote Projects and Collaboration

Both Desktop browser hosts remain on the viewing machine's local Builder connection. Forge never forwards the Managed Browser Electron host, External Chrome native relay, extension connections, candidate tabs, leases, or browser IPC to a Remote Project or Collaboration channel.

A normal manager on a remote backend can still have structurally planned browser tools. Without a Desktop host connected directly to that remote backend, calls return `unavailable-host`; the viewing machine does not satisfy them. Collaboration channel sessions receive neither Desktop browser host nor its tools. This local-only boundary is independent of collaboration sign-in cookies and remote Files, Source Control, terminal, or agent execution.
