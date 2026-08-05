# Forge Automatic Browser Chrome native relay

This package builds the narrow native relay used by the Automatic Browser Host's optional Chrome adapter. Chrome starts it through native messaging; the process authenticates to Forge Desktop's current-user rendezvous and relays bounded protocol records. It is not a browser automation engine, a separate host, or a policy owner for choosing and controlling tabs.

Read the user-facing [Browser automation guide](../../docs/BROWSER_AUTOMATION.md#optional-chrome-setup) for setup, permissions, and lifecycle behavior.

## Boundary

The host owns:

- binary native-messaging stdio framing with Forge limits below Chrome transport limits;
- exact launch-origin validation for pinned extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`;
- a version-negotiated client for an injected per-user Unix-domain socket or Windows named-pipe rendezvous;
- an authenticated challenge/response and per-connection relay-record integrity;
- bounded decoded-record and decoded-byte queues with deterministic close on overflow; and
- deterministic bundle/current-target SEA metadata plus isolated tests.

It deliberately contains no Chrome profile discovery or reads, no browser credentials, no Chrome profile databases, no official profile names, no tab selection, no automation policy, no localhost listener, no OS registration writer, no installer, and no UI. Registration and deployment belong to Forge Desktop.

The deployed executable derives only its Forge-owned integration siblings, validates the private rendezvous/key files, and connects to the advertised local endpoint. Secrets are never sent to the extension or included in diagnostics.

## Authentication

The long-lived 256-bit current-user secret authenticates only the challenge exchange. The transcript binds both protocol ranges and the selected version, pinned extension origin, Desktop instance ID, rendezvous epoch, client/server nonces, and negotiated message limit.

Challenge and response proofs use domain-separated HMAC-SHA-256. After the handshake, both peers derive a per-connection 256-bit record key with HKDF-SHA-256 and domain-separated transcript material. Ready and relay records never use the long-lived key directly. Secret copies and derived connection keys are cleared on close or failure.

## Development

Run from the repository root:

```bash
pnpm --filter @forge/protocol build
pnpm --filter @forge/external-chrome-native-host typecheck
pnpm --filter @forge/external-chrome-native-host test
pnpm --filter @forge/external-chrome-native-host build
FORGE_EXTERNAL_CHROME_BUILD_MODE=validation pnpm --filter @forge/external-chrome-native-host package:current
```

The tests cover framing bounds, host boundaries, installed-path discovery, authentication/version negotiation, record integrity, queue backpressure, transport loss, deterministic metadata, and release-signing policy. Explicit `validation` mode is credential-free and marks the produced manifest unverified. Validation mode exists only for non-publishable local/CI staging, package-content, and installer validation; runtime deployment and release publishing reject it.

## SEA and release gates

Validation-mode `package:current` uses the repository Node executable and accepts it only when its direct `--build-sea` invocation succeeds with the required `NODE_SEA_FUSE` capability. Release mode is pinned to the official Node 26.5.0 distribution and additionally requires `FORGE_SEA_NODE` to resolve to that exact executable. Explicit native-host packaging without the required fuse fails rather than producing a host; when Forge Desktop development needs to rebuild this optional host, it recognizes that structured toolchain result, leaves External Chrome unavailable, and continues startup.

The release sequence is fail-closed:

1. build the bundled host and deterministic SEA inputs with code cache and startup snapshots disabled;
2. generate the current target/architecture executable with the validated Node (the pinned official Node in release mode);
3. ad-hoc sign macOS output so the kernel can execute the validation artifact;
4. smoke the generated executable;
5. in macOS release mode, apply the configured signer (replacing the ad-hoc signature); Windows release mode records an explicit unsigned host;
6. verify the observed macOS signer against the exact expected identity/team;
7. smoke it again after the platform release preparation; and
8. only then hash it into `dist/package-manifest.json` for Electron staging.

The macOS ad-hoc signature is only an execution prerequisite and remains explicitly unverified in validation metadata; Windows does not use an ad-hoc first signature. macOS release mode replaces the ad-hoc signature and requires the exact configured `Developer ID Application` identity and Apple team. Windows release mode is credential-free and unsigned: the staged, deployed, and runtime host must match the exact release-manifest SHA-256, and any hash drift fails closed. Electron packaging preserves the manifest-hashed host bytes, then rechecks the packaged hash and platform-specific release contract after its own hooks.

A successful build or validation-mode SEA does not by itself qualify headed Chrome, live native registration, a target platform, installer behavior, or distribution. Those remain separate release gates in the [Electron guide](../electron/README.md#optional-chrome-adapter-packaging-and-validation).

Windows byte-stream handling stays behind an explicit binary-mode integration seam; Node/libuv pipe streams are binary by default.
