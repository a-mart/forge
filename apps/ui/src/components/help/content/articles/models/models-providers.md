Forge supports five AI providers. Each has a different set of models with different tradeoffs.

## OpenAI / Codex

OpenAI offers the GPT-5 model family through the Codex runtime. OpenAI/Codex can use local OAuth/API-key credentials or Forge Auth broker mode in v1. Broker-backed access is normally bootstrapped by pasting a one-time admin setup link in Settings > Authentication; Forge redeems it server-to-server and stores only the broker runtime token in secrets. While broker mode is active, local OpenAI credentials are visible in Settings for reference but read-only. Separately, Builder web can send a plain leading @Codex or [@Codex] text message to a direct Codex app-server sidecar thread. Selector forms like @Codex -<plugin>, @Codex:<plugin>, and [@Codex:<plugin>] scope the turn to a plugin and delegate it through the visible Codex Plugin specialist worker. The plugin-scoped path uses server-owned scoped exact plugin tools, stays read-only/safety-gated, and returns bounded redacted previews and metadata. Full connector exports are written to session artifacts instead of returned through normal worker tool output. The direct sidecar path requires the Codex CLI app-server, is text-only, and is not available in Collaboration.
- **GPT-5.6 Sol** — The new flagship Codex model. Supports low, medium, high, max, and ultra reasoning.
- **GPT-5.6 Terra / Luna** — GPT-5.6 variants selectable under the same family. They support low, medium, and high reasoning.
- **GPT-5.5** — The standard full Codex coding model. Strong at implementation tasks, refactors, debugging, planning, architecture, and multi-step reasoning. Supports the legacy OpenAI Codex reasoning scale.
- **GPT-5.4** — Prior full OpenAI coding model. Good for complex planning, architecture, and multi-step reasoning when 5.5 is unavailable or intentionally avoided.
- **GPT-5.4 Mini** — A smaller, faster variant of 5.4. Good for lightweight tasks like reading files, quick edits, and exploration. Much cheaper than the full model.
- **GPT-5.4 Nano** — The smallest variant. Very fast and very cheap. Best for simple lookups, grep-style searches, and tasks where speed matters more than depth.

## Anthropic

Anthropic offers the Claude model family through Forge's native Anthropic runtime path.

- **Claude Fable 5** — Anthropic's premium option for demanding reasoning and long-horizon agentic work. The visible `pi-fable` preset selects `claude-fable-5` at high reasoning by default for managers and specialist workers. It has a 1M-token context window by default, supports up to 128k output tokens per request, and is priced at $10 per million input tokens and $50 per million output tokens. Adaptive thinking cannot be disabled, so Forge offers low, medium, high, xhigh, and max but not none; at lower effort, the model can still skip thinking for simpler requests. Anthropic's safety classifiers can decline some requests, including benign false positives; in Forge's Pi runtime, a refusal surfaces as a runtime error rather than an automatic model reroute. Anthropic designates Fable 5 a Covered Model requiring 30-day provider retention, so it is not eligible for zero data retention (ZDR).
- **Claude Opus 4.8** — A premium Claude model that is particularly strong at frontend work, UI polish, writing, and nuanced code review. Reasoning levels are limited to low, medium, and high (no none or max).
- **Claude Sonnet 5** — The default Sonnet model, with a 1M-token context window. Faster than Opus, still capable, and good for documentation, lighter code tasks, and cases where Opus is overkill. The `pi-sonnet` preset selects Sonnet 5.

## Cursor SDK

Cursor SDK uses Forge's Cursor SDK auth entry and exposes Composer 2.5 plus Cursor Grok 4.5 (`grok-4.5` and `grok-4.5-fast`). It is native to the Cursor runtime, and background auth/transport failures stay contained in the worker runtime and show up as worker failures, not app crashes. Codex selector mentions are separate from model selection and do not make Codex a manager model; they scope the turn to a plugin and delegate it through the visible Codex Plugin specialist worker instead.

## xAI / Grok

xAI provides the Grok model family. Grok models are available for specialist workers but not for manager sessions.

- **Grok 4** — xAI's flagship. Strong general-purpose model.
- **Grok 4 Fast** — Optimized for speed at some quality tradeoff.
- **Grok 4.20** — A newer variant with expanded capabilities.

You need provider credentials for each provider configured in Settings > Auth before its models appear in selectors. For OpenAI/Codex, those credentials can come from local auth or Forge Auth broker mode. Cursor SDK uses Forge's Cursor SDK auth entry, and models can be disabled in Settings > Models if you do not want to see them. Manager-facing availability is also controlled there, so only enabled models show up in manager create/change/override selectors; Codex selector mentions are plugin-scoped turns that delegate to the visible Codex Plugin specialist, not the manager model selector list. Compaction settings apply only to supported Pi-backed manager compaction runtimes, currently OpenAI/Codex and Anthropic; they do not apply to Cursor SDK or xAI/Grok.

Former Claude SDK sessions use native Anthropic after load when the saved model is known. Configure Anthropic in Forge because Claude Code login credentials do not transfer. Continued sessions use native Anthropic reasoning and compaction behavior rather than the former SDK semantics. Unknown saved SDK models and user-authored SDK references remain unavailable until you choose a native Anthropic model; Forge leaves canonical history and external Claude Code data untouched. Rollback requires reinstalling the prior binary; Forge does not rewrite historical or external Claude Code data.