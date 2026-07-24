# Forge Electron Desktop App

This workspace packages Forge as a standalone desktop application for macOS, Windows, and Linux. The desktop app bundles the backend, UI, and all dependencies so end users do not need Node.js or pnpm installed.

## Architecture

The Electron app is a thin wrapper around Forge's existing backend and UI:

- **Main process** (`src/main.ts`) — launches the packaged backend, manages the application window and auto-updates, owns Managed Browser sessions, and installs the trusted browser IPC handlers
- **Trusted preload** (`src/preload.ts`) — bridges the Forge renderer to a narrow IPC API, including the Managed Browser host bridge; browser IPC rejects callers other than the trusted Forge renderer
- **Renderer process** — loads the staged UI bundle from `ui/index.html` and keeps the single connected Desktop browser host/recording authority registered with the local Builder backend
- **Guest preload** (`src/browser/guest-preload.ts`) — runs inside sandboxed managed tab views, reports only real pointer/key input so human control can interrupt an agent action, and renders the non-interactive agent cursor inside the native guest

Managed Browser partitions are persistent and profile-scoped. The main process owns exactly one `WebContentsView` and automation runtime per live tab; views enforce sandboxing, context isolation, no Node integration, HTTP(S)-only navigation, restricted permissions, and expected partitions. On macOS, Windows, and Linux, the same view can move into the single native Managed Browser pop-out and back without remounting, changing host generation, or interrupting CDP/recording. Cmd+W docks it on macOS and Ctrl+W docks it on Windows/Linux. The main-process `BrowserAutomationManager` serializes typed operations and uses Chromium's debugger protocol. Semantic locator work uses the pinned `playwright-core` 1.60.0 injected runtime extracted from `lib/coreBundle.js`; marker, version, fixture, packaging, and notice tests fail closed when that private integration changes.

### Packaged layout

`electron-builder` packages the staged contents of `apps/electron/.stage/`:

- **Backend runtime** — `.stage/backend/dist/index.mjs` bundled from `apps/backend/dist/index.js`, plus staged runtime dependencies under `.stage/backend/node_modules/`
- **Renderer** — `.stage/ui/`, copied from `apps/ui/.output/public/`; `_shell.html` is promoted to `index.html` for packaged startup
- **Forge resources** — `.stage/forge-resources/`, containing built-in skills, archetypes, operational prompts, specialists, static assets, and related runtime resources
- **CLI runtime** — `.stage/cli/cli.js`, copied from `packages/cli/dist/cli.js` and packaged as `resources/cli/cli.js` for the desktop CLI shim
- **Claude SDK runtime assets** — staged when available for native Claude Agent SDK support; if they are not present in the packaged build, the desktop app falls back to the Pi-proxied Anthropic path
- **Cursor SDK runtime assets** — required and staged for native manager and specialist support via `@cursor/sdk`, together with `sqlite3` and the required platform-native SDK assets; packaging and its packaged-runtime preflight fail if any of these assets are missing
- **SQLite runtime** — `better-sqlite3` remains external to the backend bundle so its Electron-specific native binding can be staged and exercised with Electron-as-Node before packaging
- **Managed Browser runtime** — main/trusted-preload/guest-preload bundles in `app.asar`, plus `.stage/browser-runtime/playwright-core/` and an exact staged copy of root `THIRD_PARTY_NOTICES.md` under packaged `resources/browser-runtime/`
- **External Chrome deployment resources** — deterministic extension shell/payload, platform/architecture SEA native host, and their strict combined manifest under `.stage/external-chrome/`, packaged as `resources/external-chrome/`; release staging fails if the required SEA executable is absent

At runtime the packaged app spawns the staged backend bundle from `backend/dist/index.mjs`, waits for backend readiness, then opens the renderer from the staged `ui/` directory.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Main process entry point. Window management, backend lifecycle, IPC handlers |
| `src/preload.ts` | Trusted renderer bridge, including the narrow Managed Browser IPC facade |
| `src/browser/browser-automation-manager.ts` | Host-kind routing across browser target adapters |
| `src/browser/managed-electron-target-adapter.ts` | Electron-hosted tab runtime, typed operation execution, interruption, diagnostics, and recording capture |
| `src/browser/browser-ipc.ts` | Main-authority-only automation IPC handlers |
| `src/browser/managed-browser-view-host.ts` | Epoch/sequence-guarded main-process ownership, bounds, and same-view reparenting |
| `src/browser/browser-workspace-ipc.ts` | Narrow role-scoped pop-out projection and correlated command relay |
| `src/browser/guest-preload.ts` | Sandboxed guest input-only preload |
| `src/browser/playwright-injected-runtime.ts` | Pinned, fail-closed Playwright semantic-locator runtime extraction |
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

