# Forge External Chrome extension — M1 spike

This workspace builds a deterministic, browser-only MV3 **test-side-load spike**. It pins Chrome extension ID `fcchfcnadajoejfbiclihglkmbcfhajd` from a committed public key, requires Chrome 125, and selects a versioned local payload through an immutable shell.

It is not connected to Forge Desktop and performs no Native Messaging registration. The native port implements bounded shared JSON-RPC hello/capability negotiation, heartbeat, and reconnect against `com.forge.external_chrome` when a separately managed test host exists. Resize, recording, download artifacts, and download-open remain explicitly unsupported regardless of declared permissions.

The side panel is a local candidate picker. A user must select tabs before the spike creates a one-session lease and attaches `chrome.debugger`. Restricted/internal pages are rejected; opening DevTools or another debugger loses the lease. The dynamically injected isolated-world content script provides a visible cursor/favicon state and trusted-human-input interruption signals. It does not read Chrome profile files, cookies, credentials, bookmarks, history, or top sites.

## Commands

```sh
pnpm --filter @forge/protocol build
pnpm --filter @forge/chrome-extension identity
pnpm --filter @forge/chrome-extension typecheck
pnpm --filter @forge/chrome-extension test
pnpm --filter @forge/chrome-extension build
```

Build output is `dist/extension` plus `dist/package-manifest.json`. Inputs and JSON keys are sorted; output has LF text, normalized modes, no timestamps, absolute paths, or source maps. The test suite independently builds twice and compares the full package hash.

An opt-in isolated fixture is available as `FORGE_RUN_ISOLATED_CHROME=1 pnpm fixture:chrome`. It launches only a new temporary headless profile with the built unpacked extension, never discovers or touches an existing profile/tab/process, terminates only the spawned process group, and deletes the temporary profile. It is intentionally not part of default tests because extension support in headless Chrome varies by installed channel/platform. No headed everyday-profile test or native-host/Desktop end-to-end qualification is claimed in M1.
