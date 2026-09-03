# Forge Model Catalog

Forge keeps checked-in metadata for its supported catalog models in one source of truth:

- `packages/protocol/src/model-catalog-data.ts`

The public `packages/protocol/src/model-catalog.ts` module exports that data and its helpers. `model-catalog-data.ts` defines the catalog in three layers:

- **providers**: runtime/provider behavior
- **families**: preset groupings like the visible full Codex families `pi-6`, `pi-5.6`, and `pi-5.5`; legacy aliases such as `pi-codex` remain compatibility-only and are hidden from selector/preset surfaces
- **models**: concrete model metadata used by runtime and UI

## Source of truth rules

When adding or updating supported models:

1. Edit `packages/protocol/src/model-catalog-data.ts`
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

## User-added OpenRouter models

OpenRouter models added by the user are persisted overlays, not checked-in catalog rows. They do not create a Forge family, preset, or variant.

Manager eligibility is deliberately a separate, opt-in policy:

- Forge records `supportsTools` only from live OpenRouter metadata when adding a model and when OpenRouter Settings loads and reconciles stored exact IDs. Any request-body capability claim is ignored. A live `supportsTools: true` is a necessary verified-tool-call gate; `false` or an absent field is not manager eligible.
- Every user-added model starts with its per-model **Manager agents** setting off. Enable it explicitly with `managerEnabled: true` under the exact override key `openrouter:<model-id>`. The OpenRouter override accepts only this manager field; removing it returns to the default-off state. Reconciliation refreshes only live-derived `supportsTools`; it does not enable managers or mutate the exact row's default-off `managerEnabled` opt-in.
- Manager create, change, and session-override requests accept only an exact `{ provider: "openrouter", modelId: "<exact-id>" }` selection. OpenRouter rows have no family or preset fallback, and unknown IDs fail closed.
- A configured OpenRouter credential is still required when the manager selection is resolved. Configure the key in Settings → Authentication or provide `OPENROUTER_API_KEY`.
- When OpenRouter Settings loads, Forge automatically reconciles stored exact IDs against current live metadata and refreshes matched legacy rows. Unmatched or unrefreshable rows, and rows verified as `supportsTools: false`, remain non-manager and fail closed until a later live verification, even if retained for existing worker or specialist configuration.
- Removing an OpenRouter row clears its manager override. Retired OpenRouter IDs remain rejected.

Manager eligibility does not change compaction policy. OpenRouter is not in the supported Forge compaction provider allowlist and does not appear in the compaction model selector.

## Codex app-server sidecar

The Builder web `@Codex` surface has two paths. A plain leading `@Codex` or `[@Codex]` text message uses the Codex CLI app-server as a direct sidecar thread. Selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin and delegate it to the visible `Codex Plugin` specialist worker. The plugin-scoped path is read-only/safety-gated, uses server-owned scoped exact plugin tools, and returns preview/metadata-bounded normal tool output. Full connector exports use the scoped export artifact path instead of chat chunk relay. The direct sidecar path is Builder web only, text-only, excluded from Collaboration, and limited to one active direct Codex turn globally. Parent session display cards are append-only and excluded from model context; forked sessions omit historical Codex display cards.


## Cursor SDK provider

`cursor-sdk` is a native provider backed by `@cursor/sdk`. The curated models are `composer-2.5` (Composer 2.5) and provider-scoped Cursor Grok 4.5 variants (`grok-4.5`, `grok-4.5-fast`). The static Forge mapping was curated from live Cursor SDK discovery: Cursor Grok 4.5 uses SDK model id `grok-4.5`, Forge maps reasoning levels to Cursor's `effort` param (`low`/`medium`/`high`), and Forge represents the fast pool with `fast=true` via the `grok-4.5-fast` catalog variant. Composer 2.5 is marked non-reasoning because discovery exposed only a `fast` toggle, not controllable reasoning effort. Runtime containment is provider-local and fail-closed with a Cursor/ConnectRPC/HTTP2 classifier: attributed transient transport or throttle failures may retry once before output, auth/permission/cancel/user-state failures are projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is recorded in session custom entries and rolls up into dashboard stats, token analytics, and telemetry provider inference.

## OpenAI GPT-6 Astra catalog

`openai-codex/gpt-6-astra` is the checked-in model for the visible `pi-6` family. It is selectable for managers, compaction, specialists, and worker spawns, but does not replace Forge's `pi-5.5` global default or any checked-in roster and is not added to the automatic Codex capacity fallback chain. Forge exposes low, medium, high, xhigh, and max reasoning with high as its catalog default; unsupported none and ultra selections clamp to low and max respectively.

