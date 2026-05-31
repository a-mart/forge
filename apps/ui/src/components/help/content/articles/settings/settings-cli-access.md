CLI Access controls the first-party `forge` command-line interface. Use it when you want scripts or terminal workflows to inspect sessions, send messages, run automation, wait for completion, or answer pending choices.

## Access keys

CLI keys are separate from model-provider credentials. Generate a key, copy it immediately, and store it securely; Forge shows the plaintext key only once. The backend stores generated keys hash-only, so lost keys must be rotated or regenerated.

The key list shows metadata such as name, creation time, and last-used information. Revoke keys that are no longer needed. Rotate a key when you want to replace it without keeping the old credential active.

## LAN safety

Desktop Forge may be reachable over your local network or Tailscale. Anyone with network access to the backend and a valid CLI key can use the CLI API, so treat keys like bearer tokens and revoke them if they are shared accidentally.

## Install CLI

In the desktop app, click **Install CLI** to create a user-local shim:

- macOS/Linux: `~/.forge/bin/forge`
- Windows: `%LOCALAPPDATA%\forge\bin\forge.cmd`

The shim uses the packaged Forge app runtime and bundled CLI resource, so it does not require a separate Node.js install and does not contain API keys. If the bin directory is not on `PATH`, Forge shows the exact shell instructions to add it.

Browser/source installs can use npm instead:

```bash
npm install -g @forge/cli
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge doctor
```

Prefer environment variables or flags for automation. Saved CLI config can store API keys as plaintext local data and should be used only when that tradeoff is acceptable.
