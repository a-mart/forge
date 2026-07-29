# Forge Electron Desktop App

This workspace packages Forge as a standalone desktop application for macOS, Windows, and Linux. The desktop app bundles the backend, UI, and all dependencies so end users do not need Node.js or pnpm installed.

## Architecture

The Electron app is a thin wrapper around Forge's existing backend and UI:

- **Main process** (`src/main.ts`) — launches the packaged backend, owns the application window and updates, and composes one protocol-v2 `AutomaticBrowserHost` from embedded-Electron and optional Chrome target adapters
- **Trusted preload** (`src/preload.ts`) — gives the Forge renderer narrow browser invocation, lifecycle, reveal, workspace-presentation, and Chrome setup/repair IPC; handlers reject callers other than the trusted renderer
- **Renderer process** — loads the staged UI bundle from `ui/index.html`, registers one Desktop browser host with the local Builder backend, projects canonical embedded-tab state, and renders either the embedded workspace or a Chrome-backed tab card. The renderer transiently relays complete `browser_status` inventory responses between the trusted bridge and backend, but does not project that inventory into Browser workspace UI or canonical renderer state; it also receives no per-tab operation-authority state or controls. It does receive bounded coordinator setup, build, readiness, and ownership status
- **Guest preload** (`src/browser/guest-preload.ts`) — runs inside sandboxed embedded tab views, reports only real pointer/key input so human control can interrupt an agent action, and renders the non-interactive agent cursor inside the native guest

`BrowserAutomationManager` owns the `AutomaticBrowserHost` policy seam in the main process. Logical tabs carry sticky `managed-electron` or `external-chrome` affinity. Explicit targets never migrate. Tabless common operations may acquire Chrome automatically and fall back directly to Electron when one acquisition/execution attempt proves mutation did not start; a possible mutation returns no-replay failure metadata. Resize and recording route directly to Electron. Chrome authority is exact per tab and retained only for short adaptive operation bursts. Failed release acknowledgement keeps the exact checkpoint and blocks later acquisition until reconciliation. **Show in Chrome** settles an active burst, reacquires the exact target transiently, reveals it, and releases it again. Turn end and session lifecycle cleanup use correlated generic host requests.

The embedded adapter uses main-owned `WebContentsView` instances with persistent profile-scoped partitions. Views enforce sandboxing, context isolation, no Node integration, HTTP(S)-only navigation, restricted permissions, and expected partitions. The same view can move into the single native pop-out and back without remounting, changing host generation, or interrupting CDP/recording. Cmd+W docks it on macOS and Ctrl+W docks it on Windows/Linux. The adapter uses pinned `playwright-core` 1.60.0 extracted from `lib/coreBundle.js`; marker, version, fixture, packaging, and notice tests fail closed when that private integration changes.

The optional Chrome adapter has no Electron view or recording authority. Its coordinator deploys the deterministic unpacked extension and required native host into the active Forge data directory, owns current-user authentication/rendezvous and Chrome registration, and connects the main-process relay to profile-wide eligible-tab inventory plus exact operation-scoped tab authority. Once enabled and authenticated, the extension covers eligible ordinary web tabs across its profile; `browser_status` returns a bounded inventory across ready authenticated profiles, and `browser_open` selects the active/most-recent eligible tab or an inventory `tabId` without OS focus. There is no profile confirmation prompt or picker. The [Browser automation guide](../../docs/BROWSER_AUTOMATION.md) is the user-facing source of truth.

### Packaged layout

`electron-builder` packages the staged contents of `apps/electron/.stage/`:

