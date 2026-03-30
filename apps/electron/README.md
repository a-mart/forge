# Forge Electron Desktop App

This workspace packages Forge as a standalone desktop application for macOS, Windows, and Linux. The desktop app bundles the backend, UI, and all dependencies so end users do not need Node.js or pnpm installed.

## Architecture

The Electron app is a thin wrapper around Forge's existing backend and UI:

- **Main process** (`src/main.ts`) — launches the packaged backend, manages the application window, and handles auto-updates
- **Preload script** (`src/preload.ts`) — bridges the renderer and main process, exposing a minimal IPC API
- **Renderer process** — loads the staged UI bundle from `ui/index.html`

### Packaged layout

`electron-builder` packages the staged contents of `apps/electron/.stage/`:

- **Backend runtime** — `.stage/backend/dist/index.mjs` bundled from `apps/backend/dist/index.js`, plus staged runtime dependencies under `.stage/backend/node_modules/`
- **Renderer** — `.stage/ui/`, copied from `apps/ui/.output/public/`; `_shell.html` is promoted to `index.html` for packaged startup
- **Forge resources** — `.stage/forge-resources/`, containing built-in skills, archetypes, operational prompts, specialists, static assets, and related runtime resources

At runtime the packaged app spawns the staged backend bundle from `backend/dist/index.mjs`, waits for backend readiness, then opens the renderer from the staged `ui/` directory.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Main process entry point. Window management, backend lifecycle, IPC handlers |
| `src/preload.ts` | Renderer bridge. Exposes minimal API for platform detection and window controls |
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

This command starts the UI dev server (`pnpm dev:ui`) and waits for it to be ready, then launches Electron. The Electron window loads from `http://127.0.0.1:47188` (the dev server). The backend is forked as a child process on the default dev port (`47187`).

Changes to UI code hot-reload. Changes to Electron main process code (`src/main.ts`, etc.) require restarting the app.

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
2. Builds `@forge/protocol`, `@forge/backend`, `@forge/ui`, and the Electron main process
3. Stages backend runtime assets into `apps/electron/.stage/backend/`
4. Stages renderer assets into `apps/electron/.stage/ui/`
5. Stages Forge runtime resources into `apps/electron/.stage/forge-resources/`
6. Runs a packaged-runtime preflight that resolves and loads the staged native/runtime externals from `.stage/backend/node_modules/`, ensuring they do not silently fall back to repo-level `node_modules`
7. Runs `electron-builder --publish never`

Packaged outputs are written to `apps/electron/release/`, which is treated as ephemeral build output for the current run.

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

When running in dev mode via `pnpm dev:electron`, the backend uses the dev port (`47187`) instead.

## Platform Notes

The desktop app is tested and supported on:

- **macOS** 10.13+ (both Intel and Apple Silicon)
- **Windows** 10+ (x64)
- **Linux** (x64, AppImage format)

Windows builds use an NSIS installer with per-user installation by default. Linux builds use AppImage for maximum compatibility.
