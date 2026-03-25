# Forge Electron Desktop App

This workspace packages Forge as a standalone desktop application for macOS, Windows, and Linux. The desktop app bundles the backend, UI, and all dependencies so end users don't need Node.js or pnpm installed.

## Architecture

The Electron app is a thin wrapper around Forge's existing backend and UI:

- **Main process** (`src/main.ts`) — Forks the backend as a child process, manages the application window, and handles auto-updates
- **Preload script** (`src/preload.ts`) — Bridges the renderer and main process, exposing a minimal IPC API
- **Renderer process** — Loads the bundled UI from `ui/` (static build of `apps/ui`)

The backend runs as a child process of the main Electron app. When the app starts, the main process spawns `node backend/dist/index.js` and waits for the server to be ready before opening the window. When the app quits, the backend is terminated cleanly.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Main process entry point. Window management, backend lifecycle, IPC handlers |
| `src/preload.ts` | Renderer bridge. Exposes minimal API for platform detection and window controls |
| `src/auto-updater.ts` | Auto-update logic using `electron-updater` and GitHub Releases |
| `src/window-state.ts` | Persists window position and size across restarts |
| `src/fix-path.ts` | Ensures PATH is set correctly on macOS when launched from GUI (not terminal) |
| `src/whats-new.ts` | Displays release notes after successful update |
| `electron-builder.yml` | Build configuration for packaging and distribution |
| `scripts/build-all.mjs` | Stages backend, UI, and resources into `.stage/` before packaging |

## Development

To run the Electron app in dev mode from the repository root:

```bash
pnpm dev:electron
```

This command starts the UI dev server (`pnpm dev:ui`) and waits for it to be ready, then launches Electron. The Electron window loads from `http://127.0.0.1:47188` (the dev server). The backend is forked as a child process on the default dev port (47187).

Changes to UI code will hot-reload. Changes to Electron main process code (`src/main.ts`, etc.) require restarting the app.

If you only want to run the Electron app without starting the UI dev server separately:

```bash
cd apps/electron
pnpm dev
```

This builds the main process and launches Electron, but you'll need the UI dev server running in another terminal.

## Building

To package the desktop app for distribution:

```bash
pnpm package:electron
```

This runs the full build pipeline:

1. Builds the protocol, backend, and UI packages
2. Stages all resources into `apps/electron/.stage/`
3. Builds the Electron main process code
4. Runs `electron-builder` to package the app for the current platform

The packaged app will be in `apps/electron/release/`.

### What Gets Bundled

The staging script (`scripts/build-all.mjs`) copies the following into the Electron app:

- **Backend**: `apps/backend/dist/`, `static/`, `package.json`, and production `node_modules/`
- **UI**: Full static build from `apps/ui/dist/`
- **Resources**: Platform-specific resources (icon, entitlements) from `build/`

The bundled backend runs in production mode. Port defaults to 47287, overridable via `FORGE_PORT`.

## Code Signing (macOS)

To sign and notarize the macOS build, set these environment variables in your `.env` file before running `pnpm package:electron`:

| Variable | Description |
|----------|-------------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

Without these, the build will succeed but the app won't be signed or notarized. Users will see security warnings when opening it.

Signing and notarization happen automatically during the build if the variables are set. The `electron-builder.yml` config includes the necessary entitlements for hardened runtime.

## Releasing

Releases are built locally and uploaded to GitHub. The CI workflow (`.github/workflows/electron-build.yml`) remains available as a backup and validation path but is not the primary release mechanism.

### Local Release Workflow

1. **Bump version**: Run `pnpm release:electron` to update version in `package.json` and commit, or manually update and commit

2. **Build macOS**: Run `pnpm package:electron` locally with signing environment variables set in `.env`. The signed and notarized app will be in `apps/electron/release/`

3. **Build Windows**: Build on a local Parallels Windows VM or use the CI workflow by pushing a `v*` tag

4. **Create GitHub Release**:
   ```bash
   gh release create v1.2.3 --draft --generate-notes
   ```

5. **Upload artifacts**:
   ```bash
   gh release upload v1.2.3 apps/electron/release/*.dmg
   gh release upload v1.2.3 apps/electron/release/*.exe
   ```

6. **Publish**: Review the draft release on GitHub, then publish

The app includes auto-update support. Users will be notified when a new version is available and can update with one click. Updates are fetched from GitHub Releases.

## Port Configuration

The Electron app uses port 47287 for the backend by default (production mode). You can override this by setting `FORGE_PORT` before launching the app.

When running in dev mode via `pnpm dev:electron`, the backend uses the dev port (47187) instead.

## Platform Notes

The desktop app is tested and supported on:

- **macOS** 10.13+ (both Intel and Apple Silicon)
- **Windows** 10+ (x64)
- **Linux** (x64, AppImage format)

Windows builds use NSIS installer with per-user installation by default. Linux builds use AppImage for maximum compatibility.