- **Backend runtime** — `.stage/backend/dist/index.mjs` bundled from `apps/backend/dist/index.js`, plus staged runtime dependencies under `.stage/backend/node_modules/`
- **Renderer** — `.stage/ui/`, copied from `apps/ui/.output/public/`; `_shell.html` is promoted to `index.html` for packaged startup
- **Forge resources** — `.stage/forge-resources/`, containing built-in skills, archetypes, operational prompts, specialists, static assets, and related runtime resources
- **CLI runtime** — `.stage/cli/cli.js`, copied from `packages/cli/dist/cli.js` and packaged as `resources/cli/cli.js` for the desktop CLI shim
- **Cursor SDK runtime assets** — required and staged for native manager and specialist support via `@cursor/sdk`, together with `sqlite3` and the required platform-native SDK assets; packaging and its packaged-runtime preflight fail if any of these assets are missing
- **SQLite runtime** — `better-sqlite3` remains external to the backend bundle so its Electron-specific native binding can be staged and exercised with Electron-as-Node before packaging
- **Embedded browser runtime** — main/trusted-preload/guest-preload bundles in `app.asar`, plus `.stage/browser-runtime/playwright-core/` and an exact staged copy of root `THIRD_PARTY_NOTICES.md` under packaged `resources/browser-runtime/`
- **Optional Chrome adapter resources** — deterministic extension shell/payload and a platform/architecture SEA native relay under `.stage/external-chrome/`, packaged as `resources/external-chrome/`; release builds require the official pinned SEA Node plus platform signing before the native-host hash/manifest is created

At runtime the packaged app spawns the staged backend bundle from `backend/dist/index.mjs`, waits for backend readiness, then opens the renderer from the staged `ui/` directory.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Main process entry point. Window management, backend lifecycle, IPC handlers |
| `src/preload.ts` | Trusted renderer bridge for one browser host plus bounded Chrome setup/repair |
| `src/browser/browser-automation-manager.ts` | Main-process composition of the automatic host and target adapters |
| `src/browser/automatic-browser-host.ts` | Sticky affinity, acquisition, safe fallback, no replay, authority bursts, reveal, and lifecycle policy |
| `src/browser/browser-target-adapter.ts` | Private embedded/Chrome adapter and authority contracts |
| `src/browser/managed-electron-target-adapter.ts` | Electron-hosted tab runtime, typed operation execution, interruption, diagnostics, and recording capture |
| `src/browser/external-chrome-target-adapter.ts` | Chrome common-operation, acquisition, exact release, and reveal adapter |
| `src/browser/browser-ipc.ts` | Main-authority-only automatic-host IPC handlers |
| `src/browser/managed-browser-view-host.ts` | Epoch/sequence-guarded main-process view ownership, bounds, and same-view reparenting |
| `src/browser/browser-workspace-ipc.ts` | Narrow role-scoped pop-out projection and correlated command relay |
| `src/browser/guest-preload.ts` | Sandboxed guest input-only preload |
| `src/browser/playwright-injected-runtime.ts` | Pinned, fail-closed Playwright semantic-locator runtime extraction |
| `src/external-chrome/coordinator.ts` | Optional adapter deployment, current-user authentication, registration, update, recovery, and repair coordinator |
| `src/external-chrome/relay-runtime.ts` | Authenticated profile-wide inventory, exact per-tab checkpoints, operation transport, release, reveal, and recovery |
| `src/external-chrome/registration.ts` | Forge-owned native-host manifest/registry inspection, repair, transfer, and removal |
| `src/external-chrome/data-paths.ts` | Canonical optional Chrome adapter integration paths under the active Forge data directory |
| `scripts/stage-external-chrome.mjs` | Combines verified extension and native-host inventories into the Electron stage |
| `scripts/external-chrome-package-content-smoke.mjs` | Verifies staged/packaged inventory, target metadata, hashes, and signature policy |
| `src/auto-updater.ts` | Auto-update logic using `electron-updater` and GitHub Releases |
| `src/window-state.ts` | Persists window position, size, maximized state, and fullscreen state across restarts |
| `src/fix-path.ts` | Ensures PATH is set correctly on macOS when launched from GUI (not terminal) |
| `src/whats-new.ts` | Displays release notes after successful update |
| `electron-builder.yml` | Build configuration for packaging and updater publishing |
| `scripts/build-all.mjs` | Builds protocol/backend/ui/electron code, stages resources into `.stage/`, then hands off to `electron-builder` |
| `scripts/release.mjs` | Deprecated fail-fast wrapper kept only to block the old unsafe release shortcut |

## Development

To run the Electron app in dev mode from the repository root:

```bash
pnpm dev:electron
```

