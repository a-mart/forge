# Forge Automatic Browser Chrome adapter

This workspace builds the deterministic MV3 unpacked extension for Forge Desktop's optional Chrome target adapter. The extension is loaded manually from the stable folder that Forge Desktop deploys for one Forge data directory. It is not distributed or updated through the Chrome Web Store, and it does not create a second user-selectable browser host.

Read the user-facing [Browser automation guide](../../docs/BROWSER_AUTOMATION.md#optional-chrome-setup) before loading it into Chrome.

## Identity and package model

The committed public key pins extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`. Chrome 125 is the manifest minimum. A small deterministic shell selects a versioned local payload from `current.json`:

- the classic service-worker bootstrap registers every top-level Chrome listener synchronously;
- each built shell is bound to its exact payload directory and embeds the exact worker payload bytes in a deferred static factory, so worker payload changes always change the shell Chrome installs;
- the shell verifies the SHA-256 inventory for every selected payload file and matches the embedded worker hash before initializing that factory;
- the worker does not use delayed `importScripts`, dynamic import, eval, or a blob URL; and
- remote executable code, source maps, and unverified hash-shaped fallback directories are excluded.

Build output is `dist/extension/` plus `dist/package-manifest.json`. Inputs and JSON keys are sorted; text output uses LF; file modes are normalized; and output contains no timestamps or absolute source paths. The reproducibility suite builds twice and compares the complete package hash.

## Permission and privacy boundary

The extension declares `<all_urls>` plus `alarms`, `debugger`, `nativeMessaging`, `scripting`, `storage`, and `webNavigation`. It declares no action or side panel, optional permissions, `tabGroups`, `bookmarks`, `history`, `downloads`, `sessions`, `notifications`, or `topSites`. Every declared permission has a production caller. Keep this ledger aligned across the manifest, documentation, and identity tests.

The extension creates a random local instance ID in extension storage. It does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. Forge Desktop sees opaque extension-instance identity and bounded readiness/coordinator status; during `browser_status`, bounded URL/title/profile/window/activity/focus/last-access metadata may transiently reach the manager/model, but it is not projected into Browser workspace UI or canonical renderer state and is redacted from persistence.

A dedicated Chrome profile is strongly recommended because an authorized page can expose visible content, accessibility data, bounded console/network/action diagnostics, a bounded PNG, and authenticated actions. Snapshot and interaction run through `chrome.debugger`, including arbitrary page JavaScript.

## Automatic authority behavior

### Snapshot capture and transport bounds

Snapshot PNG capture adapts to the page's CSS viewport and device pixel ratio, trying smaller scales until the image fits qualified pixel/byte limits without upscaling small viewports. It will not claim success below the 320×180 useful minimum; an image that remains too large there returns the stable `minimum-qualified-screenshot-overflow` failure. The PNG is never dropped or replaced by compaction. Complete JSON-RPC responses are measured in UTF-8; optional diagnostics, accessibility nodes, visible text, and interactive elements are compacted deterministically with omission counts when needed. A screenshot-only envelope overflow is a typed non-retryable error.

Native request timeouts retain bounded response-ID tombstones for 30 seconds (at most 128), so a late response is validated and consumed without disconnecting the port. Unknown or malformed responses remain bounded protocol errors. Request-local transport failures do not discard a valid negotiated connection; disconnect/reconnect renegotiates protocol, payload identity, message bounds, heartbeat, and authority snapshots. Navigation's single deadline covers dispatch, commit/readiness, and cleanup: after expiry, no late callback may inject, complete, or replay the navigation.

The native port connects through `com.forge.external_chrome` to Forge Desktop's authenticated current-user relay. The renderer transiently relays complete `browser_status` inventory responses between the trusted bridge and backend, but does not project that inventory into Browser workspace UI or canonical renderer state; it receives no per-tab operation-authority state or controls. For a tabless `browser_open(reuseExistingTab: true)`, Desktop selects the active/most-recent eligible tab without OS focus; an inventory `tabId` explicitly selects one exact tab. Non-open operations remain sticky. `reuseExistingTab: false`, or no eligible tab, may create an inactive neutral `about:blank` tab for one authorized initial navigation. There is no profile confirmation prompt or picker, and Chrome-internal/restricted pages are excluded by platform capability. A normal web tab held by DevTools or another competing debugger may still appear in inventory but fails acquisition or execution while that debugger controls it.

Authority is bounded to exact tabs with compare-and-set epochs. Logical lease authority and physical debugger lifetime are separate: Desktop releases the logical authority burst after 30 seconds of inactivity; the physical debugger detaches after 35 seconds idle and never exceeds five minutes. One exact same-lease attachment may be reused across nearby operations, and `attached-idle` is reported only while the physical attachment and leased root identity are still proven.

Trusted clicks, key presses, wheel scrolls, and touch gestures are collaborative: they advance the control epoch, cancel agent work, and require a fresh snapshot before mutation. The runtime waits for already-dispatched CDP commands to settle and preserves the exact lease/attachment as `attached-idle` only when that proof completes by the deadline. Idle pointer movement is ignored, but a mismatched or interleaved trusted `pointermove` during an active exact synthetic sequence cancels the sequence. A trusted navigation or renderer swap keeps the exact tab lease, positively re-proves root identity/frame ancestry, reinjects the singleton bridge, and stays `attached-idle` only after revalidation; callers must snapshot again. Status reports no attached-idle while revalidation is pending.

**Take Control** is terminal human takeover: it releases the exact Chrome authority, including a recovered durable checkpoint, rather than leaving the tab available for agent reattachment. Debugger loss, DevTools preemption, transport uncertainty, identity or restricted-target loss, target closure, operation cancellation/timeout, lease expiry, update, shutdown, turn end, or session release detaches or terminally reconciles exact authority as appropriate. User tabs remain open when Forge releases authority.

Supported operations are status, open, navigation, snapshot, click, type, press, scroll, evaluate, and wait. Chrome-backed targets do not support physical resize, recordings, download handling or saved artifacts, opening downloaded files, standalone screenshot export controls, or the embedded Browser dock/pop-out. Snapshot can still return bounded transient screenshot data.

### Maintainer correctness boundaries

- Repeated content-script injection is a recovery probe. A live document owns exactly one singleton bridge keyed by tab, frame, and document identity; duplicate or stale bridges are rejected/replaced, and bridge counts are bounded. Navigation re-proves root identity and frame ancestry before reinjection.
- Synthetic trusted-input guarding consumes an exact expected event sequence. Idle pointer movement is ignored; while synthetic input is active, each trusted pointer, key, wheel, or touch event must match the next phase and all relevant fields. A mismatch or interleaving event immediately interrupts control. There is no time blanket, and untrusted events are ignored.
- `browser_evaluate` uses CDP `Runtime.evaluate` with `userGesture: false`; arbitrary evaluation never receives transient user activation.
- The MV3 service worker retains durable authority/release evidence across suspension and reconnect, settles in-flight commands before preserving collaborative `attached-idle`, and automatically renegotiates on restart. The unit/build and isolated-profile checks do not prove live worker suspension/restart, headed Chrome, native-host/Desktop end-to-end registration, or current-platform debugger behavior. Supported macOS and Windows packaging and release-SEA checks remain separate gates: macOS requires signing and notarization, while Windows packaging is credential-free and unsigned and trusts the deployed native host only while its release-manifest SHA-256 stays pinned. Linux `dir` packaging is experimental local smoke work only: it is non-publishable and is not Linux Desktop support coverage.

Compatible connected instances can accept an authenticated local payload reload after Desktop update or rollback. Manual Chrome reload is fallback-only when **Settings → Use Chrome with Forge → Advanced diagnostics → Recovery** reports `manual-extension-reload`.

## Commands

Run from the repository root:

```sh
pnpm --filter @forge/protocol build
pnpm --filter @forge/chrome-extension identity
pnpm --filter @forge/chrome-extension typecheck
pnpm --filter @forge/chrome-extension test
pnpm --filter @forge/chrome-extension build
```

The focused tests cover pinned identity, the exact manifest ledger, declared-API use assertions, deterministic packaging, selector verification, native RPC bounds, per-tab compare-and-set rules, debugger routing, human interruption, navigation, snapshots, and interactions.

An opt-in isolated fixture is available:

```sh
FORGE_RUN_ISOLATED_CHROME=1 pnpm --filter @forge/chrome-extension fixture:chrome
```

It creates a temporary profile, a temporary copy of the built extension, and a unique ephemeral DevTools endpoint. The copy blocks native messaging so the fixture cannot contact an installed Forge registration or live Desktop, then exposes only a fixture-local request hook after the normal verified payload has booted. Through that hook it exercises the real automatic authority/runtime path for profile-wide inventory selection, explicit tab targeting, inactive neutral allocation, snapshot, click, type, press, scroll, evaluate, wait, reveal, child-tab exclusion, release, and debugger detach. It then terminates only that spawned process group and deletes the temporary profile and extension copy. It never discovers or touches an existing profile, tab, native registration, Forge data directory, or process. The fixture is not part of default validation because headless extension behavior depends on the installed browser channel.

Do not use an everyday profile or live native registration for routine validation. Headed Chrome, native-host/Desktop end-to-end, target-platform, macOS signing/notarization, and Windows hash-pinned native-host checks remain separate release gates; passing unit/build/isolated checks does not claim them.

## Staging and release boundary

The extension alone is not a releasable Desktop integration. Electron staging combines its deterministic shell/payload inventory with the required native-host package and creates `.stage/external-chrome/package-manifest.json`. Release staging must verify protocol compatibility, extension identity, every file hash, the required current target/architecture host, and platform-specific release-integrity metadata before installer packaging: verified Developer ID identity/team on macOS or explicit unsigned Windows metadata plus the exact manifest SHA-256.

See [Forge Electron Desktop App](../electron/README.md#optional-chrome-adapter-packaging-and-validation) and the [native relay README](../native-messaging-host/README.md).
