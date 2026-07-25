# Forge External Chrome extension

This workspace builds Forge's deterministic MV3 **External Chrome (Local Beta)** unpacked extension. The extension is loaded manually from the stable folder that Forge Desktop deploys for one Forge data directory. It is not distributed or updated through the Chrome Web Store.

Read the user-facing [Browser automation guide](../../docs/BROWSER_AUTOMATION.md#external-chrome-local-beta) before loading it into Chrome.

## Identity and package model

The committed public key pins extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`. Chrome 125 is the manifest minimum. A small immutable shell selects a versioned local payload from `current.json`:

- the classic service-worker bootstrap registers every top-level Chrome listener synchronously;
- the shell verifies the SHA-256 inventory for every selected payload file before execution;
- the service worker uses `importScripts` only after verification;
- the side panel performs the same full verification before importing its payload; and
- eval, blobs, remote executable code, source maps, and unverified hash-shaped fallback directories are excluded.

Build output is `dist/extension/` plus `dist/package-manifest.json`. Inputs and JSON keys are sorted; text output uses LF; file modes are normalized; and output contains no timestamps or absolute source paths. The reproducibility suite builds twice and compares the complete package hash.

## Permission and privacy boundary

The V1 manifest intentionally keeps a broad authority envelope: `<all_urls>` plus `alarms`, `bookmarks`, `debugger`, `downloads`, `favicon`, `history`, `nativeMessaging`, `notifications`, `scripting`, `sessions`, `sidePanel`, `storage`, `tabGroups`, `tabs`, `topSites`, and `webNavigation`, with optional `downloads.open`.

That ledger describes declared Chrome authority, not current API use. Current Local Beta code does not read bookmarks, history, or top sites and does not implement managed download events/artifacts or `downloads.open`. Do not narrow the manifest independently of the accepted compatibility-envelope decision, and do not describe dormant permissions as active behavior.

The extension creates a random local instance ID in extension storage. It does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. The optional Forge-local alias is extension/renderer display state, not a Chrome profile name.

A dedicated Chrome profile is strongly recommended because an attached page can expose visible content, accessibility data, bounded console/network/action diagnostics, a bounded PNG, and authenticated actions. Snapshot and interaction run through `chrome.debugger`, including arbitrary page JavaScript. Candidate pages stay local until the user confirms attachment, but attached-page data can reach the active Forge/model turn.

## Runtime and lease behavior

The native port connects through `com.forge.external_chrome` to Forge Desktop's authenticated current-user relay. The side panel and Desktop Browser workspace list bounded local candidates. Restricted/internal pages, tabs held by another debugger or DevTools, and tabs already leased elsewhere are rejected.

An extension instance owns at most one compare-and-set session lease. The lease covers only the confirmed roots plus qualifying grouped child tabs when the user explicitly enables that policy. Trusted human input interrupts agent control. A debugger detach, connection loss, bounded expiry, turn disposition, explicit detach, or session lifecycle release revokes or reconciles authority. Detach leaves user tabs open.

Supported operations are status, grouped create/open, navigation, snapshot, click, type, press, scroll, evaluate, and wait. External Chrome does not support physical resize, recording, managed download events/artifacts/open, standalone physical capture/export controls, or the Managed Browser dock/pop-out.

Compatible connected profiles can accept an authenticated local payload reload after Desktop update or rollback. Manual Chrome reload is fallback-only when Forge Settings reports **Manual extension reload required**.

## Commands

Run from the repository root:

```sh
pnpm --filter @forge/protocol build
pnpm --filter @forge/chrome-extension identity
pnpm --filter @forge/chrome-extension typecheck
pnpm --filter @forge/chrome-extension test
pnpm --filter @forge/chrome-extension build
```

The focused tests cover pinned identity, the exact manifest ledger, dormant-API assertions, deterministic packaging, selector verification, native RPC bounds, candidate/lease compare-and-set rules, debugger routing, human interruption, navigation, snapshots, and interactions.

An opt-in isolated fixture is available:

```sh
FORGE_RUN_ISOLATED_CHROME=1 pnpm --filter @forge/chrome-extension fixture:chrome
```

It creates a temporary profile, launches only the discovered Chrome/Chromium process with the built unpacked extension, terminates only that spawned process group, and deletes the temporary profile. It never discovers or touches an existing profile, tab, or process. The fixture is not part of default validation because headless extension behavior depends on the installed browser channel.

Do not use an everyday profile or live native registration for routine validation. Headed Chrome, native-host/Desktop end-to-end, target-platform, and distribution SEA/signing checks remain separate release gates; passing unit/build/isolated checks does not claim them.

## Staging and release boundary

The extension alone is not a releasable Desktop integration. Electron staging combines its deterministic shell/payload inventory with the required native-host package and creates `.stage/external-chrome/package-manifest.json`. Release staging must verify protocol compatibility, extension identity, every file hash, the required current target/architecture host, and release-signature metadata before installer packaging.

See [Forge Electron Desktop App](../electron/README.md#external-chrome-packaging-and-validation) and the [native host README](../native-messaging-host/README.md).
