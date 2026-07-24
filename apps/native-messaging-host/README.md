# Forge External Chrome native messaging host

This M1 spike is a narrow Node single-executable-application (SEA) capable relay. It owns:

- binary native-messaging stdio framing with Forge bounds below Chrome's transport limits;
- exact launch-origin validation for the pinned Forge extension;
- an authenticated, version-negotiated client for an injected per-user Unix-domain socket or Windows named pipe rendezvous; and
- deterministic bundle/current-platform SEA metadata plus isolated tests.

It deliberately contains **no browser automation or browser-control policy**, localhost listener, Chrome profile reads, real authentication key, production rendezvous discovery, OS registration, installer, or UI. The executable currently returns one bounded `desktop-unavailable` native message until Forge Desktop injects the rendezvous, secret provider, and socket connector. Secrets exist only behind an injectable interface and in test fixtures.

## Development

```bash
pnpm --filter @forge/external-chrome-native-host test
pnpm --filter @forge/external-chrome-native-host typecheck
pnpm --filter @forge/external-chrome-native-host build
pnpm --filter @forge/external-chrome-native-host package:current
```

`package:current` requires a Node release with direct `--build-sea` support (Node 25+ in the current development toolchain). It writes ignored `dist/` artifacts and a deterministic package manifest for the running platform/architecture. `sea-config.json` disables code cache and startup snapshots so generated inputs are stable. If a vendor Node binary advertises `--build-sea` but was built without `NODE_SEA_FUSE` (the current Homebrew Node 25.6.1 arm64 binary has this exact gap), the manifest records `sea.status: "unsupported-toolchain"`; use an official Node distribution containing the SEA fuse to produce and smoke the executable. macOS signing/notarization, Windows launcher `_setmode` integration and signing, Linux packaging, Chrome native-host manifests, registry/filesystem registration, repair, and uninstall are intentionally outside this spike.

Windows remains byte-stream safe through an explicit binary-mode integration seam; Node/libuv pipe streams are binary by default in this spike. Windows and Linux package artifacts were not produced on macOS.
