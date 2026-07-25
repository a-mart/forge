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
pnpm --filter @forge/external-chrome-native-host package:current
```

`package:current` requires a Node release with direct `--build-sea` support (Node 25+ in the current development toolchain). It writes ignored `dist/` artifacts and a deterministic package manifest for the running platform/architecture. `sea-config.json` disables code cache and startup snapshots so generated inputs are stable. If a vendor Node binary advertises `--build-sea` but was built without `NODE_SEA_FUSE` (the current Homebrew Node 25.6.1 arm64 binary has this exact gap), the manifest records `sea.status: "unsupported-toolchain"`; use an official Node distribution containing the SEA fuse to produce and smoke the executable. macOS signing/notarization, Windows launcher `_setmode` integration and signing, Linux packaging, Chrome native-host manifests, registry/filesystem registration, repair, and uninstall are intentionally outside this spike.

Windows remains byte-stream safe through an explicit binary-mode integration seam; Node/libuv pipe streams are binary by default in this spike. Windows and Linux package artifacts were not produced on macOS.