Astra has a 1.05M-token context window (922k maximum input plus 128k maximum output), text-and-image input, text output, tool calling, and structured output. Base Pi cost metadata is $10/MTok input, $1/MTok cached input, $12.50/MTok cache writes, and $50/MTok output. Requests above 272k total input use the request-wide $20/$2/$25/$75 tier. Temperature is disabled for the synthetic projection.

The installed Pi catalog does not yet include Astra, so Forge projects the official ID and also keeps a narrow `gpt-5.4` runtime blueprint fallback for registry paths that cannot see the generated projection. That blueprint is an internal compatibility implementation detail and does not re-expose the retired GPT-5.4 or GPT-5.4 Mini models. Persisted `pi-5.4` presets and exact GPT-5.4 descriptors migrate to `pi-5.5`. OpenAI rolls Astra access out per account; Forge does not add a separate entitlement gate, so unavailable accounts receive the provider error at execution time.

## Anthropic Fable catalog

`anthropic/claude-fable-5-1` is the checked-in default for the `pi-fable` family; `claude-fable-5` remains an explicit variant. Fable 5.1 has a 1M-token context window, 128k max output, text-and-image input, text output, and five always-on adaptive-thinking effort levels (`low`, `medium`, `high`, `xhigh`, and `max`) with `high` as the API and Forge default. Thinking cannot be disabled. It retains Fable 5's $10/MTok input and $50/MTok output prices while reducing cache reads to $0.25/MTok; Forge uses the 5-minute $12.50/MTok cache-write price in Pi's single cache-write field.

The installed Pi catalog does not yet include Fable 5.1, so Forge projects the official model ID with curated cost and adaptive-thinking compatibility metadata. Fable 5.1 supports automatic or disabled tool choice but rejects forced `tool_choice` values (`any` or a named tool); Forge's normal automatic tool path remains compatible. Anthropic designates Fable 5.1 a Covered Model requiring 30-day provider retention, without ZDR unless Anthropic expressly authorizes it.

## xAI catalog and authentication routing

`xai/grok-4.6` is the checked-in default for the native `pi-grok` family; `grok-4.5` remains an explicit variant. The retired `grok-4`, `grok-4-fast`, `grok-4.20-0309-reasoning`, and `grok-4.20-0309-non-reasoning` IDs are no longer catalog choices; persisted descriptors using them migrate to the current `pi-grok` default. Both supported checked-in models are eligible for normal manager creation, manager model changes, and exact per-session manager overrides when xAI auth is configured. With API-key authentication they support `low`, `medium`, `high`, and `xhigh` reasoning. Activating stored xAI OAuth first narrows checked-in Grok models to the bounded `low`, `medium`, and `high` fallback; when authenticated model discovery succeeds, returned reasoning levels and defaults become authoritative for that account while checked-in limits and capability metadata remain stable. Grok 4.6 is projected from Forge's curated xAI metadata until Pi ships it. Because Pi requires a numeric output bound while xAI documents no separate text output limit, Forge uses the model's 500k context limit as that projection bound. xAI/Grok remains excluded from manager compaction and the Settings compaction model selector.

OAuth discovery is account-specific and allowlists only `grok-4.6`, `grok-4.5`, `grok-build`, and `grok-composer-2.5-fast`. The latter two are dynamic, OAuth-only entitlement models that remain worker/specialist choices excluded from normal manager selectors: they appear only when the active account's authenticated response includes a valid exact-ID row. Their validated live metadata is retained in the dynamic catalog. Returned reasoning levels and default drive selector choices, while limits and input modes drive projection; capability fields remain catalog metadata. Availability and supported options may therefore differ by account or change after a refresh. Discovery errors, stale-account races, malformed/oversized responses, and an effective API-key credential all remove those entitlement rows rather than retaining or guessing availability.

The native xAI ID `grok-composer-2.5-fast` is unrelated to Cursor SDK's provider-scoped `cursor-sdk/composer-2.5`. Keep the provider attached when storing, displaying, or resolving either model. OAuth-only xAI models must never be paired with an API key: projection and registry filtering hide them under API-key auth, and request-time auth changes reject a previously selected OAuth-only model before any provider request.

API-key-backed xAI models keep the standard `api.x.ai` endpoint, including when `XAI_API_KEY` is the only configured xAI credential. When the stored xAI credential is OAuth, the Pi model registry rewrites only xAI models to `cli-chat-proxy.grok.com`; non-xAI models and checked-in catalog metadata remain unchanged. If stored OAuth refresh fails, request auth remains unavailable for the proxy-routed model: the registry does not select or send `XAI_API_KEY` to the OAuth proxy.

