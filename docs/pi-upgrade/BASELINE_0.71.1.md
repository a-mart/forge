# Pi 0.71.1 upgrade baseline (WP-0)

**Captured on:** 2026-07-11  
**Forge commit:** `c751c79c68d0` (`v0.22.0-beta.3`)  
**Branch:** `pi-upgrade-0.80.6-safety`  
**Pi family:** patched `@mariozechner/pi-ai@0.71.1` + `@mariozechner/pi-coding-agent@0.71.1`  
**Node at capture:** see evidence log (host may be newer than the upcoming `>=22.19.0` floor)

## Exact focused baseline command

```bash
cd apps/backend && pnpm exec vitest run \
  src/swarm/__tests__/runtime-factory.test.ts \
  src/test/agent-runtime.test.ts \
  src/swarm/__tests__/runtime-event-projector.test.ts \
  src/swarm/__tests__/runtime-status-projector.test.ts \
  src/swarm/__tests__/project-executable-trust.test.ts \
  src/swarm/__tests__/repo-root-phase0-characterization.test.ts \
  src/swarm/__tests__/compaction-stability-characterization.test.ts \
  src/swarm/__tests__/forge-pi-compaction.test.ts \
  src/swarm/__tests__/forge-pi-compaction-auth.test.ts \
  src/swarm/__tests__/forge-pi-compaction-bounds.test.ts \
  src/test/pi-replay-empty-content.test.ts \
  src/swarm/__tests__/openai-codex-transport-forwarding.test.ts \
  src/swarm/__tests__/model-catalog-projection.test.ts \
  src/swarm/__tests__/pi-model-registry.test.ts \
  src/ws/http/routes/__tests__/settings-routes.test.ts
```

Planning orientation cited **254 focused tests**. WP-0 must archive the machine-readable result from this branch rather than trust that number.

Machine-readable logs belong under `.internal/pi-upgrade-evidence/` (gitignored). Summarize pass/fail counts here after each capture — never paste auth payloads.

## Package / patch identity (pre-pin)

| Package | Version | Notes |
|---------|---------|-------|
| `@mariozechner/pi-ai` | `0.71.1` | Root `pnpm.patchedDependencies` |
| `@mariozechner/pi-coding-agent` | `0.71.1` | Compaction reentrancy patch |
| `@mariozechner/pi-agent-core` | `0.71.1` | Transitive |
| `@mariozechner/pi-tui` | `0.71.1` | Transitive |

Inspected target tarball SHA-256 (registry, not yet pinned):

| Package | SHA-256 |
|---------|---------|
| `@earendil-works/pi-coding-agent@0.80.6` | `2a77634640b2d86d90d24087bb67559ecf2366e0fb52a42c55eed416147da411` |
| `@earendil-works/pi-ai@0.80.6` | `1aa05502e0c3d7d4e756ec089ace195fcd9befc9566898d6c870f7be1f7a12b5` |

## Source singleton (0.71.1)

From `apps/backend`, `import.meta.resolve('@mariozechner/pi-ai')` via Forge parent and via `pi-coding-agent` parent share one realpath and identical `registerFauxProvider` / `getModel` / `closeOpenAICodexWebSocketSessions` function identity. Electron packaging still externalizes only `pi-coding-agent` today — see Electron characterization tests.

## Focused baseline result (this branch)

| Metric | Value |
|--------|-------|
| Success | true |
| Total tests | **281** (planning orientation was 254; +new characterization fixtures/tests) |
| Failed | 0 |
| Node | `v25.6.1` (above upcoming `>=22.19.0` floor; CI/Docker still need WP-1) |
| Evidence | `.internal/pi-upgrade-evidence/baseline-focused-summary.json` (gitignored) |

## Known OpenRouter timeout (baseline note)

**Finding:** Live OpenRouter model catalog fetch (`GET https://openrouter.ai/api/v1/models` via `fetchLiveOpenRouterModels` in `openrouter-routes.ts`) has **no explicit AbortSignal / timeout**. On slow or hung networks the request can stall until the platform fetch default aborts or hangs the settings UI path; failures are swallowed and the route falls back to cache/empty (`catch { return cachedLiveOpenRouterModels ?? [] }`).

**2026-07-11 capture:** A bounded 8s probe from this host failed in ~109ms with a transport `TypeError` (not an Abort timeout). That still validates the product risk: Forge does not impose its own deadline, so hung OpenRouter fetches are unbounded relative to UX. Evidence: `.internal/pi-upgrade-evidence/openrouter-live.json` (redacted fields only).

**Baseline implication for upgrade gates:**

- Do **not** treat a hung/failed OpenRouter live fetch as a Pi upgrade regression.
- Prefer cached `openrouter-models.json` / projection unit tests for CI.
- Live OpenRouter smoke remains owner-operated and non-blocking when the endpoint times out or is unreachable.
- Record whether a live attempt timed out in `.internal/pi-upgrade-evidence/openrouter-live.json` with only `{ ok, elapsedMs, timedOut, modelCount }` — never API keys or model payload dumps.

## Fixture scaffolding

Version-labelled session fixtures live at:

`apps/backend/src/swarm/__tests__/fixtures/pi-sessions/0.71.1/`

See `manifest.json` and `pi-session-fixture-characterization.test.ts`.