This command starts the UI dev server (`pnpm dev:ui`) and waits for it to be ready, then launches Electron. The Electron window loads from `http://127.0.0.1:47188` (the dev server). Electron forks its backend child on `47287`, and the root script sets `VITE_FORGE_WS_URL=ws://127.0.0.1:47287` so the renderer targets that child.

Before Electron launches, the desktop workspace prepares a cached `better-sqlite3` binary for Electron's embedded Node runtime. The cache lives under `apps/electron/.dev-native/` and is separate from the Host-Node binary installed by pnpm, so switching between `pnpm dev` and `pnpm dev:electron` does not rebuild or overwrite shared dependencies. The cache is versioned by the Electron version, platform, architecture, and `better-sqlite3` source fingerprint, and is verified with an Electron-as-Node in-memory database smoke test before use.

The dev command also builds the optional Chrome extension and native-relay bundle, wraps the bundle in an explicit current-Node shebang host, smokes it without registration, and stages the result under `apps/electron/.dev-external-chrome/`. Dev Electron validates and deploys that inventory through the same stable data-directory layout used by packaged releases, so Settings can reveal the unpacked `extension/` folder. This development manifest is opt-in and cannot pass the default release-manifest policy; packaged builds still require the SEA and platform signature. The shebang host supports macOS and Linux development. On Windows, development startup explicitly skips this optional External Chrome staging because it requires a native executable launcher; Forge Desktop, Secure Sessions, and the embedded browser continue to start normally. To build and smoke only these worktree-local resources without launching Electron or changing native registration, run `pnpm --dir apps/electron prepare:dev-external-chrome`.

Electron 42+ downloads its platform binary on first execution rather than during package postinstall. Materialize it early and assert the exact embedded runtime before native preparation or packaging:

```bash
pnpm --dir apps/electron verify:runtime
```

To prepare or revalidate the Electron development binary without launching the app:

```bash
pnpm --dir apps/electron prepare:dev-native
```

If no matching prebuilt binary is available, preparation falls back to a local source build and therefore requires the platform's normal native compiler toolchain. Electron 43's V8 external-pointer API requires `better-sqlite3` 12.11.1 or newer; 12.9.0 fails its ABI 148 source build.

Changes to UI code hot-reload. Changes to Electron main process code (`src/main.ts`, etc.) require restarting the app.

To launch the same Electron-owned backend while also exposing the development
UI to another device on a trusted network:

```bash
pnpm dev:electron:remote
```

On Windows PowerShell or Command Prompt, use
`pnpm.cmd dev:electron:remote`. The remote browser opens
`http://<station-address>:47188`; its WebSocket connection uses the same
hostname on backend port `47287`. The Electron renderer continues to receive
the loopback backend URL from preload. Do not run `pnpm dev:remote` beside this
command: that would start a second standalone backend instead of sharing the
Electron-owned backend. Remote private secret entry requires HTTPS even though
the general development UI can be reached over HTTP on a trusted network.

Focused Automatic Browser Host validation commands:

```bash
# A fresh worktree needs the shared protocol output used by the Electron bundle
pnpm --filter @forge/protocol build

# Main-process automatic policy, adapters, and relay lifecycle
pnpm --dir apps/electron exec vitest run \
  src/browser/__tests__/automatic-browser-host.test.ts \
  src/browser/__tests__/browser-target-adapters.test.ts \
  src/external-chrome/__tests__/relay-runtime.test.ts

# Electron host fixture: launches real main-owned embedded views against a local HTTP fixture
pnpm --dir apps/electron test:browser-fixture

# Native WebContentsView spike: repeatedly reparents one main-owned guest between windows
pnpm --dir apps/electron test:browser-popout-reparent

# Builds a minimal unpacked app and verifies app.asar, Playwright runtime, and notices
pnpm --dir apps/electron test:browser-package

# Verifies maintained third-party attribution and adapted-file mappings
pnpm exec vitest run scripts/__tests__/browser-third-party-notices.test.mjs
```

The real embedded-view fixtures require a graphical Electron environment. Passing on one operating system does not qualify another. Native Windows and Linux reparenting, recording/media, close-race, and packaged-layout qualification remain separate platform gates; do not infer headed or platform qualification from unit tests or one-machine smoke runs.