To prepare or revalidate the Electron development binary without launching the app:

```bash
pnpm --dir apps/electron prepare:dev-native
```

If no matching prebuilt binary is available, preparation falls back to a local source build and therefore requires the platform's normal native compiler toolchain.

Changes to UI code hot-reload. Changes to Electron main process code (`src/main.ts`, etc.) require restarting the app.

Focused Managed Browser validation commands:

```bash
# A fresh worktree needs the shared protocol output used by the Electron bundle
pnpm --filter @forge/protocol build

# Electron host fixture: launches real Electron/main-owned tab views against a local HTTP fixture
pnpm --dir apps/electron test:browser-fixture

# Native WebContentsView spike: repeatedly reparents one main-owned guest between windows
pnpm --dir apps/electron test:browser-popout-reparent

# Builds a minimal unpacked app and verifies app.asar, Playwright runtime, and notices
pnpm --dir apps/electron test:browser-package

# Verifies maintained third-party attribution and adapted-file mappings
pnpm exec vitest run scripts/__tests__/browser-third-party-notices.test.mjs
```

The real fixtures require a graphical Electron environment supported by the current platform. They execute rather than intentionally skip on macOS, Windows, and Linux. Validation for the cross-platform pop-out change was executed natively only on macOS; native Windows and Linux reparenting, recording/media, close-race, and packaged-layout qualification remain unexecuted. Run all smoke commands on each target platform; passing on one operating system does not qualify another.

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
9. Builds and validates the deterministic External Chrome shell/payload and the current platform/architecture native host, then stages their combined hash/identity/compatibility manifest into `.stage/external-chrome/`; unsupported SEA toolchains fail this packaged-release step rather than shipping a bundle-only host
10. Runs a packaged-runtime preflight that resolves and loads the staged native/runtime externals from `.stage/backend/node_modules/`, including an Electron-as-Node SQLite query, ensuring they do not silently fall back to repo-level `node_modules`
11. Runs a staged CLI preflight with Electron-as-Node against `.stage/cli/cli.js --version`
12. Runs `electron-builder --publish never`

Packaged outputs are written to `apps/electron/release/`, which is treated as ephemeral build output for the current run.

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

With these set, macOS packaging signs and notarizes automatically via `electron-builder`.

### Windows signing (optional)

| Variable | Description |
|----------|-------------|
| `CSC_LINK` or `WIN_CSC_LINK` | Base64 or file path for the Windows code-signing certificate |
| `CSC_KEY_PASSWORD` or `WIN_CSC_KEY_PASSWORD` | Password for that certificate |

If Windows signing credentials are absent, Windows installers are still buildable but remain unsigned.

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
   - Run `pnpm package:electron` on a macOS machine with signing credentials in `.env`
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

- `workflow_dispatch` is the release build path
- `electron/*` branch pushes are the release-branch validation path
- The workflow does not publish a GitHub Release on its own
- Download the Windows artifact from the workflow run, then upload those files into the draft release alongside the locally built macOS assets
- The release operator is still responsible for choosing the correct GitHub release channel: beta builds stay prerelease, stable builds are published later as stable

## Port Configuration

The Electron app uses port `47287` for the backend by default in packaged mode. You can override this by setting `FORGE_PORT` before launching the app.

The root `pnpm dev:electron` workflow also uses backend port `47287`; only its UI remains on the Vite dev port `47188`.

## Platform Notes

The desktop app is tested and supported on:

- **macOS** 10.13+ (both Intel and Apple Silicon)
- **Windows** 10+ (x64)
- **Linux** (x64, AppImage format)

Windows builds use an NSIS installer with per-user installation by default. Linux builds use AppImage for maximum compatibility.
