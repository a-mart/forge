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

The extension creates a random local instance ID in extension storage. It does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. Forge Desktop sees only opaque extension-instance identity and bounded readiness/coordinator status until automatic operation-scoped authority is acquired.

A dedicated Chrome profile is strongly recommended because an authorized page can expose visible content, accessibility data, bounded console/network/action diagnostics, a bounded PNG, and authenticated actions. Snapshot and interaction run through `chrome.debugger`, including arbitrary page JavaScript.

## Automatic authority behavior

The native port connects through `com.forge.external_chrome` to Forge Desktop's authenticated current-user relay. The renderer receives no Chrome profile/tab inventory or per-tab operation-authority state or controls. It does receive bounded coordinator setup, build, readiness, and ownership status. For a tabless operation, Desktop privately selects an eligible connected instance, acquires authority for one tab, and can fall back to the embedded browser when acquisition cannot begin safely. An explicit Chrome-backed tab never migrates. If multiple instances remain ambiguous, the main process asks the user once for the current Forge session without exposing instance IDs to the renderer.

Authority is bounded to exact tabs with compare-and-set epochs. Trusted human input interrupts agent control. A debugger loss, connection loss, bounded expiry, turn disposition, or session lifecycle release revokes or reconciles authority. User tabs remain open when Forge releases authority.

Supported operations are status, open, navigation, snapshot, click, type, press, scroll, evaluate, and wait. Chrome-backed targets do not support physical resize, recordings, download handling or saved artifacts, opening downloaded files, standalone screenshot export controls, or the embedded Browser dock/pop-out. Snapshot can still return bounded transient screenshot data.

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

It creates a temporary profile, a temporary copy of the built extension, and a unique ephemeral DevTools endpoint. The copy blocks native messaging so the fixture cannot contact an installed Forge registration or live Desktop, then exposes only a fixture-local request hook after the normal verified payload has booted. Through that hook it exercises the real automatic authority/runtime path for focused reuse, dedicated ungrouped allocation, snapshot, click, type, press, scroll, evaluate, wait, reveal, child-tab exclusion, release, and debugger detach. It then terminates only that spawned process group and deletes the temporary profile and extension copy. It never discovers or touches an existing profile, tab, native registration, Forge data directory, or process. The fixture is not part of default validation because headless extension behavior depends on the installed browser channel.

Do not use an everyday profile or live native registration for routine validation. Headed Chrome, native-host/Desktop end-to-end, target-platform, and distribution SEA/signing checks remain separate release gates; passing unit/build/isolated checks does not claim them.

## Staging and release boundary

The extension alone is not a releasable Desktop integration. Electron staging combines its deterministic shell/payload inventory with the required native-host package and creates `.stage/external-chrome/package-manifest.json`. Release staging must verify protocol compatibility, extension identity, every file hash, the required current target/architecture host, and release-signature metadata before installer packaging.

See [Forge Electron Desktop App](../electron/README.md#optional-chrome-adapter-packaging-and-validation) and the [native relay README](../native-messaging-host/README.md).