### Optional Chrome adapter packaging and validation

The optional Chrome path has separate extension, native-relay, Electron coordinator, staging, and package-content gates. The non-live validation path is:

```bash
# Shared contracts and package workspaces
pnpm --filter @forge/protocol build
pnpm --filter @forge/chrome-extension identity
pnpm --filter @forge/chrome-extension typecheck
pnpm --filter @forge/chrome-extension test
pnpm --filter @forge/chrome-extension build
pnpm --filter @forge/external-chrome-native-host typecheck
pnpm --filter @forge/external-chrome-native-host test

# Credential-free, explicitly non-publishable current-target SEA
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm --filter @forge/external-chrome-native-host package:current

# Electron automatic policy, coordinator/adapter, relay, and packaging policy
pnpm --dir apps/electron exec vitest run \
  src/browser/__tests__/automatic-browser-host.test.ts \
  src/browser/__tests__/browser-target-adapters.test.ts \
  src/external-chrome/__tests__
pnpm --dir apps/electron exec vitest run scripts/__tests__/external-chrome-staging.test.mjs scripts/__tests__/external-chrome-release-signing.test.mjs scripts/__tests__/windows-ci-signing-env.test.mjs
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm --dir apps/electron stage:external-chrome
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm --dir apps/electron test:external-chrome-package
```

`stage:external-chrome` expects the built extension and native-host package manifests. It fails on a missing required executable, target/architecture mismatch, protocol mismatch, incomplete inventory, hash drift, or signature-policy failure. The package-content smoke walks the complete stage, rejects symlinks/extra files/hash changes, and verifies the native-host signature metadata. Validation mode explicitly allows an unverified validation signature only for non-publishable staging, package-content, and installer validation; runtime deployment and the release path reject it.

The opt-in extension fixture can exercise a temporary isolated Chrome profile, but it is not a replacement for a headed Chrome/Desktop/native-registration run. Do not run live registration or load an everyday Chrome profile during routine CI/docs validation. Unit tests, builds, staging, and package-content smoke do not by themselves qualify headed Chrome, native registration, the current platform, installer contents, or the release SEA/signing path.

If you only want to run the Electron app without starting the UI dev server separately:

```bash
cd apps/electron
pnpm dev
```

This builds the main process and launches Electron, but you still need the UI dev server running in another terminal.

## Building

To package the desktop app for distribution:

```bash
pnpm package:electron
```

This is a build step only. It does **not** publish a GitHub Release.

The packaging pipeline:

1. Clears `apps/electron/release/` so stale installers, blockmaps, and unpacked directories do not leak into the next validation/upload pass
2. Clears `apps/ui/.output/` so the packaged renderer always starts from a fresh UI build output
3. Builds `@forge/protocol`, `@forge/backend`, `@forge/ui`, and the Electron main process
4. Stages backend runtime assets into `apps/electron/.stage/backend/`
5. Stages renderer assets into `apps/electron/.stage/ui/`, then validates that every asset referenced by the staged `index.html` actually exists in the staged `assets/` directory before packaging continues
6. Builds `@forge/cli` and stages the bundled CLI entrypoint into `apps/electron/.stage/cli/cli.js`
7. Stages Forge runtime resources into `apps/electron/.stage/forge-resources/`
8. Stages pinned `playwright-core` and the byte-identical root `THIRD_PARTY_NOTICES.md` into `.stage/browser-runtime/`, validating the injected-runtime markers before packaging
9. Builds the optional Chrome adapter shell/payload and current platform/architecture native relay with official Node 25.6.1; release mode signs and signer-verifies the relay before calculating its hash, while explicit validation mode produces a non-publishable unverified manifest
10. Runs a packaged-runtime preflight that resolves and loads the staged native/runtime externals from `.stage/backend/node_modules/`, exercising `better-sqlite3`, `sqlite3`, `node-pty`, `sharp`, and `koffi` with Electron-as-Node and ensuring they do not silently fall back to repo-level `node_modules`
11. Runs a staged CLI preflight with Electron-as-Node against `.stage/cli/cli.js --version`
12. Runs `electron-builder --publish never`; the Windows `afterPack` hook restores the pre-signed host after electron-builder's recursive extra-resource signer, macOS excludes that nested host with `mac.signIgnore`, and `afterSign` rechecks the packaged host hash plus platform signature before installers are produced

