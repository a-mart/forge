# Forge External Chrome native messaging host

This package is a narrow Node single-executable-application (SEA) relay. It owns:

- binary native-messaging stdio framing with Forge bounds below Chrome's transport limits;
- exact launch-origin validation for the pinned Forge extension;
- an authenticated, version-negotiated client for an injected per-user Unix-domain socket or Windows named pipe rendezvous;
- a relay receive queue bounded by both decoded record count and aggregate decoded JSON bytes, with deterministic connection close on overflow; and
- deterministic bundle/current-platform SEA metadata plus isolated tests.

The long-lived 256-bit per-user secret authenticates only the challenge exchange. The exact challenge transcript binds both protocol ranges and the selected version, pinned extension origin, Desktop instance ID, rendezvous epoch, client/server nonces, and negotiated message limit. Challenge and client-response proofs are domain-separated HMAC-SHA-256 values. Ready and relay records never use that long-lived key: both peers derive a per-connection 256-bit key with HKDF-SHA-256, using a domain-separated transcript HMAC as salt and `forge-external-chrome/relay-record-key/v1` as HKDF info. Secret copies are zeroed after the handshake, and the derived key is zeroed on every connection close or failure.

It deliberately contains **no browser automation or browser-control policy**, localhost listener, Chrome profile reads, OS registration, installer, or UI. The deployed executable derives only its Forge-owned integration siblings, validates the private rendezvous/key files, and connects the advertised Unix socket or Windows named pipe. Secrets are never sent to the extension or included in diagnostics.

## Development

```bash
pnpm --filter @forge/external-chrome-native-host test
pnpm --filter @forge/external-chrome-native-host typecheck
pnpm --filter @forge/external-chrome-native-host build
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm --filter @forge/external-chrome-native-host package:current
```

`package:current` is pinned to the official Node 25.6.1 distribution and its direct `--build-sea` path. Release mode additionally requires `FORGE_SEA_NODE` to name that exact executable; a vendor build without `NODE_SEA_FUSE` fails rather than producing a publishable package. `sea-config.json` disables code cache and startup snapshots so generated inputs are stable.

The generated executable is smoked, platform-signed, signature-verified against the expected signer, smoked again, and only then hashed into `dist/package-manifest.json`. macOS requires an exact `Developer ID Application` identity and Apple team. Windows uses Authenticode and an exact expected certificate subject. Explicit validation mode (`FORGE_EXTERNAL_CHROME_BUILD_MODE=validation`) is credential-free, but its manifest is marked unverified and the Desktop runtime rejects it as a release package.

Windows remains byte-stream safe through an explicit binary-mode integration seam; Node/libuv pipe streams are binary by default.
