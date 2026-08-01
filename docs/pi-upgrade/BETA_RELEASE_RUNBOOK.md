# Pi 0.80.6 beta / release runbook

Owner-operated gates for shipping the `@earendil-works/pi-*@0.80.6` upgrade. Production `47287` and `~/.forge` stay untouched until an explicit owner promote step.

## Breaking extension migration

1. Scan first (read-only):
   ```bash
   pnpm pi-extension:migrate -- ~/.forge/agent/extensions ~/.forge/agent/manager/extensions
   pnpm pi-extension:migrate -- <cwd>/.forge/pi/extensions <cwd>/.pi/extensions
   ```
2. Apply supported rewrites:
   ```bash
   pnpm pi-extension:migrate -- --write <extension-dir>
   ```
3. Unsupported legacy subpaths (for example `@mariozechner/pi-ai/private-subpath`) fail closed with Forge migration guidance at the runtime extension snapshot seam. There are no `@mariozechner/pi-*` shims.
4. Re-bind / smoke a trusted project extension after rewrite. Source + staged packaged preflight both exercise unsupported-subpath diagnostics.

## Thinking-level `none` / `ultra` mapping

| Legacy / fixture label | 0.80.6 target-native selector |
| --- | --- |
| `none` | `none` / off-equivalent in Forge selectors |
| `ultra` | `max` |

Fixtures retain `none`/`ultra` labels for cross-version JSONL compatibility proofs. UI/settings selectors expose the target-native set including `max`. Do not invent a silent dual-write of both labels in new sessions.

## Snapshot + old-binary rollback

1. Before upgrade, copy data with `scripts/pi-upgrade/prepare-isolated-data.sh` (refuses production overlap).
2. Provision the immutable frozen runner:
   ```bash
   pnpm pi-upgrade:provision-0711-runner
   ```
   This uses committed `scripts/pi-upgrade/pi-0711-rollback-runner/{package.json,package-lock.json}` via `npm ci`.
3. Characterization gates open 0.80.6-written v3 fixtures under the frozen `@mariozechner/pi-coding-agent@0.71.1` runner and prove bidirectional append/reopen for this fixture matrix only.
4. **In-place downgrade is not a claimed release path** until independently proven for a given format. If unproven or the frozen runner cannot open target-written state, **fail closed** and retain the pre-upgrade snapshot + old binary.

## Session fixture provenance gate

Provenance is required independently of rollback wording:

```bash
pnpm pi-upgrade:generate-session-fixture-manifests
pnpm pi-upgrade:generate-session-fixture-manifests -- --check
```

Manifests under `apps/backend/src/swarm/__tests__/fixtures/pi-sessions/*/manifest.json` must include immutable `producingCommit`, per-file SHA-256, exact Pi `0.80.6` integrities/patch SHA-256, frozen 0.71.1 runner identity, and Node/toolchain metadata. Tests assert regeneration equivalence with the committed generator.

## Isolation harness

```bash
scripts/pi-upgrade/start-isolated-instance.sh
scripts/pi-upgrade/stop-isolated-instance.sh
```

Start forces the normal non-Desktop backend path, disables the unnecessary local UI Devtools sidecar, records the **actual TCP listener PID**, validates wrapper ancestry + nonce + `FORGE_DATA_DIR`, and refuses occupied ports. Stop collects nonce-bearing descendants before signalling only the verified owned tree; it never adopts an arbitrary listener or process tree.

## Packaging / Electron

- Pi family (`pi-ai`, `pi-coding-agent`, `pi-agent-core`, `pi-tui`) is a hard singleton: skew fails closed.
- Non-Pi multi-version dependencies are staged as nested installs. Flat staging must never warn-and-discard incompatible versions.
- Exported validators: `assertPiFamilySingletonManifests`, `validateStagedPiSingletonRuntime`, `validatePackagedRuntimePreflight`.

## Windows trust

CI jobs set `FORGE_REQUIRE_WIN32_TRUST_GATES=1` on `windows-latest` and run junction/case trust characterization. Local macOS/Linux runs skip those cases unless the env flag is set (then they fail closed outside win32).

Owner-only residual: extracted installer smoke on real Windows hardware after CI artifacts land.

## Owner gates before broad rollout

These remain owner-operated and are not silently skipped by child CI jobs:

1. Extracted macOS + Windows installer smoke from staged/release artifacts
2. Live provider canary on the isolated instance (not production)
3. Copied-data downgrade rehearsal with snapshot + frozen 0.71.1 binary
4. Model-catalog audit policy warnings reviewed separately from hard failures:
   ```bash
   pnpm model-catalog:audit
   ```

## Validation checklist

```bash
pnpm pi-package:identity
pnpm lint
pnpm exec knip
pnpm test
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
pnpm build:electron   # or package:electron for full staging preflight
```