Packaged outputs are written to `apps/electron/release/`, which is treated as ephemeral build output for the current run.

The optional Chrome adapter adds fail-closed release gates to that pipeline. A publishable installer requires the pinned extension ID and deterministic shell/payload inventory, a required SEA for the package target/architecture, matching native protocol metadata, release-mode signature verification against the configured signer, byte-identical preservation through electron-builder, and post-package hash/signature verification. A validation-mode relay or manifest is deliberately non-deployable and must never be promoted by relabeling it as a release artifact. Complete headed Chrome, live native registration, target-platform, installer, and updater checks remain operator gates before any draft is published.

## Desktop CLI

The desktop app can install a user-local `forge` shim from **Settings → CLI Access** after the user generates a CLI access key. The shim launches the current Forge app with `ELECTRON_RUN_AS_NODE=1` and the packaged `resources/cli/cli.js` entrypoint, so end users do not need a system Node.js install.

Install locations:

- macOS/Linux: `~/.forge/bin/forge`
- Windows: `%LOCALAPPDATA%\forge\bin\forge.cmd` plus an optional PowerShell helper

The shim does not contain API keys. It reads a Forge-managed install hint to find the current app bundle/executable, then falls back to platform lookup. Re-running **Install CLI** is idempotent and overwrites only Forge-managed shim files. If the install directory is not on `PATH`, the renderer returns shell-specific instructions for the user to add it manually.

Packaged smoke for release validation:

```bash
ELECTRON_RUN_AS_NODE=1 /path/to/Forge.app/Contents/MacOS/Forge /path/to/Forge.app/Contents/Resources/cli/cli.js --version
~/.forge/bin/forge --version
forge doctor
```

On Windows, run `%LOCALAPPDATA%\forge\bin\forge.cmd --version` and `forge doctor` from a normal terminal after installing from Settings.

## Code Signing

Add signing variables to `.env` before packaging signed builds.

### macOS signing and notarization

| Variable | Description |
|----------|-------------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |
| `FORGE_MACOS_SIGNING_IDENTITY` | Exact `Developer ID Application: … (TEAMID)` common name expected on the native host |
| `FORGE_SEA_NODE` | Absolute path to the official Node 25.6.1 executable (not a vendor build missing `NODE_SEA_FUSE`) |

Release packaging also requires `FORGE_EXTERNAL_CHROME_BUILD_MODE=release`. The native host is signed first and its observed identity/team must match the two expected values; electron-builder then signs/notarizes the outer app.

### Windows signing

| Variable | Description |
|----------|-------------|
| `CSC_LINK` or `WIN_CSC_LINK` | Base64 or file path for the Windows code-signing certificate |
| `CSC_KEY_PASSWORD` or `WIN_CSC_KEY_PASSWORD` | Password for that certificate |
| `FORGE_WINDOWS_SIGNER_SUBJECT` | Exact Authenticode signer certificate subject expected on the native host |
| `FORGE_SEA_NODE` | Official Node 25.6.1 executable installed by `actions/setup-node` |

