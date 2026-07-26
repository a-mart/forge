# Forge Model Catalog

Forge keeps its supported model metadata in one checked-in source of truth:

- `packages/protocol/src/model-catalog.ts`

That file defines the catalog in three layers:

- **providers**: runtime/provider behavior
- **families**: preset groupings like the visible full Codex families `pi-5.6` and `pi-5.5`; legacy aliases such as `pi-codex` remain compatibility-only and are hidden from selector/preset surfaces
- **models**: concrete model metadata used by runtime and UI

## Source of truth rules

When adding or updating supported models:

1. Edit `packages/protocol/src/model-catalog.ts`
2. Run the catalog tests
3. Run the audit script against Pi upstream
4. Update any intentional divergence notes if needed

Do **not** add model metadata in frontend fallback constants, ad-hoc backend maps, or provider-specific extensions.

## Runtime flow

Forge owns model metadata end-to-end:

1. The checked-in catalog defines the baseline model metadata.
2. Optional local user overrides are stored in `~/.forge/shared/config/model-overrides.json`.
3. Backend merges catalog + overrides.
4. Backend generates a Pi-compatible projection at `~/.forge/shared/cache/generated/pi-models.json`.
5. Every Pi `ModelRegistry` is constructed with that generated projection path.
6. Request-time provider quirks are handled by `apps/backend/src/swarm/model-catalog-request-behaviors.ts`. xAI native search is future/experimental pending a dedicated adapter; it is not a current production path.

## Codex app-server sidecar

The Builder web `@Codex` surface has two paths. A plain leading `@Codex` or `[@Codex]` text message uses the Codex CLI app-server as a direct sidecar thread. Selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin and delegate it to the visible `Codex Plugin` specialist worker. The plugin-scoped path is read-only/safety-gated, uses server-owned scoped exact plugin tools, and returns preview/metadata-bounded normal tool output. Full connector exports use the scoped export artifact path instead of chat chunk relay. The direct sidecar path is Builder web only, text-only, excluded from Collaboration, and limited to one active direct Codex turn globally. Parent session display cards are append-only and excluded from model context; forked sessions omit historical Codex display cards.


## Cursor SDK provider

`cursor-sdk` is a native provider backed by `@cursor/sdk`. The curated models are `composer-2.5` (Composer 2.5) and provider-scoped Cursor Grok 4.5 variants (`grok-4.5`, `grok-4.5-fast`). The static Forge mapping was curated from live Cursor SDK discovery: Cursor Grok 4.5 uses SDK model id `grok-4.5`, Forge maps reasoning levels to Cursor's `effort` param (`low`/`medium`/`high`), and Forge represents the fast pool with `fast=true` via the `grok-4.5-fast` catalog variant. Composer 2.5 is marked non-reasoning because discovery exposed only a `fast` toggle, not controllable reasoning effort. Runtime containment is provider-local and fail-closed with a Cursor/ConnectRPC/HTTP2 classifier: attributed transient transport or throttle failures may retry once before output, auth/permission/cancel/user-state failures are projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is recorded in session custom entries and rolls up into dashboard stats, token analytics, and telemetry provider inference.

## xAI authentication routing

API-key-backed xAI models keep the standard `api.x.ai` endpoint. When the stored xAI credential is OAuth, the Pi model registry rewrites only xAI models to `cli-chat-proxy.grok.com`; non-xAI models and checked-in catalog metadata remain unchanged. The public Grok CLI client/proxy contract is provider-coupled and operationally experimental. Revalidate browser and device login, refresh behavior, and proxy routing whenever Pi or the xAI adapter is upgraded.

## Retired model policy

GPT-5.3 Codex Spark, Claude Sonnet 4.5, and Claude Haiku 4.5 are retired. They are absent from catalog, selector, preset, specialist, and generated projection surfaces. New requests using their canonical IDs, known dotted/dashed aliases, provider-scoped forms, or the removed `pi-codex-spark` preset are rejected before runtime provider dispatch.

Persisted descriptors are normalized deterministically during hydration and restart: Spark becomes `openai-codex/gpt-5.5`, Anthropic Sonnet 4.5 and Haiku 4.5 become `anthropic/claude-sonnet-5`, known former Claude SDK selections become the same native `anthropic` model, and retired SDK Sonnet/Haiku 4.5 selections become `anthropic/claude-sonnet-5`. Unknown former SDK IDs remain unavailable and require an explicit native Anthropic selection. The existing reasoning level is clamped to the replacement model's supported levels. OpenRouter references are not migrated across providers; they fail closed and require an explicit new selection. Historical transcript entries remain unchanged for replay and analytics; they cannot select the runtime model. User-authored project resources are not rewritten and report remediation instead. Claude Code credentials are not transferred; configure native Anthropic auth in Forge. Continued sessions use native Anthropic reasoning and compaction semantics. Rollback requires reinstalling the prior binary; no history or external Claude Code data is rewritten.

## Override semantics

Local overrides are intentionally narrow and safe.

Supported fields:

- `enabled`: control whether a model can appear in manager-facing selectors, including create-session, change-default, and per-session override flows
- `contextWindowCap`: cap the effective context window

### Context window cap semantics

Caps are applied with `min`, not replacement.

- catalog context window: `1_000_000`
- override cap: `300_000`
- effective context window: `300_000`

Overrides can reduce limits, but never increase them above the checked-in catalog value.

## Audit workflow

When upgrading Pi model dependencies, run:

```bash
pnpm model-catalog:audit
```

The audit reports:

- curated Forge models missing upstream
- curated Forge models pending installed Pi upstream
- upstream models not yet curated by Forge
- metadata drift for curated models
- intentional divergences recorded in the catalog

## Common maintenance tasks

### Add a routine model under an existing provider

Usually this is a one-file change in `packages/protocol/src/model-catalog.ts`.

Checklist:

1. Add/update the model entry
2. Confirm family membership and default selection
3. Confirm reasoning/input/web-search metadata
4. Run `pnpm model-catalog:audit`
5. Run typechecks and tests

### Add a new provider behavior

This usually requires more than a catalog edit. You may also need to update:

- request behavior adapters
- auth/settings UI
- runtime projection logic
- provider availability checks

## Files involved

- Shared catalog: `packages/protocol/src/model-catalog.ts`
- Backend catalog service: `apps/backend/src/swarm/model-catalog-service.ts`
- Pi projection generator: `apps/backend/src/swarm/model-catalog-projection.ts`
- Request behavior adapters: `apps/backend/src/swarm/model-catalog-request-behaviors.ts`
- Local overrides persistence: `apps/backend/src/swarm/model-overrides.ts`
- Audit script: `scripts/model-catalog-audit.mjs`