Forge centralizes the Grok proxy compatibility-version policy and proxy metadata construction in `apps/backend/src/swarm/catalog/xai-oauth-proxy-compat.ts`. The current `x-grok-client-version` compatibility value is `0.2.112`, pinned to official Grok Build commit [`02d93594`](https://github.com/xai-org/grok-build/commit/02d9359435d0e9c20a20945679389cdce441e431). This is upstream proxy compatibility data, not a Forge version or release number. Proxy requests identify the client honestly as Forge and use Forge's actual app version for its product identity rather than impersonating Grok Build.

That proxy-only compatibility metadata is attached only to authenticated xAI OAuth model discovery and OAuth inference. It is never attached to `api.x.ai` API-key requests or xAI OAuth token refresh. Forge also does not fabricate private xAI user, session, conversation, or deployment identity. Grok Build is public, but the upstream proxy contract is private, provider-coupled, and subject to change. Revalidate browser and device login, token refresh, authenticated discovery, and inference compatibility whenever Grok or the Pi xAI adapter is upgraded.

## Retired model policy

GPT-5.4, GPT-5.4 Mini, native xAI Grok 4, Grok 4 Fast, Grok 4.20 Reasoning (`grok-4.20-0309-reasoning`), Grok 4.20 Non-Reasoning (`grok-4.20-0309-non-reasoning`), GPT-5.3 Codex Spark, Claude Sonnet 4.5, and Claude Haiku 4.5 are retired. They are absent from catalog, selector, preset, specialist, and generated projection surfaces. New requests using their canonical IDs, known dotted/dashed aliases, provider-scoped forms, or the removed `pi-5.4` and `pi-codex-spark` presets are rejected before runtime provider dispatch.

Persisted descriptors are normalized deterministically during hydration and restart: `pi-5.4` presets and exact `openai-codex/gpt-5.4` or `gpt-5.4-mini` descriptors become `openai-codex/gpt-5.5`, persisted native xAI `grok-4`, `grok-4-fast`, `grok-4.20-0309-reasoning`, and `grok-4.20-0309-non-reasoning` descriptors become the current `pi-grok` default (`xai/grok-4.6`), and Spark becomes `openai-codex/gpt-5.5`. Anthropic Sonnet 4.5 and Haiku 4.5 become `anthropic/claude-sonnet-5`, known former Claude SDK selections become the same native `anthropic` model, and retired SDK Sonnet/Haiku 4.5 selections become `anthropic/claude-sonnet-5`. Unknown former SDK IDs remain unavailable and require an explicit native Anthropic selection. The existing reasoning level is clamped to the replacement model's supported levels. Retained Grok 4.6 and Grok 4.5 remain selectable; their bindings are unchanged. Specialist and roster bindings hydrate through the same persisted-descriptor normalization without rewriting roster source files. Retired OpenRouter IDs are hidden from the active model list, projection, and selector surfaces and rejected before provider dispatch. OpenRouter references are not migrated across providers; they fail closed and require an explicit exact new selection. Historical transcript entries remain unchanged for replay and analytics; they cannot select the runtime model. User-authored project resources are not rewritten and report remediation instead. Claude Code credentials are not transferred; configure native Anthropic auth in Forge. Continued sessions use native Anthropic reasoning and compaction semantics. Rollback requires reinstalling the prior binary; no history or external Claude Code data is rewritten.

## Override semantics

Local overrides are intentionally narrow and safe.

Supported fields:

- `enabled`: control whether a model can appear in manager-facing selectors, including create-session, change-default, and per-session override flows
- `managerEnabled`: control manager-agent visibility separately from general model visibility. User-added OpenRouter rows default to off and require an explicit `true` after live tool verification
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

Usually this is a one-file change in `packages/protocol/src/model-catalog-data.ts`.

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

- Shared catalog data: `packages/protocol/src/model-catalog-data.ts`
- Shared catalog types: `packages/protocol/src/model-catalog-types.ts`
- Backend catalog service: `apps/backend/src/swarm/catalog/model-catalog-service.ts`
- Pi projection generator: `apps/backend/src/swarm/catalog/model-catalog-projection.ts`
- Request behavior adapters: `apps/backend/src/swarm/catalog/model-catalog-request-behaviors.ts`
- Local overrides persistence: `apps/backend/src/swarm/catalog/model-overrides.ts`
- Audit script: `scripts/model-catalog-audit.mjs`
