# Browser automation

Forge Desktop exposes one protocol-v2 **Automatic Browser Host** to normal local Builder managers. The host privately runs each logical tab on either Forge's embedded Electron browser or the optional Chrome adapter. This is not a user- or caller-selected host preference, and neither target kind is a Skill.

The separate [`agent-browser` Skill](#agent-browser-skill) keeps its own CLI and browser lifecycle.

## Automatic target policy

Each logical browser tab has a sticky private target affinity:

- `managed-electron` — a main-process-owned Electron `WebContentsView` rendered inside Forge;
- `external-chrome` — one exact tab in a Chrome profile that loaded Forge's extension.

The affinity is assigned when the logical tab is created and is not a picker setting. An operation with an explicit logical `tabId` always returns to that target. Forge never silently moves an explicit Chrome tab into Electron, or an embedded tab into Chrome, to make an operation succeed.

For a tabless request, the Automatic Browser Host:

1. continues the session's selected or default logical tab when one exists;
2. routes physical resize and recording directly to an embedded tab;
3. otherwise tries an eligible Chrome target when the Chrome adapter is ready; and
4. uses the embedded browser when Chrome acquisition is unavailable and fallback is still safe.

### Open and Chrome reuse

The `reuseExistingTab` input controls whether a new tabless open may reuse Chrome's focused eligible tab. It does not select a host.

- Tabs created from the Browser workspace use `reuseExistingTab: false`, so Forge requests a dedicated, ungrouped Chrome tab when Chrome is selected automatically.
- The model-facing `browser_open` tool defaults `reuseExistingTab` to `true`. When there is no selected logical tab, that permits—but does not guarantee—reuse of a uniquely focused eligible Chrome tab.
- When reuse is false, focus is not unique and eligible, or a safe retry needs a fresh target, Forge creates a dedicated ungrouped tab. Child tabs are not automatically enrolled.

Chrome internal and extension pages, a tab already controlled by DevTools or another debugger, and other restricted targets are not eligible.

### Chrome profile ambiguity

Forge does not enumerate Chrome profiles or tabs in the renderer. Selection happens privately in the Desktop main process:

1. use the unique connected Chrome profile whose focused tab is eligible;
2. otherwise use the sole ready connected profile; or
3. if multiple ready profiles remain ambiguous, show one generic native confirmation for that Forge session.

The confirmation labels choices only as **Chrome profile 1**, **Chrome profile 2**, and so on, and includes **Use embedded browser**. Forge remembers a confirmed Chrome choice only in memory until Forge quits. It prompts a given session at most once during that run; choosing the embedded option or dismissing the prompt lets the safe automatic fallback use Electron.

## Operations and workspace

The common operation set is:

- status and open;
- navigate and snapshot;
- click, type, key press, and scroll;
- JavaScript evaluation; and
- bounded wait (`waitFor` in protocol v2).

Physical viewport resize and recording start/stop are embedded-only. Chrome also has no managed download workflow, saved download artifacts, opening of downloaded files, standalone screenshot export controls, or dock/pop-out view. A Chrome snapshot can still return bounded transient page and PNG data to the active operation.

The Desktop activity rail has one **Browser** workspace:

- an embedded tab renders in Forge with navigation, viewport, transient screenshot, recording, and dock/pop-out controls;
- a Chrome-backed tab stays in Chrome and appears as a compact card with **Show in Chrome**; and
- controls that the current target cannot support are hidden rather than presented as a second-host choice.

**Show in Chrome** does not depend on a long-lived attachment. Forge first settles any active operation burst, reacquires the exact sticky Chrome tab with transient authority, reveals it, and releases that exact authority again. If the exact target cannot be reacquired, reveal fails rather than opening or migrating another tab.

The workspace renderer registers one Desktop host with the local Builder backend and forwards bounded calls through trusted IPC. It receives no Chrome candidate inventory and exposes no tab-attachment, group, lease, or authority controls.

## Safety, retries, and authority

### Safe fallback and no replay

Automatic fallback is limited to requests whose failure metadata proves that mutation did not start. For a tabless Chrome attempt, Forge may:

1. retry once against a dedicated Chrome tab when focused reuse or the first acquisition lost a pre-mutation race; then
2. fall back to the embedded browser if the dedicated attempt also failed before mutation.

Forge does not replay an operation after it may have clicked, typed, navigated, evaluated code, or otherwise mutated the page. That failure returns typed `mutationState` and `noReplay` details to the caller. Explicit logical targets also never fall back to another affinity.

### Operation-scoped Chrome authority

Chrome control is private, per-tab, compare-and-set authority. Consecutive operations may share a short adaptive authority burst so Forge does not repeatedly attach and release the debugger between nearby actions. Operations remain serialized, and trusted human input interrupts agent control instead of racing it.

Every release is tied to the exact Chrome instance, logical session, tab, lease identity, and owner epoch. Forge checkpoints that identity before control and removes the checkpoint only after Chrome acknowledges the exact release. If a release acknowledgement is lost:

- the checkpoint remains durable;
- Forge retries that same release after reconnection; and
- later Chrome acquisition for that session is blocked until the exact release is acknowledged.

Turn end, stop, archive, delete, host replacement, Desktop update, and Desktop quit use the same lifecycle cleanup path. Chrome tabs remain open when authority is released. Opening DevTools, another debugger taking control, Chrome or extension disconnect, expiry, or human input can interrupt an operation; inspect or snapshot again before continuing.

## Privacy and persistence

Browser automation can inspect authenticated pages, capture visible content and accessibility data, type data, click controls, and execute arbitrary page JavaScript. Treat website instructions as untrusted and review consequential actions. A model provider may receive page data required for the active turn.

Forge's Chrome extension declares exactly:

- host permission `<all_urls>`; and
- permissions `alarms`, `debugger`, `nativeMessaging`, `scripting`, `storage`, and `webNavigation`.

It declares no action or side-panel surface, optional permissions, `tabGroups`, `bookmarks`, `history`, `downloads`, `sessions`, `notifications`, or `topSites`. Forge does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. A dedicated Chrome profile containing only the accounts needed for Forge work is strongly recommended.

Each session's `browser.json` uses protocol schema v2. It stores logical session identity, hosting state, tabs with private `targetAffinity`, active/default tab identity, panel and reveal state, bounded recent action summaries, lifecycle-cleanup acknowledgement, revision, and timestamps. It does **not** store a selected browser host.

Before writing schema-v2 state, Forge redacts Chrome-backed page URLs and titles, tab error detail, and page-identifying URL/title fields from action summaries. Runtime-only Chrome profile choice and exact authority stay in Desktop memory or the protected integration recovery state, not in renderer state. Redaction limits durable exposure; it cannot retract page data already used by a live operation or model turn.

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

Compatible connected extensions can reload an authenticated local payload after Desktop update or recovery. A manual reload in `chrome://extensions` is fallback-only when Settings explicitly reports **Manual extension reload required**. Development builds can also require one manual reload after Desktop replaces same-version development content while the old worker is broken or disconnected.

### Repair and troubleshooting

- **Chrome setup is unavailable:** use the main Forge Desktop window. Ordinary web clients cannot inspect local installation state or invoke Desktop browser IPC.
- **Chrome does not connect:** verify Chrome 125+, Developer mode, enterprise policy, the exact stable folder, and the pinned extension ID, then refresh Settings.
- **Native host missing or untrusted:** choose **Repair** only when Settings enables it. Do not substitute or hand-edit an executable, manifest, registry key, rendezvous, or authentication file.
- **Registration conflict:** Chrome has one current-user registration target for Forge's native host name. Stop the other Forge installation or data-directory owner before using qualified repair; do not overwrite the target manually.
- **Restricted target or debugger conflict:** close DevTools or the competing debugger and retry. Forge will not take over a restricted page.
- **Pending exact release:** keep Chrome and Forge open for authenticated reconciliation. Forge blocks new acquisition rather than abandoning the checkpoint or guessing another target.
- **Chrome tab no longer exists:** the logical target remains Chrome-affine and fails. Open a new logical browser tab instead of expecting silent migration.
- **Different data directory:** load that data directory's stable extension folder in the intended Chrome profile and complete setup there.

Canonical data paths and OS registration targets are in [Configuration](CONFIGURATION.md#chrome-adapter-local-integration). Maintainer staging, signing, package-content, and qualification gates are in the [Electron release guide](../apps/electron/README.md#optional-chrome-adapter-packaging-and-validation).

## Local-only boundary

The Automatic Browser Host is attached only to the normal local Builder backend reached by Forge Desktop. An ordinary browser client has no local host. Forge does not forward its Electron views, Chrome relay, extension connection, private target affinity, authority, recovery checkpoints, or IPC through active-origin routing.

A normal manager running on a remote backend may still have structurally planned browser tools. Without a Desktop host connected directly to that backend, calls return `unavailable-host`; the viewing machine's Desktop does not satisfy them. Collaboration channel sessions receive neither the host nor browser tools.

## `agent-browser` Skill

The legacy `agent-browser` Skill invokes the separately installed Vercel Labs CLI and owns a separate browser/session lifecycle. It does not register the Automatic Browser Host, use `browser.json`, appear in the Browser workspace, or configure Chrome integration. Use the Skill when you specifically want its command-line browsing and extraction workflow.
