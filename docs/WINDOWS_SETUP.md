# Windows Setup

Forge fully supports Windows for the backend daemon, dashboard UI, agent orchestration, and all persistence. This guide covers platform-specific setup, configuration, and known limitations.

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org/)
- **pnpm** — `npm install -g pnpm`
- **Git** — [Download](https://git-scm.com/download/win)

## Installation

```powershell
git clone https://github.com/radopsai/middleman.git
cd middleman
pnpm i
```

## Running

```powershell
# Development (hot reload)
pnpm dev

# Production daemon
pnpm prod:daemon

# Restart a running daemon
pnpm prod:restart
```

All core `pnpm` commands (`dev`, `build`, `test`, `prod:daemon`, `prod:restart`) work natively on Windows without WSL.

## Data Directory

On Windows, Forge defaults to:

```
%LOCALAPPDATA%\forge
```

If a legacy `~/.middleman` directory already exists and the new default does not, Forge will keep using the legacy path and log a warning so existing installs continue to work.

To override the location:

```powershell
$env:FORGE_DATA_DIR = 'C:\forge-data'
```

Or set it permanently in your `.env` file:

```
FORGE_DATA_DIR=C:\forge-data
```

## Long Path Support

Windows path length limits can affect file operations when the repo or data directory is deeply nested. To avoid issues:

1. **Enable long path support in Windows:**
   - Open `gpedit.msc` → **Computer Configuration → Administrative Templates → System → Filesystem → Enable Win32 long paths**
   - Or set the registry value: `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`

2. **Keep paths short** — avoid deeply nested checkout or data directory locations.

3. **Enable Git long paths:**
   ```powershell
   git config --system core.longpaths true
   ```

## Known Limitations

### Playwright Dashboard

The Playwright dashboard and live preview subsystem is **disabled on Windows** because it relies on Unix-domain-socket IPC with the Playwright CLI.

What works:
- Playwright settings persistence in the UI
- All other backend and dashboard functionality

What is disabled:
- Playwright session discovery
- Playwright live preview / devtools bridge

### Shell Scripts

The `scripts/*.sh` files are POSIX shell scripts used for developer tooling (test instances, cutover helpers). They are **not required** to run Forge.

To use them on Windows, run from:
- **WSL2** (recommended)
- **Git Bash**

See [scripts/README.md](../scripts/README.md) for details on which scripts are cross-platform vs POSIX-only.

## WSL2 as an Alternative

WSL2 is a good option if you want:

- Full POSIX shell compatibility for all scripts
- Unix socket semantics (enables Playwright dashboard)
- A Linux-like development experience

Tips for WSL2:
- Keep the repo and data directory **inside the WSL filesystem** (`/home/...`) for best performance. Cross-filesystem access between Windows and WSL is slower.
- Windows Defender can increase I/O latency — consider adding exclusions for your WSL filesystem or the Forge data directory.

## Environment Variables

These are the most relevant environment variables for Windows:

| Variable | Default (Windows) | Description |
|----------|-------------------|-------------|
| `FORGE_DATA_DIR` | `%LOCALAPPDATA%\forge` | Data directory location |
| `FORGE_HOST` | `127.0.0.1` | Backend bind address |
| `FORGE_PORT` | `47187` (dev) / `47287` (prod) | Backend port |
| `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` | `false` (Windows) | Force-enable/disable Playwright dashboard |

See [docs/CONFIGURATION.md](CONFIGURATION.md) for the full configuration reference.
