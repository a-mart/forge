# Windows Setup

Middleman supports Windows for the core backend, dashboard, persistence, and daemon lifecycle. A few developer conveniences still assume a POSIX shell; see `scripts/README.md` for those details.

## Recommended setup

- Install **Node.js 22+** and **pnpm**.
- Keep your checkout path short when possible.
- If you want the cleanest Unix-like developer experience for bash-heavy tooling, use **WSL2**.

## Long paths

Windows path length limits can still affect temp-file-based atomic writes when the repo or data directory is deeply nested.

Recommendations:

1. Enable long path support in Windows:
   - Open `gpedit.msc` and enable **Computer Configuration → Administrative Templates → System → Filesystem → Enable Win32 long paths**
   - Or set registry value:
     - `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`
2. Keep `MIDDLEMAN_DATA_DIR` short when possible, for example:
   - `C:\middleman-data`
3. Avoid deeply nested worktree locations if you can.

## Data directory defaults

On Windows, Middleman now defaults to:

- `%LOCALAPPDATA%\middleman`

If a legacy `~/.middleman` directory already exists and the new default does not, Middleman will keep using the legacy path and log a warning so existing installs continue to work.

You can always override the location explicitly with:

```powershell
$env:MIDDLEMAN_DATA_DIR = 'C:\middleman-data'
```

## Playwright dashboard support

The Playwright dashboard/discovery subsystem is currently **disabled on Windows** because it depends on Unix-domain-socket-based Playwright CLI IPC.

What still works:

- Playwright settings persistence
- The rest of the Middleman backend and UI

What is disabled on Windows:

- Playwright session discovery
- Playwright live preview / devtools bridge

## WSL notes

WSL2 is a good option if you want:

- POSIX shell tooling for `scripts/*.sh`
- Unix socket semantics closer to Linux/macOS
- Fewer Windows file-locking edge cases during heavy dev workflows

A few caveats:

- Cross-filesystem access between Windows and WSL can be slower.
- Windows Defender can increase IO latency and make file-lock timing more noticeable.
- If you run the app in WSL, prefer keeping the repo and data directory inside the WSL filesystem for best behavior.

## Production/dev commands

Cross-platform entrypoints:

```bash
pnpm dev
pnpm prod:start
pnpm prod:daemon
pnpm prod:restart
```

These commands are Windows-safe.