`workflow_dispatch` is release mode and fails before packaging when credentials or the expected signer are absent. `electron/*` pushes set `FORGE_EXTERNAL_CHROME_BUILD_MODE=validation`; Actions does not expose `WIN_CSC_*` / signer secrets on those pushes, packaging blanks `WIN_CSC_*` plus `CSC_*` aliases, and `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder cannot auto-discover a signing identity. Validation native-host manifests stay explicitly unverified and cannot be deployed or published as a release. For a local non-publishable package smoke, set validation mode explicitly.

```bash
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm package:electron
```

## Releasing

### Status of `pnpm release:electron`

`pnpm release:electron` and `apps/electron/scripts/release.mjs` are intentionally disabled. They are kept only as guardrails so operators do not accidentally use the old unsafe path.

### Official release flow: build first, publish last

#### Release channel policy

- **Desktop rollouts are beta-first.** New desktop builds ship to the beta channel before any stable rollout.
- **Beta GitHub Releases must be published as prereleases.** If the version includes a beta suffix (for example `1.2.3-beta.1`), keep the GitHub Release marked **This is a pre-release** when you publish it.
- **Never publish beta assets to the stable channel.** A beta-tagged build must not be published as a normal GitHub Release.
- **Stable promotion happens later.** After beta validation, publish a separate stable release flow using a stable version, not by treating the beta release as stable on day one.

1. **Bump version first**
   - Update `apps/electron/package.json`
   - Commit and push the version bump before triggering any release build
   - Do not rely on a tag-first flow

2. **Build and validate macOS locally**
   - Install the official Node 25.6.1 distribution, then run `FORGE_EXTERNAL_CHROME_BUILD_MODE=release FORGE_SEA_NODE=/absolute/path/to/official/node pnpm package:electron` on a macOS machine with the signing, expected-identity, and notarization credentials in `.env`
   - This build clears `apps/electron/release/` first; copy/archive older artifacts elsewhere if you need to keep them
   - Confirm the expected macOS assets exist in `apps/electron/release/`

3. **Build Windows through GitHub Actions**
   - Use `.github/workflows/electron-build.yml` via `workflow_dispatch` for release Windows artifacts
   - Pushes to `electron/*` branches are for validation only
   - Do not use tag pushes as the release trigger

4. **Create the GitHub Release as a draft**
   - Keep the release unpublished until every required asset is attached and validated
   - If this is a beta build, the draft must also remain marked as a GitHub **prerelease** before and after publishing

5. **Upload the full updater asset set**
   - Upload everything required by the auto-updater, not just installers
   - Typical assets include the platform installers/archives plus generated updater metadata such as `latest*.yml` and any `*.blockmap` files
   - In practice, upload the full current-run contents of `apps/electron/release/` for each platform. The package step now clears stale output first, so that directory should reflect only the current build plus transient builder metadata.

6. **Publish last**
   - Publish the draft only after both platforms are validated and the full asset set is attached
   - For beta builds, publish it as a **GitHub prerelease**
   - For stable builds, publish only after the beta rollout has been validated and you are intentionally cutting a stable version

### Why the full asset set matters

Forge uses `electron-updater` against GitHub Releases. Auto-update clients need the metadata files and blockmaps in addition to the installer artifacts. Uploading only `.dmg` or `.exe` files can leave update checks or delta downloads broken.

### Windows CI notes

- `workflow_dispatch` is the fail-closed signed release build path and requires the Windows certificate/password plus `FORGE_WINDOWS_SIGNER_SUBJECT`
- `electron/*` branch pushes are unsigned validation-only builds: no signing secrets are injected, `CSC_*` aliases are blanked, identity auto-discovery is disabled, and the optional Chrome adapter package is deliberately non-deployable
- The workflow does not publish a GitHub Release on its own
- Download the Windows artifact from the workflow run, then upload those files into the draft release alongside the locally built macOS assets
- The release operator is still responsible for choosing the correct GitHub release channel: beta builds stay prerelease, stable builds are published later as stable

## Port Configuration

The Electron app uses port `47287` for the backend by default in packaged mode. You can override this by setting `FORGE_PORT` before launching the app.

The root `pnpm dev:electron` workflow also uses backend port `47287`; only its UI remains on the Vite dev port `47188`.

## Platform Notes

Current package targets and qualification boundaries are:

- **macOS** 12+ (Apple Silicon is exercised locally; Intel requires separate native qualification before claiming support evidence)
- **Windows** 10+ (x64)
- **Linux** (x64, AppImage format)

Forge accepts Electron 43's platform dialog default when a directory picker has no `defaultPath`: Downloads when available, otherwise the user's home directory. Pickers with a repository or working-directory path keep using that explicit location; Forge does not maintain a second app-owned recent-directory store.

Windows builds use an NSIS installer with per-user installation by default. Linux builds use AppImage for maximum compatibility.
